import { registerDetector } from '../../core/registry'
import { addUsage, emptyUsage, type TokenUsage } from '../../core/model'
import { insightId } from '../../core/detector'
import { costOfUsage } from '../../pricing/pricing'
import { mapPool } from '../../util/pool'
import { collectFollowups } from './followups'
import { DETECTOR, clampLabel, themeId as makeThemeId } from './ids'
import { buildPrompt, extractionSchema, REMEDIES, TOOL_NAME, TRIGGERS, TYPES } from './prompt'
import { runThemeMerge } from './merge'
import { ensureThemeFix, type FixOccurrence } from './fix'
import { maybeSummarizeFollowups } from './summarize'
import type { Detector, DetectorContext, DetectorResult, InsightInput } from '../../core/detector'
import type { ThemeEventInput, ThemeInput, ThemeRef, ThemeRemedy, ThemeTrigger } from '../../store/types'

const CONCURRENCY = 6 // LLM calls in flight across the session delta
const MAX_TURNS_GATE = 0 // pre-gate: a session needs > this many substantive follow-ups (steered) to extract

// Surfacing threshold: a theme surfaces as an insight once it recurs enough.
const MIN_EVENTS = 3
const MIN_SESSIONS = 2
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
 * Flow: pre-gate to steered sessions in the delta → one extraction call per
 * session (assign-at-extraction against the existing theme list) → one taxonomy-
 * reconcile call (merge duplicate themes + re-home still-unclustered events) →
 * surface themes past the recurrence threshold. Themes persist in their own tables
 * so they outlive their insights (a resolved theme stays in the extraction feed and
 * can reopen on recurrence).
 */
export const recurringThemes: Detector = {
  name: DETECTOR,
  version: 1,
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
    const candidates = delta.filter((d) => steered.has(d.sessionId))
    log.debug(`${DETECTOR}: ${delta.length} in delta, ${candidates.length} steered → extracting`)

    let usage = emptyUsage()
    const processed: Array<{ sessionId: string; contentHash: string }> = []

    // 2. Per-session extraction, bounded concurrency. Each call persists its own
    // themes+events immediately (so a mid-run failure keeps prior work) and, on
    // success, records the session as processed for the delta. Each returns its
    // token usage (summed after the pool — concurrent callbacks can't safely
    // read-modify-write a shared accumulator).
    const perSessionUsage = await mapPool(candidates, CONCURRENCY, async (cand) => {
      const session = ctx.loadSession(cand.sessionId)
      if (!session) return emptyUsage()
      let followups = collectFollowups(session)
      if (followups.length === 0) {
        // Steered by count but no substantive follow-ups survive filtering —
        // nothing to extract, but it IS processed (don't re-hydrate next run).
        processed.push(cand)
        return emptyUsage()
      }

      // Nothing is clipped; a rare oversized session has its MIDDLE agent-activity
      // summarized (user turns untouched) so it fits the model without erroring.
      const summarized = await maybeSummarizeFollowups(followups, llm!, log)
      followups = summarized.followups
      let u = summarized.usage

      const repo = session.project.repo ?? null
      const visible = store.listThemes(repo)
      const { system, user } = buildPrompt(session, followups, visible)
      let result
      try {
        result = await llm.completeStructured({ system, user, schema: extractionSchema, toolName: TOOL_NAME, maxTokens: 4096 })
      } catch (err) {
        // A failed call leaves this session unprocessed (retried next analyze).
        log.warn(`${DETECTOR}: extraction failed for ${cand.sessionId}: ${(err as Error).message}`)
        return u
      }
      u = addUsage(u, result.usage)

      const { themes, events } = postprocess(result.data, followups, repo, visible, session.startedAt)
      store.persistThemeExtraction(cand.sessionId, themes, events)
      processed.push(cand)
      return u
    })
    for (const u of perSessionUsage) usage = addUsage(usage, u)

    // 3. Reconcile the taxonomy: one call that both merges duplicate themes and
    // re-homes still-unclustered events (hash-gated; no-op when nothing changed).
    const merge = await runThemeMerge(store, llm, log)
    usage = addUsage(usage, merge.usage)

    // 4. Surface themes past the recurrence threshold as insights, each with an
    // LLM-generated fix (hash-gated per theme, so quiet re-analyzes reuse it).
    const surfaced = await surfaceInsights(store, llm, log)
    usage = addUsage(usage, surfaced.usage)

    const cost = { inTokens: usage.input, outTokens: usage.output, usd: costOfUsage(llm.provider, llm.model, usage) }
    return { insights: surfaced.insights, cost, seen: processed }
  },
}

registerDetector(recurringThemes)

// ---- pre-gate ---------------------------------------------------------------

/** Session ids the steering processor marked as steered (followup_count > gate). */
function steeredIds(store: DetectorContext['store']): Set<string> {
  const rows = store.queryAll(
    `SELECT session_id AS sessionId FROM annotations
     WHERE key = 'followup_count' AND CAST(json_extract(value,'$') AS INTEGER) > ?`,
    MAX_TURNS_GATE,
  ) as Array<{ sessionId: string }>
  return new Set(rows.map((r) => r.sessionId))
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

  const raw = Array.isArray(data.events) ? data.events : []
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
    if (t.eventCount < MIN_EVENTS || t.sessionCount < MIN_SESSIONS) continue
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
