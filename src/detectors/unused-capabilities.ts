/**
 * Flags MCP servers and skills that are installed (wired into the harness config)
 * but never actually invoked — dead weight that loads into every session's startup
 * and adds to its overhead. Purely structural: the INSTALLED set (from the
 * environment reader's config snapshots) minus the INVOKED set (from tool-call
 * usage). Never used anywhere → suggest removal; installed globally but used in
 * only one repo → suggest scoping it to that repo.
 *
 * It makes NO cost or token claim. Per-item startup-token attribution is impossible
 * from the data we have — the API reports only aggregate usage and tool/MCP schemas
 * are never written to the transcript (verified) — so the card frames the cost
 * qualitatively ("adds to startup overhead") and leaves the quantified before/after
 * drop to post-fix measurement off the snapshot timeline.
 */

import { basename } from 'node:path'
import { insightId, type Detector, type DetectorContext, type EvidenceRef, type InsightInput } from '../core/detector'
import { registerDetector } from '../core/registry'
import type { Store } from '../store/store'

/** The harness this detector reads: MCP-name grammar + config layout are CC-specific. */
const SOURCE = 'claude-code'
// Detector identity. The fix-prompt marker id is derived from (DETECTOR, repo, SIGNAL_KEY),
// and persistInsights re-derives it from the SAME triple to verify the marker is embedded —
// so these must stay in lockstep with the Detector.name and the insight's signalKey below.
const DETECTOR = 'unused-capabilities'
const SIGNAL_KEY = 'unused-caps'

/** How far back invoked-capability usage is counted. */
export const WINDOW_DAYS = 30

/**
 * How long a capability must have been observed installed before "never used" is
 * trusted enough to recommend removal. Shorter than WINDOW_DAYS: usage is judged over
 * the full 30-day window, but a capability only needs 10 days of config tenure to be
 * removal-eligible, so a genuinely-unused capability surfaces without waiting a full
 * window of tuneloop history. One added more recently is held back — it couldn't have
 * appeared in sessions that predate it, so its absence isn't disuse.
 */
export const MIN_REMOVAL_TENURE_DAYS = 10

/**
 * Sessions that must have been observed before we trust "never used" enough to
 * recommend removal — below this, absence is just too little data, not disuse.
 * (Does NOT gate the scoping verdict: seeing a capability live in a few repos is
 * positive evidence, not absence, so no session minimum applies there.)
 */
export const MIN_SESSIONS = 10

/**
 * A global capability is worth scoping when it's used in half or fewer of the observed
 * repos AND in no more than SCOPE_MAX_REPOS of them. Used more broadly, it's shared and
 * stays global (a snippet that moves it into many repos is worse than leaving it).
 */
export const SCOPE_MAX_SHARE = 0.5
export const SCOPE_MAX_REPOS = 5

/**
 * A capability found in the harness config. `repo` is set (the basename of the
 * project snapshot's scope_key) for project-scoped entries; absent for global ones.
 */
export interface InstalledCap {
  kind: 'mcp' | 'skill'
  name: string
  scope: 'global' | 'project'
  repo?: string
}

/**
 * One (kind, name, repo) usage aggregate: this capability was invoked in this repo
 * across `sessions` distinct sessions. `repo` is null when the invoking session
 * wasn't in a resolvable git repo — those still count as "used" (so we never
 * recommend removing something we saw run) but can't anchor a scoping suggestion.
 */
export interface InvokedCap {
  kind: 'mcp' | 'skill'
  name: string
  repo: string | null
  sessions: number
}

/**
 * Read invoked capabilities from the `capability_usage` view — the shared definition
 * of "this server/skill ran" (the MCP-server-from-tool-name grammar and the
 * main-thread / malformed-name filters all live in the view now; see src/store/db.ts).
 *
 * The view aggregates globally; recency is applied HERE as a read-time predicate:
 * `last_invoked_at >= since` keeps a capability only if its MOST RECENT invocation is
 * inside the window (decision 6 — a server used once long ago is not current use). That
 * timestamp is `MAX(tool_call.ts)`, so usage is dated by when the tool actually ran, not
 * by when its session began (decision 7): a long session that started before the window
 * but invoked the server yesterday still counts, where the old `s.started_at` scan
 * dropped it and then misread the live server as unused.
 *
 * Grouped by (kind, name, repo) with a DISTINCT-session count — "used in N sessions",
 * not "called N times", so one chatty session isn't mistaken for broad adoption. A
 * session belongs to exactly one source, so `SUM(sessions)` across sources equals the
 * total distinct-session count. `source` restricts to one harness (the name grammar is
 * harness-specific); omitted counts every source, re-merged by the outer GROUP BY.
 */
export function queryInvoked(store: Store, sinceIso: string, source?: string): InvokedCap[] {
  return store.queryAll(
    `SELECT kind, name, repo, SUM(sessions) AS sessions
     FROM capability_usage
     WHERE (? IS NULL OR source = ?)
     GROUP BY kind, name, repo
     HAVING MAX(last_invoked_at) >= ?`,
    source ?? null,
    source ?? null,
    sinceIso,
  ) as InvokedCap[]
}

/**
 * Bridge the two sides' repo identity. Project config snapshots key on the git-root
 * PATH (`/Users/x/git/tuneloop`); sessions/tool_calls key on the short repo NAME
 * (`tuneloop`, = basename of that path — see analyze.ts resolveRepo). To ask "is this
 * installed capability used in its repo?" we translate each scope_key path to its name.
 *
 * When two DISTINCT paths share a basename (`/work/api` and `/personal/api` both →
 * `api`), the name can't uniquely identify a repo — so we mark it `ambiguous` and
 * leave it out of `byRepo`. The detector then skips those repos rather than
 * misattributing usage (a wrong "remove X from api" is worse than staying silent).
 * `byRepo` maps repo NAME → scope_key PATH for the unambiguous ones.
 */
export function mapScopeKeysToRepos(scopeKeys: string[]): { byRepo: Map<string, string>; ambiguous: Set<string> } {
  // Collect every distinct path per basename first, so a name seen once is clean and
  // a name backed by >1 path is ambiguous. A Set dedupes an identical path repeated.
  const pathsByName = new Map<string, Set<string>>()
  for (const key of scopeKeys) {
    const name = basename(key)
    const set = pathsByName.get(name) ?? new Set<string>()
    set.add(key)
    pathsByName.set(name, set)
  }
  const byRepo = new Map<string, string>()
  const ambiguous = new Set<string>()
  for (const [name, paths] of pathsByName) {
    if (paths.size > 1) ambiguous.add(name)
    else byRepo.set(name, [...paths][0]!)
  }
  return { byRepo, ambiguous }
}

/** A classified installed capability: what to do about it and (for scoping) where. */
export interface Classified {
  cap: InstalledCap
  verdict: 'remove' | 'scope'
  /** The repos a global capability is actually used in — set only for 'scope'. */
  scopeToRepos?: string[]
}

/**
 * Turn (installed, invoked) into per-capability verdicts. The one place the
 * remove-vs-scope-vs-keep policy lives; buildCards only groups the results.
 *
 * For each installed capability we find the repos it was actually invoked in (MCP by
 * exact server name, skills via skillMatches). Then, by scope:
 *
 *  GLOBAL capability
 *   - used nowhere at all → `remove`, but only once we've seen ≥ MIN_SESSIONS total
 *     (below that, absence is thin data, not disuse).
 *   - used in half or fewer of the observed repos (share ≤ SCOPE_MAX_SHARE, and in ≤
 *     SCOPE_MAX_REPOS of them), with no unattributed use → `scope` to exactly those
 *     repos (positive evidence — we saw it live there, so no session minimum).
 *   - used in more than half the repos, or in more than the cap, or only in null-repo
 *     (used but unattributable) → keep: genuinely shared.
 *
 *  PROJECT capability (already scoped to its own repo `cap.repo`)
 *   - invoked in its repo (or unattributed) → keep.
 *   - never invoked anywhere → `remove`, gated by its repo having ≥ MIN_SESSIONS.
 *
 * Unattributed (null-repo) invocations always count as USE — we never recommend
 * removing (or narrowing) something we watched run, even if we can't say where.
 * `sessionCountByRepo` (repo name → session count) is the trust denominator: a project
 * capability is gated by its own repo's count, a global one by the corpus total; its
 * `size` is the observed-repo count the scoping share is measured against.
 */
export function classify(
  installed: InstalledCap[],
  invoked: InvokedCap[],
  sessionCountByRepo: Map<string, number>,
): Classified[] {
  const totalSessions = [...sessionCountByRepo.values()].reduce((a, b) => a + b, 0)
  const observedRepos = sessionCountByRepo.size
  const out: Classified[] = []

  for (const cap of installed) {
    // Repos (and the null bucket) this capability was invoked in.
    const matches = invoked.filter((iv) => iv.kind === cap.kind && capNameMatches(cap, iv.name))
    const realRepos = new Set<string>()
    let usedUnattributed = false
    for (const iv of matches) {
      if (iv.repo === null) usedUnattributed = true
      else realRepos.add(iv.repo)
    }
    const usedAnywhere = realRepos.size > 0 || usedUnattributed

    if (cap.scope === 'global') {
      if (!usedAnywhere) {
        // Never used at all → remove, once there's enough data to trust the absence.
        if (totalSessions >= MIN_SESSIONS) out.push({ cap, verdict: 'remove' })
      } else if (
        !usedUnattributed && // can't narrow something we saw run in an unknown place
        realRepos.size <= SCOPE_MAX_REPOS &&
        realRepos.size <= observedRepos * SCOPE_MAX_SHARE
      ) {
        // Used in half or fewer of your repos → move it into exactly those, so the
        // rest stop loading it. Sorted for a stable snippet / deterministic tests.
        out.push({ cap, verdict: 'scope', scopeToRepos: [...realRepos].sort() })
      }
      // else: used broadly, or only unattributed → keep.
    } else {
      // Project-scoped: only its own repo's usage (or unattributed) counts as "used".
      const usedHere = (cap.repo !== undefined && realRepos.has(cap.repo)) || usedUnattributed
      if (!usedHere) {
        const repoSessions = cap.repo !== undefined ? (sessionCountByRepo.get(cap.repo) ?? 0) : 0
        if (repoSessions >= MIN_SESSIONS) out.push({ cap, verdict: 'remove' })
      }
    }
  }
  return out
}

/** Name reconciliation per kind: MCP servers match exactly, skills via skillMatches. */
function capNameMatches(cap: InstalledCap, invokedName: string): boolean {
  return cap.kind === 'skill' ? skillMatches(cap.name, invokedName) : cap.name === invokedName
}

/** At/above this many flagged items a card is medium severity; below it, low. */
const SEVERITY_MEDIUM_COUNT = 3
/** Evidence session pointers per card, matching the store's cap. */
const MAX_EVIDENCE = 10

/**
 * Fold every classified verdict into ONE cross-repo insight (repo '*'). The fix lists
 * the global actions (remove/scope, which edit global config) and, per project repo, the
 * capabilities dead there — each under its own labelled section, since they edit different
 * config locations. Count is the total flagged items across all scopes.
 *
 * Framing is qualitative — these load into every session's startup and add to its
 * overhead — with no token or dollar figure (unquantifiable from our data). Severity
 * tracks the total flagged count, not any cost. Evidence draws sample sessions from the
 * repos the suggestions touch (scope targets + the project repos with dead caps).
 */
export function buildCards(classified: Classified[], scopeInvocations: Map<string, EvidenceRef[]>): InsightInput[] {
  if (classified.length === 0) return []

  const globals = classified.filter((c) => c.cap.scope === 'global')
  const byRepo = new Map<string, Classified[]>()
  for (const c of classified) {
    if (c.cap.scope !== 'project' || c.cap.repo === undefined) continue
    const list = byRepo.get(c.cap.repo) ?? []
    list.push(c)
    byRepo.set(c.cap.repo, list)
  }

  // The concrete edits: the global section (remove/scope) then one "remove from <repo>"
  // section per repo. These are agent instructions, not a paste-able config blob —
  // moving a capability out of global config is a filesystem + config edit, not a snippet.
  const sections: string[] = []
  if (globals.length > 0) sections.push(globalFixContent(globals))
  for (const repo of [...byRepo.keys()].sort()) {
    sections.push(`Remove from ${repo}'s config:\n${capList(byRepo.get(repo)!.map((c) => c.cap))}`)
  }

  const total = classified.length
  const problem = [globalProblem(globals), projectProblem(byRepo)].filter(Boolean).join(' ')
  return [{
    signalKey: SIGNAL_KEY,
    repo: '*',
    severity: total >= SEVERITY_MEDIUM_COUNT ? 'medium' : 'low',
    title: `${total} unused ${plural(total, 'capability', 'capabilities')} inflating startup`,
    description: `${problem} Each loads into a session's startup and adds to its overhead. Apply the fix below to trim your config.`,
    evidence: collectEvidence(globals, scopeInvocations),
    count: total,
    fix: {
      type: 'fix-prompt',
      label: 'Trim unused capabilities',
      content: fixPromptContent(problem, sections),
    },
  }]
}

/**
 * The fix as a self-contained prompt for a coding agent. It opens with the tuneloop-fix
 * marker (so the fix session self-identifies in the transcript and the insight can flip
 * to adopted), restates the diagnosis (the card's description isn't visible once the
 * prompt is pasted), lists the concrete config edits, and gives an acceptance line the
 * agent can check. This is a fix-prompt, not a config-snippet, because relocating a
 * capability is agent work — editing/moving config across locations, not copying a blob.
 */
function fixPromptContent(problem: string, sections: string[]): string {
  return [
    `tuneloop-fix: ${insightId(DETECTOR, '*', SIGNAL_KEY)}`,
    '',
    `${problem} Each loads into every Claude Code session's startup and adds to its overhead. Make these config changes:`,
    '',
    sections.join('\n\n'),
    '',
    `Done when: every server/skill listed above is removed from the config file it's named under, and each capability marked "move to" appears only in the target repos' configs — no longer in global config.`,
    '',
  ].join('\n')
}

/**
 * The card's evidence, capped at MAX_EVIDENCE: ONLY the scope verdicts' real invocation
 * pointers (the sessions that ran the capability in each target repo, each noting the
 * capability + repo and landing on the call). A removal has no evidence — its claim is
 * "never used here", so recent sessions that didn't use it aren't evidence of anything;
 * empty is the honest answer, and the card is still dated by its lastSeenAt.
 */
function collectEvidence(globals: Classified[], scopeInvocations: Map<string, EvidenceRef[]>): EvidenceRef[] {
  const out: EvidenceRef[] = []
  for (const c of globals) {
    if (c.verdict !== 'scope') continue
    for (const ref of scopeInvocations.get(capIdentity(c.cap)) ?? []) {
      if (out.length >= MAX_EVIDENCE) return out
      out.push(ref)
    }
  }
  return out
}

/**
 * One "- kind: name" line per capability, kind-labelled. Sorted by (kind, name) so
 * the snippet text is identical run-to-run regardless of the (unordered) SQL/Set
 * order the caps arrive in — no spurious churn in the stored fix content.
 */
function capList(caps: InstalledCap[]): string {
  const label = (c: InstalledCap) => `- ${c.kind === 'mcp' ? 'MCP server' : 'skill'}: ${c.name}`
  const sorted = [...caps].sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name))
  return sorted.map(label).join('\n')
}

/** A precise statement of the global problem, split by verdict — no vague "barely used". Empty when there are no global caps. */
function globalProblem(globals: Classified[]): string {
  const scoped = globals.filter((c) => c.verdict === 'scope')
  const never = globals.length - scoped.length
  const few = scoped.length
  const parts: string[] = []
  if (never > 0) {
    parts.push(`${never} global ${plural(never, 'capability is', 'capabilities are')} never invoked in the last ${WINDOW_DAYS} days`)
  }
  if (few > 0) {
    // No second person ("your"): this sentence is reused verbatim in the fix-prompt,
    // which is copied to a coding agent. "a few repos" only reads right when the scope
    // spans >1 repo; a capability used in a single repo is "just one repo".
    const oneRepo = scoped.every((c) => (c.scopeToRepos ?? []).length <= 1)
    const where = oneRepo ? 'just one repo' : 'only a few repos'
    parts.push(`${few} global ${plural(few, 'capability is', 'capabilities are')} used in ${where}`)
  }
  if (parts.length === 0) return ''
  // Capitalize the first word of the assembled sentence.
  const s = parts.join(', and ')
  return s.charAt(0).toUpperCase() + s.slice(1) + '.'
}

/** The project-scoped half of the problem statement: dead caps per repo. Empty when there are none. */
function projectProblem(byRepo: Map<string, Classified[]>): string {
  const repos = [...byRepo.keys()].sort()
  if (repos.length === 0) return ''
  const total = repos.reduce((n, r) => n + byRepo.get(r)!.length, 0)
  const where = repos.length === 1 ? repos[0] : `${repos.length} repos`
  return `${total} project ${plural(total, 'capability is', 'capabilities are')} never invoked in ${where} in the last ${WINDOW_DAYS} days.`
}

/** The copy-paste snippet body for the global card: removals then scoping moves. */
function globalFixContent(globals: Classified[]): string {
  const sections: string[] = []
  const removes = globals.filter((c) => c.verdict === 'remove').map((c) => c.cap)
  if (removes.length > 0) sections.push(`Remove from the global config:\n${capList(removes)}`)
  const scopes = globals
    .filter((c) => c.verdict === 'scope')
    .sort((a, b) => a.cap.kind.localeCompare(b.cap.kind) || a.cap.name.localeCompare(b.cap.name))
  if (scopes.length > 0) {
    const lines = scopes.map((c) => {
      const label = c.cap.kind === 'mcp' ? 'MCP server' : 'skill'
      return `- ${label}: ${c.cap.name} → move to ${(c.scopeToRepos ?? []).join(', ')}`
    })
    sections.push(`Move out of global config into the repos that use them:\n${lines.join('\n')}`)
  }
  return sections.join('\n\n')
}

/** English count agreement: pick singular or plural by n. */
function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many
}

/**
 * Whether an invoked skill is the installed one. The config stores a skill's
 * invokable name (`frontend-design`); a tool call may carry it plugin-namespaced as
 * `<plugin-id>:<skill>` (`frontend-design:frontend-design`). Match on exact equality
 * OR on the invoked name's last `:`-segment, so a plugin-provided skill still
 * reconciles against its installed entry and isn't misflagged as never-used. MCP
 * doesn't need this — its server segment already reconciles exactly (see queryInvoked).
 */
export function skillMatches(installedName: string, invokedName: string): boolean {
  if (installedName === invokedName) return true
  const lastSegment = invokedName.slice(invokedName.lastIndexOf(':') + 1)
  return lastSegment === installedName
}

/**
 * Pull MCP server names from an `mcp`-category snapshot payload. The reader keys the
 * payload by source file (`.mcp.json`, `.claude.json`), each holding `{ servers: {
 * "<name>": {...} } }` — so the installed set is the union of server names across
 * every file. Tolerant of a missing/malformed payload (returns []): a snapshot could
 * predate a shape change, and a detector must never throw on stored data.
 */
export function parseInstalledMcp(payload: unknown): string[] {
  if (!payload || typeof payload !== 'object') return []
  const names = new Set<string>()
  for (const file of Object.values(payload as Record<string, unknown>)) {
    const servers = (file as Record<string, unknown> | null)?.servers
    if (!servers || typeof servers !== 'object') continue
    for (const name of Object.keys(servers as Record<string, unknown>)) names.add(name)
  }
  return [...names]
}

/**
 * Pull skill names from a `skills`-category snapshot payload (`{ skills: [{ name,
 * ... }], count }`). `name` is the invokable identity the reader captured (skill dir
 * / command filename), which is what a tool-call's skill name reconciles against.
 * Same defensive contract as parseInstalledMcp — malformed payload → [].
 */
export function parseInstalledSkills(payload: unknown): string[] {
  if (!payload || typeof payload !== 'object') return []
  const skills = (payload as Record<string, unknown>).skills
  if (!Array.isArray(skills)) return []
  const names: string[] = []
  for (const s of skills) {
    const name = (s as Record<string, unknown> | null)?.name
    if (typeof name === 'string' && name) names.push(name)
  }
  return names
}

// ---- run() wiring ----------------------------------------------------------

/** Snapshot categories carrying capabilities, paired with their InstalledCap kind. */
const CAP_CATEGORIES = [
  { category: 'mcp', kind: 'mcp' as const, parse: parseInstalledMcp },
  { category: 'skills', kind: 'skill' as const, parse: parseInstalledSkills },
]

/** Evidence-note label for a capability's use: "<repo> · uses MCP server sentry". */
function invocationNote(cap: InstalledCap, repo: string): string {
  return `${repo} · uses ${cap.kind === 'mcp' ? 'MCP server' : 'skill'} ${cap.name}`
}

/**
 * Real invocation evidence for each scope verdict: the sessions that ACTUALLY ran the
 * capability in each target repo — positive proof of the "you use it here" claim the
 * card makes — keyed by `capIdentity`. Reads the `capability_invocation` view (so skill
 * names reconcile through `capNameMatches`, matching a plugin-namespaced invocation) and
 * joins `block_tool`/`blocks` for the turn the call sits in, so the evidence link lands
 * on the invocation exchange, not the session top. Distinct sessions, most recent first,
 * capped at MAX_EVIDENCE per capability.
 */
export function buildScopeEvidence(store: Store, scopes: Classified[], sinceIso: string): Map<string, EvidenceRef[]> {
  const out = new Map<string, EvidenceRef[]>()
  const repos = [...new Set(scopes.flatMap((c) => c.scopeToRepos ?? []))]
  if (repos.length === 0) return out
  // Per (kind, invoked-name, repo, session): the earliest block seq the call maps to
  // (null when unmapped → the link degrades to session-level), newest session first.
  const rows = store.queryAll(
    `SELECT ci.kind, ci.name AS invokedName, ci.repo, ci.session_id AS sessionId, MIN(b.start_seq) AS seq
     FROM capability_invocation ci
     LEFT JOIN block_tool bt ON bt.session_id = ci.session_id AND bt.tool_idx = ci.idx
     LEFT JOIN blocks b ON b.session_id = bt.session_id AND b.idx = bt.block_idx
     WHERE ci.is_sidechain = 0 AND ci.source = ? AND ci.ts >= ? AND ci.repo IN (${repos.map(() => '?').join(',')})
     GROUP BY ci.kind, ci.name, ci.repo, ci.session_id
     ORDER BY MAX(ci.ts) DESC`,
    SOURCE,
    sinceIso,
    ...repos,
  ) as Array<{ kind: 'mcp' | 'skill'; invokedName: string; repo: string; sessionId: string; seq: number | null }>

  for (const c of scopes) {
    const refs: EvidenceRef[] = []
    const seen = new Set<string>() // a session can invoke twice (or under two names) — count it once
    for (const repo of c.scopeToRepos ?? []) {
      for (const r of rows) {
        if (r.repo !== repo || r.kind !== c.cap.kind || !capNameMatches(c.cap, r.invokedName) || seen.has(r.sessionId)) continue
        seen.add(r.sessionId)
        if (refs.length >= MAX_EVIDENCE) break
        refs.push({ sessionId: r.sessionId, turnIdx: r.seq ?? undefined, note: invocationNote(c.cap, repo) })
      }
    }
    if (refs.length > 0) out.set(capIdentity(c.cap), refs)
  }
  return out
}

/** Stable identity of an installed capability, for set membership across snapshots. */
export function capIdentity(cap: InstalledCap): string {
  return `${cap.scope}\u0000${cap.repo ?? ''}\u0000${cap.kind}\u0000${cap.name}`
}

/**
 * Load the installed capability set from config snapshots. Global scope (scope_key
 * '_global') contributes global caps; every project scope_key contributes repo-scoped
 * caps, keyed by the basename of its git-root path. Ambiguous basenames (two roots,
 * same name) are skipped so their caps are never misattributed — the skipped names are
 * returned for logging.
 *
 * `installed` is the CURRENT config (what to judge and report). `removalEligible` is the
 * subset that was ALSO installed at `tenureCutoffIso` — the removal-eligibility gate: a
 * capability observed only more recently can't have appeared in the older sessions we
 * compare it against, so "never used" would be a false positive. A scope_key with no
 * snapshot reaching back to the cutoff (envSnapshotAsOf `stale`) contributes nothing to
 * `removalEligible`, so its caps can't be removed until they've been observed that long.
 * Scoping isn't gated — it's driven by positive use, not absence.
 */
function loadInstalled(
  store: Store,
  tenureCutoffIso: string,
): { installed: InstalledCap[]; ambiguous: Set<string>; removalEligible: Set<string> } {
  const installed: InstalledCap[] = []
  const removalEligible = new Set<string>()

  const addScope = (scope: 'global' | 'project', scopeKey: string, repo?: string) => {
    for (const { category, kind, parse } of CAP_CATEGORIES) {
      const current = store.envSnapshotCurrent(SOURCE, scope, scopeKey, category)
      for (const name of current ? parse(current.payload) : []) installed.push({ kind, name, scope, repo })
      // Names present in the snapshot as it stood at the tenure cutoff (if one that old exists).
      const asOf = store.envSnapshotAsOf(SOURCE, scope, scopeKey, category, tenureCutoffIso)
      for (const name of asOf.row ? parse(asOf.row.payload) : []) removalEligible.add(capIdentity({ kind, name, scope, repo }))
    }
  }

  addScope('global', '_global')

  // Project: every distinct scope_key path recorded for this source, mapped to a repo name.
  const projectKeys = (
    store.queryAll(
      `SELECT DISTINCT scope_key FROM environment_snapshots WHERE source = ? AND scope = 'project'`,
      SOURCE,
    ) as Array<{ scope_key: string }>
  ).map((r) => r.scope_key)
  const { byRepo, ambiguous } = mapScopeKeysToRepos(projectKeys)
  for (const [repo, scopeKey] of byRepo) addScope('project', scopeKey, repo)

  return { installed, ambiguous, removalEligible }
}

/**
 * The most recent session start time in the window — the freshest evidence that the
 * config was still in this state. Used as the cards' `lastSeenAt` ("as of when we last
 * looked"), since a structural absence-of-use finding has no per-occurrence moment.
 * Null when the window has no sessions.
 */
function latestSessionStart(store: Store, sinceIso: string): string | null {
  const row = store.queryOne(
    `SELECT MAX(started_at) AS latest FROM sessions WHERE source = ? AND started_at >= ?`,
    SOURCE,
    sinceIso,
  ) as { latest: string | null } | undefined
  return row?.latest ?? null
}

/** Distinct-session count per repo in the window (null-repo sessions excluded — they name no repo). */
function loadSessionCounts(store: Store, sinceIso: string): Map<string, number> {
  const rows = store.queryAll(
    `SELECT repo, COUNT(*) AS n FROM sessions
     WHERE source = ? AND started_at >= ? AND repo IS NOT NULL
     GROUP BY repo`,
    SOURCE,
    sinceIso,
  ) as Array<{ repo: string; n: number }>
  return new Map(rows.map((r) => [r.repo, r.n]))
}

export const unusedCapabilities: Detector = {
  name: DETECTOR,
  version: 1,
  tier: 'S',
  run(ctx: DetectorContext): InsightInput[] {
    const now = Date.now()
    const sinceIso = new Date(now - WINDOW_DAYS * 86_400_000).toISOString()
    const tenureCutoffIso = new Date(now - MIN_REMOVAL_TENURE_DAYS * 86_400_000).toISOString()
    const { installed, ambiguous, removalEligible } = loadInstalled(ctx.store, tenureCutoffIso)
    if (ambiguous.size > 0) {
      ctx.log.debug(`unused-capabilities: skipped ${ambiguous.size} repo(s) with a colliding basename: ${[...ambiguous].join(', ')}`)
    }
    if (installed.length === 0) return [] // no config snapshots captured yet — nothing to judge

    const invoked = queryInvoked(ctx.store, sinceIso, SOURCE)
    const sessionCounts = loadSessionCounts(ctx.store, sinceIso)
    // A `remove` verdict means "never used across the window". Only trust it for a
    // capability we've observed installed for at least MIN_REMOVAL_TENURE_DAYS — one
    // observed more recently couldn't have appeared in the older sessions, so its
    // absence isn't disuse. `scope` verdicts rest on positive use, so they're not gated.
    const classified = classify(installed, invoked, sessionCounts).filter(
      (c) => c.verdict !== 'remove' || removalEligible.has(capIdentity(c.cap)),
    )
    // Scope verdicts get REAL invocation evidence (the sessions that ran the capability
    // in each target repo); project-remove repos fall back to recent sessions.
    const scopeInvocations = buildScopeEvidence(ctx.store, classified.filter((c) => c.verdict === 'scope'), sinceIso)
    const cards = buildCards(classified, scopeInvocations)
    // Stamp last-seen as of the most recent examined session, so the card doesn't
    // default to the analyze-run time. A structural finding has no first-seen moment.
    const lastSeenAt = latestSessionStart(ctx.store, sinceIso) ?? undefined
    for (const card of cards) card.lastSeenAt = lastSeenAt
    return cards
  },
}

registerDetector(unusedCapabilities)
