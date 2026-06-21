import { registerProcessor } from '../core/registry'
import type { FeatureRef, Processor, ProcessorContext, ProcessorResult } from '../core/processor'
import type { Session } from '../core/model'
import { costOfUsage } from '../pricing/pricing'
import type { AnnotationInput, ArtifactInput, OutcomeInput, SessionArtifactInput } from '../store/types'

const USE_CASES = ['plan', 'design', 'implement', 'research', 'debug', 'review', 'analysis', 'docs', 'other']
const COMPLEXITY = ['low', 'medium', 'high']
const AUTONOMY = ['autonomous', 'guided', 'minimal']
const SUCCESS = ['success', 'partial', 'failure', 'unknown']

/**
 * LLM enrichment in one batched structured call per session: use-case (multi),
 * complexity, autonomy, intent summary, judged success — plus the
 * topics/features field, which leans toward FEATURES (derived linkage). It maps
 * the session onto the user's existing feature list, biased toward it, and only
 * proposes a new (source='derived') feature when nothing fits — per
 * prd_features_shipped.md's derived-linkage mechanism.
 */
export const enrichSession: Processor = {
  name: 'enrich-session',
  version: 2,
  kind: 'enrichment',
  needs: { llm: true },
  facets: [
    { key: 'use_case', label: 'Use Case', type: 'enum', source: 'annotation', multi: true, roles: ['chart', 'filter'] },
    { key: 'complexity', label: 'Complexity', type: 'enum', source: 'annotation', roles: ['chart', 'filter'] },
    { key: 'autonomy', label: 'Autonomy', type: 'enum', source: 'annotation', roles: ['chart', 'filter'] },
    { key: 'success', label: 'Success', type: 'enum', source: 'annotation', roles: ['chart', 'filter'] },
    { key: 'topics', label: 'Topics', type: 'string', source: 'annotation', multi: true, roles: ['chart'] },
  ],
  async run(ctx: ProcessorContext): Promise<ProcessorResult> {
    const { llm, session } = ctx
    if (!llm) return {}

    const { system, user } = buildPrompt(session, ctx.existingFeatures)
    const completion = await llm.complete({ system, user, maxTokens: 1024 })
    const selfCost = { tokens: completion.usage, usd: costOfUsage(llm.provider, llm.model, completion.usage) }

    const parsed = parseJson(completion.text)
    if (!parsed) {
      ctx.log.warn(`enrich-session: unparseable LLM output for ${session.id}`)
      return { selfCost } // record the spend; don't re-charge on every run
    }

    const annotations: AnnotationInput[] = [
      { key: 'use_case', value: sanitizeList(parsed.use_cases, USE_CASES) },
      { key: 'complexity', value: oneOf(parsed.complexity, COMPLEXITY) },
      { key: 'autonomy', value: oneOf(parsed.autonomy, AUTONOMY) },
      { key: 'success', value: oneOf(parsed.success, SUCCESS) },
      { key: 'intent_summary', value: str(parsed.intent_summary) },
      { key: 'topics', value: strArray(parsed.topics).slice(0, 12) },
    ]

    const outcomes: OutcomeInput[] = []
    if (oneOf(parsed.success, SUCCESS) === 'success') {
      outcomes.push({ type: 'session_success', artifactId: null, ts: session.endedAt })
    }

    const artifacts: ArtifactInput[] = []
    const sessionArtifacts: SessionArtifactInput[] = []
    const existingIds = new Set(ctx.existingFeatures.map((f) => f.id))
    const features = Array.isArray(parsed.features) ? parsed.features : []
    for (const f of features) {
      const title = str(f?.title)
      if (!title) continue
      const matched = str(f?.matched_feature_id)
      if (matched && existingIds.has(matched)) {
        sessionArtifacts.push({ artifactId: matched, role: 'contributed', source: 'derived', confidence: 0.6 })
      } else {
        const id = `feature:derived:${slug(title)}`
        artifacts.push({ id, kind: 'feature', title, source: 'derived' })
        sessionArtifacts.push({ artifactId: id, role: 'contributed', source: 'derived', confidence: 0.5 })
      }
    }

    return { annotations, outcomes, artifacts, sessionArtifacts, selfCost }
  },
}

registerProcessor(enrichSession)

// ---- prompt -----------------------------------------------------------------

function buildPrompt(session: Session, features: FeatureRef[]): { system: string; user: string } {
  const system =
    'You analyze a single AI coding session and classify it. ' +
    'Respond with ONLY a single JSON object — no markdown fences, no commentary.'

  const featureList = features.length
    ? features.map((f) => `- [${f.id}] ${f.title}`).join('\n')
    : '(none yet — propose a feature title only if the work clearly maps to a product feature)'

  const user = [
    'Summary of an AI coding session:',
    '',
    digest(session),
    '',
    'Existing features (prefer matching the session to one of these):',
    featureList,
    '',
    'Return a JSON object with EXACTLY these fields:',
    '{',
    `  "use_cases": string[] chosen from [${USE_CASES.join(', ')}],`,
    `  "complexity": one of [${COMPLEXITY.join(', ')}],`,
    `  "autonomy": one of [${AUTONOMY.join(', ')}],`,
    '  "intent_summary": one sentence capturing the user\'s intent and key decisions,',
    `  "success": one of [${SUCCESS.join(', ')}],`,
    '  "topics": short list of free-text areas touched,',
    '  "features": [ { "matched_feature_id": "<existing id, or empty string>", "title": "<feature title>", "is_new": <boolean> } ]',
    '}',
    'Map to the most specific existing feature when possible; set is_new=true with an empty matched_feature_id only if none fit. ',
    'If the work is not feature-level (e.g. a chore or pure research), use an empty features array.',
    'Output ONLY the JSON object.',
  ].join('\n')

  return { system, user }
}

function digest(s: Session): string {
  const turns = userTurns(s)
  const files = unique(s.toolCalls.filter((t) => t.action === 'file_write').flatMap((t) => t.target.paths ?? [])).slice(0, 40)
  const cmds = s.toolCalls
    .filter((t) => t.action === 'shell' && t.target.command)
    .map((t) => (t.target.command as string).replace(/\s+/g, ' ').slice(0, 120))
    .slice(0, 20)
  const tail = assistantTail(s).slice(-1200)

  return [
    `Models: ${s.models.join(', ') || 'unknown'}`,
    `User turns: ${turns.length} | Tool calls: ${s.toolCalls.length}`,
    '',
    'User messages (the human side, in order — read these for intent, steering, and reactions):',
    userSpine(turns),
    '',
    `Files written (${files.length}):`,
    files.map((f) => `- ${f}`).join('\n') || '(none)',
    '',
    'Shell commands (sample):',
    cmds.map((c) => `- ${c}`).join('\n') || '(none)',
    '',
    'Final assistant message (tail):',
    tail || '(none)',
  ].join('\n')
}

/** All main-thread human turns, in order. Excludes sidechain (subagent) turns and strips injected reminders. */
function userTurns(s: Session): string[] {
  const out: string[] = []
  for (const ev of s.events) {
    if (ev.kind !== 'user' || ev.isSidechain) continue
    const t = stripReminders(ev.text)
    if (t) out.push(t)
  }
  return out
}

function stripReminders(text: string): string {
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .trim()
}

/** Keep every turn within budget; for very long sessions keep the opening + most recent and elide the middle. */
function userSpine(turns: string[], perMsg = 800, totalBudget = 6000): string {
  if (turns.length === 0) return '(none)'
  const labeled = turns.map((t, i) => `[${i + 1}] ${t.length > perMsg ? t.slice(0, perMsg) + ' …' : t}`)
  if (labeled.length <= 8 || labeled.join('\n').length <= totalBudget) return labeled.join('\n')
  const head = labeled.slice(0, 3)
  const tail = labeled.slice(-5)
  return [...head, `… (${labeled.length - head.length - tail.length} middle message(s) omitted) …`, ...tail].join('\n')
}

function assistantTail(s: Session): string {
  const parts: string[] = []
  for (const ev of s.events) {
    if (ev.kind !== 'assistant') continue
    for (const b of ev.blocks) if (b.type === 'text' && b.text.trim()) parts.push(b.text)
  }
  return parts.join('\n')
}

// ---- parsing / sanitizing ---------------------------------------------------

function parseJson(text: string): Record<string, any> | null {
  const tryParse = (s: string): Record<string, any> | null => {
    try {
      const v = JSON.parse(s)
      return v && typeof v === 'object' ? v : null
    } catch {
      return null
    }
  }
  const direct = tryParse(text.trim())
  if (direct) return direct
  const match = text.match(/\{[\s\S]*\}/)
  return match ? tryParse(match[0]) : null
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.map(str).filter(Boolean) : []
}

function oneOf(v: unknown, allowed: string[]): string {
  const s = str(v).toLowerCase()
  return allowed.includes(s) ? s : 'unknown'
}

function sanitizeList(v: unknown, allowed: string[]): string[] {
  const set = new Set(allowed)
  const out = strArray(v).map((s) => s.toLowerCase()).filter((s) => set.has(s))
  return out.length ? [...new Set(out)] : ['other']
}

function unique<T>(arr: T[]): T[] {
  return [...new Set(arr)]
}

function slug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'untitled'
}
