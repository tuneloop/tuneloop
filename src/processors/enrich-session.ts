import { registerProcessor } from '../core/registry'
import type { FeatureRef, Processor, ProcessorContext, ProcessorResult } from '../core/processor'
import type { Session } from '../core/model'
import { costOfUsage } from '../pricing/pricing'
import type {
  AnnotationInput,
  ArtifactInput,
  FeatureRevisionInput,
  OutcomeInput,
  SessionArtifactInput,
} from '../store/types'

const USE_CASES = ['plan', 'design', 'implement', 'research', 'debug', 'review', 'analysis', 'docs', 'other']
const COMPLEXITY = ['low', 'medium', 'high']
const AUTONOMY = ['autonomous', 'guided', 'minimal']
const SUCCESS = ['success', 'partial', 'failure', 'unknown']

/**
 * LLM enrichment in one batched structured call per session: use-case (multi),
 * complexity, autonomy, intent summary, key decisions, judged success — plus
 * feature linkage.
 *
 * `decisions` captures the consequential choices that shaped the session — a
 * technical approach taken, a tradeoff accepted, a scope cut, a library/tool
 * picked, an alternative explicitly rejected. It is deliberately separate from
 * `intent_summary` (which now states only the goal) so a reader can see WHAT was
 * decided, not just what was attempted. Each entry is one self-contained line
 * with the rationale inline; an empty list means nothing consequential was decided.
 *
 * The feature half is hierarchy-aware. The model sees the existing features as an
 * indented tree and is asked to (a) attach the session to the MOST SPECIFIC
 * feature that fits, (b) when nothing fits, propose a new (source='derived')
 * feature slotted under the right parent, and (c) reparent a feature it is
 * advancing via `feature_revisions`. Auto-rename is NOT offered: a bad rename
 * retroactively mislabels every session under a feature, so titles are fixed at
 * creation. User-authored features are shown but locked (never reparented).
 * Because the runner reads the tree fresh per session, edits compound across a run.
 */
export const enrichSession: Processor = {
  name: 'enrich-session',
  version: 9,
  kind: 'enrichment',
  needs: { llm: true },
  facets: [
    { key: 'use_case', label: 'Use Case', type: 'enum', source: 'annotation', multi: true, roles: ['chart', 'filter', 'detail'] },
    { key: 'complexity', label: 'Complexity', type: 'enum', source: 'annotation', roles: ['chart', 'filter', 'detail'] },
    { key: 'autonomy', label: 'Autonomy', type: 'enum', source: 'annotation', roles: ['chart', 'filter', 'detail'] },
    { key: 'success', label: 'Success', type: 'enum', source: 'annotation', roles: ['chart', 'filter', 'detail'] },
    { key: 'topics', label: 'Topics', type: 'string', source: 'annotation', multi: true, roles: ['chart'] },
  ],
  async run(ctx: ProcessorContext): Promise<ProcessorResult> {
    const { llm, session } = ctx
    if (!llm) return {}

    const { system, user } = buildPrompt(session, ctx.existingFeatures)
    const completion = await llm.complete({ system, user, maxTokens: 1500 })
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
      { key: 'decisions', value: decisionList(parsed.decisions) },
      { key: 'topics', value: topicList(parsed.topics) },
    ]

    const outcomes: OutcomeInput[] = []
    if (oneOf(parsed.success, SUCCESS) === 'success') {
      outcomes.push({ type: 'session_success', artifactId: null, ts: session.endedAt })
    }

    const repo = session.project.repo ?? null
    const existing = new Map(ctx.existingFeatures.map((f) => [f.id, f]))
    const isLocked = (id: string) => existing.get(id)?.source === 'user'
    // Repo isolation guard: an existing feature is a safe auto-link target only if
    // it is unscoped (global, e.g. a cross-repo epic) or already touches this repo.
    // A feature owned by other repos is never auto-linked or auto-edited from here.
    const inRepo = (f: FeatureRef) => !f.repos?.length || (repo != null && f.repos.includes(repo))
    // A new derived feature may nest under user-owned (epic) parents or any
    // parent this repo may use; otherwise it stays top-level.
    const canParent = (id: string) => {
      const p = existing.get(id)
      return !!p && (p.source === 'user' || inRepo(p))
    }

    // Session → feature links: attach to the most specific feature this repo may
    // use, else create a repo-scoped derived feature. We never link across repos.
    const artifacts: ArtifactInput[] = []
    const sessionArtifacts: SessionArtifactInput[] = []
    const linked = new Set<string>()
    const link = (id: string, confidence: number) => {
      if (linked.has(id)) return
      linked.add(id)
      sessionArtifacts.push({ artifactId: id, role: 'contributed', source: 'derived', confidence })
    }
    const features = Array.isArray(parsed.features) ? parsed.features : []
    for (const f of features) {
      const matched = str(f?.matched_feature_id)
      const mf = matched ? existing.get(matched) : undefined
      if (mf && inRepo(mf)) {
        link(mf.id, 0.6) // same-repo or global feature → link directly
        continue
      }
      // No usable match. Take the model's new title, or — if it tried to match a
      // feature owned by another repo — clone that concept into THIS repo (a
      // repo-scoped twin), never a cross-repo link.
      const title = featureTitle(f?.new_title ?? f?.title) ?? (mf ? featureTitle(mf.title) : null)
      if (!title) continue
      // Repo-qualify the id so identical titles in different repos stay distinct artifacts.
      const id = derivedFeatureId(repo, title)
      const parent = str(f?.parent_id)
      const parentArtifactId = parent && parent !== id && canParent(parent) ? parent : undefined
      artifacts.push({ id, kind: 'feature', title, source: 'derived', repo: repo ?? undefined, parentArtifactId })
      link(id, 0.5)
    }

    // Taxonomy upkeep: REPARENT only, and only for a feature this session is
    // itself advancing (in `linked`). Auto-rename is intentionally disabled — a
    // bad rename retroactively mislabels every session under that feature, far
    // worse than a slightly-stale title. Locked/user features are never touched;
    // the store also drops cycles.
    const featureRevisions: FeatureRevisionInput[] = []
    const revs = Array.isArray(parsed.feature_revisions) ? parsed.feature_revisions : []
    for (const r of revs) {
      const id = str(r?.feature_id)
      if (!id || isLocked(id) || !linked.has(id)) continue
      const rawParent = str(r?.new_parent_id)
      let parentId: string | null | undefined
      if (rawParent === 'root') parentId = null
      else if (rawParent && rawParent !== id && canParent(rawParent)) parentId = rawParent
      if (parentId === undefined) continue
      featureRevisions.push({ id, parentId })
    }

    return { annotations, outcomes, artifacts, sessionArtifacts, featureRevisions, selfCost }
  },
}

registerProcessor(enrichSession)

// ---- prompt -----------------------------------------------------------------

function buildPrompt(session: Session, features: FeatureRef[]): { system: string; user: string } {
  const system =
    'You analyze a single AI coding session, classify it, and maintain a hierarchical product-feature map. ' +
    'Respond with ONLY a single JSON object — no markdown fences, no commentary.'

  const featureTree = features.length
    ? renderFeatureTree(features)
    : '(empty — no features yet)'
  const repoLabel = session.project.repo ?? '(no repo)'

  const user = [
    `Summary of an AI coding session. This session's repo is "${repoLabel}".`,
    '',
    digest(session),
    '',
    'The full feature map across all repos (indentation = parent → child; "(locked)" = user-owned;',
    '{...} = the repos that feature spans, "{any repo}" = unscoped/global):',
    featureTree,
    '',
    'Return a JSON object with EXACTLY these fields:',
    '{',
    `  "use_cases": string[] chosen from [${USE_CASES.join(', ')}],`,
    `  "complexity": one of [${COMPLEXITY.join(', ')}],`,
    `  "autonomy": one of [${AUTONOMY.join(', ')}],`,
    '  "intent_summary": one sentence stating what the user set out to accomplish (the goal, not the decisions),',
    '  "decisions": string[] — the KEY decisions made during the session, newest insight last; [] if none,',
    `  "success": one of [${SUCCESS.join(', ')}],`,
    '  "topics": 2–5 specific technical-area tags, each a SHORT lowercase noun phrase (1–3 words) naming a subsystem, technology, or domain area touched — e.g. "authentication", "dashboard charts", "sqlite schema", "ci pipeline"; [] if none clearly apply,',
    '  "features": [ { "matched_feature_id": "<id of the most specific existing feature this session advanced, or empty>", "new_title": "<title for a NEW feature when none fit, else empty>", "parent_id": "<existing feature id to nest the new feature under, or empty for top-level>" } ],',
    '  "feature_revisions": [ { "feature_id": "<a feature THIS session advances, from the features above>", "new_parent_id": "<existing feature id to reparent it under, \\"root\\" for top-level, or empty to keep>" } ]',
    '}',
    'Grade `success` strictly — do NOT default to "success": "success" only when the session clearly ACHIEVED',
    'its stated goal (work completed and verified — tests/build pass, PR opened/merged, the user confirmed it);',
    '"partial" when it made real progress but left the goal unmet, was interrupted, or ended with unresolved',
    'errors; "failure" when it did not achieve the goal or was abandoned; "unknown" only when the transcript',
    'gives no signal either way. Most exploratory, interrupted, or still-in-progress sessions are "partial", not "success".',
    'Rules for topics: each tag is a concrete area actually worked in (a subsystem, technology, file area, or',
    'domain), never a generic filler like "code", "task", "work", "misc", or "general"; lowercase; no duplicates.',
    'What a key decision IS: a consequential choice that shaped the work and that a teammate reviewing this',
    'session later would want to know — a technical approach chosen, a tradeoff accepted, a scope cut, a',
    'library/tool/data-model picked, or an alternative explicitly rejected. Prefer the user\'s steering and the',
    'reasoning behind a turn over mechanical steps.',
    'Rules for decisions:',
    '- Each entry is ONE self-contained sentence; fold the rationale in with "because"/"to"/"over" ("Chose SQLite over Postgres to stay local-first").',
    '- Capture only what was actually settled in THIS session — not restated background, open questions, or routine edits (renames, formatting, obvious fixups).',
    '- Aim for the few decisions that genuinely mattered (typically 0–6). Use [] when the work carried no real decision (a chore, a trivial fix, pure research).',
    '- State each decision factually; do not begin entries with "The user" or "We".',
    'What a feature IS: one coherent product capability, named as a SHORT noun phrase (2–5 words, Title Case).',
    '  Good names: "Cost-per-PR metric", "Session outcome rate", "Dashboard KPI tiles", "Feature hierarchy extraction".',
    'A feature name is NOT a summary of the session. Never string capabilities together with commas or "and".',
    '  Bad (a session summary crammed into one feature):  "analyze command with cost-per-PR metric, session outcome rate tracking, and adoption positioning"',
    '  Good (name the ONE dominant feature):  "Session outcome rate".',
    'Rules for the feature map:',
    '- Map the session to AS FEW features as possible — ideally EXACTLY ONE: the single feature it primarily advanced. List that primary feature first.',
    '- Add a second feature (or, rarely, a third) ONLY when the session SUBSTANTIALLY advanced a genuinely separate capability. When unsure, pick just the one dominant feature. Incidental edits, fixups, or supporting changes do NOT each become a feature.',
    `- Repo isolation: only match (matched_feature_id) a feature tagged for this repo ("${repoLabel}") or tagged "{any repo}". To advance a feature that belongs only to OTHER repos, create a new feature instead — do not match it.`,
    '- Attach to the MOST SPECIFIC eligible feature via matched_feature_id; prefer matching an existing feature over creating a new one.',
    '- Do not split one capability into several features, and do not merge several capabilities into one run-on title.',
    '- Only set new_title when no eligible feature is specific enough. Keep it a short noun phrase (never a sentence or a list); place it under the best parent via parent_id (a same-repo, "{any repo}", or "(locked)" epic), leaving parent_id empty only for a genuinely top-level capability.',
    '- feature_revisions is ONLY for moving a feature you advanced (one you matched or created above) under a better parent. You CANNOT rename features. Never touch features you did not advance, other repos\' features, or "(locked)" features.',
    '- parent_id / new_parent_id must reference an id that already exists in the map above.',
    '- If the work is not feature-level (e.g. a chore, refactor, or pure research), use empty "features" and "feature_revisions" arrays.',
    'Output ONLY the JSON object.',
  ].join('\n')

  return { system, user }
}

/** Render the feature list as an indented tree (parent → child) for the prompt. */
function renderFeatureTree(features: FeatureRef[]): string {
  const ids = new Set(features.map((f) => f.id))
  const childrenOf = new Map<string, FeatureRef[]>()
  for (const f of features) {
    // Treat a feature whose parent is missing from the set as a root, so nothing is dropped.
    const key = f.parentId && ids.has(f.parentId) ? f.parentId : ''
    const arr = childrenOf.get(key) ?? []
    arr.push(f)
    childrenOf.set(key, arr)
  }
  const lines: string[] = []
  const seen = new Set<string>()
  const walk = (f: FeatureRef, depth: number) => {
    if (seen.has(f.id)) return // guard against parent cycles
    seen.add(f.id)
    const lock = f.source === 'user' ? ' (locked)' : ''
    const repos = f.repos && f.repos.length ? f.repos.join(', ') : 'any repo'
    lines.push(`${'  '.repeat(depth)}- [${f.id}] ${f.title}${lock} {${repos}}`)
    for (const c of childrenOf.get(f.id) ?? []) walk(c, depth + 1)
  }
  for (const root of childrenOf.get('') ?? []) walk(root, 0)
  for (const f of features) if (!seen.has(f.id)) walk(f, 0) // any left by a cycle
  return lines.join('\n')
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

/**
 * Sanitize the model's `decisions` into a small set of clean, distinct one-liners.
 * Drops blanks and exact duplicates, trims trailing punctuation noise, and caps
 * the count so a verbose model can't bury the genuinely key decisions.
 */
function decisionList(v: unknown): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of strArray(v)) {
    const d = raw.replace(/\s+/g, ' ').trim()
    if (!d) continue
    const key = d.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(d)
    if (out.length >= 8) break
  }
  return out
}

// Generic filler a weak model falls back to — dropped so topics stay meaningful.
const TOPIC_STOP = new Set(['misc', 'other', 'general', 'various', 'code', 'task', 'tasks', 'work', 'session', 'stuff', 'changes', 'misc.'])

/**
 * Sanitize `topics` into a few clean, specific lowercase tags: trims and lowercases,
 * drops generic filler and over-long phrases (which signal a session summary, not a
 * tag), dedupes, and caps the count. Parallels decisionList / sanitizeList.
 */
function topicList(v: unknown): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of strArray(v)) {
    const t = raw.toLowerCase().replace(/\s+/g, ' ').replace(/[.;,]+$/, '').trim()
    if (!t || t.length > 40 || t.split(' ').length > 4) continue
    if (TOPIC_STOP.has(t) || seen.has(t)) continue
    seen.add(t)
    out.push(t)
    if (out.length >= 6) break
  }
  return out
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

/**
 * Accept a model-proposed feature name only if it reads like a feature (a short
 * noun phrase), rejecting the run-on "session summary" strings a weaker model
 * sometimes emits — long, comma-spliced, or many-claused. Returning null drops
 * the proposal (no junk feature enters the taxonomy) rather than storing garbage.
 */
function featureTitle(raw: unknown): string | null {
  const t = str(raw)
  if (!t) return null
  if (t.length > 72 || t.split(/\s+/).length > 9 || t.includes(',')) return null
  return t
}

/** Repo-qualified id for a derived feature, so identical titles in different repos don't collide. */
function derivedFeatureId(repo: string | null, title: string): string {
  return `feature:derived:${repo ? slug(repo) : 'norepo'}:${slug(title)}`
}

function slug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'untitled'
}
