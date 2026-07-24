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
  /**
   * Per-repo usage breakdown — the evidence behind the scope-down flag. One entry per
   * repo the skill was invoked in (plus a `repo: null` bucket for unattributed usage),
   * sorted most-used first. The sum of `calls` equals the row's `calls`. Paired with
   * `report.totalActiveRepos`, the UI can say "used in aivue (3×), never in 6 other
   * active repos".
   */
  perRepo: Array<{
    repo: string | null
    sessions: number
    calls: number
    errorCalls: number
    frictionAdjacent: number
  }>
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
  /** Distinct repos with any session in the window — the denominator for "used in X of
   *  N repos". Excludes the null-repo bucket. */
  totalActiveRepos: number
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
        perRepo: [],
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
    // Keep the per-repo grain instead of only summing it away — the scope-down evidence.
    // A skill can reconcile from multiple raw names (plugin-namespaced) into one row, so
    // merge same-repo entries rather than assuming one iv per repo.
    const bucket = row.perRepo.find((p) => p.repo === iv.repo)
    if (bucket) {
      bucket.sessions += iv.sessions
      bucket.calls += iv.calls
      bucket.errorCalls += iv.errorCalls
      bucket.frictionAdjacent += iv.frictionAdjacent
    } else {
      row.perRepo.push({ repo: iv.repo, sessions: iv.sessions, calls: iv.calls, errorCalls: iv.errorCalls, frictionAdjacent: iv.frictionAdjacent })
    }
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
    // Most-used repo first; the null (unattributed) bucket sinks to the end.
    row.perRepo.sort((a, b) => b.calls - a.calls || (a.repo ?? '￿').localeCompare(b.repo ?? '￿'))
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
    totalActiveRepos: sessionCounts.size,
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

// ---- Skill co-occurrence (the add/compose signal) -------------------------
// Which other skills fire in the same sessions as this one, and how often. A high
// co-occurrence is a candidate to compose into one workflow. Windowed by the time
// filter (a "current usage" fact, unlike drift). Pure SQL. Ordering (A-before-B) is
// reported as a light "leads to" PATTERN, never a dependency claim.

const MAX_COOCCUR = 20

/** One co-occurring skill: how many of THIS skill's sessions it also appears in. */
export interface SkillCoOccurrence {
  name: string
  /** Sessions where both this skill and `name` were invoked (main-thread, in window). */
  sessions: number
  /** Fraction of this skill's sessions that also had `name` (0..1). */
  share: number
  /** Sessions where `name`'s first call preceded this skill's first call — a soft
   *  "tends to precede" pattern, not a dependency. */
  precededSessions: number
}

export interface SkillCoOccurrenceReport {
  name: string
  /** Distinct sessions this skill was invoked in (window) — the share denominator. */
  totalSessions: number
  items: SkillCoOccurrence[]
}

/**
 * Co-occurrence for one skill in the window. We resolve the skill's own invocations
 * (matching plugin-namespaced forms), collect the sessions it ran in, then count the
 * other distinct skills in those same sessions. `precededSessions` compares first-call
 * idx to give a light ordering signal. Main-thread only, matching the roster's counts.
 */
export function skillCoOccurrence(store: Store, name: string, win: SkillHealthWindow = {}): SkillCoOccurrenceReport {
  const { sinceIso, untilIso } = resolveWindow(store, win)
  // Sessions this skill ran in, plus the earliest idx it fired at (for ordering).
  const own = store.queryAll(
    `SELECT t.session_id AS sid, MIN(t.idx) AS firstIdx
     FROM tool_calls t JOIN sessions s ON s.id = t.session_id
     WHERE t.action = 'skill' AND t.is_sidechain = 0
       AND (t.name = ? OR t.name LIKE ?)
       AND s.source = ? AND s.started_at >= ? AND (? IS NULL OR s.started_at < ?)
     GROUP BY t.session_id`,
    name,
    '%:' + name,
    SOURCE,
    sinceIso,
    untilIso ?? null,
    untilIso ?? null,
  ) as Array<{ sid: string; firstIdx: number }>

  const totalSessions = own.length
  if (totalSessions === 0) return { name, totalSessions: 0, items: [] }
  const ownFirst = new Map(own.map((o) => [o.sid, o.firstIdx]))
  const sids = own.map((o) => o.sid)

  // Every skill call in those sessions (so we can bucket the OTHER skills per session).
  const placeholders = sids.map(() => '?').join(',')
  const others = store.queryAll(
    `SELECT t.session_id AS sid, t.name AS name, MIN(t.idx) AS firstIdx
     FROM tool_calls t
     WHERE t.action = 'skill' AND t.is_sidechain = 0 AND t.session_id IN (${placeholders})
     GROUP BY t.session_id, t.name`,
    ...sids,
  ) as Array<{ sid: string; name: string; firstIdx: number }>

  // Fold per other-skill: count co-sessions + how often it preceded this skill.
  const agg = new Map<string, { sessions: number; preceded: number }>()
  for (const o of others) {
    if (skillMatches(name, o.name) || o.name === name) continue // skip self (incl. namespaced)
    // Normalise a plugin-namespaced other-skill to its bare name so it aggregates once.
    const bare = o.name.indexOf(':') >= 0 ? o.name.slice(o.name.indexOf(':') + 1) : o.name
    const cur = agg.get(bare) ?? { sessions: 0, preceded: 0 }
    cur.sessions++
    const mineIdx = ownFirst.get(o.sid)
    if (mineIdx != null && o.firstIdx < mineIdx) cur.preceded++
    agg.set(bare, cur)
  }

  const items: SkillCoOccurrence[] = [...agg.entries()]
    .map(([n, v]) => ({ name: n, sessions: v.sessions, share: v.sessions / totalSessions, precededSessions: v.preceded }))
    .sort((a, b) => b.sessions - a.sessions || b.share - a.share || a.name.localeCompare(b.name))
    .slice(0, MAX_COOCCUR)

  return { name, totalSessions, items }
}

// ---- Skill drift & version comparison (the hero feature) ------------------
// Reconstructs a skill's edit timeline from the append-on-change snapshot history
// and reports usage/error/friction on each side of each edit. Deliberately EDIT-
// anchored, not time-window-scoped: the parent tab's time filter governs the "how
// is it doing lately" widgets, but "did the last change help?" is answered against
// the versions' own lifetimes, so the filter must not clip it.
//
// Honesty guards (see [[correctness-over-coverage]]):
//  - correlation, not causation: we say "changed AFTER the edit", never "the edit
//    caused it". The client frames it that way too.
//  - version history is only as granular as the analyze cadence — edits made between
//    two analyze runs collapse into one boundary. The client shows this caveat.
//  - a before/after delta is only surfaced when BOTH sides clear a small sample
//    guard; otherwise we say "not enough data yet".

/** Minimum invocations on EACH side of an edit before we'll show a before/after delta. */
const MIN_DRIFT_CALLS = 3
/** Cap (days) on each side of the symmetric before/after window. */
const DRIFT_MAX_HALF_DAYS = 30

/** Usage facts for one version's lifetime (or one side of an edit). */
export interface SkillVersionUsage {
  calls: number
  sessions: number
  errorCalls: number
  frictionAdjacent: number
}

/** One captured version of a skill: its body hash + the window it was the live body. */
export interface SkillVersion {
  bodyHash: string
  /** When this version first appeared in a snapshot (captured_at, ISO). */
  startIso: string
  /** When the next version appeared (the edit that ended this one), or null if current. */
  endIso: string | null
  /** True for the newest captured version (still on disk). */
  current: boolean
  /** Usage during THIS version's own full lifetime [startIso, endIso). */
  usage: SkillVersionUsage
  /** Whether this version's lifetime cleared MIN_DRIFT_CALLS (else "not enough data"). */
  enoughData: boolean
}

/** The headline before/after around the most recent edit, on symmetric capped windows. */
export interface SkillDriftDelta {
  /** The edit boundary (the current version's startIso). */
  editIso: string
  /** Half-width actually used for each side (days), after capping. For the label. */
  windowDays: number
  before: SkillVersionUsage
  after: SkillVersionUsage
  /** True when BOTH sides cleared MIN_DRIFT_CALLS — the delta is only shown then. */
  enoughData: boolean
}

export interface SkillDriftReport {
  name: string
  /** All captured versions, oldest→newest. Empty when there's no snapshot history. */
  versions: SkillVersion[]
  /** Before/after around the most recent edit; null when <2 versions. */
  delta: SkillDriftDelta | null
  /** True when only one version was ever captured (never edited in our history). */
  singleVersion: boolean
  /** True when we have no skills-snapshot history for this name at all. */
  noHistory: boolean
}

/** Read a skill entry's body hash from a skills-category snapshot payload. */
function bodyHashOf(payload: unknown, name: string): string | null {
  const skills = (payload as { skills?: unknown } | null)?.skills
  if (!Array.isArray(skills)) return null
  for (const s of skills) {
    const o = s as Record<string, unknown> | null
    if (!o || o.name !== name) continue
    if (typeof o.bodyHash === 'string') return o.bodyHash
    if (typeof o.body === 'string') return o.body // fall back to the body itself as identity
    return '' // present but bodyless — a stable (empty) identity
  }
  return null // the skill isn't in this snapshot
}

/**
 * The skills-category snapshot history that contains `name`, oldest→newest. Prefers
 * the global inventory (where most skills live); falls back to the first project
 * scope whose history mentions the skill. Returns [] when no history mentions it.
 */
function skillSnapshotHistory(store: Store, name: string): Array<{ payload: unknown; capturedAt: string }> {
  const globalHist = store.envSnapshotHistory(SOURCE, 'global', '_global', 'skills')
  if (globalHist.some((r) => bodyHashOf(r.payload, name) !== null)) {
    return globalHist.map((r) => ({ payload: r.payload, capturedAt: r.capturedAt }))
  }
  const projectKeys = (
    store.queryAll(
      `SELECT DISTINCT scope_key FROM environment_snapshots WHERE source = ? AND scope = 'project'`,
      SOURCE,
    ) as Array<{ scope_key: string }>
  ).map((r) => r.scope_key)
  for (const key of projectKeys) {
    const hist = store.envSnapshotHistory(SOURCE, 'project', key, 'skills')
    if (hist.some((r) => bodyHashOf(r.payload, name) !== null)) {
      return hist.map((r) => ({ payload: r.payload, capturedAt: r.capturedAt }))
    }
  }
  return []
}

/** Usage facts for one skill in [sinceIso, untilIso) — reused for versions + delta sides. */
function usageInWindow(store: Store, name: string, sinceIso: string, untilIso: string): SkillVersionUsage {
  const row = store.queryOne(
    `SELECT COUNT(*) AS calls,
            COUNT(DISTINCT t.session_id) AS sessions,
            SUM(CASE WHEN t.is_error = 1 THEN 1 ELSE 0 END) AS errorCalls,
            SUM(CASE WHEN EXISTS (
                  SELECT 1 FROM tool_calls e
                  WHERE e.session_id = t.session_id
                    AND e.idx > t.idx AND e.idx <= t.idx + ?
                    AND e.is_error = 1
                ) THEN 1 ELSE 0 END) AS frictionAdjacent
     FROM tool_calls t JOIN sessions s ON s.id = t.session_id
     WHERE t.action = 'skill' AND t.is_sidechain = 0
       AND (t.name = ? OR t.name LIKE ?)
       AND s.source = ? AND s.started_at >= ? AND s.started_at < ?`,
    FRICTION_LOOKAHEAD,
    name,
    '%:' + name,
    SOURCE,
    sinceIso,
    untilIso,
  ) as { calls: number; sessions: number; errorCalls: number | null; frictionAdjacent: number | null }
  return {
    calls: row?.calls ?? 0,
    sessions: row?.sessions ?? 0,
    errorCalls: row?.errorCalls ?? 0,
    frictionAdjacent: row?.frictionAdjacent ?? 0,
  }
}

/**
 * Build the drift report for one skill: its captured version timeline (each version's
 * usage over its own lifetime) plus a before/after delta around the most recent edit,
 * on symmetric, edit-bounded, capped windows so no window straddles two versions.
 */
export function skillDrift(store: Store, name: string, nowMs: number = Date.now()): SkillDriftReport {
  const hist = skillSnapshotHistory(store, name)
  if (hist.length === 0) return { name, versions: [], delta: null, singleVersion: false, noHistory: true }

  // Collapse consecutive same-hash snapshots into version segments. A run of rows with
  // the same body hash is one version, live from its first capture until the next
  // differing capture (the edit boundary). A→B→A yields three segments (honest: the
  // body was reverted, a distinct period).
  const nowIso = new Date(nowMs).toISOString()
  const segments: Array<{ bodyHash: string; startIso: string }> = []
  for (const row of hist) {
    const h = bodyHashOf(row.payload, name)
    if (h === null) continue // skill absent from this snapshot (installed/removed later) — skip
    const prev = segments[segments.length - 1]
    if (!prev || prev.bodyHash !== h) segments.push({ bodyHash: h, startIso: row.capturedAt })
  }
  if (segments.length === 0) return { name, versions: [], delta: null, singleVersion: false, noHistory: true }

  const versions: SkillVersion[] = segments.map((seg, i) => {
    const next = segments[i + 1]
    const endIso = next ? next.startIso : null
    const usage = usageInWindow(store, name, seg.startIso, endIso ?? nowIso)
    return {
      bodyHash: seg.bodyHash,
      startIso: seg.startIso,
      endIso,
      current: i === segments.length - 1,
      usage,
      enoughData: usage.calls >= MIN_DRIFT_CALLS,
    }
  })

  const singleVersion = segments.length === 1
  let delta: SkillDriftDelta | null = null
  if (segments.length >= 2) {
    // Most recent edit = boundary into the current (last) version.
    const editIso = segments[segments.length - 1]!.startIso
    const prevStartIso = segments[segments.length - 2]!.startIso
    const editMs = Date.parse(editIso)
    const prevLifeMs = editMs - Date.parse(prevStartIso) // how long the previous version was live
    const thisLifeMs = nowMs - editMs // how long the current version has been live
    // Symmetric + capped so a long-lived old version can't drown out a young new one.
    const halfMs = Math.min(prevLifeMs, thisLifeMs, DRIFT_MAX_HALF_DAYS * DAY_MS)
    const beforeSinceIso = new Date(editMs - halfMs).toISOString()
    const afterUntilIso = new Date(editMs + halfMs).toISOString()
    const before = usageInWindow(store, name, beforeSinceIso, editIso)
    const after = usageInWindow(store, name, editIso, afterUntilIso)
    delta = {
      editIso,
      windowDays: Math.max(1, Math.round(halfMs / DAY_MS)),
      before,
      after,
      enoughData: before.calls >= MIN_DRIFT_CALLS && after.calls >= MIN_DRIFT_CALLS,
    }
  }

  return { name, versions, delta, singleVersion, noHistory: false }
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
