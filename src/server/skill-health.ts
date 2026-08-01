/**
 * Skill-health read model: per installed/invoked skill, everything we can say
 * HONESTLY from real sessions — trigger frequency + trend, a used/dead/mis-scoped
 * verdict (reusing the unused-capabilities policy), and the skill's own-call error
 * rate. Plus the installed SKILL.md `description` so the UI can show what each skill is.
 *
 * This is a pure read over the store — analyze WRITES, serve/this only READ
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

const DAY_MS = 86_400_000

// ---- Shared SQL fragments -------------------------------------------------

/** Any skill invocation — main-thread or inside a subagent. Usage facts (counts, trend,
 *  invocation lists, per-repo) count both: skills deliberately wired into subagents are
 *  real usage, and excluding them made subagent-only skills look removable. Outcome facts
 *  need no extra filter — verdicts exist only where the outcomes processor could build an
 *  honest window (main thread + identifiable subagent threads). */
const SKILL_CALL = `t.action = 'skill'`

/**
 * The tool-run timestamp, normalized to UTC `Z`: strftime folds any stored offset to UTC
 * before we compare/min/max, so a future source storing offset timestamps can't produce
 * a wrong window boundary or a used/unused verdict that disagrees with the view. For
 * claude-code every ts is already `Z`, so this is a no-op there and a guard for any adapter
 * that stores an offset. Always used through `t` (join alias) — matches every query here.
 */
const TS_NORM = `strftime('%Y-%m-%dT%H:%M:%SZ', t.ts)`

/** The half-open tool-run window `[since, until)`; `until` NULL → open-ended (presets). Params: since, until, until. */
const IN_WINDOW = `${TS_NORM} >= ? AND (? IS NULL OR ${TS_NORM} < ?)`

/** Match a skill by its installed name OR a plugin-namespaced `<plugin>:<name>`. Params: name, '%:'+name. */
const NAME_MATCH = `(t.name = ? OR t.name LIKE ?)`

/** The bound values for one NAME_MATCH placeholder pair. */
function nameParams(name: string): [string, string] {
  return [name, '%:' + name]
}

/**
 * The real SKILL entries in a `skills`-category snapshot payload — excluding OpenCode's
 * `kind: 'command'` rows. OpenCode folds user slash-commands into the same category; they
 * have no tool-call invocation signal, so treating one as a skill would surface it as a
 * dead/unregistered skill and build a phantom drift timeline for it. `parseInstalledSkills`
 * already drops them for name extraction; every DIRECT payload read here (descriptions,
 * drift body/mtime/version identity) must apply the same filter or the two disagree.
 */
function skillEntries(payload: unknown): Array<Record<string, unknown>> {
  const skills = (payload as { skills?: unknown } | null)?.skills
  if (!Array.isArray(skills)) return []
  const out: Array<Record<string, unknown>> = []
  for (const s of skills) {
    const o = s as Record<string, unknown> | null
    if (o && o.kind !== 'command') out.push(o)
  }
  return out
}

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
  /** Total invocations in the window — main-thread AND subagent firings. */
  calls: number
  /** The subagent (sidechain) share of `calls`. Counted as real usage; judged for
   *  activation outcomes too when the firing's subagent thread is identifiable. */
  subagentCalls: number
  /** Invocations whose own tool call errored. */
  errorCalls: number
  /** Repos it was actually invoked in (excludes the null-repo bucket). */
  usedRepos: string[]
  /**
   * Per-repo usage breakdown — the evidence behind the scope-down flag. One entry per
   * repo the skill was invoked in (plus a `repo: null` bucket for unattributed usage),
   * sorted most-used first. The sum of `calls` equals the row's `calls`. Paired with
   * `report.totalActiveRepos`
   */
  perRepo: Array<{
    repo: string | null
    sessions: number
    calls: number
    errorCalls: number
  }>
  firstUsedAt: string | null
  lastUsedAt: string | null
  /** Per-bucket invocation counts, oldest→newest, aligned 1:1 with report.sparkBuckets. */
  spark: number[]
  /**
   * Usage status — the PRIMARY, mutually-exclusive axis. Window-scoped and factual:
   *  - used: invoked at least once in the window
   *  - unused: installed, never invoked in the window
   */
  status: 'used' | 'unused'
  /**
   * For an UNUSED skill: whether enough sessions were observed in the window to trust
   * the absence (the detector's MIN_SESSIONS gate). true → safe to advise removal;
   * false → "unused here, but too few sessions to say it's truly dead — widen first".
   * Always true for used skills (irrelevant there)
   */
  enoughData: boolean
  /**
   * Refinement flags on a USED skill (orthogonal to status, so a used skill can still
   * carry a hint) — was folded into `verdict`, which starved the "used" count:
   *  - scope-down: global but invoked in only a few repos — candidate to scope down
   *  - not-in-config: invoked but absent from every current config snapshot (a skill
   *    removed/relocated since it ran, or a CLI-bundled skill we can't see on disk)
   *  - often-bypassed: the LLM-judged outcomes say the agent bypassed or reworked its
   *    output in ≥OFTEN_BYPASSED_SHARE of judged firings. Gated on MIN_OUTCOME_JUDGED
   *    judged firings so a 1-of-2 fluke never earns a roster verdict.
   */
  flags: Array<'scope-down' | 'not-in-config' | 'often-bypassed'>
  /** For the 'scope-down' flag: the repos it's actually used in. */
  scopeToRepos?: string[]
  /** LLM-judged outcome counts in the window (absent when nothing was judged). Judged
   *  excludes insufficient-context; bypassed = reworked + ignored — the same definitions
   *  as skillOutcomeStats, so the roster flag and the detail panel always agree. */
  judgedCalls?: number
  bypassedCalls?: number
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
  /**
   * Which harness's skills to report. One report = one source (every denominator — active
   * repos, session counts, the classify session population — is source-scoped, so mixing
   * sources would compute cross-agent nonsense). Absent → `resolveSource` picks the source
   * with the most in-window skill activity, so a single-agent user never sees a chooser.
   */
  source?: string
}

export interface SkillHealthReport {
  /** The harness this report reflects (the resolved source — see resolveSource). */
  source: string
  /** Every source with skill data (invoked or installed), sorted. The client shows a source
   *  chooser only when there's more than one — a single-agent user sees no extra UI. */
  availableSources: string[]
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
  totalOftenBypassed: number
  rows: SkillHealthRow[]
  /** True when no config snapshot has been captured — the installed side is unknown. */
  noConfig: boolean
  /** The shared trend x-axis: each row's `spark` array aligns 1:1 with these calendar
   *  buckets, so the client can label bars + tooltips with real date ranges. */
  sparkBuckets: SparkBucket[]
}

/** Load installed skills (with descriptions) from the current config snapshots. */
function loadInstalledSkills(store: Store, source: string): InstalledSkill[] {
  const out: InstalledSkill[] = []

  const readOne = (scope: 'global' | 'project', scopeKey: string, repo?: string) => {
    const snap = store.envSnapshotCurrent(source, scope, scopeKey, 'skills')
    if (!snap) return
    // parseInstalledSkills gives names; re-read the payload for descriptions so the
    // roster can show what each skill is (payload shape: { skills: [{name, description?}] })
    const names = new Set(parseInstalledSkills(snap.payload))
    const descByName = new Map<string, string>()
    for (const o of skillEntries(snap.payload)) {
      if (typeof o.name === 'string' && typeof o.description === 'string') descByName.set(o.name, o.description)
    }
    for (const name of names) out.push({ name, scope, repo, description: descByName.get(name) })
  }

  readOne('global', '_global')

  const projectKeys = (
    store.queryAll(
      `SELECT DISTINCT scope_key FROM environment_snapshots WHERE source = ? AND scope = 'project'`,
      source,
    ) as Array<{ scope_key: string }>
  ).map((r) => r.scope_key)
  const { byRepo } = mapScopeKeysToRepos(projectKeys)
  for (const [repo, scopeKey] of byRepo) readOne('project', scopeKey, repo)

  return out
}

/** One invoked-skill row with timeline + own-call error facts (in-window; `calls` counts
 *  main-thread AND subagent firings, `subagentCalls` is the subagent share of that). */
interface InvokedDetail {
  name: string
  repo: string | null
  sessions: number
  calls: number
  subagentCalls: number
  errorCalls: number
  firstUsedAt: string | null
  lastUsedAt: string | null
}

/**
 * Per (name, repo) invocation facts (sessions, calls, own-call errors, first/last used).
 *
 * Windowed by the tool-call timestamp `t.ts` (when the skill actually ran), NOT the
 * session's start: a long session that began before the window but invoked the skill inside it still
 * counts, and its calls land in the window they happened in.
 */
function queryInvokedDetail(store: Store, source: string, sinceIso: string, untilIso?: string): InvokedDetail[] {
  return store.queryAll(
    `SELECT t.name AS name,
            s.repo AS repo,
            COUNT(DISTINCT t.session_id) AS sessions,
            COUNT(*) AS calls,
            SUM(t.is_sidechain) AS subagentCalls,
            SUM(CASE WHEN t.is_error = 1 THEN 1 ELSE 0 END) AS errorCalls,
            MIN(${TS_NORM}) AS firstUsedAt,
            MAX(${TS_NORM}) AS lastUsedAt
     FROM tool_calls t JOIN sessions s ON s.id = t.session_id
     WHERE ${SKILL_CALL}
       AND s.source = ? AND ${IN_WINDOW}
     GROUP BY t.name, s.repo`,
    source,
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
function querySpark(store: Store, source: string, sinceIso: string, buckets: SparkBucket[], untilIso?: string): Map<string, number[]> {
  const rows = store.queryAll(
    `SELECT t.name AS name, ${TS_NORM} AS ts
     FROM tool_calls t JOIN sessions s ON s.id = t.session_id
     WHERE ${SKILL_CALL}
       AND s.source = ? AND ${IN_WINDOW} AND t.ts IS NOT NULL`,
    source,
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

/**
 * Distinct-session count per repo in the window — the trust denominator for verdicts.
 * Windowed on `started_at` (a session's own clock), NOT tool-run time: this must match
 * the denominator the shared `classify` policy uses (unused-capabilities' loadSessionCounts
 * counts sessions by started_at too), so the scope/remove verdict divides invocation
 * facts by the same session population the detector does. Invocation FACTS date by t.ts;
 * the session POPULATION dates by started_at — the two clocks are intentional.
 */
function loadSessionCounts(store: Store, source: string, sinceIso: string, untilIso?: string): Map<string, number> {
  const rows = store.queryAll(
    `SELECT repo, COUNT(*) AS n FROM sessions
     WHERE source = ? AND started_at >= ? AND (? IS NULL OR started_at < ?) AND repo IS NOT NULL GROUP BY repo`,
    source,
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
function earliestSessionMs(store: Store, source: string): number | null {
  const row = store.queryOne(
    `SELECT MIN(started_at) AS earliest FROM sessions WHERE source = ?`,
    source,
  ) as { earliest: string | null } | undefined
  const t = row?.earliest ? Date.parse(row.earliest) : NaN
  return Number.isNaN(t) ? null : t
}

/**
 * Every source with skill data — a source that either INVOKED a skill (tool_calls) or has
 * a skills-category snapshot (installed inventory). Sorted alphabetically (a neutral,
 * stable order — no harness is privileged by name). This is what the client offers as the
 * source chooser; one entry → no chooser shown.
 */
function availableSkillSources(store: Store): string[] {
  const rows = store.queryAll(
    `SELECT DISTINCT source FROM (
       SELECT DISTINCT s.source AS source
         FROM tool_calls t JOIN sessions s ON s.id = t.session_id
        WHERE ${SKILL_CALL}
       UNION
       SELECT DISTINCT source FROM environment_snapshots WHERE category = 'skills'
     )`,
  ) as Array<{ source: string }>
  return rows.map((r) => r.source).sort((a, b) => a.localeCompare(b))
}

/**
 * Pick the concrete source a report reflects. An explicit `requested` source wins (when it
 * has data). Otherwise default to the source with the most skill INVOCATIONS across ALL time
 * — the harness the user works in most. Deliberately NOT window-scoped: the default source
 * stays put when the user changes the time filter (a window-scoped default would flip the
 * whole tab as you scrub dates). Deterministic tie-break on equal call counts: source name.
 * Returns '' when NO source has skill data — the report is `noConfig` with an empty roster,
 * so there's no harness to name; we don't invent one (the empty state is the honest signal).
 */
function resolveSource(store: Store, available: string[], requested: string | undefined): string {
  if (requested && available.includes(requested)) return requested
  if (available.length === 0) return ''
  const counts = store.queryAll(
    `SELECT s.source AS source, COUNT(*) AS calls
       FROM tool_calls t JOIN sessions s ON s.id = t.session_id
      WHERE ${SKILL_CALL}
      GROUP BY s.source`,
  ) as Array<{ source: string; calls: number }>
  const bySource = new Map(counts.map((r) => [r.source, r.calls]))
  const ranked = [...available].sort((a, b) => {
    const d = (bySource.get(b) ?? 0) - (bySource.get(a) ?? 0)
    if (d !== 0) return d
    return a.localeCompare(b)
  })
  return ranked[0]!
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
function resolveWindow(store: Store, source: string, win: SkillHealthWindow): ResolvedWindow {
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
    const earliest = earliestSessionMs(store, source)
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
  // One report = one source: resolve it up front and thread it through every read, so all
  // denominators (active repos, session counts, the classify population) stay coherent.
  const availableSources = availableSkillSources(store)
  const source = resolveSource(store, availableSources, win.source)

  const { sinceIso, untilIso, sinceMs, spanMs, windowDays } = resolveWindow(store, source, win)
  const sparkBuckets = buildSparkBuckets(sinceMs, sinceMs + spanMs)

  const installed = loadInstalledSkills(store, source)
  const invokedDetail = queryInvokedDetail(store, source, sinceIso, untilIso)
  const spark = querySpark(store, source, sinceIso, sparkBuckets, untilIso)
  const sessionCounts = loadSessionCounts(store, source, sinceIso, untilIso)

  // Reuse the detector's classify to get remove(=dead)/scope verdicts, skill-side only.
  const installedCaps: InstalledCap[] = installed.map((s) => ({ kind: 'skill', name: s.name, scope: s.scope, repo: s.repo }))
  const invokedCaps = queryInvoked(store, sinceIso, source, untilIso).filter((c) => c.kind === 'skill')
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
  // The raw invoked names that reconcile to each row (a plugin skill invoked as
  // `<plugin>:<name>` folds onto its installed `<name>` row). The sparkline is summed
  // from these AFTER the fold, so a namespaced-only invocation still charts its trend
  // instead of showing a flat baseline (the spark map is keyed by raw name).
  const rawNamesByRow = new Map<string, Set<string>>()
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
        subagentCalls: 0,
        errorCalls: 0,
        usedRepos: [],
        perRepo: [],
        firstUsedAt: null,
        lastUsedAt: null,
        spark: new Array(sparkBuckets.length).fill(0),
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
    // Remember the RAW invoked name so its sparkline (keyed by raw name) folds onto this
    // row below — installed name != invoked name for plugin-namespaced skills.
    let rawNames = rawNamesByRow.get(rowName)
    if (!rawNames) rawNamesByRow.set(rowName, (rawNames = new Set()))
    rawNames.add(iv.name)
    row.sessions += iv.sessions
    row.calls += iv.calls
    row.subagentCalls += iv.subagentCalls
    row.errorCalls += iv.errorCalls
    // Keep the per-repo grain instead of only summing it away — the scope-down evidence.
    // A skill can reconcile from multiple raw names (plugin-namespaced) into one row, so
    // merge same-repo entries rather than assuming one iv per repo.
    const bucket = row.perRepo.find((p) => p.repo === iv.repo)
    if (bucket) {
      bucket.sessions += iv.sessions
      bucket.calls += iv.calls
      bucket.errorCalls += iv.errorCalls
    } else {
      row.perRepo.push({ repo: iv.repo, sessions: iv.sessions, calls: iv.calls, errorCalls: iv.errorCalls })
    }
    if (iv.repo) row.usedRepos.push(iv.repo)
    row.firstUsedAt = minIso(row.firstUsedAt, iv.firstUsedAt)
    row.lastUsedAt = maxIso(row.lastUsedAt, iv.lastUsedAt)
  }

  // Fold each row's sparkline from every raw invoked name that reconciled to it. The spark
  // map is keyed by RAW name, so summing here (after the fold) charts a plugin-namespaced
  // skill's trend on its installed-name row — a namespaced-only skill no longer flatlines.
  // Bucket totals sum across all raw names for the row (dedup is by name, not by call).
  for (const [rowName, rawNames] of rawNamesByRow) {
    const row = rowsByName.get(rowName)
    if (!row) continue
    for (const raw of rawNames) {
      const arr = spark.get(raw)
      if (!arr) continue
      for (let i = 0; i < row.spark.length; i++) row.spark[i]! += arr[i] ?? 0
    }
  }

  // LLM-judged activation outcomes, rolled up once for the whole roster (raw verdict
  // names; reconciled per row below, like the invocation fold).
  const outcomeRollup = queryOutcomeRollup(store, source, sinceIso, untilIso)

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
      // Outcome verdict pill, behind two gates: enough judged firings to trust the rate,
      // and a bypass share at the detail panel's "Often bypassed" threshold.
      let judged = 0
      let bypassed = 0
      for (const [vname, c] of outcomeRollup) {
        if (vname === row.name || skillMatches(row.name, vname)) {
          judged += c.judged
          bypassed += c.bypassed
        }
      }
      if (judged > 0) {
        row.judgedCalls = judged
        row.bypassedCalls = bypassed
        if (judged >= MIN_OUTCOME_JUDGED && bypassed / judged >= OFTEN_BYPASSED_SHARE) row.flags.push('often-bypassed')
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
  const has = (r: SkillHealthRow, f: SkillHealthRow['flags'][number]) => r.flags.indexOf(f) >= 0
  // The "used in N of M repos" denominator. Sessions window by started_at while skill usage
  // windows by tool-run time (two intentional clocks), so a session that STARTED before the
  // window but INVOKED a skill inside it would otherwise land in the numerator (usedRepos)
  // yet be absent from the denominator — yielding N > M. Union the two so M is always a true
  // superset of every repo any row was used in.
  const activeRepos = new Set(sessionCounts.keys())
  for (const iv of invokedDetail) if (iv.repo) activeRepos.add(iv.repo)
  return {
    source,
    availableSources,
    windowDays,
    totalActiveRepos: activeRepos.size,
    totalInstalled: rows.filter((r) => r.installed).length,
    totalUsed: rows.filter((r) => r.status === 'used').length,
    totalUnused: rows.filter((r) => r.status === 'unused').length,
    totalScopeDown: rows.filter((r) => has(r, 'scope-down')).length,
    totalNotInConfig: rows.filter((r) => has(r, 'not-in-config')).length,
    totalOftenBypassed: rows.filter((r) => has(r, 'often-bypassed')).length,
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
  /** True when the firing happened inside a subagent (sidechain) rather than the main thread. */
  sidechain: boolean
}

/** Cap on the invocations list. The page notes the true
 * total from the roster row's `calls`, so we only need the capped page here. */
const MAX_INVOCATIONS = 100

/**
 * Every invocation of one skill in the window, newest first — the list behind the
 * per-skill "Invocations" drill-down. Each row carries session_id + the tool-call idx
 * so the client can open the session drawer scrolled to that exact call (txtool-<idx>).
 * Matches the invoked name exactly OR as a plugin-namespaced `<plugin>:<name>` (same
 * reconciliation as skillMatches), so a namespaced invocation still lists under its skill.
 * Includes subagent firings (flagged `sidechain`), matching the roster's counts.
 * Capped at MAX_INVOCATIONS.
 */
export function skillInvocations(store: Store, name: string, win: SkillHealthWindow = {}): SkillInvocation[] {
  const source = resolveSource(store, availableSkillSources(store), win.source)
  const { sinceIso, untilIso } = resolveWindow(store, source, win)
  const title = `COALESCE((SELECT json_extract(value,'$') FROM annotations WHERE session_id=s.id AND key='title'), NULLIF(s.title, ''), NULLIF(s.first_prompt, ''))`
  const rows = store.queryAll(
    `SELECT t.session_id AS sessionId, ${title} AS title, t.idx AS idx, s.repo AS repo,
            ${TS_NORM} AS ts, t.is_error AS isError, t.is_sidechain AS sidechain
     FROM tool_calls t JOIN sessions s ON s.id = t.session_id
     WHERE ${SKILL_CALL}
       AND ${NAME_MATCH}
       AND s.source = ? AND ${IN_WINDOW}
     ORDER BY ts DESC, t.idx ASC
     LIMIT ?`,
    ...nameParams(name), // exact + plugin-namespaced (<plugin>:<name>)
    source,
    sinceIso,
    untilIso ?? null,
    untilIso ?? null,
    MAX_INVOCATIONS,
  ) as Array<{ sessionId: string; title: string | null; idx: number; repo: string | null; ts: string | null; isError: number; sidechain: number }>

  return rows.map((r) => ({
    sessionId: r.sessionId,
    title: r.title,
    idx: r.idx,
    repo: r.repo,
    ts: r.ts,
    isError: r.isError === 1,
    sidechain: r.sidechain === 1,
  }))
}

// ---- Skill co-occurrence (the add/compose signal) -------------------------
// Which other skills fire in the same sessions as this one, and how often. A high
// co-occurrence is a candidate to compose into one workflow. Windowed by the time
// filter (a "current usage" fact, unlike drift). Pure SQL. Ordering (A-before-B) is
// reported as a light "leads to" PATTERN, never a dependency claim.

const MAX_COOCCUR = 20

/** Max session ids bound into one `IN (...)` — well under SQLite's ~32k parameter cap. */
const ID_CHUNK = 500

/** One co-occurring skill: how many of THIS skill's sessions it also appears in. */
export interface SkillCoOccurrence {
  name: string
  /** Sessions where both this skill and `name` were invoked (in window, incl. subagent firings). */
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
 * idx to give a light ordering signal. Counts subagent firings too, matching the roster.
 */
export function skillCoOccurrence(store: Store, name: string, win: SkillHealthWindow = {}): SkillCoOccurrenceReport {
  const source = resolveSource(store, availableSkillSources(store), win.source)
  const { sinceIso, untilIso } = resolveWindow(store, source, win)
  // Sessions this skill ran in, plus the earliest idx it fired at (for ordering). The
  // OTHER-skills query below is scoped implicitly — it reads only these session ids, which
  // are already this source's — so it needs no source filter of its own.
  const own = store.queryAll(
    `SELECT t.session_id AS sid, MIN(t.idx) AS firstIdx
     FROM tool_calls t JOIN sessions s ON s.id = t.session_id
     WHERE ${SKILL_CALL}
       AND ${NAME_MATCH}
       AND s.source = ? AND ${IN_WINDOW}
     GROUP BY t.session_id`,
    ...nameParams(name),
    source,
    sinceIso,
    untilIso ?? null,
    untilIso ?? null,
  ) as Array<{ sid: string; firstIdx: number }>

  const totalSessions = own.length
  if (totalSessions === 0) return { name, totalSessions: 0, items: [] }
  const ownFirst = new Map(own.map((o) => [o.sid, o.firstIdx]))
  const sids = own.map((o) => o.sid)

  // Every skill call in those sessions (so we can bucket the OTHER skills per session).
  // Chunk the id list: `IN (...)` binds one host parameter per session, and SQLite caps
  // parameters (~32k), so a skill invoked across very many sessions would otherwise throw.
  // Chunking keeps the query exact (no cap on results), just split across statements.
  const others: Array<{ sid: string; name: string; firstIdx: number }> = []
  for (let i = 0; i < sids.length; i += ID_CHUNK) {
    const chunk = sids.slice(i, i + ID_CHUNK)
    const placeholders = chunk.map(() => '?').join(',')
    others.push(
      ...(store.queryAll(
        `SELECT t.session_id AS sid, t.name AS name, MIN(t.idx) AS firstIdx
         FROM tool_calls t
         WHERE ${SKILL_CALL} AND t.session_id IN (${placeholders})
         GROUP BY t.session_id, t.name`,
        ...chunk,
      ) as Array<{ sid: string; name: string; firstIdx: number }>),
    )
  }

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

// ---- Skill activation outcomes (LLM-classified; the honest "did it help") --
// Reads the `skill_outcomes` annotation (written by the skill-outcomes processor):
// per skill firing, whether the agent used / reworked / ignored the output, plus an
// adjacent user-correction flag. Rolled up per skill, windowed like usage. Purely a
// read of already-persisted verdicts (analyze WRITES them; serve READS).

/** Per-skill rollup of the LLM-classified activation outcomes. */
export interface SkillOutcomeStats {
  name: string
  /** Judged firings = the distribution denominator: used + reworked + ignored + unclear.
   *  `insufficient-context` verdicts are NOT judged (our view was too small to tell) and
   *  are excluded from this and every count below — they'd be noise, not signal. */
  classified: number
  /** Followed the skill's output as-is. */
  used: number
  /** Used it but then corrected/redid it (partial bypass). */
  reworked: number
  /** Set the output aside and did the work another way (full bypass). */
  ignored: number
  /** Enough context to see it, but the outcome is genuinely ambiguous. */
  unclear: number
  /** reworked + ignored — the headline "the skill didn't earn its invocation" count. */
  bypassed: number
  /** Firings whose verdict flagged an adjacent user correction. */
  userCorrectionAdjacent: number
  /** Firings we couldn't judge because the captured window was too small — surfaced as an
   *  honest footnote, never mixed into the distribution. */
  insufficientContext: number
  /** One evidence snippet per judged firing (observational), bypass cases first since those
   *  are the actionable ones, then the rest newest-first. Not capped — the UI shows them all.
   *  sessionId + idx locate the firing's tool call so the UI can open the transcript there. */
  examples: Array<{ outcome: string; evidence: string; sessionId: string; idx: number }>
}

/** Minimum judged firings before the roster trusts a bypass rate enough to show a pill —
 *  1 bypassed of 2 judged is 50% noise, not a verdict (same spirit as MIN_DRIFT_CALLS). */
const MIN_OUTCOME_JUDGED = 5
/** Bypassed share (reworked+ignored / judged) at which the roster flags 'often-bypassed' —
 *  the same threshold as the detail panel's "Often bypassed" headline, so the pill in the
 *  list is literally the verdict the click-through shows. */
const OFTEN_BYPASSED_SHARE = 0.5

/**
 * Window-scoped rollup of outcome verdicts for EVERY skill at once (the roster's read;
 * skillOutcomeStats serves the single-skill detail). Same window clock and judged/bypassed
 * definitions as skillOutcomeStats. Keyed by the verdict's RAW skill name — the caller
 * reconciles plugin-namespaced names to roster rows via skillMatches.
 */
function queryOutcomeRollup(store: Store, source: string, sinceIso: string, untilIso?: string): Map<string, { judged: number; bypassed: number }> {
  const rows = store.queryAll(
    `SELECT json_extract(j.value, '$.name') AS vname,
            json_extract(j.value, '$.outcome') AS outcome,
            COUNT(*) AS n
     FROM annotations a
     JOIN sessions s ON s.id = a.session_id
     JOIN json_each(a.value) j
     JOIN tool_calls t ON t.session_id = a.session_id AND t.idx = json_extract(j.value, '$.idx')
     WHERE a.key = 'skill_outcomes'
       AND s.source = ? AND ${IN_WINDOW}
     GROUP BY vname, outcome`,
    source,
    sinceIso,
    untilIso ?? null,
    untilIso ?? null,
  ) as Array<{ vname: string | null; outcome: string | null; n: number }>

  const out = new Map<string, { judged: number; bypassed: number }>()
  for (const r of rows) {
    if (!r.vname || r.outcome === 'insufficient-context') continue // unjudgeable ≠ judged
    const cur = out.get(r.vname) ?? { judged: 0, bypassed: 0 }
    cur.judged += r.n
    if (r.outcome === 'reworked' || r.outcome === 'ignored') cur.bypassed += r.n
    out.set(r.vname, cur)
  }
  return out
}

/**
 * Roll up activation-outcome verdicts for one skill in the window. Each session's
 * `skill_outcomes` annotation is a JSON array of per-firing verdicts (each carrying the
 * raw skill name + the tool-call `idx` it verdicts). We unpack with json_each and join
 * each verdict back to its firing's tool_call so it windows by tool-run time `t.ts` — the
 * same clock as every other invocation-fact read (queryInvokedDetail et al.), not the
 * session start. Reconciles plugin-namespaced names to the roster name via skillMatches.
 *
 * `insufficient-context` verdicts are counted separately (insufficientContext) and kept OUT
 * of the used/reworked/ignored/unclear distribution — they mean our captured window was too
 * small to judge, not that the outcome was ambiguous. Returns null when no JUDGED verdict
 * exists for the skill (a skill with only insufficient-context firings shows nothing).
 */
export function skillOutcomeStats(store: Store, name: string, win: SkillHealthWindow = {}): SkillOutcomeStats | null {
  const source = resolveSource(store, availableSkillSources(store), win.source)
  const { sinceIso, untilIso } = resolveWindow(store, source, win)
  const rows = store.queryAll(
    `SELECT json_extract(j.value, '$.name') AS vname,
            json_extract(j.value, '$.outcome') AS outcome,
            json_extract(j.value, '$.userCorrectionAdjacent') AS correction,
            json_extract(j.value, '$.evidence') AS evidence,
            a.session_id AS sessionId,
            t.idx AS idx
     FROM annotations a
     JOIN sessions s ON s.id = a.session_id
     JOIN json_each(a.value) j
     JOIN tool_calls t ON t.session_id = a.session_id AND t.idx = json_extract(j.value, '$.idx')
     WHERE a.key = 'skill_outcomes'
       AND s.source = ? AND ${IN_WINDOW}
     ORDER BY ${TS_NORM} DESC`,
    source,
    sinceIso,
    untilIso ?? null,
    untilIso ?? null,
  ) as Array<{ vname: string | null; outcome: string | null; correction: number | null; evidence: string | null; sessionId: string; idx: number }>

  const stats: SkillOutcomeStats = {
    name,
    classified: 0,
    used: 0,
    reworked: 0,
    ignored: 0,
    unclear: 0,
    bypassed: 0,
    userCorrectionAdjacent: 0,
    insufficientContext: 0,
    examples: [],
  }
  // Collect bypass examples first (the actionable ones), then fill from the rest.
  const bypassEx: SkillOutcomeStats['examples'] = []
  const otherEx: SkillOutcomeStats['examples'] = []
  for (const r of rows) {
    // Match the verdict's skill name to the requested skill (incl. plugin-namespaced).
    if (!r.vname || !(r.vname === name || skillMatches(name, r.vname))) continue
    if (r.outcome === 'insufficient-context') {
      stats.insufficientContext++
      continue // never a judged verdict — kept out of the distribution
    }
    stats.classified++
    switch (r.outcome) {
      case 'used': stats.used++; break
      case 'reworked': stats.reworked++; break
      case 'ignored': stats.ignored++; break
      default: stats.unclear++; break
    }
    if (r.correction) stats.userCorrectionAdjacent++
    if (r.evidence) {
      const ex = { outcome: r.outcome ?? 'unclear', evidence: r.evidence, sessionId: r.sessionId, idx: r.idx }
      ;(r.outcome === 'reworked' || r.outcome === 'ignored' ? bypassEx : otherEx).push(ex)
    }
  }
  stats.bypassed = stats.reworked + stats.ignored
  stats.examples = [...bypassEx, ...otherEx] // all judged firings, bypass-first
  return stats.classified > 0 ? stats : null
}

// ---- Skill drift & version comparison (the hero feature) ------------------
// Reconstructs a skill's edit timeline from the append-on-change snapshot history. Per version,
// over its OWN full lifetime: what changed (diff vs. prior), usage + per-week traction, error
// rate, LLM-judged bypass rate. Edit-anchored, not window-scoped — rates are per-invocation so
// versions of unequal age stay comparable without clipping to a window. Correlation, not
// causation. A comparison shows only when both versions clear MIN_DRIFT_CALLS.

/** Minimum invocations in a version's lifetime before we trust its rates in a comparison. */
const MIN_DRIFT_CALLS = 3
/** Unchanged context lines to keep around each change; longer runs collapse to a gap marker. */
const DIFF_CONTEXT = 3
/** Above this many lines on either side, skip the O(n·m) LCS and report counts only. */
const DIFF_MAX_LINES = 1500

/** Usage facts for one version's lifetime (or one side of an edit). */
export interface SkillVersionUsage {
  calls: number
  sessions: number
  errorCalls: number
}

/** LLM-judged activation outcomes rolled up over one version's lifetime. Null when the
 *  version has no judged firings (only insufficient-context, or none). */
export interface SkillVersionOutcomes {
  /** Judged firings (used + reworked + ignored + unclear) — the bypass-rate denominator. */
  classified: number
  /** reworked + ignored — the agent set the skill's output aside. */
  bypassed: number
  /** Firings whose verdict flagged an adjacent user correction. */
  userCorrectionAdjacent: number
}

/** One line in a body diff: context (' '), removed ('-'), added ('+'), or a collapsed
 *  run of unchanged context ('@' — `s` holds the "N unchanged lines" label). */
export interface DiffRow {
  t: ' ' | '-' | '+' | '@'
  s: string
}

/** What changed between a version and the one before it. */
export interface SkillVersionChange {
  /** Lines added / removed in the body (vs. the previous version). */
  added: number
  removed: number
  /** The frontmatter `description` was reworded (a behavioral edit — it steers the agent). */
  descChanged: boolean
}

/** One captured version of a skill: its identity + everything we can say over its lifetime. */
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
  /** Invocations per week over this version's lifetime — exposure-fair traction, so a
   *  young version isn't read as "less used" just for being new. */
  callsPerWeek: number
  /** LLM-judged outcomes over this version's lifetime; null when nothing was judged. */
  outcomes: SkillVersionOutcomes | null
  /** What changed vs. the PREVIOUS version (null for the first/oldest version). */
  change: SkillVersionChange | null
  /** Whether this version's lifetime cleared MIN_DRIFT_CALLS (else "not enough data"). */
  enoughData: boolean
}

/**
 * The headline comparison: the current version against the one immediately before it, each
 * over its OWN full lifetime. Rates (error/bypass) are exposure-independent; traction is
 * per-week — so no time window is imposed (every invocation a version had is counted).
 */
export interface SkillDriftDelta {
  /** The edit boundary between the two versions (the current version's startIso). */
  editIso: string
  before: SkillVersionUsage & { outcomes: SkillVersionOutcomes | null; callsPerWeek: number }
  after: SkillVersionUsage & { outcomes: SkillVersionOutcomes | null; callsPerWeek: number }
  /** The full body diff of the most recent edit (previous → current), unchanged runs collapsed. */
  diff: DiffRow[]
  /** Exact added/removed line counts for the edit (from the full diff, so the client shows the
   *  true "+N/−M" without recounting the possibly-collapsed rows). */
  diffAdded: number
  diffRemoved: number
  /** True when the bodies were too large to diff (DIFF_MAX_LINES); counts only. */
  diffSkipped: boolean
  /** The frontmatter description on each side — both steer the agent, so a reword is a
   *  behavioral edit. Shown as its own before/after when it changed (even if the body didn't). */
  descBefore: string
  descAfter: string
  /** True when BOTH versions cleared MIN_DRIFT_CALLS — the rate comparison is shown only then. */
  enoughData: boolean
}

/** One install location a skill's drift can be read from (a chooser entry). */
export interface DriftLocation {
  scope: 'global' | 'project'
  scopeKey: string
  /** Short repo name for a project scope; null for global. */
  repo: string | null
  /** Display label — the repo name, or "Global". */
  label: string
  /** All-time invocations attributable to this location (drives the chooser order). */
  calls: number
  /** Distinct captured versions here — >1 means this location has an edit history worth showing. */
  versionCount: number
}

export interface SkillDriftReport {
  name: string
  /** The repo this timeline reflects (short name), or null for a global-scope skill.
   *  Versions and usage are both scoped to it — the same name in another repo is a
   *  separate timeline, never merged in. */
  repo: string | null
  /** The scopeKey of the resolved location — echoed so the client marks the chosen chooser entry. */
  scopeKey: string | null
  /** Every install location this skill has a version history in (global + per-project), most-used
   *  first. The client shows a chooser when there's more than one. */
  locations: DriftLocation[]
  /** All captured versions, oldest→newest. Empty when there's no snapshot history. */
  versions: SkillVersion[]
  /** Current vs. previous version around the most recent edit; null when <2 versions. */
  delta: SkillDriftDelta | null
  /** True when only one version was ever captured (never edited in our history). */
  singleVersion: boolean
  /** True when we have no skills-snapshot history for this name at all. */
  noHistory: boolean
}

/** Read a skill entry's file mtime (`editedAt`, ISO) from a snapshot payload, or null. */
function editedAtOf(payload: unknown, name: string): string | null {
  const o = skillEntry(payload, name)
  return o && typeof o.editedAt === 'string' ? o.editedAt : null
}

/** Locate the real skill entry named `name` in a skills-category payload (commands excluded), or null. */
function skillEntry(payload: unknown, name: string): Record<string, unknown> | null {
  for (const o of skillEntries(payload)) {
    if (o.name === name) return o
  }
  return null
}

/** A skill entry's body hash (the display identity for a version), or null if absent. */
function bodyHashOf(payload: unknown, name: string): string | null {
  const o = skillEntry(payload, name)
  if (!o) return null // the skill isn't in this snapshot
  if (typeof o.bodyHash === 'string') return o.bodyHash
  if (typeof o.body === 'string') return o.body // fall back to the body itself as identity
  return '' // present but bodyless — a stable (empty) identity
}

/** A skill entry's raw body text (for diffing versions), or '' when absent/bodyless. */
function bodyOf(payload: unknown, name: string): string {
  const o = skillEntry(payload, name)
  return o && typeof o.body === 'string' ? o.body : ''
}

/** A skill entry's frontmatter description (for the reworded-description signal), or ''. */
function descOf(payload: unknown, name: string): string {
  const o = skillEntry(payload, name)
  return o && typeof o.description === 'string' ? o.description : ''
}

/**
 * A skill entry's VERSION identity for drift segmentation: the body PLUS the frontmatter
 * `description` — both steer the agent, so a reworded description is a behavioral edit and
 * starts a new version. Pure-metadata churn (version:, tags, author, models) is deliberately
 * excluded — a version-string bump is not a behavior change. Distinct from bodyHashOf, which
 * is the display hash. Null when the skill is absent from this snapshot.
 */
function versionIdOf(payload: unknown, name: string): string | null {
  const body = bodyHashOf(payload, name)
  if (body === null) return null
  const o = skillEntry(payload, name)
  const desc = o && typeof o.description === 'string' ? o.description : ''
  return desc ? `${body} ${desc}` : body
}

/**
 * Line-level diff (LCS backtrace) of two skill bodies → rows tagged ' ' (context), '-', '+', or
 * '@' (a collapsed run of unchanged context), plus exact added/removed counts. O(n·m) is fine for
 * a SKILL.md; a DIFF_MAX_LINES guard skips the matrix for a pathological body (`skipped`, counts
 * only). No row cap — collapsing keeps it compact and the client renders the whole diff.
 */
function diffBody(prev: string, next: string): { rows: DiffRow[]; added: number; removed: number; skipped: boolean } {
  const A = prev ? prev.split('\n') : []
  const B = next ? next.split('\n') : []
  const n = A.length
  const m = B.length
  if (n > DIFF_MAX_LINES || m > DIFF_MAX_LINES) {
    // Too large to LCS cheaply — report a coarse count (symmetric diff of line multisets
    // would still be O(n), but a plain size delta is honest enough for the "too big" case).
    return { rows: [], added: Math.max(0, m - n), removed: Math.max(0, n - m), skipped: true }
  }
  const dp: number[][] = []
  for (let i = 0; i <= n; i++) dp.push(new Array(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = A[i] === B[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!)
    }
  }
  // Full raw diff first (context + changes), then collapse long unchanged runs below.
  const raw: DiffRow[] = []
  let added = 0
  let removed = 0
  let i = 0
  let j = 0
  const emit = (t: DiffRow['t'], s: string) => {
    if (t === '+') added++
    else if (t === '-') removed++
    raw.push({ t, s })
  }
  while (i < n && j < m) {
    if (A[i] === B[j]) { emit(' ', A[i]!); i++; j++ }
    else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) { emit('-', A[i]!); i++ }
    else { emit('+', B[j]!); j++ }
  }
  while (i < n) { emit('-', A[i]!); i++ }
  while (j < m) { emit('+', B[j]!); j++ }

  // Collapse unchanged context: keep DIFF_CONTEXT lines adjacent to any change, replace a
  // longer interior run with a single '@' gap marker ("N unchanged lines") — git-style, so
  // the actual edits aren't buried under a wall of untouched body. A change line = +/-.
  const keep = new Array(raw.length).fill(false)
  for (let k = 0; k < raw.length; k++) {
    if (raw[k]!.t === '+' || raw[k]!.t === '-') {
      for (let d = -DIFF_CONTEXT; d <= DIFF_CONTEXT; d++) {
        const idx = k + d
        if (idx >= 0 && idx < raw.length) keep[idx] = true
      }
    }
  }
  const collapsed: DiffRow[] = []
  for (let k = 0; k < raw.length; ) {
    if (keep[k]) { collapsed.push(raw[k]!); k++; continue }
    let run = k
    while (run < raw.length && !keep[run]) run++
    const gap = run - k
    if (gap > 0) collapsed.push({ t: '@', s: gap + ' unchanged line' + (gap === 1 ? '' : 's') })
    k = run
  }

  // No row cap: a skill body is small (a SKILL.md), and context-collapsing already keeps the
  // diff compact by summarising unchanged runs — so we send the whole thing, exact counts and
  // all, rather than truncating and forcing the client to guess at "+N/−M".
  return { rows: collapsed, added, removed, skipped: false }
}

/** One version segment: its identity, display hash, start boundary, and the body+desc snapshotted. */
interface Segment {
  versionId: string
  bodyHash: string
  startIso: string
  body: string
  desc: string
}

/**
 * Collapse a scope's snapshot history into version segments — a run of same-identity snapshots is
 * one version (A→B→A → three honest segments). Boundary time prefers the file mtime (`editedAt`),
 * clamped to (prev boundary, capture] so an implausible mtime falls back to capture time.
 */
function buildSegments(hist: ReturnType<Store['envSnapshotHistory']>, name: string): Segment[] {
  const segments: Segment[] = []
  for (const row of hist) {
    const id = versionIdOf(row.payload, name)
    if (id === null) continue // skill absent from this snapshot (installed/removed later) — skip
    const prev = segments[segments.length - 1]
    if (prev && prev.versionId === id) continue // same version, still live
    const capturedIso = row.capturedAt
    const edited = editedAtOf(row.payload, name)
    const lowerExclusive = prev?.startIso // must be strictly after the previous boundary
    const startIso =
      edited && edited <= capturedIso && (!lowerExclusive || edited > lowerExclusive) ? edited : capturedIso
    segments.push({ versionId: id, bodyHash: bodyHashOf(row.payload, name) ?? '', startIso, body: bodyOf(row.payload, name), desc: descOf(row.payload, name) })
  }
  return segments
}

/**
 * Every install location a skill has a version history in — the global scope (one shared body)
 * plus each project repo that installed it. Drift is per-(skill, location), never merged. Each
 * carries its all-time calls + version count, so the caller defaults to the busiest with history
 * and the client orders + labels the chooser. Also returns the project repos, so skillDrift can
 * scope Global's usage by the same exclude-set. Empty when no snapshot mentions the skill.
 */
/**
 * Which invocations attribute to a location. Project-first: a project install owns calls in its
 * own repo; Global owns everything else (a call in a repo with its own install is served by that
 * install, not the global one — never double-counted). `repo` is the sessions.repo basename.
 */
type RepoScope = { kind: 'repo'; repo: string } | { kind: 'global'; excludeRepos: string[] }

/** SQL predicate (+ params) selecting the sessions a RepoScope owns. */
function repoClause(scope: RepoScope): { sql: string; params: string[] } {
  if (scope.kind === 'repo') return { sql: 's.repo = ?', params: [scope.repo] }
  if (scope.excludeRepos.length === 0) return { sql: '1 = 1', params: [] } // pure global: all calls
  const placeholders = scope.excludeRepos.map(() => '?').join(',')
  return { sql: `(s.repo IS NULL OR s.repo NOT IN (${placeholders}))`, params: scope.excludeRepos }
}

function driftLocations(store: Store, source: string, name: string): { locations: DriftLocation[]; installedRepos: string[] } {
  const hasName = (scope: 'global' | 'project', scopeKey: string): boolean =>
    store.envSnapshotHistory(source, scope, scopeKey, 'skills').some((r) => bodyHashOf(r.payload, name) !== null)
  const countVersions = (scope: 'global' | 'project', scopeKey: string): number =>
    buildSegments(store.envSnapshotHistory(source, scope, scopeKey, 'skills'), name).length
  const callsIn = (scope: RepoScope): number => {
    const c = repoClause(scope)
    const row = store.queryOne(
      `SELECT COUNT(*) AS calls FROM tool_calls t JOIN sessions s ON s.id = t.session_id
        WHERE ${SKILL_CALL} AND ${NAME_MATCH} AND s.source = ? AND ${c.sql}`,
      ...nameParams(name),
      source,
      ...c.params,
    ) as { calls: number } | undefined
    return row?.calls ?? 0
  }

  // Project installs, by repo basename. mapScopeKeysToRepos flags basenames backed by >1 path as
  // ambiguous — sessions.repo is only the basename, so their usage can't be split → skip them.
  const projectKeys = (
    store.queryAll(
      `SELECT DISTINCT scope_key FROM environment_snapshots WHERE source = ? AND scope = 'project'`,
      source,
    ) as Array<{ scope_key: string }>
  ).map((r) => r.scope_key)
  const { ambiguous } = mapScopeKeysToRepos(projectKeys)
  const projectInstalls = projectKeys
    .filter((k) => !ambiguous.has(basename(k)) && hasName('project', k))
    .map((scopeKey) => ({ scopeKey, repo: basename(scopeKey) }))
  const installedRepos = projectInstalls.map((p) => p.repo)

  const out: DriftLocation[] = []
  // Global: project-first, so it owns only calls NOT in a project-installed repo.
  if (hasName('global', '_global')) {
    out.push({ scope: 'global', scopeKey: '_global', repo: null, label: 'Global', calls: callsIn({ kind: 'global', excludeRepos: installedRepos }), versionCount: countVersions('global', '_global') })
  }
  for (const { scopeKey, repo } of projectInstalls) {
    out.push({ scope: 'project', scopeKey, repo, label: repo, calls: callsIn({ kind: 'repo', repo }), versionCount: countVersions('project', scopeKey) })
  }
  // Most-used first; ties broken by label for a stable order.
  out.sort((a, b) => b.calls - a.calls || a.label.localeCompare(b.label))
  return { locations: out, installedRepos }
}

/** The RepoScope that owns a location's calls — the same attribution driftLocations counted with. */
function scopeForLocation(loc: DriftLocation, installedRepos: string[]): RepoScope {
  return loc.repo ? { kind: 'repo', repo: loc.repo } : { kind: 'global', excludeRepos: installedRepos }
}

/**
 * Pick the ONE location a drift report reflects: an explicit `requestedScopeKey` wins, else the
 * busiest location WITH an edit history (versionCount > 1) — so a skill edited in a quieter repo
 * isn't hidden behind a busier single-version install. Falls back to busiest overall, then null.
 */
function pickDriftLocation(locations: DriftLocation[], requestedScopeKey?: string): DriftLocation | null {
  if (requestedScopeKey) {
    const found = locations.find((l) => l.scopeKey === requestedScopeKey)
    if (found) return found
  }
  // locations is sorted most-used first; prefer the first with real history.
  return locations.find((l) => l.versionCount > 1) ?? locations[0] ?? null
}

/** Usage facts for one skill in [sinceIso, untilIso), scoped to the location that owns the calls
 *  (a project repo, or Global = everything not in a project-installed repo). */
function usageInWindow(store: Store, source: string, name: string, sinceIso: string, untilIso: string, scope: RepoScope): SkillVersionUsage {
  const c = repoClause(scope)
  const row = store.queryOne(
    `SELECT COUNT(*) AS calls,
            COUNT(DISTINCT t.session_id) AS sessions,
            SUM(CASE WHEN t.is_error = 1 THEN 1 ELSE 0 END) AS errorCalls
     FROM tool_calls t JOIN sessions s ON s.id = t.session_id
     WHERE ${SKILL_CALL}
       AND ${NAME_MATCH}
       AND s.source = ? AND ${c.sql} AND ${TS_NORM} >= ? AND ${TS_NORM} < ?`,
    ...nameParams(name),
    source,
    ...c.params,
    sinceIso,
    untilIso,
  ) as { calls: number; sessions: number; errorCalls: number | null }
  return {
    calls: row?.calls ?? 0,
    sessions: row?.sessions ?? 0,
    errorCalls: row?.errorCalls ?? 0,
  }
}

/**
 * LLM-judged activation outcomes for one skill in [sinceIso, untilIso), scoped to the same
 * RepoScope as usageInWindow. Joins each verdict to its tool_call to window by tool-run
 * time; the judged population is whatever the outcomes processor produced verdicts for
 * (main-thread + identifiable subagent firings), so no sidechain filter is applied here.
 * `insufficient-context` is excluded (not judged); null when nothing was judged (no fake 0%).
 */
function outcomesInWindow(store: Store, source: string, name: string, sinceIso: string, untilIso: string, scope: RepoScope): SkillVersionOutcomes | null {
  const c = repoClause(scope)
  const rows = store.queryAll(
    `SELECT json_extract(j.value, '$.name') AS vname,
            json_extract(j.value, '$.outcome') AS outcome,
            json_extract(j.value, '$.userCorrectionAdjacent') AS correction
     FROM annotations a
     JOIN sessions s ON s.id = a.session_id
     JOIN json_each(a.value) j
     JOIN tool_calls t ON t.session_id = a.session_id AND t.idx = json_extract(j.value, '$.idx')
     WHERE a.key = 'skill_outcomes'
       AND ${SKILL_CALL}
       AND s.source = ? AND ${c.sql}
       AND ${TS_NORM} >= ? AND ${TS_NORM} < ?`,
    source,
    ...c.params,
    sinceIso,
    untilIso,
  ) as Array<{ vname: string | null; outcome: string | null; correction: number | null }>

  let classified = 0
  let bypassed = 0
  let userCorrectionAdjacent = 0
  for (const r of rows) {
    if (!r.vname || !(r.vname === name || skillMatches(name, r.vname))) continue
    if (r.outcome === 'insufficient-context') continue // not judged
    classified++
    if (r.outcome === 'reworked' || r.outcome === 'ignored') bypassed++
    if (r.correction) userCorrectionAdjacent++
  }
  return classified > 0 ? { classified, bypassed, userCorrectionAdjacent } : null
}

/** Invocations normalized to a per-week rate over [startMs, endMs) — exposure-fair traction. */
function callsPerWeek(calls: number, startMs: number, endMs: number): number {
  const weeks = Math.max(endMs - startMs, DAY_MS) / (7 * DAY_MS)
  return calls / weeks
}

/** Build the drift report for one skill: its version timeline plus a current-vs-previous
 *  comparison around the most recent edit. See the section header above for the model.
 *  `scopeKey` picks which install location to read (from the chooser); default = busiest. */
export function skillDrift(store: Store, name: string, opts: { nowMs?: number; source?: string; scopeKey?: string } = {}): SkillDriftReport {
  const nowMs = opts.nowMs ?? Date.now()
  // Drift is edit-anchored, not windowed. An explicit source (from the roster's resolved
  // choice) wins; else default to the source with the most skill activity (resolveSource is
  // all-time by design, which is exactly right here).
  const source = resolveSource(store, availableSkillSources(store), opts.source)
  // Offer every location; read the ONE the caller chose (else busiest) — versions and usage both
  // come from it, so same-named installs never merge into a phantom cross-repo history.
  const { locations, installedRepos } = driftLocations(store, source, name)
  const loc = pickDriftLocation(locations, opts.scopeKey)
  if (!loc) return { name, repo: null, scopeKey: null, locations, versions: [], delta: null, singleVersion: false, noHistory: true }
  const hist = store.envSnapshotHistory(source, loc.scope, loc.scopeKey, 'skills')
  if (hist.length === 0) return { name, repo: loc.repo, scopeKey: loc.scopeKey, locations, versions: [], delta: null, singleVersion: false, noHistory: true }

  // Scope usage the same way the location's call count was — so timeline numbers match the chooser.
  const usageScope = scopeForLocation(loc, installedRepos)
  const nowIso = new Date(nowMs).toISOString()
  const segments = buildSegments(hist, name)
  if (segments.length === 0) return { name, repo: loc.repo, scopeKey: loc.scopeKey, locations, versions: [], delta: null, singleVersion: false, noHistory: true }

  const versions: SkillVersion[] = segments.map((seg, i) => {
    const next = segments[i + 1]
    const endIso = next ? next.startIso : null
    const usage = usageInWindow(store, source, name, seg.startIso, endIso ?? nowIso, usageScope)
    const outcomes = outcomesInWindow(store, source, name, seg.startIso, endIso ?? nowIso, usageScope)
    const prevSeg = segments[i - 1]
    const change: SkillVersionChange | null = prevSeg
      ? (() => {
          const d = diffBody(prevSeg.body, seg.body)
          return { added: d.added, removed: d.removed, descChanged: prevSeg.desc !== seg.desc }
        })()
      : null
    return {
      bodyHash: seg.bodyHash,
      startIso: seg.startIso,
      endIso,
      current: i === segments.length - 1,
      usage,
      callsPerWeek: callsPerWeek(usage.calls, Date.parse(seg.startIso), endIso ? Date.parse(endIso) : nowMs),
      outcomes,
      change,
      enoughData: usage.calls >= MIN_DRIFT_CALLS,
    }
  })

  const singleVersion = segments.length === 1
  let delta: SkillDriftDelta | null = null
  if (segments.length >= 2) {
    // Current vs. previous version, each over its OWN full lifetime — no window. Rates make
    // them comparable despite unequal age; the diff shows exactly what the last edit changed.
    const prevV = versions[versions.length - 2]!
    const curV = versions[versions.length - 1]!
    const prevSeg = segments[segments.length - 2]!
    const curSeg = segments[segments.length - 1]!
    const d = diffBody(prevSeg.body, curSeg.body)
    delta = {
      editIso: curSeg.startIso,
      before: { ...prevV.usage, outcomes: prevV.outcomes, callsPerWeek: prevV.callsPerWeek },
      after: { ...curV.usage, outcomes: curV.outcomes, callsPerWeek: curV.callsPerWeek },
      diff: d.rows,
      diffAdded: d.added,
      diffRemoved: d.removed,
      diffSkipped: d.skipped,
      descBefore: prevSeg.desc,
      descAfter: curSeg.desc,
      enoughData: prevV.usage.calls >= MIN_DRIFT_CALLS && curV.usage.calls >= MIN_DRIFT_CALLS,
    }
  }

  return { name, repo: loc.repo, scopeKey: loc.scopeKey, locations, versions, delta, singleVersion, noHistory: false }
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
