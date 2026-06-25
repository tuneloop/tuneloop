import { basename } from 'node:path'
import { loadConfig } from '../config'
import { INTRINSIC_FACETS } from '../core/facets'
import { INTRINSIC_MEASURES } from '../core/measures'
import { assignSeq, NORMALIZE_VERSION } from '../core/blocks'
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
  // The stored parse_version is per-adapter (`parseVersion`) composed with the
  // shared NORMALIZE_VERSION, so a per-vendor parser bump re-ingests only that
  // vendor and a normalization bump re-ingests everyone. See ADR-0002.
  const parseVersionBySource = new Map<string, number>()
  for (const a of getAdapters()) parseVersionBySource.set(a.id, a.parseVersion * 1000 + NORMALIZE_VERSION)
  const parsedSessions: Session[] = []
  for (const adapter of getAdapters()) {
    const roots = opts.dirs && opts.dirs.length > 0 ? opts.dirs : adapter.defaultRoots()
    log.debug(`[${adapter.id}] scanning: ${roots.join(', ')}`)
    const files = await adapter.discover(roots)
    discovered += files.length
    for (const file of files) {
      const session = await adapter.parse(file)
      if (!session) continue
      parsed++
      parsedSessions.push(session)
    }
  }

  // Group files into logical sessions. Same-id files merge (Claude resume/sidechain).
  // A sub-agent transcript that lives in its own file (Codex) carries `forkedFromId`
  // pointing at its parent; fold it under its ROOT ancestor so the parent merge pulls
  // it in as a sidechain (ADR-0003). Resolve to root in a second pass since a child can
  // be parsed before its parent and nest more than one level deep.
  const byId = new Map<string, Session>()
  for (const s of parsedSessions) byId.set(s.id, s)
  const rootKey = (s: Session): string => {
    const seen = new Set<string>()
    let cur = s
    while (cur.forkedFromId && !seen.has(cur.id)) {
      seen.add(cur.id)
      const parent = byId.get(`${cur.source}:${cur.forkedFromId}`)
      if (!parent) return `${cur.source}:${cur.forkedFromId}` // parent file absent — group under it anyway
      cur = parent
    }
    return cur.id
  }
  for (const s of parsedSessions) {
    const key = rootKey(s)
    const g = groups.get(key)
    if (g) g.push(s)
    else groups.set(key, [s])
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
    const parseVersion = parseVersionBySource.get(session.source) ?? NORMALIZE_VERSION
    // Re-ingest when the transcript changed OR a newer parser can extract more
    // from the same bytes (e.g. skill names — the adapter's parseVersion bumped).
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
