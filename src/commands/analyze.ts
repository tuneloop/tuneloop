import { basename } from 'node:path'
import { loadConfig } from '../config'
import { INTRINSIC_FACETS } from '../core/facets'
import { INTRINSIC_MEASURES } from '../core/measures'
import { assignSeq } from '../core/blocks'
import { mergeSessions } from '../core/merge'
import type { Session } from '../core/model'
import { getAdapters, getProcessors } from '../core/registry'
import { runProcessors } from '../core/runner'
import { createLlmClient } from '../llm'
import { computeSessionCost, PRICE_TABLE_VERSION } from '../pricing/pricing'
import { openDb } from '../store/db'
import { Store } from '../store/store'
import type { Summary } from '../store/store'
import { createLogger } from '../util/log'
import { makeSh } from '../util/sh'

export interface AnalyzeOptions {
  dirs?: string[]
  db?: string
  verbose?: boolean
  /** Cap the number of sessions processed — handy for a cheap enrichment test. */
  limit?: number
}

/**
 * Discover sessions → parse (adapter) → ingest changed ones → run processors
 * (cache-aware) → print a summary. Writes to the store only; the dashboard,
 * `search`, and `observe` all read it.
 */
export async function analyze(opts: AnalyzeOptions): Promise<void> {
  const log = createLogger(opts.verbose ? 'debug' : 'info')
  const config = loadConfig({ db: opts.db })
  const db = openDb(config.dbPath)
  const store = new Store(db)
  const sh = makeSh()

  const processors = getProcessors()
  store.registerFacets('intrinsic', INTRINSIC_FACETS)
  store.registerMeasures('intrinsic', INTRINSIC_MEASURES)
  for (const p of processors) {
    if (p.facets?.length) store.registerFacets(p.name, p.facets)
    if (p.measures?.length) store.registerMeasures(p.name, p.measures)
  }

  let llm = null
  try {
    llm = createLlmClient(config.llm)
  } catch (err) {
    log.warn((err as Error).message)
  }
  const llmEnabled = !!llm
  const llmModel = llm?.model ?? null
  if (llmEnabled) {
    log.info(`LLM enrichment on (${llm!.provider}/${llm!.model}). Session data goes to your configured provider.`)
  } else {
    log.info('LLM enrichment off (set AIVUE_LLM_PROVIDER + key to enable). Static analysis only.')
  }

  let discovered = 0
  let parsed = 0
  let reingested = 0

  // Parse every file, then group files that share a session id and merge them
  // so each logical session is ingested and processed exactly once.
  const groups = new Map<string, Session[]>()
  // Per-source parse version, used by the re-ingest cache gate below. Each adapter
  // owns its own so a parser change in one source doesn't rebuild the others.
  const parseVersionBySource = new Map<string, number>()
  for (const adapter of getAdapters()) {
    parseVersionBySource.set(adapter.id, adapter.parseVersion)
    const roots = opts.dirs && opts.dirs.length > 0 ? opts.dirs : adapter.defaultRoots()
    log.debug(`[${adapter.id}] scanning: ${roots.join(', ')}`)
    const collect = (session: Session | null): void => {
      if (!session) return
      parsed++
      const g = groups.get(session.id)
      if (g) g.push(session)
      else groups.set(session.id, [session])
    }
    if (adapter.discoverSessions) {
      // Store-backed adapter (e.g. OpenCode): one DB yields many sessions.
      const sessions = await adapter.discoverSessions(roots)
      discovered += sessions.length
      for (const session of sessions) collect(session)
    } else {
      const files = await adapter.discover(roots)
      discovered += files.length
      for (const file of files) collect(await adapter.parse(file))
    }
  }

  // Resolve a session's repo from its cwd via git (the parser only sees cwd, and
  // cwd may be a subdir). Short name = basename of the git toplevel. Cached per
  // cwd since sessions cluster into a few working dirs; null when the dir is gone
  // or isn't a git checkout.
  const repoCache = new Map<string, string | null>()
  const resolveRepo = async (cwd: string | undefined): Promise<string | null> => {
    if (!cwd) return null
    const cached = repoCache.get(cwd)
    if (cached !== undefined) return cached
    let repo: string | null = null
    const res = await sh('git', ['-C', cwd, 'rev-parse', '--show-toplevel'])
    if (res && res.code === 0) {
      const top = res.stdout.trim()
      if (top) repo = basename(top)
    }
    repoCache.set(cwd, repo)
    return repo
  }

  let processed = 0
  for (const group of groups.values()) {
    if (opts.limit != null && processed >= opts.limit) break
    const session = mergeSessions(group)
    assignSeq(session) // main-thread seq, post-merge — the block partition's coordinate
    const repo = await resolveRepo(session.project.cwd)
    if (repo) session.project.repo = repo
    const prior = store.storedMeta(session.id)
    const parseVersion = parseVersionBySource.get(session.source) ?? 1
    // Re-ingest when the transcript changed OR a newer parser can extract more
    // from the same bytes (e.g. skill names — PARSE_VERSION bumped to 2).
    if (prior?.hash !== session.raw.contentHash || prior.parseVersion < parseVersion) {
      const cost = computeSessionCost(session)
      store.ingestSession(session, cost.usd, cost.facts, PRICE_TABLE_VERSION, parseVersion)
      if (cost.unpriced.length > 0) {
        log.debug(`unpriced model(s) in ${session.id}: ${cost.unpriced.join(', ')}`)
      }
      reingested++
    }
    // Backfill repo onto already-ingested (unchanged) sessions too, without a
    // version bump. Populate-only: never overwrite a known repo with null.
    if (repo) store.setSessionRepo(session.id, repo)
    await runProcessors({ session, processors, store, log, llmEnabled, llmModel, llm, sh })
    processed++
  }

  // Refresh stale artifacts: let each processor with a refresh() method re-check
  // its unresolved artifacts against the live source (e.g. open PRs → gh).
  for (const p of processors) {
    if (!p.refresh) continue
    const stale = store.unresolvedArtifacts(p.name)
    if (!stale.length) continue
    log.debug(`refreshing ${stale.length} unresolved artifact(s) for ${p.name}`)
    try {
      const result = await p.refresh({ artifacts: stale, log, sh })
      if (result.artifacts?.length || result.outcomes?.length) {
        store.persistRefresh(p.name, result)
        log.info(`${p.name}: refreshed ${result.artifacts?.length ?? 0} artifact(s)`)
      }
    } catch (err) {
      log.warn(`refresh failed for ${p.name}: ${(err as Error).message}`)
    }
  }

  // Remove sessions that the parser now skips (returns null) — their parse_version
  // stays stale since they were never re-ingested this run.
  const staleSessionCount = store.pruneStaleSessionsByVersion(parseVersionBySource)
  if (staleSessionCount > 0) log.debug(`pruned ${staleSessionCount} stale session(s)`)

  const pruned = store.pruneOrphanArtifacts()
  if (pruned > 0) log.debug(`pruned ${pruned} orphan artifact(s)`)

  log.info(
    `Scanned ${discovered} file(s), parsed ${parsed} session(s) into ${groups.size} unique session(s), ${reingested} new/changed.`,
  )
  printSummary(store.summary())
  store.close()
}

function printSummary(s: Summary): void {
  const usd = (n: number) => `$${n.toFixed(2)}`
  const out: string[] = []
  out.push('')
  out.push('  Sessions      ' + s.sessions)
  out.push('  Total spend   ' + usd(s.costUsd))
  out.push('  Tokens        ' + s.tokens.toLocaleString('en-US'))
  if (s.firstAt && s.lastAt) out.push(`  Range         ${s.firstAt.slice(0, 10)} → ${s.lastAt.slice(0, 10)}`)

  if (s.costPerMergedPr.costPerUnit != null) {
    out.push(`  Cost / merged PR  ${usd(s.costPerMergedPr.costPerUnit)} (${s.costPerMergedPr.count} merged)`)
  }
  if (s.analysisCostUsd > 0) out.push('  Analysis spend  ' + usd(s.analysisCostUsd) + ' (enrichment)')

  const dist = (label: string, rows: { value: string; count: number }[]) => {
    if (!rows.length) return
    out.push('')
    out.push('  ' + label)
    for (const r of rows.slice(0, 8)) out.push(`    ${String(r.value).padEnd(22)} ${r.count}`)
  }

  if (s.models.length) {
    out.push('')
    out.push('  Models')
    for (const m of s.models.slice(0, 6)) out.push(`    ${m.model.padEnd(22)} ${m.count}`)
  }

  if (s.outcomes.length) {
    out.push('')
    out.push('  Outcomes')
    for (const o of s.outcomes) out.push(`    ${o.type.padEnd(22)} ${o.count}`)
  }

  if (s.topTools.length) {
    out.push('')
    out.push('  Top tools')
    for (const t of s.topTools) {
      const errs = t.errors > 0 ? ` (${t.errors} err)` : ''
      out.push(`    ${t.name.padEnd(22)} ${t.calls}${errs}`)
    }
  }

  // Enrichment (only present when LLM enrichment has run)
  dist('Work type', s.useCases)
  dist('Complexity', s.complexity)
  dist('Autonomy', s.autonomy)
  // 'Session success' is no longer a facet/distribution — it surfaces as the
  // `session_success` outcome in the Outcomes section above.
  if (s.features.total > 0) {
    out.push('')
    out.push(`  Features        ${s.features.linked} linked (${s.features.derived} LLM-proposed)`)
  }

  out.push('')
  process.stdout.write(out.join('\n') + '\n')
}
