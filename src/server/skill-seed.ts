/**
 * Synthetic skill-data generator — seeds a store with realistic sessions,
 * skill tool_calls, and versioned skills-category environment_snapshots that
 * deliberately cover every edge case the Skills tab features must handle.
 *
 * Why this exists: building the per-repo / drift / co-occurrence / activation
 * features against one developer's real usage overfits the logic + UI to that
 * usage and misses edge cases (lost intermediate versions, A→B→A reverts,
 * too-little-data on one side of an edit, scope-down, not-in-config, ambiguous
 * repo basenames, co-occurrence vs never). We generate a broad, labelled
 * dataset here, build + unit-test each feature against it, and only THEN
 * validate against a real seeded store — synthetic for coverage, real for truth.
 *
 * Shape-faithful to what `analyze` writes: sessions.repo (short name) + tool_calls
 * (action='skill', main-thread, ts) + skills-category snapshots recorded via
 * store.recordEnvSnapshot at explicit timestamps (append-on-change, keyed on the
 * whole-category payload hash — so a version boundary is a snapshot whose review
 * body changed). Version history is only as granular as the capture cadence, so
 * the "lost intermediate" case is modelled by editing a body WITHOUT recording a
 * snapshot in between.
 *
 * Reusable: `seedSkillStore(store, opts)` returns an EXPECTATIONS manifest that
 * unit tests assert against (deterministic when `nowMs` is fixed).
 *
 * This lives under `src/` (not `scripts/`) so tests can import it under the Node
 * `rootDir: src` typecheck; it never ships — tsup only bundles from cli.ts/index.ts.
 */

import { contentHash } from '../core/hash'
import type { Store } from '../store/store'

const SOURCE = 'claude-code'
const DAY = 86_400_000

/** A skill body at a point in time — the generator hashes this to a bodyHash. */
interface SkillState {
  name: string
  body: string
  description?: string
}

/** One captured config state: the full skills inventory as of `dayAgo`. */
interface CaptureState {
  dayAgo: number
  skills: SkillState[]
}

/** A single skill invocation to emit as a tool_call. */
interface Invocation {
  skill: string
  /** Extra plugin namespace form, e.g. 'frontend-design:frontend-design'. */
  raw?: string
  /** The skill's OWN tool call errored (drives errorCalls / the version-timeline error rate). */
  error?: boolean
  /** Fired inside a subagent (sidechain) — counts as usage but is never outcome-judged. */
  sidechain?: boolean
  /** A pre-classified activation outcome, stand-in for the LLM classifier's verdict
   *  (so the read model + UI can be exercised without a real LLM). */
  outcome?: 'used' | 'reworked' | 'ignored' | 'unclear'
  /** Whether the seeded verdict flags an adjacent user correction. */
  correction?: boolean
}

/** What the generator guarantees about the seeded data, for test assertions. */
export interface SeedExpectations {
  nowMs: number
  /** Skills that should read as used (invoked in a 30d window). */
  used: string[]
  /** Skills installed but never invoked in a 30d window. */
  unused: string[]
  /** Global skills used in only a subset of active repos → scope-down candidates,
   *  each with the exact repos they're used in (the per-repo breakdown's evidence). */
  scopeDown: Array<{ name: string; repos: string[] }>
  /** Global skill used broadly (>half of repos) → must NOT be scope-down. */
  notScopeDown: { name: string; repos: string[] }
  /** Invoked but absent from every config snapshot. */
  notInConfig: string[]
  /** review's version boundaries (days-ago of each captured edit), oldest→newest. */
  reviewEditsDaysAgo: number[]
  /** review's bodyHash per captured version, oldest→newest (for drift-diff tests). */
  reviewHashes: string[]
  /** A version boundary the generator skipped capturing (lost-intermediate case). */
  lostIntermediate: { skill: string; dayAgo: number }
  /** Pairs that co-occur in the same session, with the session count they share. */
  coOccur: Array<{ a: string; b: string; sessions: number }>
  /** Repos that have sessions but where `browse` was never used. */
  browseAbsentRepos: string[]
  /** review's seeded activation-outcome distribution (30d window) + correction count. */
  reviewOutcomes: { classified: number; used: number; reworked: number; ignored: number; userCorrectionAdjacent: number }
  /** The skill seeded past BOTH often-bypassed gates (judged floor + bypass share), with
   *  its 30d judged/bypassed counts. review is the deliberate near-miss (11 judged, ~45%). */
  oftenBypassed: { name: string; judged: number; bypassed: number }
  /** The skill with seeded subagent (sidechain) firings + how many (30d window). */
  subagentUsage: { name: string; calls: number }
}

interface SeedOptions {
  /** Evaluation "now" in ms. Fixed value → deterministic seed (tests pass this). */
  nowMs: number
}

/**
 * Seed `store` with the synthetic corpus. Returns the expectations manifest.
 * Idempotent per store only in the sense that it INSERTs — call once on a fresh db.
 */
export function seedSkillStore(store: Store, opts: SeedOptions): SeedExpectations {
  const { nowMs } = opts
  const db = (store as unknown as { db: import('better-sqlite3').Database }).db
  const iso = (dayAgo: number) => new Date(nowMs - dayAgo * DAY).toISOString()

  let sid = 0
  const insertSession = (repo: string | null, dayAgo: number, invocations: Invocation[]): string => {
    const id = `syn-${sid++}`
    const calls: Array<{ name: string; action: string; error: boolean; sidechain: boolean }> = []
    // Verdicts stand in for the skill-outcomes processor's output, keyed by tool_call idx.
    const verdicts: Array<{ idx: number; name: string; outcome: string; userCorrectionAdjacent: boolean; evidence: string }> = []
    for (const inv of invocations) {
      const idx = calls.length
      calls.push({ name: inv.raw ?? inv.skill, action: 'skill', error: !!inv.error, sidechain: !!inv.sidechain })
      if (inv.outcome) {
        verdicts.push({
          idx,
          name: inv.raw ?? inv.skill,
          outcome: inv.outcome,
          userCorrectionAdjacent: !!inv.correction,
          evidence: 'synthetic: agent ' + inv.outcome + ' the ' + inv.skill + ' output',
        })
      }
    }
    db.prepare(
      `INSERT INTO sessions (id, session_id, source, repo, title, first_prompt, started_at, n_turns, n_tool_calls)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, id, SOURCE, repo, null, `synthetic session ${id}`, iso(dayAgo), calls.length, calls.length)
    calls.forEach((c, idx) => {
      db.prepare(
        `INSERT INTO tool_calls (session_id, idx, name, action, ok, is_error, is_sidechain, ts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, idx, c.name, c.action, c.error ? 0 : 1, c.error ? 1 : 0, c.sidechain ? 1 : 0, iso(dayAgo))
    })
    if (verdicts.length) {
      db.prepare(
        `INSERT INTO annotations (session_id, processor, key, value) VALUES (?, 'skill-outcomes', 'skill_outcomes', ?)`,
      ).run(id, JSON.stringify(verdicts))
    }
    return id
  }

  // A background repo with sessions but no skill usage — a "no skill fired" denominator
  // so scope-down has other-active-repos to compare against.
  const bgSession = (repo: string, dayAgo: number) =>
    insertSession(repo, dayAgo, []) // no invocations → just a plain session
  const plainSession = (repo: string, dayAgo: number) => {
    const id = `syn-${sid++}`
    db.prepare(
      `INSERT INTO sessions (id, session_id, source, repo, first_prompt, started_at, n_turns, n_tool_calls)
       VALUES (?, ?, ?, ?, ?, ?, 1, 1)`,
    ).run(id, id, SOURCE, repo, `plain ${id}`, iso(dayAgo))
    db.prepare(
      `INSERT INTO tool_calls (session_id, idx, name, action, ok, is_error, is_sidechain, ts)
       VALUES (?, 0, 'Bash', 'shell', 1, 0, 0, ?)`,
    ).run(id, iso(dayAgo))
    return id
  }
  void bgSession

  // ---- skill bodies (versions) ----
  const reviewV1 = '# review\nCheck the diff for obvious bugs.\n'
  const reviewV2 = '# review\nCheck the diff for bugs. Run the tests. Summarise findings.\n'
  const reviewV3 = '# review\nCheck the diff for bugs, run tests, and cite file:line for each finding.\n'
  const driftV1 = '# drifty\nDo the thing.\n'
  const driftLost = '# drifty\nDo the thing, carefully.\n' // edited but NEVER captured
  const driftV2 = '# drifty\nDo the thing, carefully, and verify.\n' // the next CAPTURED state
  const revertA = '# reverter\nOriginal approach.\n'
  const revertB = '# reverter\nAlternate approach.\n'

  const reviewHashes = [contentHash(reviewV1), contentHash(reviewV2), contentHash(reviewV3)]
  void driftLost // documents the intermediate we intentionally never snapshot

  // ---- capture timeline (global skills inventory across time) ----
  // Each entry becomes a recordEnvSnapshot at that timestamp; a new row is appended
  // whenever the category payload changes. review changes body at day 40, 20 → three
  // versions. drifty changes body once (captured), with an uncaptured edit in between.
  // reverter goes A→B→A (byte-identical revert).
  const base = (review: string, drifty: string, reverter: string): SkillState[] => [
    { name: 'review', body: review, description: 'review a diff' },
    { name: 'browse', body: '# browse\nFetch and summarise a URL.\n', description: 'browse the web' },
    { name: 'lint-fix', body: '# lint-fix\nRun the linter and fix.\n', description: 'lint and fix' },
    { name: 'deadskill', body: '# deadskill\nUnused for ages.\n', description: 'does nothing lately' },
    { name: 'frontend-design', body: '# frontend-design\nDesign UI.\n', description: 'design' },
    { name: 'drifty', body: drifty, description: 'a drifting skill' },
    { name: 'reverter', body: reverter, description: 'flip-flops' },
    { name: 'flaky-helper', body: '# flaky-helper\nSuggest a fix for the failing test.\n', description: 'suggest test fixes' },
  ]
  const captures: CaptureState[] = [
    { dayAgo: 60, skills: base(reviewV1, driftV1, revertA) },
    { dayAgo: 40, skills: base(reviewV2, driftV1, revertB) }, // review edit #1
    { dayAgo: 20, skills: base(reviewV3, driftV2, revertA) }, // review edit #2 + drifty captured edit + reverter revert
    { dayAgo: 1, skills: base(reviewV3, driftV2, revertA) }, // current (no change → bumps last_observed)
  ]
  for (const cap of captures) {
    store.recordEnvSnapshot(
      {
        source: SOURCE,
        scope: 'global',
        scopeKey: '_global',
        category: 'skills',
        payload: {
          skills: cap.skills.map((s) => ({
            name: s.name,
            body: s.body,
            bodyHash: contentHash(s.body),
            ...(s.description ? { description: s.description } : {}),
          })),
          count: cap.skills.length,
        },
      },
      iso(cap.dayAgo),
    )
  }

  // A project-scoped skill install in two repos with the SAME basename but different
  // paths → ambiguous; the read model must skip it rather than misattribute.
  for (const path of ['/home/dev/work/api', '/home/dev/side/api']) {
    store.recordEnvSnapshot(
      {
        source: SOURCE,
        scope: 'project',
        scopeKey: path,
        category: 'skills',
        payload: { skills: [{ name: 'proj-skill', body: '# proj\n', bodyHash: contentHash('# proj\n') }], count: 1 },
      },
      iso(1),
    )
  }

  // ---- usage ----
  // review: the drift hero. Dense usage on both sides of each edit so before/after
  // clears the min-sample guard. Low own-call error rate early, higher after the last
  // edit (the "changed after the edit" story). All in 'aivue'. Also carries pre-classified
  // activation outcomes (stand-in for the LLM classifier) skewing worse post-edit.
  for (let i = 0; i < 6; i++) insertSession('aivue', 50 - i, [{ skill: 'review', error: i === 0, outcome: 'used' }]) // v1 era, ~8% errored
  for (let i = 0; i < 6; i++) insertSession('aivue', 33 - i, [{ skill: 'review', error: i < 1, outcome: i < 1 ? 'reworked' : 'used' }]) // v2 era
  for (let i = 0; i < 6; i++)
    insertSession('aivue', 15 - (i % 15), [{ skill: 'review', error: i >= 2, outcome: i >= 4 ? 'ignored' : i >= 2 ? 'reworked' : 'used', correction: i >= 4 }]) // v3 era, worse outcomes

  // review also co-occurs with grill-with-docs (not-in-config) and lint-fix.
  for (let i = 0; i < 4; i++)
    insertSession('aivue', 12 - i, [{ skill: 'review' }, { skill: 'grill-with-docs' }, { skill: 'lint-fix' }])

  // review also fires inside subagents: counts as usage (with a subagent split + list tag)
  // AND carries outcome verdicts — the processor judges subagent firings within their own
  // thread. One followed, one reworked, keeping review's bypass share a near-miss (5/11).
  insertSession('aivue', 4, [{ skill: 'review', sidechain: true, outcome: 'used' }])
  insertSession('aivue', 3, [{ skill: 'review', sidechain: true, outcome: 'reworked' }])

  // browse: global but used ONLY in aivue, while 6 other repos are active → scope-down.
  for (let i = 0; i < 3; i++) insertSession('aivue', 10 - i, [{ skill: 'browse' }])
  const browseAbsentRepos = ['api', 'infra', 'docs-site', 'mobile', 'cli-tools', 'playground']
  for (const repo of browseAbsentRepos) for (let i = 0; i < 2; i++) plainSession(repo, 9 - i)

  // lint-fix: used broadly (4 of 7 observed repos → share > SCOPE_MAX_SHARE) → NOT scope-down.
  for (const repo of ['aivue', 'api', 'infra', 'mobile'])
    for (let i = 0; i < 3; i++) insertSession(repo, 8 - i, [{ skill: 'lint-fix' }])

  // frontend-design: invoked in plugin-namespaced form → must reconcile to installed name.
  insertSession('aivue', 5, [{ skill: 'frontend-design', raw: 'frontend-design:frontend-design' }])

  // ghostskill + grill-with-docs: invoked, never in any config snapshot → not-in-config.
  for (let i = 0; i < 2; i++) insertSession('aivue', 6 - i, [{ skill: 'ghostskill' }])

  // flaky-helper: fires regularly but the agent mostly bypasses its output — past BOTH
  // often-bypassed gates (7 judged ≥ floor; 5 bypassed = 71% ≥ share). review stays the
  // near-miss (9 judged, 44%) proving the share threshold, and the roster's judged-floor
  // gate is proven by unit tests on skillHealth itself.
  const flakyOutcomes: Array<'used' | 'reworked' | 'ignored'> = ['ignored', 'ignored', 'reworked', 'ignored', 'used', 'used', 'reworked']
  flakyOutcomes.forEach((o, i) => insertSession('aivue', 9 - i, [{ skill: 'flaky-helper', outcome: o }]))

  // deadskill: installed, never invoked, but plenty of sessions exist → unused + enoughData.
  // (Already have >MIN_SESSIONS aivue sessions above.)

  // A handful of extra plain sessions so the global session count is comfortably
  // above MIN_SESSIONS for the enoughData gate.
  for (let i = 0; i < 12; i++) plainSession('aivue', 7)

  return {
    nowMs,
    used: ['review', 'browse', 'lint-fix', 'frontend-design', 'grill-with-docs', 'ghostskill', 'flaky-helper'],
    unused: ['deadskill', 'drifty', 'reverter'],
    scopeDown: [
      { name: 'review', repos: ['aivue'] },
      { name: 'browse', repos: ['aivue'] },
      { name: 'frontend-design', repos: ['aivue'] },
    ],
    notScopeDown: { name: 'lint-fix', repos: ['aivue', 'api', 'infra', 'mobile'] },
    notInConfig: ['ghostskill', 'grill-with-docs'],
    reviewEditsDaysAgo: [60, 40, 20],
    reviewHashes,
    lostIntermediate: { skill: 'drifty', dayAgo: 30 },
    coOccur: [
      { a: 'review', b: 'grill-with-docs', sessions: 4 },
      { a: 'review', b: 'lint-fix', sessions: 4 },
    ],
    browseAbsentRepos,
    // 30d window: v2 era contributes 3 'used' (days 28-30), v3 era contributes
    // 2 used + 2 reworked + 2 ignored (days 10-15) with 2 adjacent corrections, and the
    // two subagent firings (days 3-4) add 1 used + 1 reworked.
    reviewOutcomes: { classified: 11, used: 6, reworked: 3, ignored: 2, userCorrectionAdjacent: 2 },
    oftenBypassed: { name: 'flaky-helper', judged: 7, bypassed: 5 },
    subagentUsage: { name: 'review', calls: 2 },
  }
}
