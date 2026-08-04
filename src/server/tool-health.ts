/**
 * Tool-health read model: for every MCP server and built-in tool the agent
 * actually used, what we can say honestly from real sessions — call volume and
 * trend, error rate, empty-result rate, and the flags that say what to do about
 * it. This is the backend for the MCP / Agent tools tab
 * (docs/plans/mcp-agent-tools-tab.md), and it replaces the Metrics → Ops tool
 * charts rather than sitting beside them.
 *
 * Three decisions shape everything here:
 *
 *  - **Error pills are the heroes.** Deferred tool loading means an unused server
 *    costs little context, so unused/scope-down are quiet hygiene chips; the
 *    signal worth a user's attention is a tool that keeps failing.
 *  - **Read `tool_calls`, never `capability_usage`.** That view is main-thread
 *    only and would silently undercount subagent MCP usage. Counts here include
 *    sidechain calls (broken out per row); the used/unused VERDICT still comes
 *    from the shared `classify()` in unused-capabilities, so this tab and the
 *    Recommendations tab can never disagree.
 *  - **One clock: tool-run time (`t.ts`).** Not session start. See health-window.
 *
 * Pure reads over the store — analyze WRITES, serve/this only READ.
 */
import { ERROR_CATEGORIES } from '../core/error-category'
import {
  classify,
  MIN_REMOVAL_TENURE_DAYS,
  mapScopeKeysToRepos,
  parseInstalledMcp,
  queryInvoked,
  queryInvokedOpencodeMcp,
  type InstalledCap,
} from '../detectors/unused-capabilities'
import type { ErrorOccurrence, Store } from '../store/store'
import {
  buildSparkBuckets,
  bucketIndex,
  DAY_MS,
  IN_WINDOW,
  resolveWindow,
  sessionCountsByRepo,
  TS_DAY,
  TS_NORM,
  type HealthWindow,
  type SparkBucket,
} from './health-window'

// ---- Flag policy ----------------------------------------------------------

/** `high-error` fires at this share of failed calls… */
export const HIGH_ERROR_SHARE = 0.2
/** …but only once there are this many calls: below it, a bad afternoon isn't a pattern. */
export const HIGH_ERROR_MIN_CALLS = 10

/** `degrading` compares the window's two halves; each needs this many calls to count. */
export const DEGRADING_MIN_CALLS_PER_HALF = 10
/** "Materially worse" is BOTH a real jump in percentage points… */
export const DEGRADING_MIN_ABS = 0.1
/** …and a real multiple of where it was — so 40%→50% doesn't cry wolf (high-error already has it). */
export const DEGRADING_MIN_RATIO = 1.5

/** The empty-result rate at which the advice line mentions it (with enough calls to mean it). */
const NOISY_EMPTY_SHARE = 0.3
const NOISY_EMPTY_MIN_CALLS = 10

/**
 * The calls list is grouped by session. These cap the LISTING, never the counts:
 * each group reports its session's true totals from an aggregate query, so a
 * capped list can't quietly understate how often a tool ran.
 */
const MAX_CALL_SESSIONS = 50
const MAX_CALL_ITEMS = 400

export type ToolKind = 'mcp' | 'builtin'

/**
 * Hero pills (red/amber) first, hygiene chips (quiet) after. Hygiene chips exist
 * only for MCP rows — a built-in has nothing to install or remove.
 */
export type ToolFlag = 'high-error' | 'degrading' | 'unused' | 'scope-down' | 'not-in-config'

/** One roster row: an MCP server, a built-in tool, or a promoted shell binary. */
export interface ToolHealthRow {
  kind: ToolKind
  /** Server name, tool name, or shell binary (`git`, `./deploy.sh`). */
  name: string
  /** Total calls in the window, INCLUDING subagent calls. */
  calls: number
  /** Distinct sessions the entity was used in. */
  sessions: number
  /** The subagent (sidechain) share of `calls` — the roster tooltip's breakdown. */
  sidechainCalls: number
  errorCalls: number
  /** Successful retrieval calls that came back with nothing (see core/empty-result). */
  emptyCalls: number
  /** Calls where emptiness is a meaningful question — the empty rate's denominator. */
  emptyEligibleCalls: number
  firstUsedAt: string | null
  lastUsedAt: string | null
  /** Calls per bucket, aligned 1:1 with `report.sparkBuckets`. */
  spark: number[]
  /** Errors per bucket, same axis — the per-row error trend. */
  errorSpark: number[]
  flags: ToolFlag[]
  /** Built-in only: this row is a shell binary promoted out of Bash commands. */
  shell?: boolean
  /** A shell row invoked by repo-relative path (`./deploy.sh`) — this project's own script. */
  repoLocal?: boolean
  /** MCP only: the primary status dot. Built-ins have nothing to be "unused" of. */
  status?: 'used' | 'unused'
  /** MCP only: present in a current config snapshot. */
  installed?: boolean
  installedRepos?: string[]
  /** MCP only, for an unused row: enough evidence to advise removal (classify + tenure). */
  enoughData?: boolean
  /** MCP only, with `scope-down`: the repos it's actually used in. */
  scopeToRepos?: string[]
  /** With `high-error`: the category most of the failures fall into, for the tooltip. */
  dominantErrorCategory?: string
  dominantErrorShare?: number
  /** With `degrading`: the two half-window error rates behind the pill (0..1). */
  priorErrorRate?: number
  recentErrorRate?: number
}

export interface ToolRosterSection<T> {
  rows: T[]
  totalHighError: number
  totalDegrading: number
}

export interface McpSection extends ToolRosterSection<ToolHealthRow> {
  totalUsed: number
  totalUnused: number
  /**
   * No MCP inventory exists for this harness, so every config-dependent chip is
   * suppressed and the rows are observed-only. Pi lives here permanently (it has
   * no MCP config by default, so no reader will be written); any harness whose
   * snapshot hasn't been captured yet lands here too, which is the honest state —
   * we don't know what's installed, so we don't claim anything is missing.
   */
  observedOnly: boolean
}

export interface BuiltinSection extends ToolRosterSection<ToolHealthRow> {
  /**
   * Shell calls that named no binary (`cd /repo`, a bare redirect). They belong to
   * no row by design, so the roster's calls don't add up to the shell total —
   * reported rather than silently dropped.
   */
  unlabeledShellCalls: number
}

export interface ToolHealthReport {
  /** The harness this report reflects. '' when the store has no tool calls at all. */
  source: string
  /** Every source with tool calls, sorted — the client shows a chooser past one. */
  availableSources: string[]
  windowDays: number | null
  sparkBuckets: SparkBucket[]
  /** Every tool call in the window, per bucket — the overall error trend above the roster. */
  overallCallSpark: number[]
  overallErrorSpark: number[]
  mcp: McpSection
  builtin: BuiltinSection
}

// ---- SQL fragments --------------------------------------------------------

/** Skills have their own tab; shell calls are exploded into binaries, not rowed as `Bash`. */
const NON_SHELL_TOOL = `t.action NOT IN ('skill', 'shell')`

/**
 * When a failed compound shell call names the binary that broke, the failure counts
 * against THAT binary only. Otherwise (`failed_binary IS NULL`) it counts against
 * every binary involved — the honest multi-label. Applied to the error NUMERATOR
 * only: "calls involving git" is still every call git was part of.
 */
const BLAMED = `(t.failed_binary IS NULL OR t.failed_binary = c.binary)`

/** The per-row aggregate columns. `errored` is the query's own error predicate. */
const aggColumns = (errored = 't.is_error = 1') => `COUNT(*) AS calls,
       SUM(t.is_sidechain) AS sidechainCalls,
       SUM(CASE WHEN ${errored} THEN 1 ELSE 0 END) AS errorCalls,
       SUM(CASE WHEN t.result_empty = 1 THEN 1 ELSE 0 END) AS emptyCalls,
       SUM(CASE WHEN t.result_empty IS NOT NULL THEN 1 ELSE 0 END) AS emptyEligibleCalls,
       MIN(${TS_NORM}) AS firstUsedAt,
       MAX(${TS_NORM}) AS lastUsedAt`

const TITLE_EXPR = `COALESCE((SELECT json_extract(value,'$') FROM annotations WHERE session_id=s.id AND key='title'), NULLIF(s.title, ''), NULLIF(s.first_prompt, ''))`

// ---- The MCP name grammar -------------------------------------------------

/**
 * The server inside `mcp__<server>__<tool>`, or null when the name is malformed
 * (no second `__`) — a phantom "" server would be worse than dropping the call.
 *
 * This mirrors the SQL in `capability_invocation` (src/store/db.ts), which the
 * used/unused verdict flows through; `mcp name grammar` in the tests pins the two
 * to the same answers so a change to one can't silently split them.
 */
export function mcpServerFromToolName(name: string): string | null {
  if (!name.startsWith('mcp__')) return null
  const rest = name.slice(5)
  const sep = rest.indexOf('__')
  if (sep <= 0) return null
  return rest.slice(0, sep)
}

/**
 * OpenCode writes MCP calls as bare `<server>_<tool>` with no `mcp__` marker, so the
 * parser can't tag them and they land as `action='other'`. Reconcile them here against
 * the KNOWN installed servers (not "split on the first _", since both server and tool
 * names contain underscores), longest server first so a server whose name prefixes
 * another can't steal its calls — the same rule as `queryInvokedOpencodeMcp`, which
 * the verdict side uses.
 */
function opencodeServerOf(name: string, serversLongestFirst: string[]): string | null {
  return serversLongestFirst.find((s) => name === s || name.startsWith(s + '_')) ?? null
}

// ---- Internal aggregation -------------------------------------------------

interface RepoAgg {
  sessions: Set<string>
  calls: number
  errorCalls: number
}

/** Everything gathered about one roster entity before it's projected to a row. */
interface EntityAgg {
  kind: ToolKind
  name: string
  shell: boolean
  calls: number
  sidechainCalls: number
  errorCalls: number
  emptyCalls: number
  emptyEligibleCalls: number
  sessions: Set<string>
  firstUsedAt: string | null
  lastUsedAt: string | null
  perRepo: Map<string | null, RepoAgg>
  /** MCP: the raw `mcp__srv__tool` names seen, with their own counts (the per-tool table). */
  perRawName: Map<string, { calls: number; errorCalls: number; lastUsedAt: string | null }>
  /** UTC day → calls/errors, folded into sparkline buckets at projection time. */
  days: Map<string, { calls: number; errors: number }>
  errorCats: Map<string, number>
}

const entityKey = (kind: ToolKind, name: string) => `${kind}\u0000${name}`

function newAgg(kind: ToolKind, name: string, shell: boolean): EntityAgg {
  return {
    kind,
    name,
    shell,
    calls: 0,
    sidechainCalls: 0,
    errorCalls: 0,
    emptyCalls: 0,
    emptyEligibleCalls: 0,
    sessions: new Set(),
    firstUsedAt: null,
    lastUsedAt: null,
    perRepo: new Map(),
    perRawName: new Map(),
    days: new Map(),
    errorCats: new Map(),
  }
}

interface AggRow {
  name: string
  action?: string
  repo: string | null
  sessionId: string
  calls: number
  sidechainCalls: number
  errorCalls: number
  emptyCalls: number
  emptyEligibleCalls: number
  firstUsedAt: string | null
  lastUsedAt: string | null
}

function absorb(agg: EntityAgg, r: AggRow, rawName?: string): void {
  agg.calls += r.calls
  agg.sidechainCalls += r.sidechainCalls ?? 0
  agg.errorCalls += r.errorCalls
  agg.emptyCalls += r.emptyCalls
  agg.emptyEligibleCalls += r.emptyEligibleCalls
  agg.sessions.add(r.sessionId)
  agg.firstUsedAt = minIso(agg.firstUsedAt, r.firstUsedAt)
  agg.lastUsedAt = maxIso(agg.lastUsedAt, r.lastUsedAt)

  const repo = agg.perRepo.get(r.repo) ?? { sessions: new Set<string>(), calls: 0, errorCalls: 0 }
  repo.sessions.add(r.sessionId)
  repo.calls += r.calls
  repo.errorCalls += r.errorCalls
  agg.perRepo.set(r.repo, repo)

  if (rawName === undefined) return
  const raw = agg.perRawName.get(rawName) ?? { calls: 0, errorCalls: 0, lastUsedAt: null }
  raw.calls += r.calls
  raw.errorCalls += r.errorCalls
  raw.lastUsedAt = maxIso(raw.lastUsedAt, r.lastUsedAt)
  agg.perRawName.set(rawName, raw)
}

/** An installed MCP server: which config files declare it, and what they say about it. */
interface InstalledMcp {
  name: string
  scope: 'global' | 'project'
  repo?: string
  sourceFiles: string[]
  type?: string
  url?: string
}

/**
 * The installed MCP inventory from current config snapshots. Names come from the
 * shared `parseInstalledMcp` (one definition of "installed", including its
 * `enabled: false` rule); this only adds the display metadata beside each name.
 */
function loadInstalledMcp(store: Store, source: string): InstalledMcp[] {
  const out: InstalledMcp[] = []

  const readOne = (scope: 'global' | 'project', scopeKey: string, repo?: string) => {
    const snap = store.envSnapshotCurrent(source, scope, scopeKey, 'mcp')
    if (!snap) return
    const payload = snap.payload as Record<string, unknown> | null
    const names = new Set(parseInstalledMcp(payload))
    const meta = new Map<string, { sourceFiles: string[]; type?: string; url?: string }>()
    for (const [file, entry] of Object.entries(payload ?? {})) {
      const servers = (entry as { servers?: unknown } | null)?.servers
      if (!servers || typeof servers !== 'object') continue
      for (const [name, def] of Object.entries(servers as Record<string, unknown>)) {
        if (!names.has(name)) continue // parseInstalledMcp dropped it (disabled)
        const d = (def ?? {}) as { type?: unknown; url?: unknown }
        const m = meta.get(name) ?? { sourceFiles: [] }
        m.sourceFiles.push(file)
        if (typeof d.type === 'string') m.type ??= d.type
        if (typeof d.url === 'string') m.url ??= d.url
        meta.set(name, m)
      }
    }
    for (const name of names) {
      const m = meta.get(name) ?? { sourceFiles: [] }
      out.push({ name, scope, repo, sourceFiles: m.sourceFiles, type: m.type, url: m.url })
    }
  }

  readOne('global', '_global')
  const projectKeys = (
    store.queryAll(`SELECT DISTINCT scope_key FROM environment_snapshots WHERE source = ? AND scope = 'project'`, source) as Array<{
      scope_key: string
    }>
  ).map((r) => r.scope_key)
  const { byRepo } = mapScopeKeysToRepos(projectKeys)
  for (const [repo, scopeKey] of byRepo) readOne('project', scopeKey, repo)
  return out
}

/** True when this source has captured any MCP config at all (see McpSection.observedOnly). */
function hasMcpInventory(store: Store, source: string): boolean {
  const row = store.queryOne(
    `SELECT 1 AS present FROM environment_snapshots WHERE source = ? AND category = 'mcp' LIMIT 1`,
    source,
  ) as { present: number } | undefined
  return !!row
}

/** Every source with tool calls, sorted — a neutral order, no harness privileged. */
function availableToolSources(store: Store): string[] {
  const rows = store.queryAll(
    `SELECT DISTINCT s.source AS source FROM tool_calls t JOIN sessions s ON s.id = t.session_id`,
  ) as Array<{ source: string }>
  return rows.map((r) => r.source).sort((a, b) => a.localeCompare(b))
}

/**
 * Pick the source a report reflects: an explicit request wins, else the harness with
 * the most tool calls across ALL time — deliberately not window-scoped, so the tab
 * doesn't flip harness as you scrub the date filter. '' when nothing has tool calls.
 */
function resolveSource(store: Store, available: string[], requested: string | undefined): string {
  if (requested && available.includes(requested)) return requested
  if (available.length === 0) return ''
  const counts = store.queryAll(
    `SELECT s.source AS source, COUNT(*) AS calls FROM tool_calls t JOIN sessions s ON s.id = t.session_id GROUP BY s.source`,
  ) as Array<{ source: string; calls: number }>
  const bySource = new Map(counts.map((r) => [r.source, r.calls]))
  return [...available].sort((a, b) => (bySource.get(b) ?? 0) - (bySource.get(a) ?? 0) || a.localeCompare(b))[0]!
}

/** The roster plus the raw per-entity aggregates the detail page reads. */
interface RosterData {
  report: ToolHealthReport
  entities: Map<string, EntityAgg>
  installed: Map<string, InstalledMcp[]>
  sinceIso: string
  untilIso?: string
  source: string
}

function collect(store: Store, win: HealthWindow): RosterData {
  const availableSources = availableToolSources(store)
  const source = resolveSource(store, availableSources, win.source)
  const { sinceIso, untilIso, sinceMs, spanMs, windowDays } = resolveWindow(store, source, win)
  const sparkBuckets = buildSparkBuckets(sinceMs, sinceMs + spanMs)
  const winParams = [sinceIso, untilIso ?? null, untilIso ?? null]

  const installedList = source ? loadInstalledMcp(store, source) : []
  const installed = new Map<string, InstalledMcp[]>()
  for (const i of installedList) installed.set(i.name, [...(installed.get(i.name) ?? []), i])
  const observedOnly = !source || !hasMcpInventory(store, source)
  // Longest first: a server whose name prefixes another must not steal its calls.
  const serversLongestFirst = [...installed.keys()].sort((a, b) => b.length - a.length)

  const entities = new Map<string, EntityAgg>()
  const ensure = (kind: ToolKind, name: string, shell = false): EntityAgg => {
    const key = entityKey(kind, name)
    let agg = entities.get(key)
    if (!agg) entities.set(key, (agg = newAgg(kind, name, shell)))
    if (shell) agg.shell = true
    return agg
  }

  /** The entity a raw tool call belongs to — the one place the MCP grammar is applied. */
  const resolveEntity = (name: string, action: string): { kind: ToolKind; name: string } | null => {
    if (action === 'mcp_call') {
      const server = mcpServerFromToolName(name)
      return server ? { kind: 'mcp', name: server } : null // malformed: drop, don't invent
    }
    if (source === 'opencode' && action === 'other') {
      const server = opencodeServerOf(name, serversLongestFirst)
      if (server) return { kind: 'mcp', name: server }
    }
    return { kind: 'builtin', name }
  }

  if (source) {
    // Per (name, action, repo, session): session-grained so folding several raw names
    // onto one server can't double-count a session that used two of its tools.
    const byName = store.queryAll(
      `SELECT t.name AS name, t.action AS action, s.repo AS repo, t.session_id AS sessionId, ${aggColumns()}
       FROM tool_calls t JOIN sessions s ON s.id = t.session_id
       WHERE s.source = ? AND ${NON_SHELL_TOOL} AND ${IN_WINDOW}
       GROUP BY t.name, t.action, s.repo, t.session_id`,
      source,
      ...winParams,
    ) as AggRow[]
    for (const r of byName) {
      const e = resolveEntity(r.name, r.action ?? '')
      if (!e) continue
      absorb(ensure(e.kind, e.name), r, e.kind === 'mcp' ? r.name : undefined)
    }

    const byBinary = store.queryAll(
      `SELECT c.binary AS name, s.repo AS repo, t.session_id AS sessionId, ${aggColumns(`t.is_error = 1 AND ${BLAMED}`)}
       FROM tool_call_commands c
       JOIN tool_calls t ON t.session_id = c.session_id AND t.idx = c.idx
       JOIN sessions s ON s.id = t.session_id
       WHERE s.source = ? AND ${IN_WINDOW}
       GROUP BY c.binary, s.repo, t.session_id`,
      source,
      ...winParams,
    ) as AggRow[]
    for (const r of byBinary) absorb(ensure('builtin', r.name, true), r)

    // Per-day trend, folded into buckets below. Aggregating by UTC day (not per call)
    // keeps this small; every bucket boundary is day-aligned, so no call can straddle.
    const daysByName = store.queryAll(
      `SELECT t.name AS name, t.action AS action, ${TS_DAY} AS day, COUNT(*) AS calls,
              SUM(CASE WHEN t.is_error = 1 THEN 1 ELSE 0 END) AS errors
       FROM tool_calls t JOIN sessions s ON s.id = t.session_id
       WHERE s.source = ? AND ${NON_SHELL_TOOL} AND ${IN_WINDOW} AND t.ts IS NOT NULL
       GROUP BY t.name, t.action, day`,
      source,
      ...winParams,
    ) as Array<{ name: string; action: string; day: string; calls: number; errors: number }>
    for (const r of daysByName) {
      const e = resolveEntity(r.name, r.action)
      if (!e) continue
      addDay(ensure(e.kind, e.name), r.day, r.calls, r.errors)
    }

    const daysByBinary = store.queryAll(
      `SELECT c.binary AS name, ${TS_DAY} AS day, COUNT(*) AS calls,
              SUM(CASE WHEN t.is_error = 1 AND ${BLAMED} THEN 1 ELSE 0 END) AS errors
       FROM tool_call_commands c
       JOIN tool_calls t ON t.session_id = c.session_id AND t.idx = c.idx
       JOIN sessions s ON s.id = t.session_id
       WHERE s.source = ? AND ${IN_WINDOW} AND t.ts IS NOT NULL
       GROUP BY c.binary, day`,
      source,
      ...winParams,
    ) as Array<{ name: string; day: string; calls: number; errors: number }>
    for (const r of daysByBinary) addDay(ensure('builtin', r.name, true), r.day, r.calls, r.errors)

    const catsByName = store.queryAll(
      `SELECT t.name AS name, t.action AS action, t.error_category AS category, COUNT(*) AS calls
       FROM tool_calls t JOIN sessions s ON s.id = t.session_id
       WHERE s.source = ? AND ${NON_SHELL_TOOL} AND ${IN_WINDOW}
         AND t.is_error = 1 AND t.error_category IS NOT NULL
       GROUP BY t.name, t.action, t.error_category`,
      source,
      ...winParams,
    ) as Array<{ name: string; action: string; category: string; calls: number }>
    for (const r of catsByName) {
      const e = resolveEntity(r.name, r.action)
      if (!e) continue
      const agg = ensure(e.kind, e.name)
      agg.errorCats.set(r.category, (agg.errorCats.get(r.category) ?? 0) + r.calls)
    }

    const catsByBinary = store.queryAll(
      `SELECT c.binary AS name, t.error_category AS category, COUNT(*) AS calls
       FROM tool_call_commands c
       JOIN tool_calls t ON t.session_id = c.session_id AND t.idx = c.idx
       JOIN sessions s ON s.id = t.session_id
       WHERE s.source = ? AND ${IN_WINDOW} AND t.is_error = 1 AND t.error_category IS NOT NULL AND ${BLAMED}
       GROUP BY c.binary, t.error_category`,
      source,
      ...winParams,
    ) as Array<{ name: string; category: string; calls: number }>
    for (const r of catsByBinary) {
      const agg = ensure('builtin', r.name, true)
      agg.errorCats.set(r.category, (agg.errorCats.get(r.category) ?? 0) + r.calls)
    }
  }

  // Seed a row for every installed-but-never-called server, so the roster can show it.
  if (!observedOnly) for (const name of installed.keys()) ensure('mcp', name)

  // The used/unused verdict comes from the SHARED policy, main-thread scoped, so this
  // tab and the Recommendations tab can never reach different conclusions.
  const sessionCounts = sessionCountsByRepo(store, source, sinceIso, untilIso)
  const installedCaps: InstalledCap[] = installedList.map((i) => ({ kind: 'mcp', name: i.name, scope: i.scope, repo: i.repo }))
  const invokedCaps = source
    ? [
        ...queryInvoked(store, sinceIso, source, untilIso).filter((c) => c.kind === 'mcp'),
        // OpenCode's untagged MCP calls, reconciled the same way the detector does.
        ...(source === 'opencode' ? queryInvokedOpencodeMcp(store, sinceIso, [...installed.keys()]) : []),
      ]
    : []
  const classified = classify(installedCaps, invokedCaps, sessionCounts)
  const verdictByName = new Map<string, { verdict: 'remove' | 'scope'; scopeToRepos?: string[] }>()
  for (const c of classified) {
    const prev = verdictByName.get(c.cap.name)
    if (!prev || c.verdict === 'scope') verdictByName.set(c.cap.name, { verdict: c.verdict, scopeToRepos: c.scopeToRepos })
  }
  const tenureCutoffIso = new Date((win.nowMs ?? Date.now()) - MIN_REMOVAL_TENURE_DAYS * DAY_MS).toISOString()
  const removalEligible = source && !observedOnly ? loadRemovalEligible(store, source, tenureCutoffIso) : new Set<string>()

  const midMs = sinceMs + spanMs / 2
  const rows: ToolHealthRow[] = []
  for (const agg of entities.values()) {
    rows.push(
      project(agg, sparkBuckets, midMs, {
        observedOnly,
        installed: installed.get(agg.name),
        verdict: verdictByName.get(agg.name),
        removalEligible: removalEligible.has(agg.name),
      }),
    )
  }
  rows.sort(rankRows)

  const overall = store.queryAll(
    `SELECT ${TS_DAY} AS day, COUNT(*) AS calls, SUM(CASE WHEN t.is_error = 1 THEN 1 ELSE 0 END) AS errors
     FROM tool_calls t JOIN sessions s ON s.id = t.session_id
     WHERE s.source = ? AND ${IN_WINDOW} AND t.ts IS NOT NULL
     GROUP BY day`,
    source,
    ...winParams,
  ) as Array<{ day: string; calls: number; errors: number }>
  const overallCallSpark = new Array(sparkBuckets.length).fill(0)
  const overallErrorSpark = new Array(sparkBuckets.length).fill(0)
  for (const r of overall) {
    const b = bucketIndex(sparkBuckets, Date.parse(r.day + 'T00:00:00Z'))
    if (b < 0) continue
    overallCallSpark[b] += r.calls
    overallErrorSpark[b] += r.errors
  }

  const unlabeled = source
    ? ((store.queryOne(
        `SELECT COUNT(*) AS n FROM tool_calls t JOIN sessions s ON s.id = t.session_id
         WHERE s.source = ? AND t.action = 'shell' AND ${IN_WINDOW}
           AND NOT EXISTS (SELECT 1 FROM tool_call_commands c WHERE c.session_id = t.session_id AND c.idx = t.idx)`,
        source,
        ...winParams,
      ) as { n: number } | undefined)?.n ?? 0)
    : 0

  const mcpRows = rows.filter((r) => r.kind === 'mcp')
  const builtinRows = rows.filter((r) => r.kind === 'builtin')
  const has = (r: ToolHealthRow, f: ToolFlag) => r.flags.indexOf(f) >= 0
  return {
    report: {
      source,
      availableSources,
      windowDays,
      sparkBuckets,
      overallCallSpark,
      overallErrorSpark,
      mcp: {
        rows: mcpRows,
        totalUsed: mcpRows.filter((r) => r.status === 'used').length,
        totalUnused: mcpRows.filter((r) => r.status === 'unused').length,
        totalHighError: mcpRows.filter((r) => has(r, 'high-error')).length,
        totalDegrading: mcpRows.filter((r) => has(r, 'degrading')).length,
        observedOnly,
      },
      builtin: {
        rows: builtinRows,
        totalHighError: builtinRows.filter((r) => has(r, 'high-error')).length,
        totalDegrading: builtinRows.filter((r) => has(r, 'degrading')).length,
        unlabeledShellCalls: unlabeled,
      },
    },
    entities,
    installed,
    sinceIso,
    untilIso,
    source,
  }
}

function addDay(agg: EntityAgg, day: string, calls: number, errors: number): void {
  const d = agg.days.get(day) ?? { calls: 0, errors: 0 }
  d.calls += calls
  d.errors += errors
  agg.days.set(day, d)
}

/**
 * The removal-tenure gate (the detector's MIN_REMOVAL_TENURE_DAYS): a server only
 * counts as removable if it was already installed BEFORE the cutoff — a fresh
 * install can't have appeared in the older sessions its absence is judged against.
 */
function loadRemovalEligible(store: Store, source: string, cutoffIso: string): Set<string> {
  const out = new Set<string>()
  const readOne = (scope: 'global' | 'project', scopeKey: string) => {
    const asOf = store.envSnapshotAsOf(source, scope, scopeKey, 'mcp', cutoffIso)
    if (!asOf.row) return
    for (const name of parseInstalledMcp(asOf.row.payload)) out.add(name)
  }
  readOne('global', '_global')
  const projectKeys = (
    store.queryAll(`SELECT DISTINCT scope_key FROM environment_snapshots WHERE source = ? AND scope = 'project'`, source) as Array<{
      scope_key: string
    }>
  ).map((r) => r.scope_key)
  const { byRepo } = mapScopeKeysToRepos(projectKeys)
  for (const [, scopeKey] of byRepo) readOne('project', scopeKey)
  return out
}

/** Project one aggregate into its roster row, applying the flag policy. */
function project(
  agg: EntityAgg,
  buckets: SparkBucket[],
  midMs: number,
  ctx: {
    observedOnly: boolean
    installed?: InstalledMcp[]
    verdict?: { verdict: 'remove' | 'scope'; scopeToRepos?: string[] }
    removalEligible: boolean
  },
): ToolHealthRow {
  const spark = new Array(buckets.length).fill(0)
  const errorSpark = new Array(buckets.length).fill(0)
  let priorCalls = 0
  let priorErrors = 0
  let recentCalls = 0
  let recentErrors = 0
  for (const [day, d] of agg.days) {
    const ms = Date.parse(day + 'T00:00:00Z')
    const b = bucketIndex(buckets, ms)
    if (b >= 0) {
      spark[b] += d.calls
      errorSpark[b] += d.errors
    }
    // A whole UTC day falls in one half; the day containing the midpoint goes to the
    // half its START is in, so the split is deterministic and never double-counts.
    if (ms >= midMs) {
      recentCalls += d.calls
      recentErrors += d.errors
    } else {
      priorCalls += d.calls
      priorErrors += d.errors
    }
  }

  const row: ToolHealthRow = {
    kind: agg.kind,
    name: agg.name,
    calls: agg.calls,
    sessions: agg.sessions.size,
    sidechainCalls: agg.sidechainCalls,
    errorCalls: agg.errorCalls,
    emptyCalls: agg.emptyCalls,
    emptyEligibleCalls: agg.emptyEligibleCalls,
    firstUsedAt: agg.firstUsedAt,
    lastUsedAt: agg.lastUsedAt,
    spark,
    errorSpark,
    flags: [],
  }
  if (agg.shell) {
    row.shell = true
    // Absolute paths were reduced to a basename at ingest, so a surviving '/' means
    // the agent invoked it by repo-relative path — this project's own script.
    if (agg.name.includes('/')) row.repoLocal = true
  }

  // Hero pills first: an entity that keeps failing is the reason this tab exists.
  if (agg.calls >= HIGH_ERROR_MIN_CALLS && agg.errorCalls / agg.calls >= HIGH_ERROR_SHARE) {
    row.flags.push('high-error')
    const dominant = [...agg.errorCats].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]
    if (dominant) {
      row.dominantErrorCategory = dominant[0]
      row.dominantErrorShare = dominant[1] / agg.errorCalls
    }
  }
  if (priorCalls >= DEGRADING_MIN_CALLS_PER_HALF && recentCalls >= DEGRADING_MIN_CALLS_PER_HALF) {
    const prior = priorErrors / priorCalls
    const recent = recentErrors / recentCalls
    if (recent - prior >= DEGRADING_MIN_ABS && recent >= prior * DEGRADING_MIN_RATIO) {
      row.flags.push('degrading')
      row.priorErrorRate = prior
      row.recentErrorRate = recent
    }
  }

  if (agg.kind !== 'mcp') return row

  row.status = agg.calls > 0 ? 'used' : 'unused'
  if (ctx.observedOnly) return row // nothing installed-side to say; observed stats only

  const installed = ctx.installed ?? []
  row.installed = installed.length > 0
  row.installedRepos = [...new Set(installed.map((i) => i.repo).filter((r): r is string => !!r))].sort()
  if (row.status === 'unused') {
    row.flags.push('unused')
    row.enoughData = ctx.verdict?.verdict === 'remove' && ctx.removalEligible
  } else {
    if (!row.installed) row.flags.push('not-in-config')
    if (ctx.verdict?.verdict === 'scope') {
      row.flags.push('scope-down')
      row.scopeToRepos = ctx.verdict.scopeToRepos
    }
  }
  return row
}

/** Roster order: busiest first, then used before unused, then name. */
function rankRows(a: ToolHealthRow, b: ToolHealthRow): number {
  if (b.calls !== a.calls) return b.calls - a.calls
  const rank = (r: ToolHealthRow) => (r.status === 'unused' ? 1 : 0)
  return rank(a) - rank(b) || a.name.localeCompare(b.name)
}

/**
 * The tool-health report: both rosters, their stats and flags, and the overall
 * error trend that replaces the old Ops chart.
 */
export function toolHealth(store: Store, win: HealthWindow = {}): ToolHealthReport {
  return collect(store, win).report
}

// ---- Drill-in -------------------------------------------------------------

export interface ToolInvocation {
  sessionId: string
  title: string | null
  /** Tool-call idx within its session — the transcript anchor (txtool-<idx>). */
  idx: number
  repo: string | null
  ts: string | null
  isError: boolean
  sidechain: boolean
  /** The raw tool name (for MCP, which tool of the server ran). */
  name: string
  command: string | null
  /** Shell rows: the call ran more than one binary, so this error is shared — the compound badge. */
  compound: boolean
  /** The call failed, but the output blamed a different binary in the same chain. */
  blamedElsewhere?: boolean
}

/**
 * One session's calls of this entity. `calls`/`errorCalls` are the session's TRUE
 * totals; `items` is the (capped) list behind them, so a group can honestly say
 * "12 calls" while listing the most recent few.
 */
export interface ToolSessionGroup {
  sessionId: string
  title: string | null
  repo: string | null
  calls: number
  errorCalls: number
  lastTs: string | null
  items: ToolInvocation[]
}

export interface ToolHealthDetail {
  kind: ToolKind
  name: string
  /** The SAME row the roster shows — computed once, so the two can't disagree. */
  row: ToolHealthRow
  sparkBuckets: SparkBucket[]
  perRepo: Array<{ repo: string | null; sessions: number; calls: number; errorCalls: number }>
  /**
   * MCP only: the tools of this server that were actually CALLED. Observed-only —
   * an installed-but-never-called tool is invisible, because no tool inventory
   * exists (snapshots keep only `{type, url}`).
   */
  perTool: Array<{ name: string; calls: number; errorCalls: number; lastUsedAt: string | null }>
  errorCategories: Array<{ category: string; calls: number }>
  /**
   * The calls, grouped by session and newest-session first. Grouped because a busy
   * tool produces hundreds of near-identical rows, and the session is the unit a
   * user actually navigates to. `row.sessions` is the true session count, so the
   * page can say how many groups it is showing of how many.
   */
  sessions: ToolSessionGroup[]
  details: {
    scope?: 'global' | 'project'
    sourceFiles?: string[]
    type?: string
    url?: string
    installedRepos?: string[]
    firstUsedAt: string | null
    lastUsedAt: string | null
  }
  /** A deterministic, always-present line. The LLM card (AL-144) is separate and optional. */
  advice: string
}

/**
 * Everything the drill-in page shows for one entity, or null when it has nothing
 * in the window.
 *
 * The roster is recomputed here rather than re-queried per section: the detail
 * page's headline stats are then literally the roster's row, so a number can
 * never differ between the two views. The extra cost is one aggregate pass.
 */
export function toolHealthDetail(store: Store, kind: ToolKind, name: string, win: HealthWindow = {}): ToolHealthDetail | null {
  const data = collect(store, win)
  const agg = data.entities.get(entityKey(kind, name))
  const row = data.report[kind === 'mcp' ? 'mcp' : 'builtin'].rows.find((r) => r.name === name)
  if (!agg || !row) return null

  const perRepo = [...agg.perRepo]
    .map(([repo, r]) => ({ repo, sessions: r.sessions.size, calls: r.calls, errorCalls: r.errorCalls }))
    .sort((a, b) => b.calls - a.calls || (a.repo ?? '￿').localeCompare(b.repo ?? '￿'))

  const perTool =
    kind === 'mcp'
      ? [...agg.perRawName]
          .map(([raw, r]) => ({ name: toolLabel(raw, name), calls: r.calls, errorCalls: r.errorCalls, lastUsedAt: r.lastUsedAt }))
          .sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name))
      : []

  const errorCategories = [...agg.errorCats]
    .map(([category, calls]) => ({ category, calls }))
    .sort((a, b) => b.calls - a.calls || a.category.localeCompare(b.category))

  const installed = data.installed.get(name) ?? []
  const primary = installed.find((i) => i.scope === 'global') ?? installed[0]

  return {
    kind,
    name,
    row,
    sparkBuckets: data.report.sparkBuckets,
    perRepo,
    perTool,
    errorCategories,
    sessions: loadSessionGroups(store, data, agg),
    details: {
      scope: primary?.scope,
      sourceFiles: primary ? [...new Set(installed.flatMap((i) => i.sourceFiles))] : undefined,
      type: primary?.type,
      url: primary?.url,
      installedRepos: row.installedRepos,
      firstUsedAt: row.firstUsedAt,
      lastUsedAt: row.lastUsedAt,
    },
    advice: advice(row),
  }
}

/** `mcp__sentry__listIssues` / `sentry_listIssues` → `listIssues`; unrecognized shapes stay whole. */
function toolLabel(rawName: string, server: string): string {
  const mcp = `mcp__${server}__`
  if (rawName.startsWith(mcp)) return rawName.slice(mcp.length)
  if (rawName.startsWith(server + '_')) return rawName.slice(server.length + 1)
  return rawName
}

/**
 * SQL scoping one entity's calls. MCP servers and built-in tools scope by raw tool
 * name; a shell binary scopes through its child table, which is what makes "the
 * calls that INVOLVED git" (compound commands included) expressible at all.
 *
 * MEMBERSHIP only — no blame filter. A call whose failure was pinned on another
 * binary still involved this one, and the roster's `calls` counts it; filtering it
 * out here made the calls list sum to one less than the tile above it. Blame
 * belongs to the error NUMERATOR, which is what `errorBlame` is for.
 */
function entityScope(agg: EntityAgg): { sql: string; params: unknown[] } {
  const clauses: string[] = []
  const params: unknown[] = []
  const rawNames = [...agg.perRawName.keys()]
  const names = agg.kind === 'mcp' ? rawNames : [agg.name]
  if (!agg.shell && names.length) {
    clauses.push(`t.name IN (${names.map(() => '?').join(', ')})`)
    params.push(...names)
  }
  if (agg.shell) {
    clauses.push(`EXISTS (SELECT 1 FROM tool_call_commands c WHERE c.session_id = t.session_id AND c.idx = t.idx AND c.binary = ?)`)
    params.push(agg.name)
  }
  // A built-in name that is also a shell binary would produce both clauses; OR keeps
  // the row's own calls and its shell calls together, matching how it was aggregated.
  return { sql: clauses.length ? `(${clauses.join(' OR ')})` : '1 = 0', params }
}

/**
 * The entity's calls, grouped by session.
 *
 * Two queries on purpose. The AGGREGATE gives each session its true call/error
 * totals; the ITEM query then fetches the individual calls for those sessions,
 * capped. Grouping a capped item list client-side would have produced counts that
 * silently meant "of the most recent 100" — a number that looks authoritative and
 * isn't. Sessions are ordered newest-call-first, which is the order a user scans.
 */
/**
 * The error-attribution predicate for one entity: a failure counts as ITS failure
 * when the output blamed it, or blamed nobody. Non-shell entities have no chain to
 * disambiguate, so every failure is theirs.
 */
function errorBlame(agg: EntityAgg): { sql: string; params: unknown[] } {
  return agg.shell
    ? { sql: `(t.failed_binary IS NULL OR t.failed_binary = ?)`, params: [agg.name] }
    : { sql: '1 = 1', params: [] }
}

function loadSessionGroups(store: Store, data: RosterData, agg: EntityAgg): ToolSessionGroup[] {
  const scope = entityScope(agg)
  const blame = errorBlame(agg)
  const win = [data.sinceIso, data.untilIso ?? null, data.untilIso ?? null]

  const groups = store.queryAll(
    `SELECT t.session_id AS sessionId, ${TITLE_EXPR} AS title, s.repo AS repo,
            COUNT(*) AS calls,
            SUM(CASE WHEN t.is_error = 1 AND ${blame.sql} THEN 1 ELSE 0 END) AS errorCalls,
            MAX(${TS_NORM}) AS lastTs
     FROM tool_calls t JOIN sessions s ON s.id = t.session_id
     WHERE s.source = ? AND ${IN_WINDOW} AND ${scope.sql}
     GROUP BY t.session_id
     ORDER BY lastTs DESC
     LIMIT ?`,
    // Bind order follows where the placeholders APPEAR in the SQL: the blame
    // predicate sits in the SELECT's errorCalls sum, ahead of the WHERE clause.
    ...blame.params,
    data.source,
    ...win,
    ...scope.params,
    MAX_CALL_SESSIONS,
  ) as Array<{ sessionId: string; title: string | null; repo: string | null; calls: number; errorCalls: number; lastTs: string | null }>
  if (!groups.length) return []

  const ids = groups.map((g) => g.sessionId)
  const items = store.queryAll(
    `SELECT t.session_id AS sessionId, ${TITLE_EXPR} AS title, t.idx AS idx, s.repo AS repo,
            ${TS_NORM} AS ts, t.is_error AS isError, t.is_sidechain AS sidechain,
            t.name AS name, t.command AS command, t.failed_binary AS failedBinary,
            (SELECT COUNT(*) FROM tool_call_commands c2 WHERE c2.session_id = t.session_id AND c2.idx = t.idx) AS binaryCount
     FROM tool_calls t JOIN sessions s ON s.id = t.session_id
     WHERE s.source = ? AND ${IN_WINDOW} AND ${scope.sql}
       AND t.session_id IN (${ids.map(() => '?').join(', ')})
     ORDER BY ts DESC, t.idx ASC
     LIMIT ?`,
    data.source,
    ...win,
    ...scope.params,
    ...ids,
    MAX_CALL_ITEMS,
  ) as Array<{
    sessionId: string
    title: string | null
    idx: number
    repo: string | null
    ts: string | null
    isError: number
    sidechain: number
    name: string
    command: string | null
    failedBinary: string | null
    binaryCount: number
  }>

  const bySession = new Map<string, ToolInvocation[]>()
  for (const r of items) {
    const list = bySession.get(r.sessionId) ?? []
    list.push({
      sessionId: r.sessionId,
      title: r.title,
      idx: r.idx,
      repo: r.repo,
      ts: r.ts,
      isError: r.isError === 1,
      sidechain: r.sidechain === 1,
      name: r.name,
      command: r.command,
      compound: r.binaryCount > 1,
      // The call failed, but its output named a DIFFERENT binary in the chain — so
      // it isn't this tool's failure, and badging it "errored" here would say it was.
      blamedElsewhere: !!r.failedBinary && r.failedBinary !== agg.name,
    })
    bySession.set(r.sessionId, list)
  }

  return groups.map((g) => ({ ...g, items: bySession.get(g.sessionId) ?? [] }))
}

/**
 * Every failed call of one category for one entity — the occurrence list behind the
 * drill-in's error accordion. Windowed on TOOL-RUN time, matching the rest of the
 * tab (the Ops widget's session clock is the other caller's default).
 */
export function toolErrorOccurrences(
  store: Store,
  kind: ToolKind,
  name: string,
  category: string,
  win: HealthWindow = {},
): ErrorOccurrence[] {
  const data = collect(store, win)
  const agg = data.entities.get(entityKey(kind, name))
  if (!agg) return []
  // `to` is left off for an open-ended window rather than pinned to "now": the tool
  // clock is second-resolution, so a millisecond-bearing upper bound would drop a
  // call made in that same second.
  const names = agg.kind === 'mcp' ? [...agg.perRawName.keys()] : agg.shell ? [] : [agg.name]
  return store.errorOccurrences(category, { from: data.sinceIso, to: data.untilIso }, names, {
    shellBinary: agg.shell ? agg.name : undefined,
    clock: 'tool',
    source: data.source, // one report = one harness, same as the bars above the list
  })
}

/** One failed call of an entity, with the coordinates to reach its FULL text. */
export interface ToolErrorSample {
  sessionId: string
  /** Tool-call idx within its session — indexes `session.toolCalls` in the blob. */
  idx: number
  name: string
  command: string | null
  category: string | null
  /** The store's clipped (200-char) message. The full text lives in the session blob. */
  message: string | null
  ts: string | null
}

/**
 * An entity's failed calls in the window, newest first — the evidence the
 * tool-error-advice pass reads. It returns COORDINATES rather than text, because
 * the stored `error_message` is clipped to 200 characters and the advice pass
 * needs the whole thing from the session blob.
 */
export function toolErrorSamples(store: Store, kind: ToolKind, name: string, win: HealthWindow = {}, limit = 25): ToolErrorSample[] {
  const data = collect(store, win)
  const agg = data.entities.get(entityKey(kind, name))
  if (!agg) return []
  const scope = entityScope(agg)
  return store.queryAll(
    `SELECT t.session_id AS sessionId, t.idx AS idx, t.name AS name, t.command AS command,
            t.error_category AS category, t.error_message AS message, ${TS_NORM} AS ts
     FROM tool_calls t JOIN sessions s ON s.id = t.session_id
     WHERE s.source = ? AND ${IN_WINDOW} AND t.is_error = 1 AND ${scope.sql}
     ORDER BY ts DESC, t.idx ASC
     LIMIT ?`,
    data.source,
    data.sinceIso,
    data.untilIso ?? null,
    data.untilIso ?? null,
    ...scope.params,
    limit,
  ) as ToolErrorSample[]
}

/**
 * The cached LLM advice card for one entity, resolved against the SAME source the
 * roster resolved — so the card on a page can never belong to another harness's
 * server of the same name. Null when no card exists (the common case).
 */
export function toolAdviceCard(store: Store, kind: ToolKind, name: string, win: HealthWindow = {}) {
  const source = resolveSource(store, availableToolSources(store), win.source)
  if (!source) return null
  const row = store.toolErrorAdvice(source, kind, name)
  // A declined pass is cached as an empty snippet so it isn't re-asked; there is
  // nothing to show for it, so the card stays hidden.
  return row && (row.diagnosis || row.snippet) ? row : null
}

// ---- Deterministic advice -------------------------------------------------

const CATEGORY_LABEL = new Map(ERROR_CATEGORIES.map((c) => [c.key, c.label]))
const pct = (x: number) => `${Math.round(x * 100)}%`

/**
 * One always-present line keyed on the row's flags and dominant error category —
 * templated, so it costs nothing and can't hallucinate. The LLM "Suggested fix"
 * card (AL-144) is the optional, richer companion for `high-error` entities only.
 */
function advice(row: ToolHealthRow): string {
  const label = row.dominantErrorCategory ? (CATEGORY_LABEL.get(row.dominantErrorCategory) ?? row.dominantErrorCategory) : null
  if (row.flags.includes('high-error')) {
    // "mostly" only when it really is most of them — a 1-of-3 plurality is "most
    // often", and saying otherwise would send the user after the wrong cause.
    const share = row.dominantErrorShare ?? 0
    const cause = !label ? '' : share >= 0.5 ? `, mostly ${label.toLowerCase()}` : `, most often ${label.toLowerCase()}`
    return `${pct(row.errorCalls / row.calls)} of ${row.calls} calls failed${cause}. Open the errors below to see what the agent hit.`
  }
  if (row.flags.includes('degrading')) {
    return `Errors went from ${pct(row.priorErrorRate ?? 0)} to ${pct(row.recentErrorRate ?? 0)} across this window — something changed recently.`
  }
  if (row.status === 'unused') {
    return row.enoughData
      ? `Never called in this window. Its tool names and instructions load into every session, so removing it is safe to consider.`
      : `Not called in this window, but there isn't enough history yet to call it dead — widen the window before removing it.`
  }
  if (row.emptyEligibleCalls >= NOISY_EMPTY_MIN_CALLS && row.emptyCalls / row.emptyEligibleCalls >= NOISY_EMPTY_SHARE) {
    return `${pct(row.emptyCalls / row.emptyEligibleCalls)} of successful calls came back empty — the agent may be querying it too narrowly.`
  }
  if (row.errorCalls === 0) return `${row.calls} calls in this window, none failed.`
  return `${row.calls} calls, ${pct(row.errorCalls / row.calls)} failed — no pattern worth acting on in this window.`
}

function minIso(a: string | null, b: string | null): string | null {
  if (!a) return b
  if (!b) return a
  return a < b ? a : b
}

function maxIso(a: string | null, b: string | null): string | null {
  if (!a) return b
  if (!b) return a
  return a > b ? a : b
}
