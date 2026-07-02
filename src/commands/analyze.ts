import { existsSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { loadConfig } from '../config'
import type { LlmOverrides } from '../config'
import { INTRINSIC_FACETS } from '../core/facets'
import { INTRINSIC_MEASURES } from '../core/measures'
import { assignSeq, NORMALIZE_VERSION } from '../core/blocks'
import { mergeSessions, trimInheritedPrefix } from '../core/merge'
import type { Session } from '../core/model'
import type { SourceAdapter } from '../adapters/types'
import { getAdapters, getProcessors } from '../core/registry'
import { orderProcessors, runProcessors } from '../core/runner'
import { createLlmClient } from '../llm'
import { computeSessionCost, priceFor, PRICE_TABLE_VERSION } from '../pricing/pricing'
import { loadOpenRouterPrices } from '../pricing/openrouter'
import { openDb } from '../store/db'
import { Store } from '../store/store'
import type { Summary } from '../store/store'
import { createLogger } from '../util/log'
import { Progress } from '../util/progress'
import { makeSh } from '../util/sh'

export interface AnalyzeOptions {
  dirs?: string[]
  /** `--source` entries: a harness name, optionally `name=dir` to override its roots. */
  sources?: string[]
  db?: string
  verbose?: boolean
  /** Cap the number of sessions processed — handy for a cheap enrichment test. */
  limit?: number
  /** Non-secret LLM flag overrides (provider/model/base-url); the key stays env-only. */
  llm?: LlmOverrides
}

/**
 * Discover sessions → parse (adapter) → ingest changed ones → run processors
 * (cache-aware) → print a summary. Writes to the store only; the dashboard,
 * `search`, and `observe` all read it.
 */
export async function analyze(opts: AnalyzeOptions): Promise<void> {
  const log = createLogger(opts.verbose ? 'debug' : 'info')
  const config = loadConfig({ db: opts.db, llm: opts.llm })
  const db = openDb(config.dbPath)
  const store = new Store(db)
  const sh = makeSh()

  // Fetch the OpenRouter price backfill only to price an enrichment model the
  // static table lacks; static-only runs stay offline.
  if (config.llm && !priceFor(config.llm.provider, config.llm.model)) await loadOpenRouterPrices(config.dataDir, log)

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
    printEnrichmentHint(log)
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

  // Ingest provenance: the (source, directory) roots actually scanned this run,
  // recorded after the run completes so `--schema` / coverage can report what's
  // covered. Only roots that exist on disk — a default root for an uninstalled
  // harness was never really analyzed.
  const scannedRoots: Array<{ source: string; path: string }> = []
  const parsedSessions: Session[] = []
  for (const adapter of activeAdapters) {
    const roots = sourceRoots.get(adapter.id) ?? (opts.dirs && opts.dirs.length > 0 ? opts.dirs : adapter.defaultRoots())
    for (const root of roots) {
      const abs = resolve(root)
      if (existsSync(abs)) scannedRoots.push({ source: adapter.id, path: abs })
    }
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

  // Merge each group, then process oldest-first. Chronological order matters:
  // enrich-session builds the feature taxonomy incrementally — each session links
  // to features proposed by sessions processed before it — so the earliest session
  // to touch a feature should be the one that creates it. Map iteration order is
  // discovery order (filesystem walk / per-adapter), not time, so sort by
  // startedAt. Sessions with no startedAt sort first; ties keep a stable order.
  const merged = [...groups.values()].map((group) => mergeSessions(group))
  merged.sort((a, b) => (a.startedAt ?? '').localeCompare(b.startedAt ?? ''))

  // Pre-scan: count sessions that will need processing (at least one cache miss).
  const sessionsToProcess = opts.limit != null ? merged.slice(0, opts.limit) : merged
  const ordered = orderProcessors(processors)
  let totalNeedingWork = 0
  for (const session of sessionsToProcess) {
    const prior = store.storedMeta(session.id)
    const parseVersion = parseVersionBySource.get(session.source) ?? NORMALIZE_VERSION
    if (prior?.hash !== session.raw.contentHash || prior.parseVersion < parseVersion) {
      totalNeedingWork++
      continue
    }
    const inputHash = session.raw.contentHash
    let anyMiss = false
    for (const p of ordered) {
      if (p.needs?.llm && !llmEnabled) continue
      const model = p.needs?.llm ? llmModel : null
      const cached = store.processorRun(session.id, p.name)
      if (!cached || cached.version !== p.version || cached.inputHash !== inputHash || cached.model !== model) {
        anyMiss = true
        break
      }
    }
    if (anyMiss) totalNeedingWork++
  }
  const n = sessionsToProcess.length
  log.info(
    `${n} ${n === 1 ? 'session' : 'sessions'} to scan, ` +
      `${totalNeedingWork} ${totalNeedingWork === 1 ? 'needs' : 'need'} processing.`,
  )

  const progress = new Progress(sessionsToProcess.length, totalNeedingWork)

  let processed = 0
  for (const session of merged) {
    if (opts.limit != null && processed >= opts.limit) break
    assignSeq(session) // main-thread seq, post-merge — the block partition's coordinate
    const repo = await resolveRepo(session.project.cwd)
    if (repo) session.project.repo = repo
    const prior = store.storedMeta(session.id)
    const parseVersion = parseVersionBySource.get(session.source) ?? NORMALIZE_VERSION
    const needsIngest = prior?.hash !== session.raw.contentHash || prior.parseVersion < parseVersion
    // Re-ingest when the transcript changed OR a newer parser can extract more
    // from the same bytes (e.g. skill names — the adapter's parseVersion bumped).
    if (needsIngest) {
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

    const t0 = Date.now()
    const { costUsd: sessionCost } = await runProcessors({ session, processors, store, log, llmEnabled, llmModel, llm, sh })
    const elapsedMs = Date.now() - t0

    const didWork = elapsedMs > 50 || sessionCost > 0
    progress.tick(didWork, elapsedMs, sessionCost)
    processed++
  }
  progress.clear()

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
  // Stamp completion at the very end so a run that crashed partway can't claim the
  // store is fresh. Drives the dashboard's "last analyzed" line + the stale-store
  // nudge; per-session analyzed_at / processor ran_at only move when work is done,
  // so they can't answer "when did analyze last finish" (e.g. for a no-op re-run).
  const finishedAt = new Date().toISOString()
  store.setMeta('last_analyze_at', finishedAt)
  // Per-directory provenance, stamped with the same completion time.
  store.recordAnalyzedRoots(scannedRoots, finishedAt)
  printSummary(store.summary())
  store.close()
}

/**
 * Notice when no enrichment provider is configured — prints whenever enrichment
 * is off (not just the first run). Discoverability, not a gate; the multi-line
 * form with setup hints prints only on an interactive terminal.
 */
function printEnrichmentHint(log: ReturnType<typeof createLogger>): void {
  if (!process.stdout.isTTY) {
    log.info('LLM enrichment off (set TUNELOOP_LLM_PROVIDER + key to enable). Static analysis only.')
    return
  }
  process.stdout.write(
    [
      '',
      'LLM enrichment is off — static analysis only. Enable it with your own key, e.g.:',
      '    export TUNELOOP_LLM_PROVIDER=openrouter',
      '    export OPENROUTER_API_KEY=sk-or-...',
      '  Providers: anthropic, openai, openrouter, groq, deepseek, gemini, ollama (see README).',
      '',
    ].join('\n') + '\n',
  )
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

  out.push('')
  process.stdout.write(out.join('\n') + '\n')
}
