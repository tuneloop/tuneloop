/**
 * skill-outcomes — an LLM enrichment that classifies what happened AROUND each
 * skill invocation: did the agent use the skill's output, rework it, or ignore it,
 * and was there an adjacent user correction? This is the honest, observation-grounded
 * version of a "did the skill help" signal — never a fabricated counterfactual
 * (see [[correctness-over-coverage]]).
 *
 * Spend control (see docs/plans/skill-analytics-roadmap.md #4):
 *  - SMALL context per firing: we send only the few turns bracketing each skill call,
 *    never the whole transcript.
 *  - BATCH: all of a session's skill firings go in ONE call; the model returns one
 *    verdict per firing (a keyed array). This is chunking, not a drop-cap — nothing
 *    is silently skipped.
 *  - The per-session processor CACHE (runner keys on session content_hash + version +
 *    model) means unchanged sessions are never re-charged on a re-run. No delta code.
 *
 * Honesty framing: outcomes are OBSERVATIONAL ("the agent reworked the output after"),
 * never causal ("the skill failed"). `unclear` is a first-class outcome so the model
 * can abstain instead of guessing. Persisted as ONE session annotation (key
 * 'skill_outcomes') whose value is an array keyed by the skill call's tool-call idx —
 * the annotations grain is per-session, so the idx lives inside the value (there is no
 * per-tool-call annotation table, and adding one would be a new pattern).
 */

import { registerProcessor } from '../core/registry'
import type { Processor, ProcessorContext, ProcessorResult } from '../core/processor'
import type { AnnotationInput } from '../store/types'
import type { Event, Session, ToolCall } from '../core/model'
import type { JsonSchema } from '../llm/types'
import { costOfUsage } from '../pricing/pricing'
import { isRealUserEvent, stripReminders } from '../core/turns'

/**
 * Outcome taxonomy. `used`/`reworked`/`ignored` are the substantive verdicts (followed vs
 * bypassed the skill's output); `unclear` = the context was enough but the outcome is
 * genuinely ambiguous; `insufficient-context` = we couldn't send enough of the session to
 * tell (window truncated / firing at the very end) — a defect of OUR view, kept separate so
 * the read model can exclude it from the distribution rather than count it as noise.
 */
export const SKILL_OUTCOMES = ['used', 'reworked', 'ignored', 'unclear', 'insufficient-context'] as const
export type SkillOutcome = (typeof SKILL_OUTCOMES)[number]

/** Events of leading context before a firing (its triggering user turn + agent reasoning). */
const CONTEXT_BEFORE = 2
/** Hard cap on events after a firing, when no user turn / next skill bounds it sooner. */
const MAX_CONTEXT_AFTER = 30
/** Cap on how much text we send per event (keeps a chatty session cheap). */
const MAX_EVENT_CHARS = 600
/** Safety cap on firings classified per session (a pathological session guard; logged). */
const MAX_FIRINGS = 40

const TOOL_NAME = 'record_skill_outcomes'

/** One firing's verdict, as persisted in the `skill_outcomes` annotation array. */
export interface SkillOutcomeVerdict {
  /** tool_calls.idx of the skill firing (its index in session.toolCalls). */
  idx: number
  /** The invoked skill name (raw, as it appears on the tool call). */
  name: string
  outcome: SkillOutcome
  /** Whether a user correction/re-steer landed adjacent to the firing (heuristic-adjacent). */
  userCorrectionAdjacent: boolean
  /** A short observational snippet the model cites as evidence. */
  evidence: string
}

export const skillOutcomes: Processor = {
  name: 'skill-outcomes',
  // 2: window extends to the next user turn / skill firing (was fixed ±few events) and
  //    surfaces interrupts + tool errors, so the model judges from real friction; taxonomy
  //    gains `insufficient-context` (distinct from genuine `unclear`). Bump re-runs the LLM.
  // 3: evidence must be ONE complete <200-char sentence + a word-boundary clip backstop, so
  //    snippets stop getting cut off mid-word ("…summary at t"). Bump re-runs the LLM.
  // 4: route to the heavy (detector-tier) model — the followed/bypassed judgement is worth
  //    the stronger model. Model change re-keys the cache, so this re-runs the LLM.
  // 5: raise the evidence clip to 500 (UI shows evidence in full) so a complete sentence is
  //    never truncated. Bump re-runs the LLM.
  version: 5,
  kind: 'enrichment',
  needs: { llm: true },
  model: 'heavy',
  async run(ctx: ProcessorContext): Promise<ProcessorResult> {
    const { llm, session } = ctx
    if (!llm) return {}

    // Skill firings on the MAIN thread only (matches the roster's counts).
    const firings = collectFirings(session)
    if (firings.length === 0) return {}
    if (firings.length > MAX_FIRINGS) {
      ctx.log.warn(`skill-outcomes: ${session.id} has ${firings.length} firings; classifying the first ${MAX_FIRINGS}`)
    }
    const batch = firings.slice(0, MAX_FIRINGS)

    const { system, user } = buildPrompt(session, batch)
    const { data, usage } = await llm.completeStructured({
      system,
      user,
      schema: outputSchema(),
      toolName: TOOL_NAME,
      maxTokens: 2048,
    })
    const selfCost = { tokens: usage, usd: costOfUsage(llm.provider, llm.model, usage) }

    const verdicts = normalizeVerdicts(data, batch)
    if (verdicts.length === 0) {
      ctx.log.warn(`skill-outcomes: empty/invalid LLM output for ${session.id}`)
      return { selfCost } // record the spend so a re-run doesn't re-charge
    }

    const annotations: AnnotationInput[] = [{ key: 'skill_outcomes', value: verdicts }]
    return { annotations, selfCost }
  },
}

registerProcessor(skillOutcomes)

/** A skill firing plus the coordinate we build its context window around. */
interface Firing {
  idx: number
  name: string
  /** Index of the firing's assistant event in session.events (for windowing). */
  eventIdx: number
  seq?: number
}

/**
 * Locate each main-thread skill tool call and the assistant event it fired in.
 * session.toolCalls index IS the persisted tool_calls.idx; we match the tool_use id
 * to its containing assistant message to get the transcript coordinate for windowing.
 */
function collectFirings(session: Session): Firing[] {
  // Map tool_use id → the index of the assistant event that emitted it.
  const eventIdxById = new Map<string, number>()
  session.events.forEach((ev, i) => {
    if (ev.kind !== 'assistant' || ev.isSidechain) return
    for (const b of ev.blocks) if (b.type === 'tool_use') eventIdxById.set(b.id, i)
  })
  const out: Firing[] = []
  session.toolCalls.forEach((tc: ToolCall, idx: number) => {
    if (tc.action !== 'skill' || tc.isSidechain) return
    const eventIdx = eventIdxById.get(tc.id)
    out.push({ idx, name: tc.name, eventIdx: eventIdx ?? -1, seq: eventIdx != null ? session.events[eventIdx]?.seq : undefined })
  })
  return out
}

/** Compact text for one event — role-tagged, truncated, reminders stripped. Surfaces
 *  friction inline: an Esc-interrupt user turn and an errored tool call are the raw
 *  signals the model needs to tell "followed" from "reworked/bypassed". */
function eventText(ev: Event): string | null {
  if (ev.isSidechain) return null
  if (ev.kind === 'user') {
    const raw = stripReminders(ev.text).trim()
    if (/^\[Request interrupted/i.test(raw)) return 'USER: [interrupted the agent]'
    // A tool_result-only turn isn't steering, but an ERROR in it is friction worth showing.
    if (!isRealUserEvent(ev)) {
      return ev.blocks.some((b) => b.type === 'tool_result' && b.isError) ? 'SYSTEM: [a tool call errored]' : null
    }
    return raw ? 'USER: ' + clip(raw) : null
  }
  if (ev.kind === 'assistant') {
    const parts: string[] = []
    for (const b of ev.blocks) {
      if (b.type === 'text' && b.text.trim()) parts.push(clip(b.text.trim()))
      else if (b.type === 'tool_use') parts.push('[calls ' + b.name + ']')
    }
    const t = parts.join(' ')
    return t ? 'ASSISTANT: ' + t : null
  }
  return null
}

function clip(s: string): string {
  return s.length > MAX_EVENT_CHARS ? s.slice(0, MAX_EVENT_CHARS) + '…' : s
}

/** True if this event is a substantive user turn — the natural end of "what the agent did
 *  with the skill before the user spoke again". An Esc-interrupt is NOT a boundary: it's
 *  mid-action friction, and the re-steer that follows is part of the same episode, so the
 *  window extends through it to the next real turn (the interrupt still renders inline). */
function isTurnBoundary(ev: Event): boolean {
  if (ev.kind !== 'user' || ev.isSidechain) return false
  if (/^\[Request interrupted/i.test(stripReminders(ev.text))) return false
  return isRealUserEvent(ev)
}

/** True if the assistant event at `i` emits a skill tool_use other than this firing. */
function firesAnotherSkill(session: Session, i: number, self: number): boolean {
  if (i === self) return false
  const ev = session.events[i]
  if (!ev || ev.kind !== 'assistant' || ev.isSidechain) return false
  return ev.blocks.some((b) => b.type === 'tool_use' && b.name === 'Skill')
}

/**
 * The window around a firing: a little leading context, then everything the agent did
 * with the skill up to the NEXT user turn or NEXT skill firing (whichever comes first),
 * capped at MAX_CONTEXT_AFTER. Returns the rendered lines plus whether the after-side was
 * cut by the cap while the session still ran on — the signal that our view (not the
 * outcome) was the limiter, so the model should answer `insufficient-context`.
 */
function windowFor(session: Session, f: Firing): { text: string; truncated: boolean } {
  if (f.eventIdx < 0) return { text: '(context unavailable)', truncated: true }
  const lo = Math.max(0, f.eventIdx - CONTEXT_BEFORE)
  // Extend forward to the boundary: next user turn or next skill firing, capped.
  const capHi = Math.min(session.events.length - 1, f.eventIdx + MAX_CONTEXT_AFTER)
  let hi = capHi
  for (let i = f.eventIdx + 1; i <= capHi; i++) {
    if (isTurnBoundary(session.events[i]!) || firesAnotherSkill(session, i, f.eventIdx)) {
      hi = i // include the boundary line itself (the user's next words are evidence)
      break
    }
  }
  // Truncated = we hit the cap with more session after it AND no boundary closed the window.
  const truncated = hi === capHi && capHi < session.events.length - 1
  const lines: string[] = []
  for (let i = lo; i <= hi; i++) {
    const ev = session.events[i]
    if (!ev) continue
    const marker = i === f.eventIdx ? ' «— the ' + f.name + ' skill fired here' : ''
    const txt = eventText(ev)
    if (txt) lines.push(txt + marker)
    else if (marker) lines.push('ASSISTANT: [calls ' + f.name + ']' + marker)
  }
  return { text: lines.join('\n'), truncated }
}

function buildPrompt(session: Session, firings: Firing[]): { system: string; user: string } {
  const system = [
    'You classify how a coding agent treated each skill invocation — did it FOLLOW the skill’s',
    'output or BYPASS it? Judge ONLY from the shown turns.',
    '- used: the agent proceeded with the skill’s output as-is (followed).',
    '- reworked: the agent used it but then corrected, redid, or substantially changed it (partly bypassed).',
    '- ignored: the agent set it aside and did the work another way (bypassed).',
    '- unclear: the shown turns ARE enough to see what happened, but the outcome is genuinely ambiguous.',
    '- insufficient-context: the shown window doesn’t contain enough to tell (e.g. it ends right after the',
    '  firing). Use this — NOT `unclear` — when the limit is how much you were shown.',
    'Flag userCorrectionAdjacent=true when a USER turn corrects, re-steers, or interrupts right around the firing.',
    'Be OBSERVATIONAL: describe what happened ("the agent re-ran the diff manually"), never assert the skill caused it.',
    'evidence: ONE complete, self-contained sentence under 200 characters — a finished thought, not a fragment cut off mid-way.',
    'Return exactly one verdict per firing, echoing its idx.',
  ].join('\n')

  const blocks = firings
    .map((f) => {
      const w = windowFor(session, f)
      const note = w.truncated ? '\n(window truncated here — the session continued past what is shown)' : ''
      return `--- firing idx=${f.idx} (skill: ${f.name}) ---\n${w.text}${note}`
    })
    .join('\n\n')
  const user = [
    `Session in repo ${session.project.repo ?? 'unknown'}. ${firings.length} skill firing(s) to classify.`,
    '',
    blocks,
    '',
    `Return a verdict for each of these idx values: ${firings.map((f) => f.idx).join(', ')}.`,
  ].join('\n')
  return { system, user }
}

function outputSchema(): JsonSchema {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['verdicts'],
    properties: {
      verdicts: {
        type: 'array',
        description: 'One entry per skill firing, echoing its idx.',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['idx', 'outcome', 'userCorrectionAdjacent', 'evidence'],
          properties: {
            idx: { type: 'integer', description: 'The firing idx from the prompt.' },
            outcome: { type: 'string', enum: SKILL_OUTCOMES, description: 'How the agent treated the skill output.' },
            userCorrectionAdjacent: { type: 'boolean', description: 'A nearby user turn corrected/re-steered around the firing.' },
            evidence: { type: 'string', description: 'ONE complete, self-contained sentence (<200 chars) on what happened after the firing — a finished thought, never cut off mid-way.' },
          },
        },
      },
    },
  }
}

/** Defensive normalization of the model output into verdicts for the known firings. */
function normalizeVerdicts(data: Record<string, unknown>, firings: Firing[]): SkillOutcomeVerdict[] {
  const raw = Array.isArray((data as { verdicts?: unknown }).verdicts) ? (data.verdicts as unknown[]) : []
  const byIdx = new Map<number, Record<string, unknown>>()
  for (const v of raw) {
    const o = v as Record<string, unknown> | null
    if (o && typeof o.idx === 'number') byIdx.set(o.idx, o)
  }
  const out: SkillOutcomeVerdict[] = []
  for (const f of firings) {
    const o = byIdx.get(f.idx)
    if (!o) continue // the model didn't return this firing — skip it (not fabricated)
    const outcome = SKILL_OUTCOMES.includes(o.outcome as SkillOutcome) ? (o.outcome as SkillOutcome) : 'unclear'
    out.push({
      idx: f.idx,
      name: f.name,
      outcome,
      userCorrectionAdjacent: o.userCorrectionAdjacent === true,
      evidence: typeof o.evidence === 'string' ? clipEvidence(o.evidence) : '',
    })
  }
  return out
}

/**
 * Trim evidence to a safety length WITHOUT cutting mid-word. We ask the model for one
 * <200-char sentence and the UI shows evidence in full, so this only guards against a
 * pathologically long reply — the budget is generous (a normal 1-2 sentence reply passes
 * through untouched). When it does trigger, cut at the last sentence end within budget,
 * else the last word boundary, never mid-word ("…summary at t").
 */
function clipEvidence(s: string, max = 500): string {
  const t = s.trim()
  if (t.length <= max) return t
  const head = t.slice(0, max)
  const sentenceEnd = Math.max(head.lastIndexOf('. '), head.lastIndexOf('! '), head.lastIndexOf('? '))
  if (sentenceEnd >= max * 0.5) return head.slice(0, sentenceEnd + 1)
  const wordEnd = head.lastIndexOf(' ')
  return (wordEnd >= max * 0.5 ? head.slice(0, wordEnd) : head).trimEnd() + '…'
}
