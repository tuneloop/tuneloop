/**
 * Skill-health read model: per installed/invoked skill, everything we can say
 * HONESTLY from real sessions — trigger frequency + trend, a used/dead/mis-scoped
 * verdict (reusing the unused-capabilities policy), the skill's own-call error rate,
 * and a clearly-labelled friction-adjacency PROXY. Plus the installed SKILL.md
 * `description` so the UI can show what each skill is.
 *
 * Deliberate NON-claims (see docs/plans/skill-health.md and [[correctness-over-coverage]]):
 *  - NO per-skill token/time cost. Tokens live per-assistant-message, never on the
 *    ToolCall; attributing cost to a skill would be fabricated. Frequency is honest;
 *    cost per skill is not.
 *  - The friction-adjacency number is a PROXY ("an errored tool call followed the
 *    skill within the same session"), not a quality verdict. It is labelled as such
 *    and never phrased as "the skill was wrong".
 *
 * This is a pure read over the store — analyze WRITES, serve/this only READ.
 */

import { basename } from 'node:path'
import type { Store } from '../store/store'
import {
  classify,
  mapScopeKeysToRepos,
  parseInstalledSkills,
  queryInvoked,
  skillMatches,
  WINDOW_DAYS,
  type InstalledCap,
} from '../detectors/unused-capabilities'

/** The harness this reads: skill grammar + config layout are Claude-Code-specific (matches unused-capabilities). */
const SOURCE = 'claude-code'
/** How many tool calls after a skill engagement we scan for an error, for the friction proxy. */
const FRICTION_LOOKAHEAD = 3

const DAY_MS = 86_400_000

/** One trend bucket on the shared x-axis: its start (ms) and a human date label. */
export interface SparkBucket {
  startMs: number
  endMs: number
  label: string
}

/**
 * Build the shared trend x-axis: calendar-aligned buckets spanning [sinceMs, untilMs].
 * Granularity scales with the span so bars stay readable — daily for short windows,
 * weekly for medium, monthly for long. Every bucket in the range is emitted (including
 * empty ones) so the timeline is continuous. Labels are date-formatted for the axis.
 */
function buildSparkBuckets(sinceMs: number, untilMs: number): SparkBucket[] {
  const spanDays = (untilMs - sinceMs) / DAY_MS
  const gran: 'day' | 'week' | 'month' = spanDays <= 31 ? 'day' : spanDays <= 182 ? 'week' : 'month'
  const out: SparkBucket[] = []
  const fmtDay = (ms: number) => new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
  const fmtMonth = (ms: number) => new Date(ms).toLocaleDateString('en-US', { month: 'short', year: '2-digit', timeZone: 'UTC' })

  if (gran === 'month') {
    // Calendar months from the month containing sinceMs through untilMs.
    const d = new Date(sinceMs)
    let y = d.getUTCFullYear()
    let m = d.getUTCMonth()
    while (true) {
      const startMs = Date.UTC(y, m, 1)
      const endMs = Date.UTC(m === 11 ? y + 1 : y, (m + 1) % 12, 1)
      if (startMs > untilMs) break
      out.push({ startMs, endMs, label: fmtMonth(startMs) })
      m = (m + 1) % 12
      if (m === 0) y++
    }
    return out
  }

  // Day/week: fixed-width chunks aligned to the UTC day containing sinceMs.
  const step = gran === 'day' ? DAY_MS : 7 * DAY_MS
  const first = Date.UTC(new Date(sinceMs).getUTCFullYear(), new Date(sinceMs).getUTCMonth(), new Date(sinceMs).getUTCDate())
  for (let s = first; s <= untilMs; s += step) {
    out.push({ startMs: s, endMs: s + step, label: fmtDay(s) })
  }
  return out
}

/** An installed skill with the metadata the roster shows. */
interface InstalledSkill {
  name: string
  scope: 'global' | 'project'
  repo?: string
  description?: string
}

/** Per-skill aggregate the UI renders. */
export interface SkillHealthRow {
  name: string
  description?: string
  /** Where it's installed. 'unregistered' = we saw it run but it's in no config snapshot. */
  scope: 'global' | 'project' | 'unregistered'
  /** Project repos it's installed in (scope='project'). */
  installedRepos: string[]
  installed: boolean
  /** Distinct sessions it was invoked in, in the window. */
  sessions: number
  /** Total invocations in the window. */
  calls: number
  /** Invocations whose own tool call errored. */
  errorCalls: number
  /** Repos it was actually invoked in (excludes the null-repo bucket). */
  usedRepos: string[]
  /** Proxy: invocations followed by an errored tool call within FRICTION_LOOKAHEAD calls, same session. */
  frictionAdjacent: number
  firstUsedAt: string | null
  lastUsedAt: string | null
  /** Per-bucket invocation counts, oldest→newest, aligned 1:1 with report.sparkBuckets. */
  spark: number[]
  /**
   * Usage status — the PRIMARY, mutually-exclusive axis. Window-scoped and factual:
   *  - used: invoked at least once in the window
   *  - unused: installed, never invoked in the window
   * (There is no separate "too little data" status — "unused in the last 7 days" is a
   * true statement regardless of sample size. Confidence lives in `enoughData` below,
   * which only gates the *removal advice*, not the label.)
   */
  status: 'used' | 'unused'
  /**
   * For an UNUSED skill: whether enough sessions were observed in the window to trust
   * the absence (the detector's MIN_SESSIONS gate). true → safe to advise removal;
   * false → "unused here, but too few sessions to say it's truly dead — widen first".
   * Always true for used skills (irrelevant there).
   */
  enoughData: boolean
  /**
   * Refinement flags on a USED skill (orthogonal to status, so a used skill can still
   * carry a hint) — was folded into `verdict`, which starved the "used" count:
   *  - scope-down: global but invoked in only a few repos — candidate to scope down
   *  - not-in-config: invoked but absent from every current config snapshot (a skill
   *    removed/relocated since it ran, or a CLI-bundled skill we can't see on disk)
   */
  flags: Array<'scope-down' | 'not-in-config'>
  /** For the 'scope-down' flag: the repos it's actually used in. */
  scopeToRepos?: string[]
}

/**
 * The time window a report was computed over. A custom `from`/`to` range (ISO)
 * takes precedence; otherwise `days` (null = all-time; default 30) applies.
 */
export interface SkillHealthWindow {
  /** Preset length in days, or null for all-time. Default 30. Ignored when from/to set. */
  days?: number | null
  /** Custom range lower bound (ISO). When set (with `to`), overrides `days`. */
  from?: string
  /** Custom range upper bound (ISO). When set (with `from`), overrides `days`. */
  to?: string
  /** Evaluation "now" (ms). Defaults to Date.now(). */
  nowMs?: number
}

export interface SkillHealthReport {
  /** The window length in days, or null when all-time (UI shows "all time"). */
  windowDays: number | null
  totalInstalled: number
  /** Primary status counts (used + unused = installed-or-seen). */
  totalUsed: number
  totalUnused: number
  /** Flag counts (subsets of `used`, so they overlap totalUsed — not a partition). */
  totalScopeDown: number
  totalNotInConfig: number
  rows: SkillHealthRow[]
  /** True when no config snapshot has been captured — the installed side is unknown. */
  noConfig: boolean
  /** The shared trend x-axis: each row's `spark` array aligns 1:1 with these calendar
   *  buckets, so the client can label bars + tooltips with real date ranges. */
  sparkBuckets: SparkBucket[]
}

/** Load installed skills (with descriptions) from the current config snapshots. */
function loadInstalledSkills(store: Store): InstalledSkill[] {
  const out: InstalledSkill[] = []

  const readOne = (scope: 'global' | 'project', scopeKey: string, repo?: string) => {
    const snap = store.envSnapshotCurrent(SOURCE, scope, scopeKey, 'skills')
    if (!snap) return
    // parseInstalledSkills gives names; re-read the payload for descriptions so the
    // roster can show what each skill is (payload shape: { skills: [{name, description?}] }).
    const names = new Set(parseInstalledSkills(snap.payload))
    const descByName = new Map<string, string>()
    const skills = (snap.payload as { skills?: unknown })?.skills
    if (Array.isArray(skills)) {
      for (const s of skills) {
        const o = s as Record<string, unknown> | null
        if (o && typeof o.name === 'string' && typeof o.description === 'string') descByName.set(o.name, o.description)
      }
    }
    for (const name of names) out.push({ name, scope, repo, description: descByName.get(name) })
  }

  readOne('global', '_global')

  const projectKeys = (
    store.queryAll(
      `SELECT DISTINCT scope_key FROM environment_snapshots WHERE source = ? AND scope = 'project'`,
      SOURCE,
    ) as Array<{ scope_key: string }>
  ).map((r) => r.scope_key)
  const { byRepo } = mapScopeKeysToRepos(projectKeys)
  for (const [repo, scopeKey] of byRepo) readOne('project', scopeKey, repo)

  return out
}

/** One invoked-skill row with timeline + error/friction facts (main-thread, in-window). */
interface InvokedDetail {
  name: string
  repo: string | null
  sessions: number
  calls: number
  errorCalls: number
  frictionAdjacent: number
  firstUsedAt: string | null
  lastUsedAt: string | null
}

/**
 * Per (name, repo) invocation facts. The friction-adjacency proxy is computed with a
 * correlated subquery: for each skill call, is there an errored tool call in the same
 * session within the next FRICTION_LOOKAHEAD idx positions? Main-thread only.
 */
function queryInvokedDetail(store: Store, sinceIso: string, untilIso?: string): InvokedDetail[] {
  return store.queryAll(
    `SELECT t.name AS name,
            s.repo AS repo,
            COUNT(DISTINCT t.session_id) AS sessions,
            COUNT(*) AS calls,
            SUM(CASE WHEN t.is_error = 1 THEN 1 ELSE 0 END) AS errorCalls,
            SUM(CASE WHEN EXISTS (
                  SELECT 1 FROM tool_calls e
                  WHERE e.session_id = t.session_id
                    AND e.idx > t.idx AND e.idx <= t.idx + ?
                    AND e.is_error = 1
                ) THEN 1 ELSE 0 END) AS frictionAdjacent,
            MIN(t.ts) AS firstUsedAt,
            MAX(t.ts) AS lastUsedAt
     FROM tool_calls t JOIN sessions s ON s.id = t.session_id
     WHERE t.action = 'skill' AND t.is_sidechain = 0
       AND s.source = ? AND s.started_at >= ? AND (? IS NULL OR s.started_at < ?)
     GROUP BY t.name, s.repo`,
    FRICTION_LOOKAHEAD,
    SOURCE,
    sinceIso,
    untilIso ?? null,
    untilIso ?? null,
  ) as InvokedDetail[]
}

/**
 * Per-skill trend: invocation counts folded into the shared calendar buckets. Each
 * skill's array is aligned to `buckets` (same length/order), so a bar's index maps to
 * a real date range for the axis + tooltip. A ts is placed in the last bucket whose
 * startMs <= ts (buckets are contiguous and sorted).
 */
function querySpark(store: Store, sinceIso: string, buckets: SparkBucket[], untilIso?: string): Map<string, number[]> {
  const rows = store.queryAll(
    `SELECT t.name AS name, t.ts AS ts
     FROM tool_calls t JOIN sessions s ON s.id = t.session_id
     WHERE t.action = 'skill' AND t.is_sidechain = 0
       AND s.source = ? AND s.started_at >= ? AND (? IS NULL OR s.started_at < ?) AND t.ts IS NOT NULL`,
    SOURCE,
    sinceIso,
    untilIso ?? null,
    untilIso ?? null,
  ) as Array<{ name: string; ts: string }>
  const out = new Map<string, number[]>()
  const n = buckets.length
  for (const { name, ts } of rows) {
    const t = Date.parse(ts)
    if (Number.isNaN(t)) continue
    // Find the bucket containing t (linear scan from the end; buckets are contiguous).
    let b = -1
    for (let i = n - 1; i >= 0; i--) {
      if (t >= buckets[i]!.startMs) { b = i; break }
    }
    if (b < 0) b = 0
    const arr = out.get(name) ?? new Array(n).fill(0)
    arr[b]++
    out.set(name, arr)
  }
  return out
}

/** Distinct-session count per repo in the window — the trust denominator for verdicts. */
function loadSessionCounts(store: Store, sinceIso: string, untilIso?: string): Map<string, number> {
  const rows = store.queryAll(
    `SELECT repo, COUNT(*) AS n FROM sessions
     WHERE source = ? AND started_at >= ? AND (? IS NULL OR started_at < ?) AND repo IS NOT NULL GROUP BY repo`,
    SOURCE,
    sinceIso,
    untilIso ?? null,
    untilIso ?? null,
  ) as Array<{ repo: string; n: number }>
  return new Map(rows.map((r) => [r.repo, r.n]))
}

/**
 * The earliest session start for this source, as ms — the natural lower bound for
 * the all-time window's sparkline span. Null when there are no sessions.
 */
function earliestSessionMs(store: Store): number | null {
  const row = store.queryOne(
    `SELECT MIN(started_at) AS earliest FROM sessions WHERE source = ?`,
    SOURCE,
  ) as { earliest: string | null } | undefined
  const t = row?.earliest ? Date.parse(row.earliest) : NaN
  return Number.isNaN(t) ? null : t
}

interface ResolvedWindow {
  sinceIso: string
  /** Upper bound (ISO), or undefined for an open range (presets/all-time). */
  untilIso?: string
  sinceMs: number
  spanMs: number
  /** null = all-time; -1 = a custom range (UI shows the dates, not "N days"). */
  windowDays: number | null
}

/**
 * Resolve a requested window into the concrete bounds the queries need: the ISO
 * lower bound (`sinceIso`), an optional upper bound (`untilIso`, set only for a custom
 * range), the sparkline span (`spanMs`) and its start (`sinceMs`), and the `windowDays`
 * echoed to the client. A custom from/to range wins; else `days` (null = all-time). For
 * all-time we anchor the span at the earliest session (falling back to WINDOW_DAYS when
 * the store is empty) so the sparkline still covers the real data range.
 */
function resolveWindow(store: Store, win: SkillHealthWindow): ResolvedWindow {
  const nowMs = win.nowMs ?? Date.now()
  // Custom range takes precedence when both bounds are valid dates.
  if (win.from && win.to) {
    const sinceMs = Date.parse(win.from)
    const untilMs = Date.parse(win.to)
    if (!Number.isNaN(sinceMs) && !Number.isNaN(untilMs) && untilMs > sinceMs) {
      return {
        sinceIso: new Date(sinceMs).toISOString(),
        untilIso: new Date(untilMs).toISOString(),
        sinceMs,
        spanMs: untilMs - sinceMs,
        windowDays: -1, // sentinel: a custom range
      }
    }
  }
  if (win.days === null) {
    const earliest = earliestSessionMs(store)
    const sinceMs = earliest ?? nowMs - WINDOW_DAYS * 86_400_000
    // Guard against a zero/negative span if the only session is "now".
    const spanMs = Math.max(nowMs - sinceMs, 86_400_000)
    return { sinceIso: new Date(sinceMs).toISOString(), sinceMs, spanMs, windowDays: null }
  }
  const days = win.days && win.days > 0 ? win.days : WINDOW_DAYS
  const spanMs = days * 86_400_000
  const sinceMs = nowMs - spanMs
  return { sinceIso: new Date(sinceMs).toISOString(), sinceMs, spanMs, windowDays: days }
}

/**
 * Build the skill-health report. Installed skills come from config snapshots (with
 * descriptions); invocation facts from tool_calls. The remove/scope verdict reuses the
 * unused-capabilities `classify` policy so the two features never disagree. A skill
 * seen running but absent from every snapshot is surfaced as 'unregistered' (not
 * dropped) — it's real usage we can't tie to a config entry.
 *
 * Each row carries a mutually-exclusive `status` (used / unused) plus orthogonal
 * `flags` (scope-down, not-in-config) — a USED skill can still carry a scope-down hint,
 * which the old single `verdict` enum couldn't express (it starved the "used" bucket by
 * claiming every used-but-scopeable skill as 'scope').
 *
 * `win` selects the time window (default 30 days; `days: null` = all-time). The
 * installed inventory is always current — only the invocation/usage facts window.
 * NOTE: "unused" is window-scoped and factual ("not invoked in the last N days"); the
 * detector's MIN_SESSIONS gate sets `enoughData`, which decides only whether we advise
 * removal (enough sessions to trust the absence) vs. suggest widening the window.
 */
export function skillHealth(store: Store, win: SkillHealthWindow = {}): SkillHealthReport {
  const { sinceIso, untilIso, sinceMs, spanMs, windowDays } = resolveWindow(store, win)
  const sparkBuckets = buildSparkBuckets(sinceMs, sinceMs + spanMs)

  const installed = loadInstalledSkills(store)
  const invokedDetail = queryInvokedDetail(store, sinceIso, untilIso)
  const spark = querySpark(store, sinceIso, sparkBuckets, untilIso)
  const sessionCounts = loadSessionCounts(store, sinceIso, untilIso)

  // Reuse the detector's classify to get remove(=dead)/scope verdicts, skill-side only.
  const installedCaps: InstalledCap[] = installed.map((s) => ({ kind: 'skill', name: s.name, scope: s.scope, repo: s.repo }))
  const invokedCaps = queryInvoked(store, sinceIso, SOURCE, untilIso).filter((c) => c.kind === 'skill')
  const classified = classify(installedCaps, invokedCaps, sessionCounts)
  // Verdict + scope targets per installed skill name (a name can be classified once per install entry;
  // keep the strongest signal: scope target if any, else remove).
  const verdictByName = new Map<string, { verdict: 'remove' | 'scope'; scopeToRepos?: string[] }>()
  for (const c of classified) {
    if (c.cap.kind !== 'skill') continue
    const prev = verdictByName.get(c.cap.name)
    if (!prev || c.verdict === 'scope') verdictByName.set(c.cap.name, { verdict: c.verdict, scopeToRepos: c.scopeToRepos })
  }

  // Fold invocation detail per skill NAME (summing across repos), matching installed names
  // via skillMatches (plugin-namespaced invocations reconcile to their installed entry).
  const rowsByName = new Map<string, SkillHealthRow>()
  const ensureRow = (name: string, inst?: InstalledSkill): SkillHealthRow => {
    let row = rowsByName.get(name)
    if (!row) {
      row = {
        name,
        description: inst?.description,
        scope: inst ? inst.scope : 'unregistered',
        installedRepos: [],
        installed: !!inst,
        sessions: 0,
        calls: 0,
        errorCalls: 0,
        usedRepos: [],
        frictionAdjacent: 0,
        firstUsedAt: null,
        lastUsedAt: null,
        spark: spark.get(name) ?? new Array(sparkBuckets.length).fill(0),
        status: 'unused',
        enoughData: false,
        flags: [],
      }
      rowsByName.set(name, row)
    }
    return row
  }

  // Seed rows from installed skills (so dead ones appear). Merge multiple install entries
  // for the same name (global + project) into one row, collecting project repos.
  for (const inst of installed) {
    const row = ensureRow(inst.name, inst)
    if (!row.description && inst.description) row.description = inst.description
    if (inst.scope === 'project' && inst.repo) row.installedRepos.push(inst.repo)
    // A skill installed both globally and per-project reads as global (the broader scope).
    if (inst.scope === 'global') row.scope = 'global'
    row.installed = true
  }

  // Fold invocations onto matching installed rows (or create an unregistered row).
  for (const iv of invokedDetail) {
    // Find the installed name this invocation reconciles to.
    const match = installed.find((s) => skillMatches(s.name, iv.name))
    const rowName = match ? match.name : iv.name
    const row = ensureRow(rowName, match)
    row.sessions += iv.sessions
    row.calls += iv.calls
    row.errorCalls += iv.errorCalls
    row.frictionAdjacent += iv.frictionAdjacent
    if (iv.repo) row.usedRepos.push(iv.repo)
    row.firstUsedAt = minIso(row.firstUsedAt, iv.firstUsedAt)
    row.lastUsedAt = maxIso(row.lastUsedAt, iv.lastUsedAt)
    // An unregistered invocation carries its own spark under its raw name; fold it in.
    if (!match && row.spark.every((n) => n === 0)) row.spark = spark.get(iv.name) ?? row.spark
  }

  // Assign the status axis + refinement flags (orthogonal — a used skill can still
  // carry a scope-down / not-in-config hint).
  for (const row of rowsByName.values()) {
    row.installedRepos = [...new Set(row.installedRepos)].sort()
    row.usedRepos = [...new Set(row.usedRepos)].sort()
    const v = verdictByName.get(row.name)

    if (row.calls > 0) {
      // Invoked in the window → used, regardless of scope/config hints.
      row.status = 'used'
      row.enoughData = true
      if (!row.installed) row.flags.push('not-in-config')
      if (v?.verdict === 'scope') {
        row.scopeToRepos = v.scopeToRepos
        row.flags.push('scope-down')
      }
    } else {
      // Installed, never invoked in the window → unused (a true, window-scoped fact).
      // `enoughData` marks whether we've seen enough sessions to *advise removal*:
      // classify emits 'remove' only past MIN_SESSIONS, so it's our confidence gate.
      // (An uninstalled row with no calls can't occur — a row exists only from an
      // install entry or an invocation, and no-calls means it came from install.)
      row.status = 'unused'
      row.enoughData = v?.verdict === 'remove'
    }
  }

  const rows = [...rowsByName.values()].sort(rankRows)
  const has = (r: SkillHealthRow, f: 'scope-down' | 'not-in-config') => r.flags.indexOf(f) >= 0
  return {
    windowDays,
    totalInstalled: rows.filter((r) => r.installed).length,
    totalUsed: rows.filter((r) => r.status === 'used').length,
    totalUnused: rows.filter((r) => r.status === 'unused').length,
    totalScopeDown: rows.filter((r) => has(r, 'scope-down')).length,
    totalNotInConfig: rows.filter((r) => has(r, 'not-in-config')).length,
    rows,
    noConfig: installed.length === 0,
    sparkBuckets,
  }
}

/** Roster order: most-used first, then used-before-unused, then name. */
function rankRows(a: SkillHealthRow, b: SkillHealthRow): number {
  if (b.calls !== a.calls) return b.calls - a.calls
  const order = { used: 0, unused: 1 }
  return order[a.status] - order[b.status] || a.name.localeCompare(b.name)
}

/** One invocation of a skill — a row in the per-skill "invocations" drill-down list. */
export interface SkillInvocation {
  sessionId: string
  title: string | null
  /** Tool-call idx within its session — the transcript anchor (txtool-<idx>) to scroll to. */
  idx: number
  repo: string | null
  ts: string | null
  /** True when its own tool call errored. */
  isError: boolean
  /** Proxy: an errored tool call followed within FRICTION_LOOKAHEAD calls, same session. */
  frictionAfter: boolean
}

/** Cap on the invocations list (mirrors errorOccurrences). The page notes the true
 * total from the roster row's `calls`, so we only need the capped page here. */
const MAX_INVOCATIONS = 100

/**
 * Every invocation of one skill in the window, newest first — the list behind the
 * per-skill "Invocations" drill-down. Each row carries session_id + the tool-call idx
 * so the client can open the session drawer scrolled to that exact call (txtool-<idx>).
 * Matches the invoked name exactly OR as a plugin-namespaced `<plugin>:<name>` (same
 * reconciliation as skillMatches), so a namespaced invocation still lists under its skill.
 * Main-thread only, matching the roster's counts. Capped at MAX_INVOCATIONS.
 */
export function skillInvocations(store: Store, name: string, win: SkillHealthWindow = {}): SkillInvocation[] {
  const { sinceIso, untilIso } = resolveWindow(store, win)
  const title = `COALESCE((SELECT json_extract(value,'$') FROM annotations WHERE session_id=s.id AND key='title'), NULLIF(s.title, ''), NULLIF(s.first_prompt, ''))`
  const rows = store.queryAll(
    `SELECT t.session_id AS sessionId, ${title} AS title, t.idx AS idx, s.repo AS repo,
            t.ts AS ts, t.is_error AS isError,
            (CASE WHEN EXISTS (
               SELECT 1 FROM tool_calls e WHERE e.session_id = t.session_id
                 AND e.idx > t.idx AND e.idx <= t.idx + ? AND e.is_error = 1
             ) THEN 1 ELSE 0 END) AS frictionAfter
     FROM tool_calls t JOIN sessions s ON s.id = t.session_id
     WHERE t.action = 'skill' AND t.is_sidechain = 0
       AND (t.name = ? OR t.name LIKE ?)
       AND s.source = ? AND s.started_at >= ? AND (? IS NULL OR s.started_at < ?)
     ORDER BY s.started_at DESC, t.idx ASC
     LIMIT ?`,
    FRICTION_LOOKAHEAD,
    name,
    '%:' + name, // plugin-namespaced form (<plugin>:<name>)
    SOURCE,
    sinceIso,
    untilIso ?? null,
    untilIso ?? null,
    MAX_INVOCATIONS,
  ) as Array<{ sessionId: string; title: string | null; idx: number; repo: string | null; ts: string | null; isError: number; frictionAfter: number }>

  return rows.map((r) => ({
    sessionId: r.sessionId,
    title: r.title,
    idx: r.idx,
    repo: r.repo,
    ts: r.ts,
    isError: r.isError === 1,
    frictionAfter: r.frictionAfter === 1,
  }))
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
