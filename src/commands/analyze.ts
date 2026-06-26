import { basename } from 'node:path'
import { loadConfig } from '../config'
import { INTRINSIC_FACETS } from '../core/facets'
import { INTRINSIC_MEASURES } from '../core/measures'
import { assignSeq, NORMALIZE_VERSION } from '../core/blocks'
import { mergeSessions, trimInheritedPrefix } from '../core/merge'
import type { Session } from '../core/model'
import type { SourceAdapter } from '../adapters/types'
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
  /** `--source` entries: a harness name, optionally `name=dir` to override its roots. */
  sources?: string[]
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

  // Parse every session, then group those that share a logical session (Claude
  // resume/sidechain files, Codex forks) and merge them so each is ingested and
  // processed exactly once.
  const groups = new Map<string, Session[]>()
  const adapters = getAdapters()
  // The stored parse_version is per-adapter (`parseVersion`) composed with the
  // shared NORMALIZE_VERSION, so a per-vendor parser bump re-ingests only that
  // vendor and a normalization bump re-ingests everyone. See ADR-0002.
  const parseVersionBySource = new Map<string, number>()
  for (const a of adapters) parseVersionBySource.set(a.id, a.parseVersion * 1000 + NORMALIZE_VERSION)

  // --source name[=dir] (repeatable): pick a subset of harnesses, each optionally
  // with its own roots. No --source → every adapter with its own default. Roots
  // precedence per source: explicit `=dir` ▸ positional [dirs] ▸ defaultRoots().
  const sourceRoots = new Map<string, string[]>()
  const selected = new Set<string>()
  for (const entry of opts.sources ?? []) {
    const eq = entry.indexOf('=')
    const id = resolveSource((eq >= 0 ? entry.slice(0, eq) : entry).trim(), adapters)
    selected.add(id)
    const dir = eq >= 0 ? entry.slice(eq + 1).trim() : ''
    if (dir) sourceRoots.set(id, [...(sourceRoots.get(id) ?? []), dir])
  }
  const activeAdapters = selected.size ? adapters.filter((a) => selected.has(a.id)) : adapters

  const parsedSessions: Session[] = []
  for (const adapter of activeAdapters) {
    const roots = sourceRoots.get(adapter.id) ?? (opts.dirs && opts.dirs.length > 0 ? opts.dirs : adapter.defaultRoots())
    log.debug(`[${adapter.id}] scanning: ${roots.join(', ')}`)
    if (adapter.discoverSessions) {
      // Store-backed adapter (e.g. OpenCode): one DB yields many sessions.
      const sessions = await adapter.discoverSessions(roots)
      discovered += sessions.length
      for (const session of sessions) {
        parsed++
        parsedSessions.push(session)
      }
    } else {
      const files = await adapter.discover(roots)
      discovered += files.length
      for (const file of files) {
        const session = await adapter.parse(file)
        if (!session) continue
        parsed++
        parsedSessions.push(session)
      }
    }
  }

  const byId = new Map<string, Session>()
  for (const s of parsedSessions) byId.set(s.id, s)

  // A Codex child (`/fork` or sub-agent) replays its parent's transcript prefix —
  // including the parent's token_count usage. Trim that inherited prefix so it's not
  // counted twice; leaves each child with only its own divergent work.
  for (const s of parsedSessions) {
    if (!s.forkedFromId) continue
    const parent = byId.get(`${s.source}:${s.forkedFromId}`)
    if (parent) trimInheritedPrefix(s, parent)
  }

  // Group sessions into logical sessions. Same-id sessions merge (Claude resume/sidechain).
  // A sub-agent transcript that lives in its own file (Codex) folds under its ROOT ancestor
  // via `forkedFromId` so the parent merge pulls it in as a sidechain (ADR-0003). A `/fork`
  // also carries `forkedFromId` but is its OWN top-level session (ADR-0005), so only
  // sub-agents fold. Resolve to root in a second pass since a child can be parsed before
  // its parent and nest more than one level deep.
  const rootKey = (s: Session): string => {
    if (!s.isSubagent) return s.id // forks and top-level sessions key on their own id
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

/** Resolve a --source name to a registered adapter id, tolerant of a short alias (`claude` → `claude-code`). */
function resolveSource(name: string, adapters: SourceAdapter[]): string {
  const exact = adapters.find((a) => a.id === name)
  if (exact) return exact.id
  const prefix = adapters.filter((a) => a.id.startsWith(name))
  if (prefix.length === 1) return prefix[0]!.id
  const available = adapters.map((a) => a.id).join(', ')
  if (prefix.length > 1) {
    throw new Error(`ambiguous --source "${name}" (matches ${prefix.map((a) => a.id).join(', ')})`)
  }
  throw new Error(`unknown --source "${name}" (available: ${available})`)
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
