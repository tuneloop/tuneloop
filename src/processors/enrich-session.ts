import { registerProcessor } from '../core/registry'
import { blockSpine, deterministicBlocks } from '../core/blocks'
import type { Block } from '../core/blocks'
import type { FeatureRef, Processor, ProcessorContext, ProcessorResult } from '../core/processor'
import type { Session } from '../core/model'
import { isSyntheticUser, stripReminders } from '../core/turns'
import { costOfUsage } from '../pricing/pricing'
import type {
  AnnotationInput,
  ArtifactInput,
  BlockAnnotationInput,
  BlockArtifactInput,
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
 * `autonomy` measures how much the agent ran on its own, classified from how much
 * the user STEERED it rather than from the model's general impression (which
 * biased everything to "guided" — AL-33). It is a spectrum: "autonomous" (agent
 * ran end-to-end on minimal input beyond approvals) → "guided" (human gave
 * substantive direction at key points, agent executed) → "minimal" (heavy
 * involvement, frequent corrections/redirections). The digest surfaces a "steering
 * signal" — the count of substantive follow-up turns after the opener — but the
 * prompt asks the model to weigh their NATURE, since a follow-up may be genuine
 * direction ("use Postgres instead") or mere workflow progression ("commit and
 * open a PR", "mark it done"), and only the latter-vs-former call decides
 * autonomous-vs-guided. Two upstream fixes make this work: `userTurns` drops
 * Claude-injected pseudo-user turns (slash-command echoes, local-command
 * caveats/stdout) so the opener is the first REAL prompt, and the count excludes
 * bare approvals. Both matter because the user spine is truncated for long
 * sessions, so the model cannot reliably reconstruct the count itself.
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
  version: 12,
  kind: 'enrichment',
  needs: { llm: true },
  requires: ['segment-blocks'],
  facets: [
    // use_case is BLOCK-grain: a session's spend time-slices across its blocks'
    // use-cases (P3). Session-level filter/detail roll up via block_annotations.
    { key: 'use_case', label: 'Work type', type: 'enum', source: 'block', roles: ['chart', 'filter', 'detail'] },
    { key: 'complexity', label: 'Complexity', type: 'enum', source: 'annotation', roles: ['chart', 'filter', 'detail'] },
    { key: 'autonomy', label: 'Autonomy', type: 'enum', source: 'annotation', roles: ['chart', 'filter', 'detail'] },
    // NOTE: `success` is deliberately NOT a facet. The LLM judgment is surfaced to
    // users only as the `session_success` outcome; the raw 4-way grade stays as
    // a plain annotation (below) for traceability, not exposed in any UI.
  ],
  async run(ctx: ProcessorContext): Promise<ProcessorResult> {
    const { llm, session } = ctx
    if (!llm) return {}

    const blocks = deterministicBlocks(session)
    const { system, user } = buildPrompt(session, ctx.existingFeatures, blocks)
    const completion = await llm.complete({ system, user, maxTokens: 2200 })
    const selfCost = { tokens: completion.usage, usd: costOfUsage(llm.provider, llm.model, completion.usage) }

    const parsed = parseJson(completion.text)
    if (!parsed) {
      ctx.log.warn(`enrich-session: unparseable LLM output for ${session.id}`)
      return { selfCost } // record the spend; don't re-charge on every run
    }

    // Session-level classification (P4: success/autonomy/complexity stay per-session).
    // use_case is NOT here — it's block-grain (see block labels below).
    const annotations: AnnotationInput[] = [
      { key: 'complexity', value: oneOf(parsed.complexity, COMPLEXITY) },
      { key: 'autonomy', value: oneOf(parsed.autonomy, AUTONOMY) },
      // Trace-only: the raw 4-way grade is kept for inspection but is not a facet
      // (see facets[] above). The user-facing signal is the outcome below.
      { key: 'success', value: oneOf(parsed.success, SUCCESS) },
      { key: 'intent_summary', value: str(parsed.intent_summary) },
      { key: 'decisions', value: decisionList(parsed.decisions) },
    ]

    // The LLM-judged "did this session accomplish its task(s)" signal lives in the
    // outcomes list (alongside git-derived pr_merged etc.), not as a facet.
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

    // Feature linkage is BLOCK-FIRST: the model attaches features to block ranges
    // (feature_runs); the session's feature set is the UNION of its blocks'
    // features (exactly like the use_case rollup). The `features` palette only
    // NAMES the candidates that feature_runs reference by index — a palette entry
    // never tied to a block is dropped, so session-level and block-level features
    // can never diverge. We never link across repos.
    const features = Array.isArray(parsed.features) ? parsed.features : []
    const palette: Array<{ id: string; create?: ArtifactInput }> = []
    for (const f of features) {
      const matched = str(f?.matched_feature_id)
      const mf = matched ? existing.get(matched) : undefined
      if (mf && inRepo(mf)) { palette.push({ id: mf.id }); continue } // existing same-repo/global feature
      // No usable match → propose a repo-scoped derived feature (created only if used).
      const title = featureTitle(f?.new_title ?? f?.title) ?? (mf ? featureTitle(mf.title) : null)
      if (!title) { palette.push({ id: '' }); continue }
      const id = derivedFeatureId(repo, title)
      const parent = str(f?.parent_id)
      const parentArtifactId = parent && parent !== id && canParent(parent) ? parent : undefined
      palette.push({ id, create: { id, kind: 'feature', title, source: 'derived', repo: repo ?? undefined, parentArtifactId } })
    }

    // Block labels: use_case per block (use_case_runs) + block→feature links
    // (feature_runs: sparse, non-overlapping, palette-resolved). `linked`
    // accumulates the UNION of features any block advanced.
    const blockAnnotations: BlockAnnotationInput[] = []
    const blockArtifacts: BlockArtifactInput[] = []
    const linked = new Set<string>()
    if (blocks.length > 0) {
      expandUseCaseRuns(parsed.use_case_runs, blocks.length).forEach((uc, idx) =>
        blockAnnotations.push({ blockIdx: idx, key: 'use_case', value: uc }),
      )
      const assigned = new Set<number>()
      for (const run of featureRuns(parsed.feature_runs)) {
        const id = palette[run.feature]?.id || ''
        if (!id) continue
        linked.add(id)
        for (let i = Math.max(0, run.from); i <= Math.min(blocks.length - 1, run.to); i++) {
          if (assigned.has(i)) continue
          assigned.add(i)
          blockArtifacts.push({ blockIdx: i, artifactId: id, role: 'contributed', source: 'derived', confidence: 0.5 })
        }
      }
    }

    // Session → feature links + new-feature creation, DERIVED from the block union:
    // only features with block coverage are linked/created, so the Summary and the
    // transcript's View-by features always agree.
    const artifacts: ArtifactInput[] = []
    const sessionArtifacts: SessionArtifactInput[] = []
    const emitted = new Set<string>()
    for (const slot of palette) {
      if (!slot.id || !linked.has(slot.id) || emitted.has(slot.id)) continue
      emitted.add(slot.id)
      if (slot.create) artifacts.push(slot.create)
      sessionArtifacts.push({ artifactId: slot.id, role: 'contributed', source: 'derived', confidence: 0.6 })
    }

    // Taxonomy upkeep: REPARENT only, and only for a feature this session advanced
    // (in `linked`). Auto-rename stays disabled; locked/user features untouched.
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

    return {
      annotations,
      outcomes,
      artifacts,
      sessionArtifacts,
      featureRevisions,
      blockAnnotations,
      blockArtifacts,
      selfCost,
    }
  },
}

registerProcessor(enrichSession)

// ---- prompt -----------------------------------------------------------------

function buildPrompt(session: Session, features: FeatureRef[], blocks: Block[]): { system: string; user: string } {
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
    `Blocks — the session split into ${blocks.length} contiguous slice(s); boundaries are FIXED (label every one):`,
    blockSpine(session, blocks),
    '',
    'The full feature map across all repos (indentation = parent → child; "(locked)" = user-owned;',
    '{...} = the repos that feature spans, "{any repo}" = unscoped/global):',
    featureTree,
    '',
    'Return a JSON object with EXACTLY these fields:',
    '{',
    `  "complexity": one of [${COMPLEXITY.join(', ')}],`,
    `  "autonomy": one of [${AUTONOMY.join(', ')}],`,
    '  "intent_summary": one sentence stating what the user set out to accomplish (the goal, not the decisions),',
    '  "decisions": string[] — the KEY decisions made during the session, newest insight last; [] if none,',
    `  "success": one of [${SUCCESS.join(', ')}],`,
    '  "features": [ { "matched_feature_id": "<id of the most specific existing feature this session advanced, or empty>", "new_title": "<title for a NEW feature when none fit, else empty>", "parent_id": "<existing feature id to nest the new feature under, or empty for top-level>" } ],',
    '  "feature_revisions": [ { "feature_id": "<a feature THIS session advances, from the features above>", "new_parent_id": "<existing feature id to reparent it under, \\"root\\" for top-level, or empty to keep>" } ],',
    `  "use_case_runs": [ { "from": <block idx>, "to": <block idx>, "use_case": one of [${USE_CASES.join(', ')}] } ],`,
    '  "feature_runs": [ { "from": <block idx>, "to": <block idx>, "feature": <0-based index into the "features" array above> } ]',
    '}',
    'How to classify autonomy — it measures how much the AGENT ran on its own. Look at the user turns AFTER the',
    'opening request and judge how much they STEERED the work. Steering = a correction, a redirection, a design',
    'choice, or a new requirement. NOT steering: the opening request itself, bare approvals ("yes", "continue",',
    '"looks good"), and routine progression that only advances the workflow ("commit and open a PR", "mark it',
    'done", "now do the next one") — those mean the user is letting the agent run, not directing it.',
    '- "autonomous": the agent executed end-to-end on minimal input beyond approvals — no or very few genuinely',
    '  steering turns; the agent decided HOW to do the work. A session kicked off with one request and then only',
    '  nudged forward ("commit", "open a PR", "mark it done") is autonomous, even if it ran long.',
    '- "guided": the user gave substantive direction at KEY POINTS — choosing an approach, correcting course, or',
    '  adding requirements — and the agent handled execution in between.',
    '- "minimal": minimal agent autonomy — frequent corrections or redirections, a tight back-and-forth where the',
    '  user steered most steps.',
    'Do NOT default to "guided": when the user mostly approved and let the agent run, choose "autonomous".',
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
    'Rules for use_case_runs (the use-case of each block, in time order):',
    `- Cover EVERY block index 0..${Math.max(0, blocks.length - 1)} with contiguous, non-overlapping runs (a partition). Merge adjacent blocks of the same use-case into one run; expect FEW runs (work changes use-case only a few times).`,
    '- Pick the single dominant use_case per run.',
    'What each use_case means (pick the best fit; when two could apply, choose the one the block\'s actions center on):',
    '- plan: laying out an approach or breaking work into steps before building — little or no code written yet.',
    '- design: deciding the SHAPE of the solution (architecture, interfaces, data models, tradeoffs), beyond just sequencing steps.',
    '- implement: writing or changing code/config to build or modify functionality — the default for hands-on building.',
    '- debug: diagnosing and fixing a specific failure — reproducing, tracing, and correcting a bug, test failure, or error.',
    '- review: evaluating existing code or a change for quality/correctness (PR or code review, critique, security/architecture audit), not authoring the feature.',
    '- research: gathering EXTERNAL or unfamiliar information — reading vendor docs, web search, learning a new library/API.',
    '- analysis: examining THIS project\'s own code or data to understand or measure it — tracing how something works, auditing, computing metrics (internal focus, vs research\'s external focus).',
    '- docs: writing or updating human-facing prose — READMEs, code comments, changelogs, guides.',
    '- other: work that fits none of the above — chores, dependency bumps, environment/CI setup, git mechanics.',
    'Rules for feature_runs (which blocks advanced which feature):',
    '- SPARSE: emit a run ONLY for blocks that substantially advanced a feature; chores/research/fixups belong to no feature — leave them out.',
    '- "feature" is the 0-based index into the "features" array above. Runs must not overlap. Most sessions need 0–2 feature_runs.',
    '- The session is credited a feature ONLY through feature_runs, so give every feature you list in "features" at least one feature_run; a feature with no run is dropped.',
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
  const followups = followupTurns(turns)
  const files = unique(s.toolCalls.filter((t) => t.action === 'file_write').flatMap((t) => t.target.paths ?? [])).slice(0, 40)
  const cmds = s.toolCalls
    .filter((t) => t.action === 'shell' && t.target.command)
    .map((t) => (t.target.command as string).replace(/\s+/g, ' ').slice(0, 120))
    .slice(0, 20)
  const tail = assistantTail(s).slice(-1200)

  return [
    `Models: ${s.models.join(', ') || 'unknown'}`,
    `User turns: ${turns.length} | Tool calls: ${s.toolCalls.length}`,
    `Steering signal: ${followups.length} of ${turns.length} user turn(s) were follow-ups after the opening ` +
      `request (bare approvals like "yes"/"continue" already excluded). Judge how many GENUINELY steered the ` +
      `work — a correction, redirection, design choice, or new requirement — versus routine "do the next step" ` +
      `progression ("commit and open a PR", "mark it done"), which is the user letting the agent run. Only ` +
      `genuine steering pushes toward guided/minimal.`,
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

/**
 * All main-thread human turns, in order. Excludes sidechain (subagent) turns,
 * strips injected reminders, and drops Claude-injected pseudo-user turns —
 * slash-command echoes, local-command caveats/stdout, interrupts, tool
 * rejections. Those are machinery, not the human steering the agent; counting
 * them skewed the opener (the first REAL prompt) and the autonomy signal (AL-33).
 */
function userTurns(s: Session): string[] {
  const out: string[] = []
  for (const ev of s.events) {
    if (ev.kind !== 'user' || ev.isSidechain) continue
    const t = stripReminders(ev.text)
    if (t && !isSyntheticUser(t)) out.push(t)
  }
  return out
}

/**
 * Substantive follow-up turns: the user turns AFTER the opening request, minus
 * bare approvals/continuations ("yes", "continue"). This is a CEILING on
 * steering, not steering itself — a follow-up may be genuine direction
 * ("use Postgres instead") or mere workflow progression ("commit and open a PR",
 * "mark it done"), and only the model can tell those apart from the text. The
 * count feeds the autonomy classification (autonomous → guided → minimal as
 * genuine steering rises; see AL-33). Deliberately conservative: only whole-turn
 * known approvals are dropped, so nothing substantive is hidden from the model.
 */
function followupTurns(turns: string[]): string[] {
  return turns.slice(1).filter((t) => !isApproval(t))
}

/** A short, content-free affirmation/continuation ("yes", "ok continue") that lets the agent proceed rather than redirecting it. */
function isApproval(text: string): boolean {
  const t = text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim()
  if (!t) return true
  if (t.split(' ').length > 6) return false // too long to be a bare approval
  return APPROVAL_RE.test(t)
}

// Whole-turn approval/continuation phrases (matched against punctuation-stripped,
// lowercased text). Kept conservative — when unsure, a turn counts as steering.
const APPROVAL_RE =
  /^(y|yes|yep|yup|yeah|ya|ok|okay|k|kk|sure|fine|cool|great|perfect|nice|good|awesome|excellent|thanks|thank you|thanks a lot|thank you so much|ty|thx|continue|please continue|proceed|go|go ahead|go for it|go on|do it|do that|keep going|carry on|next|lgtm|looks good|looks great|that works|sounds good|ship it|approved|correct|right|exactly|agreed|got it|makes sense|yes please|ok thanks|perfect thanks|great thanks|yes continue|ok continue|ok go ahead|sure go ahead)$/

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

function oneOf(v: unknown, allowed: string[]): string {
  const s = str(v).toLowerCase()
  return allowed.includes(s) ? s : 'unknown'
}

function intOf(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) ? v : null
}

/**
 * Expand the model's use_case_runs into one use_case per block, tiling [0,n).
 * Out-of-range / invalid runs are clamped or dropped. Unlabeled blocks fall to
 * 'unclassified'; a gap bracketed by the SAME label on both sides inherits it
 * (use-case is sticky). A miss degrades quality, never cost (see plan).
 */
function expandUseCaseRuns(v: unknown, n: number): string[] {
  const out = new Array<string>(n).fill('unclassified')
  const filled = new Array<boolean>(n).fill(false)
  if (Array.isArray(v)) {
    for (const r of v) {
      const uc = oneOf(r?.use_case, USE_CASES)
      const from = intOf(r?.from)
      const to = intOf(r?.to)
      if (uc === 'unknown' || from == null || to == null) continue
      for (let i = Math.max(0, Math.min(from, to)); i <= Math.min(n - 1, Math.max(from, to)); i++) {
        out[i] = uc
        filled[i] = true
      }
    }
  }
  for (let i = 0; i < n; i++) {
    if (filled[i]) continue
    let p = i - 1
    while (p >= 0 && !filled[p]) p--
    let q = i + 1
    while (q < n && !filled[q]) q++
    if (p >= 0 && q < n && out[p] === out[q]) out[i] = out[p]!
  }
  return out
}

/** Normalize feature_runs into clamped {from,to,feature} entries (caller resolves the palette index). */
function featureRuns(v: unknown): Array<{ from: number; to: number; feature: number }> {
  if (!Array.isArray(v)) return []
  const out: Array<{ from: number; to: number; feature: number }> = []
  for (const r of v) {
    const from = intOf(r?.from)
    const to = intOf(r?.to)
    const feature = intOf(r?.feature)
    if (from == null || to == null || feature == null) continue
    out.push({ from: Math.min(from, to), to: Math.max(from, to), feature })
  }
  return out
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
