import { registerProcessor } from '../core/registry'
import { deterministicBlocks } from '../core/blocks'
import { classifyError, resultText } from '../core/error-category'
import { isApproval, stripReminders, userTurnEvents } from '../core/turns'
import { costOfUsage } from '../pricing/pricing'
import type { FrictionTopicRef, Processor, ProcessorContext, ProcessorResult } from '../core/processor'
import type { Session } from '../core/model'
import type { JsonSchema } from '../llm/types'
import type {
  AnnotationInput,
  FrictionEventInput,
  FrictionRemedy,
  FrictionTopicInput,
  FrictionTrigger,
  FrictionType,
} from '../store/types'

const TYPES: FrictionType[] = ['re-steer', 'context-supply', 'tool-gap', 'rework', 'preference', 'other']
const REMEDIES: FrictionRemedy[] = ['add_doc', 'add_skill', 'add_tool', 'model_or_prompt', 'none']
const TRIGGERS: FrictionTrigger[] = ['unprompted', 'after_tool_error', 'after_review', 'agent_stated']

/**
 * Friction mining (docs/plans/friction-mining.md): one structured LLM call over
 * the session's substantive follow-up turns, extracting moments where the human
 * had to compensate for the agent. Topic assignment happens AT EXTRACTION — the
 * prompt shows the existing topics (repo + globals) and the model matches or
 * proposes a label; a later merge pass cleans up near-duplicates. The prompt
 * rules encode the Phase 0.5 spike learnings recorded in the plan doc.
 */
export const enrichFriction: Processor = {
  name: 'enrich-friction',
  version: 1,
  kind: 'enrichment',
  needs: { llm: true },
  requires: ['segment-blocks'],
  facets: [
    // Multi-valued session facet: the distinct friction types the session hit.
    { key: 'friction_type', label: 'Friction', type: 'enum', source: 'annotation', multi: true, roles: ['chart', 'filter', 'detail'] },
  ],
  measures: [
    {
      key: 'friction_count',
      label: 'Friction events',
      source: 'annotation',
      expr: "(SELECT json_extract(a.value,'$') FROM annotations a WHERE a.session_id = s.id AND a.key = 'friction_count')",
      agg: 'sum',
      format: 'int',
    },
  ],
  async run(ctx: ProcessorContext): Promise<ProcessorResult> {
    const { llm, session } = ctx
    if (!llm) return {}

    const followups = collectFollowups(session)
    // No substantive follow-ups → nothing to extract; skip the LLM call entirely.
    if (followups.length === 0) return { annotations: rollup([]) }

    const { system, user } = buildPrompt(session, followups, ctx.existingTopics)
    const { data: parsed, usage } = await llm.completeStructured({
      system,
      user,
      schema: outputSchema,
      toolName: TOOL_NAME,
      maxTokens: 4096,
    })
    const selfCost = { tokens: usage, usd: costOfUsage(llm.provider, llm.model, usage) }

    if (Object.keys(parsed).length === 0) {
      // A failure, not a zero-friction result: skipping persistResult keeps a prior
      // run's events intact and leaves the session eligible for retry next analyze.
      throw new Error('empty LLM output')
    }

    const repo = session.project.repo ?? null
    const blocks = deterministicBlocks(session)
    const seqToBlock = new Map<number, number>()
    for (const b of blocks) for (let s = b.startSeq; s <= b.endSeq; s++) seqToBlock.set(s, b.idx)

    const visible = new Map(ctx.existingTopics.map((t) => [t.id, t]))
    const topics = new Map<string, FrictionTopicInput>() // every topic this session's events reference
    const events: FrictionEventInput[] = []

    const raw = Array.isArray(parsed.events) ? parsed.events : []
    for (const e of raw) {
      const turn = typeof e?.turn === 'number' ? e.turn : 0
      const fu = followups[turn - 1] // events reference the 1-based [n] labels
      const description = str(e?.description)
      if (!fu || !description) continue
      const type = oneOf(e?.type, TYPES, 'other')

      // Topic: match a VISIBLE topic id, else mint from the proposed label (gated —
      // a junk label drops the topic, never the event).
      let topicId = str(e?.matched_topic_id)
      if (topicId && !visible.has(topicId) && !topics.has(topicId)) topicId = ''
      if (topicId && visible.has(topicId) && !topics.has(topicId)) {
        // Re-emit matched topics (INSERT OR IGNORE): resurrects one orphan-pruned
        // mid-run, which would otherwise break the event FK and roll back the persist.
        const v = visible.get(topicId)!
        topics.set(topicId, {
          id: topicId,
          label: v.label,
          type: oneOf(v.type, TYPES, 'other'),
          repo: v.repo ?? undefined,
          firstSeen: session.startedAt,
        })
      }
      if (!topicId) {
        const label = topicLabel(e?.new_topic_label)
        if (label) {
          // Preference topics are global (conventions span repos, DR-4); everything
          // else is repo-scoped so "point at the sqlite db" can't leak across repos.
          const global = type === 'preference' || repo == null
          topicId = `friction:derived:${global ? 'global' : slug(repo!)}:${slug(label)}`
          if (!visible.has(topicId) && !topics.has(topicId)) {
            topics.set(topicId, {
              id: topicId,
              label,
              type,
              remedy: oneOf(e?.remedy_hint, REMEDIES, 'none'),
              repo: global ? undefined : repo!,
              firstSeen: session.startedAt,
            })
          }
        }
      }

      events.push({
        idx: events.length,
        turnSeq: fu.seq,
        blockIdx: fu.seq != null ? seqToBlock.get(fu.seq) : undefined,
        type,
        trigger: oneOf(e?.trigger, TRIGGERS, 'unprompted'),
        remedyHint: oneOf(e?.remedy_hint, REMEDIES, 'none'),
        description,
        topicId: topicId || undefined,
      })
    }

    return {
      frictionTopics: [...topics.values()],
      frictionEvents: events,
      annotations: rollup(events),
      selfCost,
    }
  },
}

registerProcessor(enrichFriction)

// ---- inputs -----------------------------------------------------------------

/** A substantive follow-up turn plus the tool errors that occurred since the previous turn. */
interface Followup {
  text: string
  seq?: number
  /** error_category keys of failed main-thread tool calls preceding this turn. */
  errors: string[]
  /** Compact digest of what the assistant did/said since the previous user turn. */
  did?: string
  /**
   * Set when the user pressed interrupt (Esc) in this window: what the agent was
   * doing at that moment ('' when unrecoverable). The strongest re-steer signal —
   * but the turn text must still react to it (same discipline as error tags).
   */
  interrupted?: string
}

/**
 * The follow-up spine with per-turn error alignment: for each substantive
 * follow-up, the categories of the failed tool calls between the previous user
 * turn and this one. That positional link is what lets the model (and trigger
 * fusion) tell "user re-prompted AFTER a test failure" from an unprompted nudge.
 */
export function collectFollowups(session: Session): Followup[] {
  const turns = userTurnEvents(session)
  if (turns.length <= 1) return []

  // tool_use id → main-thread seq of the assistant message that issued it.
  const uidSeq = new Map<string, number>()
  for (const ev of session.events) {
    if (ev.kind !== 'assistant' || ev.isSidechain || ev.seq == null) continue
    for (const b of ev.blocks) if (b.type === 'tool_use') uidSeq.set(b.id, ev.seq)
  }
  const errors: Array<{ seq: number; cat: string }> = []
  for (const t of session.toolCalls) {
    if (t.result.ok || t.isSidechain) continue
    const seq = uidSeq.get(t.id)
    if (seq == null) continue
    errors.push({ seq, cat: classifyError(t.action, resultText(t.result.raw).slice(0, 8000)) })
  }

  // Assistant activity, for the per-followup digest: main-thread text snippets
  // and tool calls keyed by seq (windowed per follow-up below).
  const texts: Array<{ seq: number; text: string }> = []
  for (const ev of session.events) {
    if (ev.kind !== 'assistant' || ev.isSidechain || ev.seq == null) continue
    for (const b of ev.blocks) if (b.type === 'text' && b.text.trim()) texts.push({ seq: ev.seq, text: b.text })
  }
  const calls: Array<{ seq: number; action: string; path?: string; cmd?: string }> = []
  for (const t of session.toolCalls) {
    if (t.isSidechain) continue
    const seq = uidSeq.get(t.id)
    if (seq == null) continue
    calls.push({ seq, action: t.action, path: t.target.paths?.[0], cmd: t.target.command?.replace(/\s+/g, ' ').slice(0, 60) })
  }

  // Esc-interrupt markers: synthetic "user" events dropped from the real turn
  // spine (core/turns.ts) but still present in the event stream — each one is
  // the user cutting the agent off mid-action.
  const interrupts: number[] = []
  for (const ev of session.events) {
    if (ev.kind !== 'user' || ev.isSidechain || ev.seq == null) continue
    // Stripped text, matching how core/turns.ts excludes these from the real spine.
    if (/^\[Request interrupted/i.test(stripReminders(ev.text))) interrupts.push(ev.seq)
  }

  const out: Followup[] = []
  for (let i = 1; i < turns.length; i++) {
    const t = turns[i]!
    if (isApproval(t.text)) continue
    const prevSeq = turns[i - 1]!.seq ?? -1
    const seq = t.seq ?? Number.MAX_SAFE_INTEGER
    const cats = errors.filter((e) => e.seq > prevSeq && e.seq < seq).map((e) => e.cat)
    const mark = interrupts.find((m) => m > prevSeq && m < seq)
    out.push({
      text: t.text,
      seq: t.seq,
      errors: cats,
      did: didDigest(texts, calls, prevSeq, seq),
      interrupted: mark != null ? directionAt(texts, calls, prevSeq, mark) : undefined,
    })
  }
  return out
}

/** What the agent was doing right before an interrupt: its last action or statement in the window. */
function directionAt(
  texts: Array<{ seq: number; text: string }>,
  calls: Array<{ seq: number; action: string; path?: string; cmd?: string }>,
  fromSeq: number,
  toSeq: number,
): string {
  const last = <T extends { seq: number }>(xs: T[]) => xs.filter((x) => x.seq > fromSeq && x.seq < toSeq).at(-1)
  const c = last(calls)
  const t = last(texts)
  // Prefer whichever came later — the in-flight tool call usually IS the direction.
  if (c && (!t || c.seq >= t.seq)) return `running ${c.action}${c.path ? ` ${shortPath(c.path)}` : c.cmd ? ` \`${c.cmd}\`` : ''}`
  if (t) {
    const s = t.text.replace(/\s+/g, ' ').trim()
    return `saying: "${s.length > 140 ? '… ' + s.slice(-140) : s}"`
  }
  return ''
}

/**
 * "edited a.ts, b.ts; tools bash×2; said: …" — what the agent did between two
 * user turns, so the model can read the user's REACTION instead of guessing what
 * "no, not like that" refers to. Ends with the TAIL of the agent's last message
 * (its conclusion) rather than the head.
 */
function didDigest(
  texts: Array<{ seq: number; text: string }>,
  calls: Array<{ seq: number; action: string; path?: string }>,
  fromSeq: number,
  toSeq: number,
): string | undefined {
  const inWin = <T extends { seq: number }>(xs: T[]) => xs.filter((x) => x.seq > fromSeq && x.seq < toSeq)
  const parts: string[] = []
  const wc = inWin(calls)
  const edited = [...new Set(wc.filter((c) => c.action === 'file_write' && c.path).map((c) => shortPath(c.path!)))]
  if (edited.length) parts.push(`edited ${edited.slice(0, 3).join(', ')}${edited.length > 3 ? ` +${edited.length - 3}` : ''}`)
  const counts = new Map<string, number>()
  for (const c of wc) if (c.action !== 'file_write') counts.set(c.action, (counts.get(c.action) ?? 0) + 1)
  if (counts.size) parts.push('tools ' + [...counts.entries()].map(([a, n]) => (n > 1 ? `${a}×${n}` : a)).join(', '))
  const last = inWin(texts).at(-1)
  if (last) {
    const t = last.text.replace(/\s+/g, ' ').trim()
    parts.push(`said: "${t.length > 220 ? '… ' + t.slice(-220) : t}"`)
  }
  return parts.length ? parts.join('; ') : undefined
}

function shortPath(p: string): string {
  return p.split('/').slice(-2).join('/')
}

// Assistant "I can't do X" statements — the agent-limitation signal (plan Q4: phrasings to be broadened as other harnesses' transcripts are validated).
const LIMIT_RE =
  /\b(i can(?:no|')t\b|i cannot\b|i don'?t have (?:access|permission)|unable to (?:access|reach|run|connect)|not able to (?:access|reach|run)|you(?:'ll| will) need to (?:run|provide|paste))/i

function limitationSnippets(s: Session, max = 5): string[] {
  const out: string[] = []
  for (const ev of s.events) {
    if (ev.kind !== 'assistant' || ev.isSidechain) continue
    for (const b of ev.blocks) {
      if (b.type !== 'text') continue
      const m = LIMIT_RE.exec(b.text)
      if (!m) continue
      const at = Math.max(0, m.index - 40)
      out.push(trim(b.text.slice(at, m.index + 160).replace(/\s+/g, ' ').trim(), 200))
      if (out.length >= max) return out
    }
  }
  return out
}

// ---- prompt -----------------------------------------------------------------

const TOOL_NAME = 'record_friction'

function buildPrompt(session: Session, followups: Followup[], topics: FrictionTopicRef[]): { system: string; user: string } {
  const system =
    'You analyze the follow-up user messages of an AI coding session to find FRICTION: moments where the ' +
    'human had to nudge, correct, re-steer, re-supply context, or force rework of the agent. You also ' +
    `maintain a running list of friction topics across sessions. Report via the ${TOOL_NAME} tool.`

  const opener = userTurnEvents(session)[0]?.text ?? '(none)'
  const topicLines = topics.length
    ? topics.map((t) => `- [${t.id}] ${t.label} (${t.type})`).join('\n')
    : '(empty — no topics yet)'

  const user = [
    `Repo: ${session.project.repo ?? '(none)'}`,
    '',
    'Opening request (context only — never a friction event):',
    trim(opener.replace(/\s+/g, ' '), 600),
    '',
    `Follow-up user turns (${followups.length}, bare approvals already removed; "(after errors: …)" = failed`,
    'tool calls between the previous turn and this one; the indented "agent before:" line digests what the',
    "agent did and said just before that turn — context for reading the user's reaction, never itself friction):",
    numberedFollowups(followups),
    '',
    'Assistant limitation statements (the agent saying it cannot do something):',
    limitationSnippets(session)
      .map((x) => `- ${x}`)
      .join('\n') || '(none)',
    '',
    'Existing friction topics (match against these FIRST):',
    topicLines,
    '',
    'Friction means the AGENT FELL SHORT and the user had to compensate. The test for every event: "would a',
    'better-equipped agent (better docs, better tools, better instructions) have made this turn unnecessary?"',
    'If the turn would happen even with a perfect agent — it is the user thinking, deciding, or directing — it is NOT friction.',
    'The friction types:',
    '- re-steer: the user corrected a WRONG approach or a misunderstanding the agent had. Not a design choice.',
    '- context-supply: the user supplied information the agent should have found itself — pointing at files, dbs,',
    '  docs, pasting data the agent could have located. Includes having to ask what tools/skills the agent has',
    '  because its capabilities were not surfaced.',
    '- tool-gap: the user worked around something the agent could not do or reach (no access, missing tool).',
    '- rework: the user asked for work produced earlier IN THIS SESSION to be redone because it was wrong or',
    '  unusable. A pre-existing product bug or a change to older work is a NEW TASK, never rework.',
    '- preference: the user restated a personal/team convention the agent keeps missing (style, format, process).',
    'NOT friction (never emit these):',
    '- COLLABORATION: design discussion, the user answering an open question, choosing between options the agent',
    '  presented, weighing tradeoffs, raising edge cases, asking the agent questions. Thinking together is the',
    '  point of the tool, not a failure of it.',
    '- workflow progression ("commit and open a PR", "now do the next one", "mark it done") — even when it',
    "  follows tool errors: the error tag alone is NEVER friction, the turn's own text must react to the failure,",
    '- brand-new task requests and scope additions,',
    '- ordinary Q&A follow-ups where the user is learning, not correcting (but a question that identifies a',
    '  concrete defect the agent missed IS friction),',
    '- TASTE ITERATION: refining subjective output (visual design, wording, names) after seeing a draft or',
    '  render, when no explicit earlier spec was violated. It becomes friction only when the same correction',
    '  has to be repeated or the output contradicted an explicit instruction,',
    "- system/harness notifications and the user correcting their OWN earlier mistake.",
    'A "(user INTERRUPTED the agent …)" tag means the user cut the agent off mid-action (Esc); the tag names',
    'what the agent was doing. Use it ONLY to interpret that turn\'s text — the same test as error tags applies:',
    "the turn must react to the agent's direction, and an interrupt followed by an unrelated request or a pause",
    'to answer/think is NOT friction. The tag never makes an otherwise-collaborative turn friction.',
    'When the user repeatedly pastes screenshots to show the agent its own rendered output, the recurring gap',
    'is ONE tool-gap topic (the agent cannot verify rendered UI itself), not many per-tweak rework topics.',
    'Consecutive turns rejecting the same deliverable ("no, try again" × N) are ONE event, not N.',
    'Be sparse and certain: only emit an event when the agent clearly fell short. Emitting NO events is a',
    'common, correct answer for a smooth session.',
    'Rules for description: one abstract sentence a reader from another team would understand, phrased so',
    'recurrences across sessions read the same — e.g. "user had to tell the agent which env file holds the',
    'service credentials", "user had to run the deploy command themselves and paste the output", "user had to',
    'restate the team\'s changelog format" — never a quote, never session-specific details like line numbers.',
    'Rules for topics: a topic is a RECURRING friction pattern, named as a CONCRETE, ACTIONABLE gap in Title Case',
    '(6 words max) — name the specific missing thing ("Agent Tool Inventory Not Documented"), never an abstract',
    'theme ("Implementation Scope Ambiguity"). Match matched_topic_id ONLY when the event is genuinely another',
    'occurrence of that same specific gap — do NOT force-fit an event into a popular topic, and NEVER match',
    'just because the event shares a domain with a topic (two different metric mistakes are two topics, not one',
    '"metrics" topic); when unsure whether it matches, mint a new topic instead. Only propose new_topic_label',
    'for a pattern absent from the list.',
    'Use trigger=after_tool_error when the friction follows the turn\'s listed tool errors, after_review when the',
    "follow-up itself relays code-review feedback (quotes or paraphrases a reviewer's comments), agent_stated when",
    'it corresponds to an assistant limitation statement, else unprompted.',
  ].join('\n')

  return { system, user }
}

/** Number every follow-up [n] (with its error tag); for very long sessions keep head + tail, eliding the middle. */
function numberedFollowups(followups: Followup[], perMsg = 500, maxTurns = 36): string {
  const labeled = followups.map((f, i) => {
    const errTag = f.errors.length ? ` (after errors: ${countTag(f.errors)})` : ''
    const intTag = f.interrupted != null ? ` (user INTERRUPTED the agent${f.interrupted ? ` while it was ${f.interrupted}` : ''})` : ''
    const head = `[${i + 1}]${errTag}${intTag} ${trim(f.text.replace(/\s+/g, ' '), perMsg)}`
    return f.did ? `${head}\n    agent before: ${trim(f.did, 340)}` : head
  })
  if (labeled.length <= maxTurns) return labeled.join('\n')
  const head = labeled.slice(0, 12)
  const tail = labeled.slice(-(maxTurns - 12))
  return [...head, `… (${labeled.length - maxTurns} middle turn(s) omitted) …`, ...tail].join('\n')
}

function countTag(cats: string[]): string {
  const counts = new Map<string, number>()
  for (const c of cats) counts.set(c, (counts.get(c) ?? 0) + 1)
  return [...counts.entries()].map(([c, n]) => (n > 1 ? `${c}×${n}` : c)).join(', ')
}

const outputSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['events'],
  properties: {
    events: {
      type: 'array',
      description: 'One entry per follow-up turn that carries GENUINE friction; [] when none do.',
      items: {
        type: 'object',
        properties: {
          turn: { type: 'integer', description: 'The [n] index of the follow-up turn.' },
          type: { type: 'string', enum: TYPES },
          description: { type: 'string', description: 'ONE abstract, self-contained sentence naming the friction (not a quote).' },
          matched_topic_id: { type: 'string', description: 'Id of the existing topic this is another occurrence of, or empty.' },
          new_topic_label: { type: 'string', description: 'Concrete Title-Case label (max 6 words) for a NEW topic when none match, else empty.' },
          remedy_hint: { type: 'string', enum: REMEDIES },
          trigger: { type: 'string', enum: TRIGGERS },
        },
      },
    },
  },
}

// ---- parsing / sanitizing ---------------------------------------------------

/** Session-level rollups: the facet/measure denormalization of this session's events. */
function rollup(events: FrictionEventInput[]): AnnotationInput[] {
  return [
    { key: 'friction_count', value: events.length },
    { key: 'friction_type', value: [...new Set(events.map((e) => e.type))].sort() },
  ]
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  const s = str(v).toLowerCase() as T
  return allowed.includes(s) ? s : fallback
}

/**
 * Accept a proposed topic label only if it reads like a short concrete gap name;
 * run-on / comma-spliced strings drop the TOPIC (the event survives topicless)
 * rather than polluting the taxonomy. Mirrors featureTitle in enrich-session.
 */
function topicLabel(raw: unknown): string | null {
  const t = str(raw)
  if (!t) return null
  if (t.length > 60 || t.split(/\s+/).length > 8 || t.includes(',')) return null
  return t
}

function trim(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + ' …' : s
}

/** Mirrors enrich-session's slug so topic and feature id shapes stay consistent. */
function slug(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'untitled'
  )
}
