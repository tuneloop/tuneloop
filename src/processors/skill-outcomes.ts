/**
 * skill-outcomes — an LLM enrichment that classifies what happened AROUND each
 * skill invocation: did the agent use the skill's output, rework it, or ignore it,
 * and was there an adjacent user correction? This is the honest, observation-grounded
 * version of a "did the skill help" signal — never a fabricated counterfactual.
 *
 * Honesty framing: outcomes are OBSERVATIONAL ("the agent reworked the output after"),
 * never causal ("the skill failed"). `unclear` is a first-class outcome so the model
 * can abstain instead of guessing. Persisted as ONE session annotation (key
 * 'skill_outcomes') whose value is an array keyed by the skill call's tool-call idx —
 * the annotations grain is per-session, so the idx lives inside the value.
 *
 * Covers main-thread firings AND subagent (sidechain) firings whose events carry an
 * agentId: each firing's window is built inside its OWN thread, so parallel threads never
 * contaminate the evidence. Subagent windows have no user turns after the firing — the
 * verdict rests on the agent's behavior, and the thread ending is a closed episode.
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
  version: 6,
  kind: 'enrichment',
  needs: { llm: true },
  model: 'heavy',
  async run(ctx: ProcessorContext): Promise<ProcessorResult> {
    const { llm, session } = ctx
    if (!llm) return {}

    // Skill firings from the main thread AND identifiable subagent threads; each is
    // windowed inside its own thread (see collectFirings).
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
      return { selfCost } 
    }

    const annotations: AnnotationInput[] = [{ key: 'skill_outcomes', value: verdicts }]
    return { annotations, selfCost }
  },
}

registerProcessor(skillOutcomes)

/** A skill firing plus the thread-scoped coordinate we build its context window around. */
interface Firing {
  idx: number
  name: string
  /** The firing's thread: the main-thread events, or one subagent's (same agentId) events.
   *  Windowing runs INSIDE this list, so parallel threads never bleed into the evidence. */
  thread: Event[]
  /** Index of the firing's anchor event within `thread` (-1 = unlocatable). */
  eventIdx: number
  /** Thread positions holding OTHER skill firings — the next-skill window boundary. Derived
   *  from the collected firings themselves, so it covers synthesized calls and non-Claude
   *  block names (OpenCode's lowercase `skill`) that block-name matching would miss. */
  firingPos: Set<number>
  /** Set when the firing happened inside a subagent thread (used to label the prompt). */
  agentId?: string
  seq?: number
}

/**
 * Locate each skill tool call and its anchor event, with a thread-scoped coordinate:
 * main-thread firings window over the main thread; a subagent's firings window over that
 * subagent's own events (matched by agentId). Block-backed calls anchor on the assistant
 * event that emitted the tool_use; synthesized calls (explicit /skill-style invocations,
 * recorded as messages with no tool_use block) anchor on the nearest same-thread event by
 * timestamp — the same fallback core/blocks.ts uses for block attribution. A sidechain
 * firing with no resolvable thread is skipped rather than judged against interleaved
 * noise. session.toolCalls index IS the persisted tool_calls.idx.
 */
function collectFirings(session: Session): Firing[] {
  // Partition events into threads ('main' + one per agentId) and map each tool_use id to
  // its thread coordinate. A sidechain event with no agentId belongs to no judgeable thread.
  const threads = new Map<string, Event[]>()
  const posById = new Map<string, { key: string; pos: number }>()
  for (const ev of session.events) {
    const key = ev.isSidechain ? ev.agentId ?? null : 'main'
    if (key == null) continue
    let list = threads.get(key)
    if (!list) threads.set(key, (list = []))
    const pos = list.length
    list.push(ev)
    if (ev.kind === 'assistant') {
      for (const b of ev.blocks) if (b.type === 'tool_use') posById.set(b.id, { key, pos })
    }
  }

  // Anchor one call: its tool_use block's event, else nearest same-thread event by ts.
  const locate = (tc: ToolCall): { key: string; pos: number } | undefined => {
    const at = posById.get(tc.id)
    // A sidechain call anchored on a main-thread event is contradictory data — fall through
    // to the ts fallback (which only considers sidechain threads) rather than trust it.
    if (at && !(tc.isSidechain && at.key === 'main')) return at
    const t = tc.ts ? Date.parse(tc.ts) : NaN
    if (Number.isNaN(t)) return undefined
    let best: { key: string; pos: number } | undefined
    let bestD = Infinity
    for (const [key, list] of threads) {
      if (tc.isSidechain ? key === 'main' : key !== 'main') continue
      list.forEach((ev, pos) => {
        const evT = ev.ts ? Date.parse(ev.ts) : NaN
        if (Number.isNaN(evT)) return
        const d = Math.abs(evT - t)
        if (d < bestD) { bestD = d; best = { key, pos } }
      })
    }
    return best
  }

  const located: Array<{ idx: number; name: string; key: string | null; pos: number; sidechain: boolean }> = []
  session.toolCalls.forEach((tc: ToolCall, idx: number) => {
    if (tc.action !== 'skill') return
    const at = locate(tc)
    located.push({ idx, name: tc.name, key: at?.key ?? null, pos: at?.pos ?? -1, sidechain: tc.isSidechain })
  })

  // Per-thread positions that host a skill firing — each firing's next-skill boundary set.
  const firingPosByThread = new Map<string, Set<number>>()
  for (const l of located) {
    if (l.key == null) continue
    let set = firingPosByThread.get(l.key)
    if (!set) firingPosByThread.set(l.key, (set = new Set()))
    set.add(l.pos)
  }

  const out: Firing[] = []
  for (const l of located) {
    if (l.key == null) {
      // Main-thread firing we can't locate → judged with '(context unavailable)' as before;
      // an unlocatable sidechain firing is skipped (no honest window can be built).
      if (!l.sidechain) out.push({ idx: l.idx, name: l.name, thread: [], eventIdx: -1, firingPos: new Set() })
      continue
    }
    const thread = threads.get(l.key)!
    out.push({
      idx: l.idx,
      name: l.name,
      thread,
      eventIdx: l.pos,
      firingPos: firingPosByThread.get(l.key)!,
      agentId: l.key === 'main' ? undefined : l.key,
      seq: thread[l.pos]?.seq,
    })
  }
  return out
}

/** Compact text for one event — role-tagged, truncated, reminders stripped. Surfaces
 *  friction inline: an Esc-interrupt user turn and an errored tool call are the raw
 *  signals the model needs to tell "followed" from "reworked/bypassed". Only ever fed
 *  events from ONE thread (the firing's), so no cross-thread filtering happens here. */
function eventText(ev: Event): string | null {
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
 *  window extends through it to the next real turn (the interrupt still renders inline).
 *  In a subagent thread real user turns don't occur after a firing (the "user" role there
 *  is tool results), so its windows run to the next firing, the cap, or the thread's end. */
function isTurnBoundary(ev: Event): boolean {
  if (ev.kind !== 'user') return false
  if (/^\[Request interrupted/i.test(stripReminders(ev.text))) return false
  return isRealUserEvent(ev)
}


/**
 * The window around a firing, built INSIDE its thread: a little leading context, then
 * everything the agent did with the skill up to the NEXT user turn or NEXT skill firing
 * (whichever comes first), capped at MAX_CONTEXT_AFTER. Returns the rendered lines plus
 * whether the after-side was cut by the cap while the thread still ran on — the signal
 * that our view (not the outcome) was the limiter, so the model should answer
 * `insufficient-context`. A thread that simply ENDS closes the window cleanly: for a
 * subagent that's the episode finishing, not a cut-off view.
 */
function windowFor(f: Firing): { text: string; truncated: boolean } {
  const events = f.thread
  if (f.eventIdx < 0) return { text: '(context unavailable)', truncated: true }
  const lo = Math.max(0, f.eventIdx - CONTEXT_BEFORE)
  // Extend forward to the boundary: next user turn or next skill firing, capped.
  const capHi = Math.min(events.length - 1, f.eventIdx + MAX_CONTEXT_AFTER)
  let hi = capHi
  for (let i = f.eventIdx + 1; i <= capHi; i++) {
    if (isTurnBoundary(events[i]!) || f.firingPos.has(i)) {
      hi = i // include the boundary line itself (the user's next words are evidence)
      break
    }
  }
  // Truncated = we hit the cap with more thread after it AND no boundary closed the window.
  const truncated = hi === capHi && capHi < events.length - 1
  const lines: string[] = []
  for (let i = lo; i <= hi; i++) {
    const ev = events[i]
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
    'A firing marked "inside a subagent thread" has no USER turns after it — judge purely from the agent\'s behavior.',
    'Be OBSERVATIONAL: describe what happened ("the agent re-ran the diff manually"), never assert the skill caused it.',
    'evidence: ONE complete, self-contained sentence under 200 characters — a finished thought, not a fragment cut off mid-way.',
    'Return exactly one verdict per firing, echoing its idx.',
  ].join('\n')

  const blocks = firings
    .map((f) => {
      const w = windowFor(f)
      const note = w.truncated ? '\n(window truncated here — the session continued past what is shown)' : ''
      const where = f.agentId ? ', inside a subagent thread' : ''
      return `--- firing idx=${f.idx} (skill: ${f.name}${where}) ---\n${w.text}${note}`
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
