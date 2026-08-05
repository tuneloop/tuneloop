/**
 * The shared time machinery behind the health read models (skills, tools): one
 * definition of the clock, one calendar x-axis, one window resolver.
 *
 * These live apart from any one tab because two tabs charting the same sessions
 * on different clocks is exactly the failure the tools tab was built to end (the
 * old Ops charts bucketed by `sessions.started_at` while skill health used
 * tool-run time, so the same week showed two different error rates). Anything
 * reporting per-entity usage over time imports from here rather than restating it.
 *
 * Pure reads over the store — analyze WRITES, serve/this only READ.
 */
import type { Store } from '../store/store'
import { WINDOW_DAYS } from '../detectors/unused-capabilities'

export const DAY_MS = 86_400_000

/**
 * The tool-run timestamp, normalized to UTC `Z`: strftime folds any stored offset to UTC
 * before we compare/min/max, so a future source storing offset timestamps can't produce
 * a wrong window boundary or a used/unused verdict that disagrees with the view. For
 * claude-code every ts is already `Z`, so this is a no-op there and a guard for any adapter
 * that stores an offset. Always used through `t` (the tool_calls join alias).
 */
export const TS_NORM = `strftime('%Y-%m-%dT%H:%M:%SZ', t.ts)`

/** The half-open tool-run window `[since, until)`; `until` NULL → open-ended (presets). Params: since, until, until. */
export const IN_WINDOW = `${TS_NORM} >= ? AND (? IS NULL OR ${TS_NORM} < ?)`

/** The UTC calendar day a tool call ran on — the atomic bucket every trend folds up from. */
export const TS_DAY = `strftime('%Y-%m-%d', t.ts)`

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
export function buildSparkBuckets(sinceMs: number, untilMs: number): SparkBucket[] {
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

/**
 * The bucket index containing `ms`, or -1 when it falls before the first bucket.
 * Every bucket boundary is day-aligned, so a whole UTC day always lands in one
 * bucket — which is why per-day SQL aggregates can be folded up here without
 * re-reading individual calls.
 */
export function bucketIndex(buckets: SparkBucket[], ms: number): number {
  for (let i = buckets.length - 1; i >= 0; i--) {
    if (ms >= buckets[i]!.startMs) return i
  }
  return -1
}

/**
 * The time window a report was computed over. A custom `from`/`to` range (ISO)
 * takes precedence; otherwise `days` (null = all-time; default 30) applies.
 */
export interface HealthWindow {
  /** Preset length in days, or null for all-time. Default 30. Ignored when from/to set. */
  days?: number | null
  /** Custom range lower bound (ISO). When set (with `to`), overrides `days`. */
  from?: string
  /** Custom range upper bound (ISO). When set (with `from`), overrides `days`. */
  to?: string
  /** Evaluation "now" (ms). Defaults to Date.now(). */
  nowMs?: number
  /**
   * Which harness to report. One report = one source (every denominator is
   * source-scoped, so mixing sources would compute cross-agent nonsense). Absent →
   * the read model picks the source with the most activity.
   */
  source?: string
}

export interface ResolvedWindow {
  sinceIso: string
  /** Upper bound (ISO), or undefined for an open range (presets/all-time). */
  untilIso?: string
  sinceMs: number
  spanMs: number
  /** null = all-time; -1 = a custom range (UI shows the dates, not "N days"). */
  windowDays: number | null
}

/**
 * The earliest session start for this source, as ms — the natural lower bound for
 * the all-time window's sparkline span. Null when there are no sessions.
 */
export function earliestSessionMs(store: Store, source: string): number | null {
  const row = store.queryOne(`SELECT MIN(started_at) AS earliest FROM sessions WHERE source = ?`, source) as
    | { earliest: string | null }
    | undefined
  const t = row?.earliest ? Date.parse(row.earliest) : NaN
  return Number.isNaN(t) ? null : t
}

/**
 * Distinct-session count per repo in the window — the trust denominator every
 * used/unused verdict divides by. Windowed on `started_at` (a session's own clock),
 * NOT tool-run time: this must match the population the shared `classify` policy
 * uses in unused-capabilities, so a health tab and the Recommendations tab can't
 * reach different verdicts from the same data. Invocation FACTS date by `t.ts`; the
 * session POPULATION dates by `started_at` — the two clocks are intentional.
 */
export function sessionCountsByRepo(store: Store, source: string, sinceIso: string, untilIso?: string): Map<string, number> {
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
 * Resolve a requested window into the concrete bounds the queries need: the ISO
 * lower bound (`sinceIso`), an optional upper bound (`untilIso`, set only for a custom
 * range), the sparkline span (`spanMs`) and its start (`sinceMs`), and the `windowDays`
 * echoed to the client. A custom from/to range wins; else `days` (null = all-time). For
 * all-time we anchor the span at the earliest session (falling back to WINDOW_DAYS when
 * the store is empty) so the sparkline still covers the real data range.
 */
export function resolveWindow(store: Store, source: string, win: HealthWindow): ResolvedWindow {
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
    const sinceMs = earliest ?? nowMs - WINDOW_DAYS * DAY_MS
    // Guard against a zero/negative span if the only session is "now".
    const spanMs = Math.max(nowMs - sinceMs, DAY_MS)
    return { sinceIso: new Date(sinceMs).toISOString(), sinceMs, spanMs, windowDays: null }
  }
  const days = win.days && win.days > 0 ? win.days : WINDOW_DAYS
  const spanMs = days * DAY_MS
  const sinceMs = nowMs - spanMs
  return { sinceIso: new Date(sinceMs).toISOString(), sinceMs, spanMs, windowDays: days }
}
