import { registerDetector } from '../../core/registry'
import { addUsage, emptyUsage, type Session, type TokenUsage } from '../../core/model'
import { insightId } from '../../core/detector'
import { arrayField } from '../../llm/json'
import { costOfUsage } from '../../pricing/pricing'
import { collectFollowups } from './followups'
import { DETECTOR, clampLabel, themeId as makeThemeId } from './ids'
import { buildPrompt, extractionSchema, REMEDIES, TOOL_NAME, TRIGGERS, TYPES } from './prompt'
import { runThemeMerge } from './merge'
import { ensureThemeFix, type FixOccurrence } from './fix'
import { maybeSummarizeFollowups } from './summarize'
import type { Detector, DetectorContext, DetectorResult, InsightInput } from '../../core/detector'
import type { ThemeEventInput, ThemeInput, ThemeRef, ThemeRemedy, ThemeTrigger } from '../../store/types'

const MAX_TURNS_GATE = 0 // pre-gate: a session needs > this many substantive follow-ups (steered) to extract

// Step-2 bar unit is an extraction WINDOW (= one LLM call), not a session, since
// windows are homogeneous work. Plus one reserved unit for the cross-session tail
// (reconcile + fix gen): its size isn't knowable up front, so we accept a small end-bump.
const FINALIZE_WEIGHT = 1

// A theme surfaces once it recurs enough: across sessions (>= MIN_EVENTS over
// >= MIN_SESSIONS) OR intensely within one (>= STRONG_SINGLE_SESSION_EVENTS).
const MIN_EVENTS = 3
const MIN_SESSIONS = 2
const STRONG_SINGLE_SESSION_EVENTS = 5
// Severity by total event count — recurrence scale, not dollars.
const SEVERITY_EVENTS = { high: 8, medium: 4 }

/**
 * The hero detector (T19): mine recurring FRICTION themes across sessions and
 * surface each as an insight with a generated fix-prompt once it recurs.
 *
 * Reactive friction only — moments the user had to compensate for the agent
 * (corrections, re-supplied context, workarounds, in-session rework). Latent
 * inefficiency (dormant tooling, model mismatch, compaction) is the job of the
 * S/P-tier detectors, not this one.
 *
 * Flow: pre-gate to steered sessions in the delta → one extraction call per session
 * → one taxonomy-reconcile call (merge duplicate themes + re-home orphan events) →
 * surface themes past the recurrence threshold. Themes persist in their own tables so
 * they outlive their insights (a resolved theme can reopen on recurrence).
 *
 * Extraction runs SEQUENTIALLY, not concurrently: parallel sessions read a stale theme
 * list and coin near-duplicate labels for the same gap. One at a time, each session
 * matches its predecessors' freshly-minted themes — far less fragmentation at the source.
 */
export const recurringThemes: Detector = {
  name: DETECTOR,
  // v2: theme_events now record each occurrence's message timestamp (occurred_at),
  // so first/last-seen reflect real friction moments
  version: 2,
  tier: 'X',
  needsLlm: true,
  async run(ctx: DetectorContext): Promise<DetectorResult> {
    const { store, llm, log } = ctx
    if (!llm) return { insights: [] }

    // 1. Pre-gate: only steered sessions in the delta. A session is steered when
    // the steering processor recorded followup_count > gate. Unchanged/unsteered
    // sessions cost nothing (no hydrate, no LLM call).
    const delta = ctx.unseenSessions()
    const steered = steeredIds(store)
    const candidates = delta
      .filter((d) => steered.has(d.sessionId))
      .map((d) => ({ ...d, windows: windowsFor(steered.get(d.sessionId)!) }))
    log.debug(`${DETECTOR}: ${delta.length} in delta, ${candidates.length} steered → extracting`)
    // Declare the step-2 delta weighted by windows (+ the finalize unit) so total is
    // known up front and the bar never regresses.
    const declaredWindows = candidates.reduce((n, c) => n + c.windows, 0)
    ctx.progress?.addUnits(declaredWindows + FINALIZE_WEIGHT)

    let usage = emptyUsage()
    const processed: Array<{ sessionId: string; contentHash: string }> = []

    // 2. Per-session extraction (sequential — see class doc). Each reads the LIVE theme
    // list, persists its own themes+events immediately (a mid-run failure keeps prior
    // work), and on success is recorded as processed. The bar ticks once per window;
    // a declared window that doesn't run (empty session, or a failure) is padded with a
    // cost-0 tick so the declared total still resolves to 100%.
    for (const cand of candidates) {
      const padRemaining = (ran: number) => {
        for (let i = ran; i < cand.windows; i++) ctx.progress?.unitDone(0)
      }

      const session = ctx.loadSession(cand.sessionId)
      if (!session) {
        padRemaining(0)
        continue
      }
      const followups = collectFollowups(session)
      if (followups.length === 0) {
        // Steered by count but no substantive follow-ups survive filtering —
        // nothing to extract, but it IS processed (don't re-hydrate next run).
        padRemaining(0)
        processed.push(cand)
        continue
      }

      const repo = session.project.repo ?? null
      const visible = store.listThemes(repo)
      const res = await extractSession(session, followups, repo, visible, llm!, log, (u) =>
        ctx.progress?.unitDone(costOfUsage(llm.provider, llm.model, u)),
      )
      usage = addUsage(usage, res.usage)
      padRemaining(res.windowsRun)
      if (res.failed) continue // a window failed → leave unprocessed (retried next analyze)

      store.persistThemeExtraction(cand.sessionId, res.themes, res.events)
      processed.push(cand)
    }

    // 3 + 4: the cross-session tail (the reserved finalize unit) — reconcile the taxonomy,
    // then surface themes past the threshold with an LLM fix. Both hash-gated (no-op when
    // unchanged). Spend rides the finalize unit's unitDone so it feeds est-total like any unit.
    const merge = await runThemeMerge(store, llm, log)
    usage = addUsage(usage, merge.usage)
    const surfaced = await surfaceInsights(store, llm, log)
    usage = addUsage(usage, surfaced.usage)
    const tailUsage = addUsage(merge.usage, surfaced.usage)
    ctx.progress?.unitDone(costOfUsage(llm.provider, llm.model, tailUsage))

    const cost = { inTokens: usage.input, outTokens: usage.output, usd: costOfUsage(llm.provider, llm.model, usage), model: llm.model }
    return { insights: surfaced.insights, cost, seen: processed }
  },
}

registerDetector(recurringThemes)

// ---- pre-gate ---------------------------------------------------------------

/**
 * Steered sessions (followup_count > gate) → their follow-up count. That count is the
 * same tally collectFollowups() produces, so ceil(count/WINDOW) exactly pre-counts the
 * extraction windows — used to weight the step-2 bar without hydrating.
 */
function steeredIds(store: DetectorContext['store']): Map<string, number> {
  const rows = store.queryAll(
    `SELECT session_id AS sessionId, CAST(json_extract(value,'$') AS INTEGER) AS count FROM annotations
     WHERE key = 'followup_count' AND CAST(json_extract(value,'$') AS INTEGER) > ?`,
    MAX_TURNS_GATE,
  ) as Array<{ sessionId: string; count: number }>
  return new Map(rows.map((r) => [r.sessionId, r.count]))
}

/** Extraction windows a session will run — one LLM call each (see WINDOW). */
function windowsFor(followupCount: number): number {
  return Math.max(1, Math.ceil(followupCount / WINDOW))
}

// ---- windowed extraction ----------------------------------------------------

// Follow-ups per extraction call. One call over a whole large session is unstable
// (intermittently returns 0 events); bounded windows keep each ask stable and the
// union is the session's events.
const WINDOW = 30

interface Extracted {
  themes: ThemeInput[]
  events: ThemeEventInput[]
  usage: TokenUsage
  failed: boolean
  /** Windows actually run (incl. a failed one) — lets the caller pad the bar to its budget. */
  windowsRun: number
}

/**
 * Extract one session's friction by windowing its follow-ups and unioning the results.
 * Windows run sequentially so each sees earlier windows' minted themes (threaded via
 * `visible`); residual duplicates are caught by the cross-session reconcile. If any
 * window's call fails, the whole session is reported failed (not persisted) so it
 * retries next analyze rather than persisting a partial event set. `onWindow` is
 * invoked with each window's incremental usage as it completes (drives the step-2 bar).
 */
async function extractSession(
  session: Session,
  followups: ReturnType<typeof collectFollowups>,
  repo: string | null,
  baseVisible: ThemeRef[],
  llm: NonNullable<DetectorContext['llm']>,
  log: DetectorContext['log'],
  onWindow: (windowUsage: TokenUsage) => void,
): Promise<Extracted> {
  let usage = emptyUsage()
  let windowsRun = 0
  const themes = new Map<string, ThemeInput>()
  const events: ThemeEventInput[] = []
  // Grows as windows mint themes, so a later window matches an earlier one's theme.
  const visible = new Map(baseVisible.map((t) => [t.id, t] as const))

  for (let start = 0; start < followups.length; start += WINDOW) {
    const windowFu = followups.slice(start, start + WINDOW)
    const summarized = await maybeSummarizeFollowups(windowFu, llm, log)
    let windowUsage = summarized.usage
    const visibleList = [...visible.values()]
    const { system, user } = buildPrompt(session, summarized.followups, visibleList)
    let result
    try {
      // cacheSystem: the rule block repeats identically every call, so cache it.
      result = await llm.completeStructured({ system, user, schema: extractionSchema, toolName: TOOL_NAME, maxTokens: 4096, cacheSystem: true })
    } catch (err) {
      log.warn(`${DETECTOR}: extraction failed for ${session.id} (window @${start}): ${(err as Error).message}`)
      windowsRun++
      usage = addUsage(usage, windowUsage)
      onWindow(windowUsage) // count the failed window's spend (summarize may have cost)
      return { themes: [], events: [], usage, failed: true, windowsRun }
    }
    windowUsage = addUsage(windowUsage, result.usage)
    usage = addUsage(usage, windowUsage)
    windowsRun++

    const pp = postprocess(result.data, summarized.followups, repo, visibleList, session.startedAt)
    for (const t of pp.themes) {
      if (!visible.has(t.id)) visible.set(t.id, { id: t.id, label: t.label, description: t.description ?? null, type: t.type, repo: t.repo ?? null })
      themes.set(t.id, t)
    }
    for (const e of pp.events) events.push({ ...e, idx: events.length }) // re-index into the session-wide sequence
    onWindow(windowUsage)
  }

  return { themes: [...themes.values()], events, usage, failed: false, windowsRun }
}

// ---- extraction postprocess -------------------------------------------------

interface Postprocessed {
  themes: ThemeInput[]
  events: ThemeEventInput[]
}

/**
 * Turn the LLM's raw event list into persistable themes + events. Assign-at-
 * extraction: match a VISIBLE theme id, else mint from the proposed label (junk
 * labels drop the theme, the event survives topicless). Matched themes are
 * re-emitted so an orphan-pruned-mid-run theme doesn't break the event FK.
 */
function postprocess(
  data: Record<string, unknown>,
  followups: ReturnType<typeof collectFollowups>,
  repo: string | null,
  visibleList: ThemeRef[],
  startedAt: string | undefined,
): Postprocessed {
  const visible = new Map(visibleList.map((t) => [t.id, t]))
  const themes = new Map<string, ThemeInput>()
  const events: ThemeEventInput[] = []
  const firstSeen = startedAt ?? new Date().toISOString()

  const raw = arrayField(data, 'events')
  for (const e of raw as Array<Record<string, unknown>>) {
    const turn = typeof e?.turn === 'number' ? e.turn : 0
    const fu = followups[turn - 1] // events reference the 1-based [n] labels
    const description = str(e?.description)
    if (!fu || !description) continue
    const type = oneOf(e?.type, TYPES, 'other')

    let themeId = str(e?.matched_theme_id)
    if (themeId && !visible.has(themeId) && !themes.has(themeId)) themeId = '' // hallucinated id → drop the match
    if (themeId && visible.has(themeId) && !themes.has(themeId)) {
      const v = visible.get(themeId)!
      themes.set(themeId, { id: themeId, label: v.label, description: v.description ?? undefined, type: oneOf(v.type, TYPES, 'other'), repo: v.repo ?? undefined, firstSeen })
    }
    if (!themeId) {
      const label = themeLabel(e?.new_theme_label)
      if (label) {
        // Global by default; repo-scoped only when the LLM marks the gap inherent
        // to this project (and we actually have a repo to scope it to).
        const projectSpecific = e?.new_theme_project_specific === true && repo != null
        themeId = makeThemeId(label, repo, projectSpecific)
        if (!visible.has(themeId) && !themes.has(themeId)) {
          themes.set(themeId, {
            id: themeId,
            label,
            description: str(e?.new_theme_description) || undefined,
            type,
            remedy: oneOf(e?.remedy_hint, REMEDIES, 'none') as ThemeRemedy,
            repo: projectSpecific ? repo! : undefined,
            firstSeen,
          })
        }
      }
    }

    events.push({
      idx: events.length,
      turnSeq: fu.seq,
      type,
      trigger: oneOf(e?.trigger, TRIGGERS, 'unprompted') as ThemeTrigger,
      description,
      themeId: themeId || undefined,
      occurredAt: fu.ts,
    })
  }

  return { themes: [...themes.values()], events }
}

// ---- surfacing --------------------------------------------------------------

// Button label per fix type, for the insight card.
const FIX_LABEL: Record<string, string> = {
  'behavioral-nudge': 'How to improve',
  'config-snippet': 'Copy config',
  'install-command': 'Copy command',
  'fix-prompt': 'Apply fix-prompt',
}

/**
 * Recurrence gate. The single-session arm surfaces heavy in-session friction (a claim
 * corrected 10× in one session is real) that the strict cross-session gate would hide.
 */
function surfaces(eventCount: number, sessionCount: number): boolean {
  if (eventCount >= MIN_EVENTS && sessionCount >= MIN_SESSIONS) return true
  return eventCount >= STRONG_SINGLE_SESSION_EVENTS
}

/**
 * Themes past the recurrence threshold become insights (one per theme), each with
 * an LLM-generated, occurrence-grounded fix (hash-gated, so a quiet re-analyze
 * reuses the cached fix). Returns the insights + tokens spent generating fixes.
 */
async function surfaceInsights(
  store: DetectorContext['store'],
  llm: NonNullable<DetectorContext['llm']>,
  log: DetectorContext['log'],
): Promise<{ insights: InsightInput[]; usage: TokenUsage }> {
  const insights: InsightInput[] = []
  let usage = emptyUsage()

  for (const t of store.themesWithEvents()) {
    if (!surfaces(t.eventCount, t.sessionCount)) continue
    const repo = t.repo ?? '*'

    // Re-surface guard: don't re-emit a theme whose insight the user already
    // resolved or dismissed, UNLESS it genuinely recurred (new occurrences since
    // that insight was last persisted). Presence of old events is not a recurrence
    // — without this, a resolved insight flips back to surfaced on every analyze.
    const prior = store.insightStatus(DETECTOR, repo, t.id)
    if (prior && (prior.state === 'dismissed' || (prior.state === 'resolved' && t.eventCount <= prior.count))) continue

    const id = insightId(DETECTOR, repo, t.id)
    const severity = t.eventCount >= SEVERITY_EVENTS.high ? 'high' : t.eventCount >= SEVERITY_EVENTS.medium ? 'medium' : 'low'

    // Evidence: the theme's member turns, ranked most-recent-first (store orders
    // by added_at desc). The occurrence description rides as the note.
    const evidence = t.evidence.map((e) => ({ sessionId: e.sessionId, turnIdx: e.turnSeq ?? undefined, note: e.description }))

    // Fix input is built LAZILY: ensureThemeFix hashes the descriptions first and
    // only calls buildOccurrences() on a cache miss — so a quiet re-analyze skips
    // the session-blob hydration entirely.
    const buildOccurrences = (): FixOccurrence[] => {
      const snippets = store.turnTexts(t.evidence.map((e) => ({ sessionId: e.sessionId, seq: e.turnSeq })))
      return t.evidence.map((e) => ({
        description: e.description,
        snippet: e.turnSeq != null ? snippets.get(`${e.sessionId}:${e.turnSeq}`) : undefined,
      }))
    }

    let fix: InsightInput['fix']
    try {
      const res = await ensureThemeFix(store, llm, log, t, t.descriptions, buildOccurrences)
      usage = addUsage(usage, res.usage)
      // The fix pass can veto a theme that crossed the count threshold (a clustered
      // one-off, taste iteration, too vague). Skip surfacing it, and retire any insight
      // it had surfaced before (a later verdict flip) so the ledger doesn't lag.
      if (!res.verdict.worthSurfacing) {
        store.retireInsightForTheme(DETECTOR, t.id)
        continue
      }
      if (res.verdict.fix) {
        // Non-nudge fixes carry the tuneloop-fix marker so the fix session self-
        // identifies on the next analyze (loop closure). A nudge has no artifact
        // to adopt, so no marker.
        const f = res.verdict.fix
        const content = f.fixType === 'behavioral-nudge' ? f.content : `tuneloop-fix: ${id}\n\n${f.content}`
        fix = { type: f.fixType, label: FIX_LABEL[f.fixType] ?? 'Suggested fix', content }
      } else {
        fix = fallbackFix()
      }
    } catch (err) {
      // A failed fix call is non-fatal — surface the insight with a placeholder;
      // the hash gate stays unstamped so the next analyze retries generation.
      log.warn(`${DETECTOR}: fix generation failed for "${t.label}": ${(err as Error).message}`)
      fix = fallbackFix()
    }

    insights.push({
      signalKey: t.id,
      repo,
      severity,
      title: t.label,
      description:
        (t.description ? `${t.description} ` : '') +
        `Recurred across ${t.sessionCount} session${t.sessionCount === 1 ? '' : 's'} (${t.eventCount} time${t.eventCount === 1 ? '' : 's'}) — a repeated ` +
        `${t.type} pattern the user had to compensate for.`,
      evidence,
      count: t.eventCount,
      firstSeenAt: t.firstSeenAt ?? undefined,
      lastSeenAt: t.lastSeenAt ?? undefined,
      fix,
    })
  }
  return { insights, usage }
}

// Placeholder when fix generation fails/returns empty — a nudge (no marker needed),
// so persistInsights never rejects it. Replaced next analyze when generation succeeds.
function fallbackFix(): InsightInput['fix'] {
  return { type: 'behavioral-nudge', label: 'How to improve', content: 'A tailored fix could not be generated this run — it will be retried on the next analyze.' }
}

// ---- sanitizers -------------------------------------------------------------

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  const s = str(v).toLowerCase() as T
  return allowed.includes(s) ? s : fallback
}

/**
 * Accept a proposed label if it's a non-empty gap name, trimmed to a sane length.
 * We deliberately DON'T reject on word count / commas — the prompt already asks for
 * a concise Title-Case name, and a slightly-verbose one is far better clustered than
 * dropped (a dropped label leaves the event topicless, unable to ever recur).
 */
function themeLabel(raw: unknown): string | null {
  const t = str(raw)
  if (!t) return null
  return clampLabel(t)
}
