/**
 * Skill-health read model: per installed/invoked skill, everything we can say
 * HONESTLY from real sessions — trigger frequency + trend, a used/dead/mis-scoped
 * verdict (reusing the unused-capabilities policy), the skill's own-call error rate,
 * and a clearly-labelled friction-adjacency PROXY. Plus the installed SKILL.md
 * `description` so the UI can show what each skill is.
 *
 * Deliberate NON-claims (see docs/plans/skill-health.md and [[correctness-over-coverage]]):
 *  - NO per-skill token/time cost. Tokens live per-assistant-message, never on the
 *    ToolCall; attributing cost to a skill would be fabricated. Frequency is honest;
 *    cost per skill is not.
 *  - The friction-adjacency number is a PROXY ("an errored tool call followed the
 *    skill within the same session"), not a quality verdict. It is labelled as such
 *    and never phrased as "the skill was wrong".
 *
 * This is a pure read over the store — analyze WRITES, serve/this only READ.
 */

import { basename } from 'node:path'
import type { Store } from '../store/store'
import {
  classify,
  mapScopeKeysToRepos,
  parseInstalledSkills,
  queryInvoked,
  skillMatches,
  WINDOW_DAYS,
  type InstalledCap,
} from '../detectors/unused-capabilities'

/** The harness this reads: skill grammar + config layout are Claude-Code-specific (matches unused-capabilities). */
const SOURCE = 'claude-code'
/** How many tool calls after a skill engagement we scan for an error, for the friction proxy. */
const FRICTION_LOOKAHEAD = 3
/** Sparkline granularity. */
const SPARK_BUCKETS = 12

/** An installed skill with the metadata the roster shows. */
interface InstalledSkill {
  name: string
  scope: 'global' | 'project'
  repo?: string
  description?: string
}

/** Per-skill aggregate the UI renders. */
export interface SkillHealthRow {
  name: string
  description?: string
  /** Where it's installed. 'unregistered' = we saw it run but it's in no config snapshot. */
  scope: 'global' | 'project' | 'unregistered'
  /** Project repos it's installed in (scope='project'). */
  installedRepos: string[]
  installed: boolean
  /** Distinct sessions it was invoked in, in the window. */
  sessions: number
  /** Total invocations in the window. */
  calls: number
  /** Invocations whose own tool call errored. */
  errorCalls: number
  /** Repos it was actually invoked in (excludes the null-repo bucket). */
  usedRepos: string[]
  /** Proxy: invocations followed by an errored tool call within FRICTION_LOOKAHEAD calls, same session. */
  frictionAdjacent: number
  firstUsedAt: string | null
  lastUsedAt: string | null
  /** Per-bucket invocation counts for the sparkline, oldest→newest, length SPARK_BUCKETS. */
  spark: number[]
  /**
   * The health verdict:
   *  - active: installed and invoked in the window
   *  - dead: installed, never invoked, AND enough sessions observed to trust the
   *    absence (a "missed opportunity" / removal candidate) — the classify 'remove' verdict
   *  - idle: installed, never invoked, but too few sessions to judge — we abstain
   *    rather than call it dead (honest "not enough data")
   *  - scope: global but used in only a few repos — candidate to scope down
   *  - unregistered: invoked but not found in any current config snapshot (a plugin,
   *    or a skill removed/relocated since it last ran)
   */
  verdict: 'active' | 'dead' | 'idle' | 'scope' | 'unregistered'
  /** For verdict='scope': the repos it's actually used in. */
  scopeToRepos?: string[]
}

export interface SkillHealthReport {
  windowDays: number
  totalInstalled: number
  totalActive: number
  totalDead: number
  totalIdle: number
  totalScope: number
  totalUnregistered: number
  rows: SkillHealthRow[]
  /** True when no config snapshot has been captured — the installed side is unknown. */
  noConfig: boolean
}

/** Load installed skills (with descriptions) from the current config snapshots. */
function loadInstalledSkills(store: Store): InstalledSkill[] {
  const out: InstalledSkill[] = []

  const readOne = (scope: 'global' | 'project', scopeKey: string, repo?: string) => {
    const snap = store.envSnapshotCurrent(SOURCE, scope, scopeKey, 'skills')
    if (!snap) return
    // parseInstalledSkills gives names; re-read the payload for descriptions so the
    // roster can show what each skill is (payload shape: { skills: [{name, description?}] }).
    const names = new Set(parseInstalledSkills(snap.payload))
    const descByName = new Map<string, string>()
    const skills = (snap.payload as { skills?: unknown })?.skills
    if (Array.isArray(skills)) {
      for (const s of skills) {
        const o = s as Record<string, unknown> | null
        if (o && typeof o.name === 'string' && typeof o.description === 'string') descByName.set(o.name, o.description)
      }
    }
    for (const name of names) out.push({ name, scope, repo, description: descByName.get(name) })
  }

  readOne('global', '_global')

  const projectKeys = (
    store.queryAll(
      `SELECT DISTINCT scope_key FROM environment_snapshots WHERE source = ? AND scope = 'project'`,
      SOURCE,
    ) as Array<{ scope_key: string }>
  ).map((r) => r.scope_key)
  const { byRepo } = mapScopeKeysToRepos(projectKeys)
  for (const [repo, scopeKey] of byRepo) readOne('project', scopeKey, repo)

  return out
}

/** One invoked-skill row with timeline + error/friction facts (main-thread, in-window). */
interface InvokedDetail {
  name: string
  repo: string | null
  sessions: number
  calls: number
  errorCalls: number
  frictionAdjacent: number
  firstUsedAt: string | null
  lastUsedAt: string | null
}

/**
 * Per (name, repo) invocation facts. The friction-adjacency proxy is computed with a
 * correlated subquery: for each skill call, is there an errored tool call in the same
 * session within the next FRICTION_LOOKAHEAD idx positions? Main-thread only.
 */
function queryInvokedDetail(store: Store, sinceIso: string): InvokedDetail[] {
  return store.queryAll(
    `SELECT t.name AS name,
            s.repo AS repo,
            COUNT(DISTINCT t.session_id) AS sessions,
            COUNT(*) AS calls,
            SUM(CASE WHEN t.is_error = 1 THEN 1 ELSE 0 END) AS errorCalls,
            SUM(CASE WHEN EXISTS (
                  SELECT 1 FROM tool_calls e
                  WHERE e.session_id = t.session_id
                    AND e.idx > t.idx AND e.idx <= t.idx + ?
                    AND e.is_error = 1
                ) THEN 1 ELSE 0 END) AS frictionAdjacent,
            MIN(t.ts) AS firstUsedAt,
            MAX(t.ts) AS lastUsedAt
     FROM tool_calls t JOIN sessions s ON s.id = t.session_id
     WHERE t.action = 'skill' AND t.is_sidechain = 0
       AND s.source = ? AND s.started_at >= ?
     GROUP BY t.name, s.repo`,
    FRICTION_LOOKAHEAD,
    SOURCE,
    sinceIso,
  ) as InvokedDetail[]
}

/** Per-skill sparkline: invocation counts bucketed into SPARK_BUCKETS even slices over the window. */
function querySpark(store: Store, sinceIso: string, sinceMs: number, spanMs: number): Map<string, number[]> {
  const rows = store.queryAll(
    `SELECT t.name AS name, t.ts AS ts
     FROM tool_calls t JOIN sessions s ON s.id = t.session_id
     WHERE t.action = 'skill' AND t.is_sidechain = 0
       AND s.source = ? AND s.started_at >= ? AND t.ts IS NOT NULL`,
    SOURCE,
    sinceIso,
  ) as Array<{ name: string; ts: string }>
  const bucketMs = spanMs / SPARK_BUCKETS
  const out = new Map<string, number[]>()
  for (const { name, ts } of rows) {
    const t = Date.parse(ts)
    if (Number.isNaN(t)) continue
    const b = Math.min(SPARK_BUCKETS - 1, Math.max(0, Math.floor((t - sinceMs) / bucketMs)))
    const arr = out.get(name) ?? new Array(SPARK_BUCKETS).fill(0)
    arr[b]++
    out.set(name, arr)
  }
  return out
}

/** Distinct-session count per repo in the window — the trust denominator for verdicts. */
function loadSessionCounts(store: Store, sinceIso: string): Map<string, number> {
  const rows = store.queryAll(
    `SELECT repo, COUNT(*) AS n FROM sessions
     WHERE source = ? AND started_at >= ? AND repo IS NOT NULL GROUP BY repo`,
    SOURCE,
    sinceIso,
  ) as Array<{ repo: string; n: number }>
  return new Map(rows.map((r) => [r.repo, r.n]))
}

/**
 * Build the skill-health report. Installed skills come from config snapshots (with
 * descriptions); invocation facts from tool_calls. The remove/scope verdict reuses the
 * unused-capabilities `classify` policy so the two features never disagree. A skill
 * seen running but absent from every snapshot is surfaced as 'unregistered' (not
 * dropped) — it's real usage we can't tie to a config entry.
 */
export function skillHealth(store: Store, nowMs: number = Date.now()): SkillHealthReport {
  const spanMs = WINDOW_DAYS * 86_400_000
  const sinceMs = nowMs - spanMs
  const sinceIso = new Date(sinceMs).toISOString()

  const installed = loadInstalledSkills(store)
  const invokedDetail = queryInvokedDetail(store, sinceIso)
  const spark = querySpark(store, sinceIso, sinceMs, spanMs)
  const sessionCounts = loadSessionCounts(store, sinceIso)

  // Reuse the detector's classify to get remove(=dead)/scope verdicts, skill-side only.
  const installedCaps: InstalledCap[] = installed.map((s) => ({ kind: 'skill', name: s.name, scope: s.scope, repo: s.repo }))
  const invokedCaps = queryInvoked(store, sinceIso, SOURCE).filter((c) => c.kind === 'skill')
  const classified = classify(installedCaps, invokedCaps, sessionCounts)
  // Verdict + scope targets per installed skill name (a name can be classified once per install entry;
  // keep the strongest signal: scope target if any, else remove).
  const verdictByName = new Map<string, { verdict: 'remove' | 'scope'; scopeToRepos?: string[] }>()
  for (const c of classified) {
    if (c.cap.kind !== 'skill') continue
    const prev = verdictByName.get(c.cap.name)
    if (!prev || c.verdict === 'scope') verdictByName.set(c.cap.name, { verdict: c.verdict, scopeToRepos: c.scopeToRepos })
  }

  // Fold invocation detail per skill NAME (summing across repos), matching installed names
  // via skillMatches (plugin-namespaced invocations reconcile to their installed entry).
  const rowsByName = new Map<string, SkillHealthRow>()
  const ensureRow = (name: string, inst?: InstalledSkill): SkillHealthRow => {
    let row = rowsByName.get(name)
    if (!row) {
      row = {
        name,
        description: inst?.description,
        scope: inst ? inst.scope : 'unregistered',
        installedRepos: [],
        installed: !!inst,
        sessions: 0,
        calls: 0,
        errorCalls: 0,
        usedRepos: [],
        frictionAdjacent: 0,
        firstUsedAt: null,
        lastUsedAt: null,
        spark: spark.get(name) ?? new Array(SPARK_BUCKETS).fill(0),
        verdict: 'active',
      }
      rowsByName.set(name, row)
    }
    return row
  }

  // Seed rows from installed skills (so dead ones appear). Merge multiple install entries
  // for the same name (global + project) into one row, collecting project repos.
  for (const inst of installed) {
    const row = ensureRow(inst.name, inst)
    if (!row.description && inst.description) row.description = inst.description
    if (inst.scope === 'project' && inst.repo) row.installedRepos.push(inst.repo)
    // A skill installed both globally and per-project reads as global (the broader scope).
    if (inst.scope === 'global') row.scope = 'global'
    row.installed = true
  }

  // Fold invocations onto matching installed rows (or create an unregistered row).
  for (const iv of invokedDetail) {
    // Find the installed name this invocation reconciles to.
    const match = installed.find((s) => skillMatches(s.name, iv.name))
    const rowName = match ? match.name : iv.name
    const row = ensureRow(rowName, match)
    row.sessions += iv.sessions
    row.calls += iv.calls
    row.errorCalls += iv.errorCalls
    row.frictionAdjacent += iv.frictionAdjacent
    if (iv.repo) row.usedRepos.push(iv.repo)
    row.firstUsedAt = minIso(row.firstUsedAt, iv.firstUsedAt)
    row.lastUsedAt = maxIso(row.lastUsedAt, iv.lastUsedAt)
    // An unregistered invocation carries its own spark under its raw name; fold it in.
    if (!match && row.spark.every((n) => n === 0)) row.spark = spark.get(iv.name) ?? row.spark
  }

  // Assign verdicts.
  for (const row of rowsByName.values()) {
    row.installedRepos = [...new Set(row.installedRepos)].sort()
    row.usedRepos = [...new Set(row.usedRepos)].sort()
    if (!row.installed) {
      row.verdict = 'unregistered'
      continue
    }
    const v = verdictByName.get(row.name)
    if (row.calls > 0) {
      // Invoked in the window. 'scope' still applies (global used in only a few repos);
      // otherwise it's simply active.
      row.verdict = v?.verdict === 'scope' ? (row.scopeToRepos = v.scopeToRepos, 'scope') : 'active'
    } else if (v?.verdict === 'remove') {
      // classify emits 'remove' only once there's enough data to trust the absence.
      row.verdict = 'dead'
    } else {
      // Installed, never invoked, but too little data to call it dead — abstain.
      row.verdict = 'idle'
    }
  }

  const rows = [...rowsByName.values()].sort(rankRows)
  const totalInstalled = rows.filter((r) => r.installed).length
  return {
    windowDays: WINDOW_DAYS,
    totalInstalled,
    totalActive: rows.filter((r) => r.verdict === 'active').length,
    totalDead: rows.filter((r) => r.verdict === 'dead').length,
    totalIdle: rows.filter((r) => r.verdict === 'idle').length,
    totalScope: rows.filter((r) => r.verdict === 'scope').length,
    totalUnregistered: rows.filter((r) => r.verdict === 'unregistered').length,
    rows,
    noConfig: installed.length === 0,
  }
}

/** Roster order: most-used first, then by verdict priority, then name. */
function rankRows(a: SkillHealthRow, b: SkillHealthRow): number {
  if (b.calls !== a.calls) return b.calls - a.calls
  const order = { active: 0, scope: 1, unregistered: 2, dead: 3, idle: 4 }
  return order[a.verdict] - order[b.verdict] || a.name.localeCompare(b.name)
}

function minIso(a: string | null, b: string | null): string | null {
  if (!a) return b
  if (!b) return a
  return a < b ? a : b
}
function maxIso(a: string | null, b: string | null): string | null {
  if (!a) return b
  if (!b) return a
  return a > b ? a : b
}
