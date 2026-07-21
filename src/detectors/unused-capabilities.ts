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
import type { Detector, DetectorContext, EvidenceRef, InsightInput } from '../core/detector'
import { registerDetector } from '../core/registry'
import type { Store } from '../store/store'

/** The harness this detector reads: MCP-name grammar + config layout are CC-specific. */
const SOURCE = 'claude-code'
/** Evidence pointers to keep per repo — feeds the store-capped card evidence. */
const SAMPLE_SESSIONS_PER_REPO = 10

/** How far back invoked-capability usage is counted. */
export const WINDOW_DAYS = 30

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
 * Read invoked capabilities from tool-call usage in the last WINDOW_DAYS.
 * Main-thread only (`is_sidechain = 0`): a subagent's tool calls run against its own
 * context, and we're reasoning about what the user wired into their own sessions.
 *
 *  - MCP:   `action = 'mcp_call'`, name = `mcp__<server>__<tool>` → the SERVER is the
 *           2nd `__`-segment (the installed unit is the server, not each tool).
 *  - skill: `action = 'skill'`, name = the specific skill (the adapter already refines
 *           the generic `Skill` tool into the invoked skill's name).
 *
 * Grouped by (kind, name, repo) with a DISTINCT-session count, since "used in N
 * sessions" (not "called N times") is the signal — one chatty session shouldn't
 * look like broad adoption. `source` restricts to one harness's sessions (the MCP
 * name grammar and skill action are harness-specific); omitted counts every source.
 */
export function queryInvoked(store: Store, sinceIso: string, source?: string): InvokedCap[] {
  // The (kind, name) derivation happens in an inner SELECT so the outer GROUP BY
  // keys on the DERIVED name, not tool_calls.name — an alias named `name` would
  // otherwise bind to the real column and split servers back into their per-tool rows.
  const rows = store.queryAll(
    `SELECT kind, name, repo, COUNT(DISTINCT session_id) AS sessions
     FROM (
       SELECT
          CASE t.action WHEN 'mcp_call' THEN 'mcp' ELSE 'skill' END AS kind,
          CASE t.action
            WHEN 'mcp_call' THEN
              -- server = text between the 1st and 2nd '__' in mcp__<server>__<tool>;
              -- empty when there's no 2nd '__' (guards substr against a negative length,
              -- which SQLite would otherwise read backwards).
              CASE WHEN instr(substr(t.name, 6), '__') > 0
                   THEN substr(t.name, 6, instr(substr(t.name, 6), '__') - 1)
                   ELSE '' END
            ELSE t.name
          END AS name,
          t.session_id AS session_id,
          s.repo AS repo
       FROM tool_calls t JOIN sessions s ON s.id = t.session_id
       WHERE t.is_sidechain = 0
         AND t.action IN ('mcp_call', 'skill')
         AND s.started_at >= ?
         AND (? IS NULL OR s.source = ?)
     )
     GROUP BY kind, name, repo`,
    sinceIso,
    source ?? null,
    source ?? null,
  ) as Array<{ kind: 'mcp' | 'skill'; name: string; repo: string | null; sessions: number }>
  // A malformed mcp name (no 2nd '__') yields an empty server segment — drop it
  // rather than emit a phantom "" capability.
  return rows.filter((r) => r.name !== '')
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
 * Group classified verdicts into insight cards — one holistic card per scope.
 *
 *  - Global card (repo '*'): every global capability to remove or scope. It owns the
 *    scoping suggestions because narrowing a global capability edits global config.
 *  - Project card (repo '<name>'): the project capabilities dead in that repo.
 *
 * Framing is qualitative — these load into every session's startup and add to its
 * overhead — with no token or dollar figure (unquantifiable from our data). Severity
 * tracks the count of flagged items, not any cost. `sampleSessionsByRepo` supplies
 * evidence pointers (repo name → session ids); the global card draws its evidence
 * from the repos its scope suggestions point at.
 */
export function buildCards(classified: Classified[], sampleSessionsByRepo: Map<string, string[]>): InsightInput[] {
  const globals = classified.filter((c) => c.cap.scope === 'global')
  const byRepo = new Map<string, Classified[]>()
  for (const c of classified) {
    if (c.cap.scope !== 'project' || c.cap.repo === undefined) continue
    const list = byRepo.get(c.cap.repo) ?? []
    list.push(c)
    byRepo.set(c.cap.repo, list)
  }

  const cards: InsightInput[] = []

  if (globals.length > 0) {
    // Evidence: sessions from the repos the scope suggestions point at (concrete
    // "used here" pointers). Removals name no repo, so contribute none.
    const evidenceRepos = new Set(globals.flatMap((c) => c.scopeToRepos ?? []))
    const evidence = sampleEvidence(evidenceRepos, sampleSessionsByRepo)
    cards.push({
      signalKey: 'unused-caps',
      repo: '*',
      severity: globals.length >= SEVERITY_MEDIUM_COUNT ? 'medium' : 'low',
      title: `${globals.length} global ${plural(globals.length, 'capability', 'capabilities')} inflating startup`,
      description:
        `${globalProblem(globals)} Each one loads into every session's startup across all your repos, ` +
        `adding to its overhead. Apply the fix below to trim your global config.`,
      evidence,
      count: globals.length,
      fix: {
        type: 'config-snippet',
        label: 'Trim global config',
        content: globalFixContent(globals),
      },
    })
  }

  for (const repo of [...byRepo.keys()].sort()) {
    const items = byRepo.get(repo)!
    const names = items.map((c) => c.cap)
    cards.push({
      signalKey: 'unused-caps',
      repo,
      severity: items.length >= SEVERITY_MEDIUM_COUNT ? 'medium' : 'low',
      title: `${items.length} unused ${plural(items.length, 'capability', 'capabilities')} in ${repo}`,
      description:
        `${items.length} ${plural(items.length, 'capability', 'capabilities')} configured in ${repo} ` +
        `${plural(items.length, 'was', 'were')} never invoked there in the last ${WINDOW_DAYS} days. ` +
        `${plural(items.length, 'It loads', 'They load')} into every session's startup in this repo, ` +
        `adding to its overhead. Apply the fix below to remove them.`,
      evidence: sampleEvidence(new Set([repo]), sampleSessionsByRepo),
      count: items.length,
      fix: {
        type: 'config-snippet',
        label: 'Remove unused capabilities',
        content: `Remove from ${repo}'s config:\n${capList(names)}`,
      },
    })
  }

  return cards
}

/** Up to MAX_EVIDENCE session pointers drawn from the given repos' samples. */
function sampleEvidence(repos: Set<string>, sampleSessionsByRepo: Map<string, string[]>): EvidenceRef[] {
  const out: EvidenceRef[] = []
  for (const repo of repos) {
    for (const sessionId of sampleSessionsByRepo.get(repo) ?? []) {
      if (out.length >= MAX_EVIDENCE) return out
      out.push({ sessionId })
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

/** A precise statement of the problem, split by verdict — no vague "barely used". */
function globalProblem(globals: Classified[]): string {
  const scoped = globals.filter((c) => c.verdict === 'scope')
  const never = globals.length - scoped.length
  const few = scoped.length
  const parts: string[] = []
  if (never > 0) {
    parts.push(`${never} global ${plural(never, 'capability is', 'capabilities are')} never invoked in the last ${WINDOW_DAYS} days`)
  }
  if (few > 0) {
    // "a few of your repos" only reads right when the scope actually spans >1 repo;
    // a capability used in a single repo is "just one of your repos".
    const oneRepo = scoped.every((c) => (c.scopeToRepos ?? []).length <= 1)
    const where = oneRepo ? 'just one of your repos' : 'only a few of your repos'
    parts.push(`${few} global ${plural(few, 'capability is', 'capabilities are')} used in ${where}`)
  }
  // Capitalize the first word of the assembled sentence.
  const s = parts.join(', and ')
  return s.charAt(0).toUpperCase() + s.slice(1) + '.'
}

/** The copy-paste snippet body for the global card: removals then scoping moves. */
function globalFixContent(globals: Classified[]): string {
  const sections: string[] = []
  const removes = globals.filter((c) => c.verdict === 'remove').map((c) => c.cap)
  if (removes.length > 0) sections.push(`Remove from your global config:\n${capList(removes)}`)
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

/**
 * Load the installed capability set from the current config snapshots. Global scope
 * (scope_key '_global') contributes global caps; every project scope_key contributes
 * repo-scoped caps, keyed by the basename of its git-root path. Ambiguous basenames
 * (two roots, same name) are skipped so their caps are never misattributed — the
 * skipped names are returned for logging.
 */
function loadInstalled(store: Store): { installed: InstalledCap[]; ambiguous: Set<string> } {
  const installed: InstalledCap[] = []

  // Global: one well-known scope_key.
  const gMcp = store.envSnapshotCurrent(SOURCE, 'global', '_global', 'mcp')
  for (const name of gMcp ? parseInstalledMcp(gMcp.payload) : []) installed.push({ kind: 'mcp', name, scope: 'global' })
  const gSkill = store.envSnapshotCurrent(SOURCE, 'global', '_global', 'skills')
  for (const name of gSkill ? parseInstalledSkills(gSkill.payload) : []) installed.push({ kind: 'skill', name, scope: 'global' })

  // Project: every distinct scope_key path recorded for this source, mapped to a repo name.
  const projectKeys = (
    store.queryAll(
      `SELECT DISTINCT scope_key FROM environment_snapshots WHERE source = ? AND scope = 'project'`,
      SOURCE,
    ) as Array<{ scope_key: string }>
  ).map((r) => r.scope_key)
  const { byRepo, ambiguous } = mapScopeKeysToRepos(projectKeys)
  for (const [repo, scopeKey] of byRepo) {
    const pMcp = store.envSnapshotCurrent(SOURCE, 'project', scopeKey, 'mcp')
    for (const name of pMcp ? parseInstalledMcp(pMcp.payload) : []) installed.push({ kind: 'mcp', name, scope: 'project', repo })
    const pSkill = store.envSnapshotCurrent(SOURCE, 'project', scopeKey, 'skills')
    for (const name of pSkill ? parseInstalledSkills(pSkill.payload) : []) installed.push({ kind: 'skill', name, scope: 'project', repo })
  }
  return { installed, ambiguous }
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

/** A few recent session ids per repo, for card evidence pointers. */
function loadSampleSessions(store: Store, sinceIso: string): Map<string, string[]> {
  const rows = store.queryAll(
    `SELECT id, repo FROM sessions
     WHERE source = ? AND started_at >= ? AND repo IS NOT NULL
     ORDER BY started_at DESC`,
    SOURCE,
    sinceIso,
  ) as Array<{ id: string; repo: string }>
  const out = new Map<string, string[]>()
  for (const { id, repo } of rows) {
    const list = out.get(repo) ?? []
    if (list.length < SAMPLE_SESSIONS_PER_REPO) list.push(id)
    out.set(repo, list)
  }
  return out
}

export const unusedCapabilities: Detector = {
  name: 'unused-capabilities',
  version: 1,
  tier: 'S',
  run(ctx: DetectorContext): InsightInput[] {
    const sinceIso = new Date(Date.now() - WINDOW_DAYS * 86_400_000).toISOString()
    const { installed, ambiguous } = loadInstalled(ctx.store)
    if (ambiguous.size > 0) {
      ctx.log.debug(`unused-capabilities: skipped ${ambiguous.size} repo(s) with a colliding basename: ${[...ambiguous].join(', ')}`)
    }
    if (installed.length === 0) return [] // no config snapshots captured yet — nothing to judge

    const invoked = queryInvoked(ctx.store, sinceIso, SOURCE)
    const sessionCounts = loadSessionCounts(ctx.store, sinceIso)
    const classified = classify(installed, invoked, sessionCounts)
    return buildCards(classified, loadSampleSessions(ctx.store, sinceIso))
  },
}

registerDetector(unusedCapabilities)
