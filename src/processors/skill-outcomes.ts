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

/** The 4-way outcome taxonomy (user-approved). `unclear` lets the model abstain. */
export const SKILL_OUTCOMES = ['used', 'reworked', 'ignored', 'unclear'] as const
export type SkillOutcome = (typeof SKILL_OUTCOMES)[number]

/** How many events before/after a skill firing we include as its context. */
const CONTEXT_BEFORE = 2
const CONTEXT_AFTER = 4
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
  version: 1,
  kind: 'enrichment',
  needs: { llm: true },
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

/** Compact text for one event — role-tagged, truncated, reminders stripped. */
function eventText(ev: Event): string | null {
  if (ev.isSidechain) return null
  if (ev.kind === 'user') {
    if (!isRealUserEvent(ev)) return null // skip harness/skill-body machinery
    const t = stripReminders(ev.text).trim()
    return t ? 'USER: ' + clip(t) : null
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

/** The window of events around a firing, as compact role-tagged lines. */
function windowFor(session: Session, f: Firing): string {
  if (f.eventIdx < 0) return '(context unavailable)'
  const lo = Math.max(0, f.eventIdx - CONTEXT_BEFORE)
  const hi = Math.min(session.events.length - 1, f.eventIdx + CONTEXT_AFTER)
  const lines: string[] = []
  for (let i = lo; i <= hi; i++) {
    const ev = session.events[i]
    if (!ev) continue
    const marker = i === f.eventIdx ? ' «— the ' + f.name + ' skill fired here' : ''
    const txt = eventText(ev)
    if (txt) lines.push(txt + marker)
    else if (marker) lines.push('ASSISTANT: [calls ' + f.name + ']' + marker)
  }
  return lines.join('\n')
}

function buildPrompt(session: Session, firings: Firing[]): { system: string; user: string } {
  const system = [
    'You classify what happened AROUND each skill invocation in a coding-agent session.',
    'For each firing, judge ONLY from the surrounding turns how the agent treated the skill’s output:',
    '- used: the agent proceeded with the skill’s output as-is.',
    '- reworked: the agent used it but then corrected, redid, or substantially modified it.',
    '- ignored: the agent set it aside and did something else instead.',
    '- unclear: the surrounding turns don’t show enough to tell. Prefer this over guessing.',
    'Also flag userCorrectionAdjacent=true when a nearby USER turn corrects or re-steers right around the firing.',
    'Be OBSERVATIONAL: describe what happened after ("the agent re-ran the diff manually"), never assert the skill caused anything.',
    'Return exactly one verdict object per firing, echoing its idx.',
  ].join('\n')

  const blocks = firings.map((f) => `--- firing idx=${f.idx} (skill: ${f.name}) ---\n${windowFor(session, f)}`).join('\n\n')
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
            evidence: { type: 'string', description: 'A short observational snippet: what happened after the firing.' },
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
      evidence: typeof o.evidence === 'string' ? o.evidence.slice(0, 300) : '',
    })
  }
  return out
}
