import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openDb } from '../../store/db'
import { Store } from '../../store/store'
import { emptyUsage } from '../../core/model'
import { runThemeMerge } from './merge'
import type { LlmClient, LlmResult, StructuredRequest } from '../../llm/types'

let dir: string
let n = 0
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'theme-merge-'))
})
afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

const noopLog = { debug() {}, info() {}, warn() {}, error() {} }

function setup() {
  const db = openDb(join(dir, `t${n++}.db`))
  const store = new Store(db)
  return { db, store }
}

/** Insert a theme and one member event so it survives (events reference it). */
function seedTheme(db: ReturnType<typeof openDb>, id: string, label: string, repo: string | null, sid: string) {
  db.prepare('INSERT INTO sessions (id, session_id, source, provider, started_at, content_hash) VALUES (?,?,?,?,?,?)')
    .run(sid, sid, 'claude-code', 'anthropic', new Date().toISOString(), `h-${sid}`)
  db.prepare('INSERT INTO theme (id, label, type, repo, source, first_seen) VALUES (?,?,?,?,?,?)')
    .run(id, label, 'context-supply', repo, 'derived', new Date().toISOString())
  db.prepare('INSERT INTO theme_events (session_id, idx, type, trigger, description, theme_id, added_at) VALUES (?,?,?,?,?,?,?)')
    .run(sid, 0, 'context-supply', 'unprompted', `event for ${id}`, id, new Date().toISOString())
}

// One canonical-gap cluster in the unified reconcile_taxonomy output shape.
interface Cluster {
  merge_ids?: string[]
  keep_id?: string
  label?: string
  description?: string
  project_specific?: boolean
  orphan_refs?: string[]
}

/**
 * LLM stub returning canned reconcile clusters. Tests express clusters by id/ref
 * (readable); the reconcile prompt now numbers themes [1..N] and orphans [1..M] and
 * the model answers with those NUMBERS — so translate id→number at call time, using
 * the same ordering runThemeMerge builds (store.allThemes / orphanThemeEvents).
 */
function themeLlm(store: Store, clusters: Cluster[] = []): LlmClient {
  return {
    provider: 'anthropic',
    model: 'claude-fable-5',
    async completeStructured(_req: StructuredRequest): Promise<LlmResult> {
      const themeNum = new Map(store.allThemes().map((t, i) => [t.id, i + 1]))
      const orphanTok = new Map(store.orphanThemeEvents().map((o, i) => [`${o.sessionId}#${o.idx}`, `E${i + 1}`]))
      const numeric = clusters.map((c) => ({
        merge_ids: c.merge_ids?.map((id) => themeNum.get(id)),
        keep_id: c.keep_id != null ? themeNum.get(c.keep_id) : undefined,
        orphan_refs: c.orphan_refs?.map((r) => orphanTok.get(r)),
        label: c.label,
        description: c.description,
        project_specific: c.project_specific,
      }))
      return { data: { themes: numeric }, usage: emptyUsage() }
    },
  }
}

/** Sugar for the common "merge two themes" cluster. */
function mergeLlm(store: Store, pairs: Array<{ keep_id: string; drop_id: string }>): LlmClient {
  return themeLlm(store, pairs.map((p) => ({ keep_id: p.keep_id, merge_ids: [p.keep_id, p.drop_id] })))
}

/** Seed a topicless (theme_id NULL) friction event on a session with a repo. */
function seedOrphan(db: ReturnType<typeof openDb>, sid: string, idx: number, repo: string | null, description: string) {
  db.prepare('INSERT OR IGNORE INTO sessions (id, session_id, source, provider, started_at, content_hash, repo) VALUES (?,?,?,?,?,?,?)')
    .run(sid, sid, 'claude-code', 'anthropic', new Date().toISOString(), `h-${sid}`, repo)
  db.prepare('INSERT INTO theme_events (session_id, idx, type, trigger, description, theme_id, added_at) VALUES (?,?,?,?,?,?,?)')
    .run(sid, idx, 'context-supply', 'unprompted', description, null, new Date().toISOString())
}

describe('runThemeMerge', () => {
  it('absorbs a duplicate: events re-pointed to the keeper, the drop deleted', async () => {
    const { db, store } = setup()
    seedTheme(db, 'recurring-themes:o-r:db-config-path', 'Db Config Path', 'o/r', 's1')
    seedTheme(db, 'recurring-themes:o-r:where-is-db-config', 'Where Is Db Config', 'o/r', 's2')
    const llm = mergeLlm(store, [{ keep_id: 'recurring-themes:o-r:db-config-path', drop_id: 'recurring-themes:o-r:where-is-db-config' }])
    const { applied } = await runThemeMerge(store, llm, noopLog)
    expect(applied).toBe(1)
    const themes = store.allThemes()
    expect(themes.map((t) => t.id)).toEqual(['recurring-themes:o-r:db-config-path'])
    // Both events now belong to the keeper.
    expect(store.themesWithEvents().find((t) => t.id === 'recurring-themes:o-r:db-config-path')!.eventCount).toBe(2)
  })

  it('retires the absorbed theme\'s insight (no frozen duplicate left behind)', async () => {
    const { db, store } = setup()
    seedTheme(db, 'recurring-themes:global:a', 'Theme A', null, 's1')
    seedTheme(db, 'recurring-themes:global:b', 'Theme B (dup)', null, 's2')
    // Both themes had surfaced as insights.
    store.persistInsights('recurring-themes', 1, [
      { signalKey: 'recurring-themes:global:a', repo: '*', severity: 'low', title: 'A', description: 'd', evidence: [], count: 3, fix: { type: 'behavioral-nudge', label: 'l', content: 'c' } },
      { signalKey: 'recurring-themes:global:b', repo: '*', severity: 'low', title: 'B', description: 'd', evidence: [], count: 3, fix: { type: 'behavioral-nudge', label: 'l', content: 'c' } },
    ])
    const llm = mergeLlm(store, [{ keep_id: 'recurring-themes:global:a', drop_id: 'recurring-themes:global:b' }])
    await runThemeMerge(store, llm, noopLog)
    const insights = store.insights({ detector: 'recurring-themes' })
    // A still surfaced; B resolved (retired) rather than left dangling on a deleted theme.
    expect(insights.find((i) => i.signalKey === 'recurring-themes:global:a')?.state).toBe('surfaced')
    // insights() excludes dismissed but includes resolved; B should be resolved.
    const b = store.insights({ detector: 'recurring-themes', state: 'resolved' }).find((i) => i.signalKey === 'recurring-themes:global:b')
    expect(b).toBeDefined()
  })

  it('refuses an illegal cross-repo merge (keeper repo-scoped, drop in another repo)', async () => {
    const { db, store } = setup()
    seedTheme(db, 'recurring-themes:o-a:x', 'X', 'o/a', 's1')
    seedTheme(db, 'recurring-themes:o-b:y', 'Y', 'o/b', 's2')
    const llm = mergeLlm(store, [{ keep_id: 'recurring-themes:o-a:x', drop_id: 'recurring-themes:o-b:y' }])
    const { applied } = await runThemeMerge(store, llm, noopLog)
    expect(applied).toBe(0)
    expect(store.allThemes()).toHaveLength(2)
  })

  it('a global keeper may absorb a repo-scoped duplicate', async () => {
    const { db, store } = setup()
    seedTheme(db, 'recurring-themes:global:changelog-format', 'Changelog Format', null, 's1')
    seedTheme(db, 'recurring-themes:o-r:changelog-style', 'Changelog Style', 'o/r', 's2')
    const llm = mergeLlm(store, [{ keep_id: 'recurring-themes:global:changelog-format', drop_id: 'recurring-themes:o-r:changelog-style' }])
    const { applied } = await runThemeMerge(store, llm, noopLog)
    expect(applied).toBe(1)
    expect(store.allThemes().map((t) => t.id)).toEqual(['recurring-themes:global:changelog-format'])
  })

  it('is a no-op when the theme set is unchanged since the last pass (hash gate)', async () => {
    const { db, store } = setup()
    seedTheme(db, 'recurring-themes:o-r:a', 'A', 'o/r', 's1')
    seedTheme(db, 'recurring-themes:o-r:b', 'B', 'o/r', 's2')
    let calls = 0
    const countingLlm: LlmClient = {
      provider: 'anthropic', model: 'claude-fable-5',
      async completeStructured() { calls++; return { data: { themes: [] }, usage: emptyUsage() } },
    }
    await runThemeMerge(store, countingLlm, noopLog)
    const afterFirst = calls
    expect(afterFirst).toBeGreaterThan(0)
    await runThemeMerge(store, countingLlm, noopLog) // unchanged set → gated
    expect(calls).toBe(afterFirst)
  })

  it('rewrites the kept theme label + description when the cluster proposes better wording', async () => {
    const { db, store } = setup()
    seedTheme(db, 'recurring-themes:o-r:db-config-path', 'Db Config Path', 'o/r', 's1')
    seedTheme(db, 'recurring-themes:o-r:where-is-db-config', 'Where Is Db Config', 'o/r', 's2')
    const llm = themeLlm(store, [{
      merge_ids: ['recurring-themes:o-r:db-config-path', 'recurring-themes:o-r:where-is-db-config'],
      keep_id: 'recurring-themes:o-r:db-config-path',
      label: 'Database Config Location Unknown',
      description: 'Agent cannot locate the file holding the database connection config.',
    }])
    await runThemeMerge(store, llm, noopLog)
    const kept = store.allThemes().find((t) => t.id === 'recurring-themes:o-r:db-config-path')!
    expect(kept.label).toBe('Database Config Location Unknown')
    expect(kept.description).toBe('Agent cannot locate the file holding the database connection config.')
  })

  it('clamps a reworded keeper label to the max length (same bound as minting)', async () => {
    const { db, store } = setup()
    seedTheme(db, 'recurring-themes:global:a', 'A', null, 's1')
    seedTheme(db, 'recurring-themes:global:b', 'B', null, 's2')
    const longLabel = 'X'.repeat(200)
    const llm = themeLlm(store, [{ merge_ids: ['recurring-themes:global:a', 'recurring-themes:global:b'], keep_id: 'recurring-themes:global:a', label: longLabel }])
    await runThemeMerge(store, llm, noopLog)
    const kept = store.allThemes().find((t) => t.id === 'recurring-themes:global:a')!
    expect(kept.label.length).toBeLessThanOrEqual(80)
  })

  it('merges 3 themes into one keeper in a single cluster', async () => {
    const { db, store } = setup()
    seedTheme(db, 'recurring-themes:global:t1', 'T1', null, 's1')
    seedTheme(db, 'recurring-themes:global:t2', 'T2', null, 's2')
    seedTheme(db, 'recurring-themes:global:t3', 'T3', null, 's3')
    const llm = themeLlm(store, [{
      merge_ids: ['recurring-themes:global:t1', 'recurring-themes:global:t2', 'recurring-themes:global:t3'],
      keep_id: 'recurring-themes:global:t1',
    }])
    const { applied } = await runThemeMerge(store, llm, noopLog)
    expect(applied).toBe(2) // two absorbed into the keeper
    expect(store.allThemes().map((t) => t.id)).toEqual(['recurring-themes:global:t1'])
    expect(store.themesWithEvents().find((t) => t.id === 'recurring-themes:global:t1')!.eventCount).toBe(3)
  })

  it('assigns an orphan event onto an existing theme via orphan_refs', async () => {
    const { db, store } = setup()
    seedTheme(db, 'recurring-themes:global:self-review-misses-bugs', 'Self-Review Misses Bugs', null, 's1')
    seedOrphan(db, 's2', 0, 'o/r', 'a code review caught a real bug the agent shipped')
    const llm = themeLlm(store, [{
      keep_id: 'recurring-themes:global:self-review-misses-bugs',
      orphan_refs: ['s2#0'],
    }])
    const { applied } = await runThemeMerge(store, llm, noopLog)
    expect(applied).toBe(1)
    const rows = store.queryAll('SELECT theme_id FROM theme_events WHERE session_id = ?', 's2') as Array<{ theme_id: string | null }>
    expect(rows[0]!.theme_id).toBe('recurring-themes:global:self-review-misses-bugs')
  })

  it('mints a new theme from orphans when none match (one cluster, both events attached)', async () => {
    const { db, store } = setup()
    seedTheme(db, 'recurring-themes:o-r:unrelated', 'Unrelated', 'o/r', 's0')
    seedOrphan(db, 's1', 0, 'o/a', 'user had to restate the changelog format')
    seedOrphan(db, 's2', 0, 'o/b', 'user again had to restate the changelog format')
    const llm = themeLlm(store, [{
      label: 'Changelog Format Not Followed',
      description: 'Agent keeps missing the changelog format.',
      project_specific: false,
      orphan_refs: ['s1#0', 's2#0'],
    }])
    const { applied } = await runThemeMerge(store, llm, noopLog)
    expect(applied).toBe(2) // both orphans attached
    const minted = store.allThemes().find((t) => t.id === 'recurring-themes:global:changelog-format-not-followed')
    expect(minted).toBeDefined()
    expect(minted!.repo).toBeNull() // project_specific=false → global
    const twe = store.themesWithEvents().find((t) => t.id === minted!.id)!
    expect(twe.eventCount).toBe(2)
    expect(twe.sessionCount).toBe(2)
  })

  it('scopes a minted theme to the repo when project_specific and orphans share one repo', async () => {
    const { db, store } = setup()
    seedTheme(db, 'recurring-themes:o-r:unrelated', 'Unrelated', 'o/r', 's0')
    seedOrphan(db, 's1', 0, 'acme/app', 'agent did not know this app\'s deploy sequence')
    seedOrphan(db, 's2', 0, 'acme/app', 'agent again did not know this app\'s deploy sequence')
    const llm = themeLlm(store, [{
      label: 'Deploy Sequence Unknown',
      description: 'Agent does not know this project\'s deploy steps.',
      project_specific: true,
      orphan_refs: ['s1#0', 's2#0'],
    }])
    await runThemeMerge(store, llm, noopLog)
    const minted = store.allThemes().find((t) => t.label === 'Deploy Sequence Unknown')!
    expect(minted.repo).toBe('acme/app')
  })

  it('does NOT mint a theme from a single orphan (one incident is not a recurrence)', async () => {
    const { db, store } = setup()
    seedTheme(db, 'recurring-themes:global:x', 'X', null, 's0')
    seedTheme(db, 'recurring-themes:global:y', 'Y', null, 's3')
    seedOrphan(db, 's1', 0, 'o/r', 'a one-off gap the model wanted to coin a theme for')
    // The LLM proposes a mint from a lone orphan — the code guard must reject it.
    const llm = themeLlm(store, [{ label: 'Tempting But Single', description: 'one incident', orphan_refs: ['s1#0'] }])
    await runThemeMerge(store, llm, noopLog)
    expect(store.allThemes().some((t) => t.label === 'Tempting But Single')).toBe(false)
    const rows = store.queryAll('SELECT theme_id FROM theme_events WHERE session_id = ?', 's1') as Array<{ theme_id: string | null }>
    expect(rows[0]!.theme_id).toBeNull() // stays unassigned; can join a theme if it recurs
  })

  it('leaves a genuine one-off orphan unassigned (no cluster references it)', async () => {
    const { db, store } = setup()
    seedTheme(db, 'recurring-themes:global:x', 'X', null, 's0')
    seedTheme(db, 'recurring-themes:global:y', 'Y', null, 's3')
    seedOrphan(db, 's1', 0, 'o/r', 'a truly one-off friction that fits nothing')
    const llm = themeLlm(store, []) // nothing to consolidate
    await runThemeMerge(store, llm, noopLog)
    const rows = store.queryAll('SELECT theme_id FROM theme_events WHERE session_id = ?', 's1') as Array<{ theme_id: string | null }>
    expect(rows[0]!.theme_id).toBeNull()
  })

  it('applies clusters even when the tool returns `themes` as a JSON string (Sonnet-5 quirk)', async () => {
    const { db, store } = setup()
    seedTheme(db, 'recurring-themes:global:a', 'A', null, 's1')
    seedTheme(db, 'recurring-themes:global:b', 'B (dup)', null, 's2')
    // The model emitted the whole array as a stringified value, not native JSON.
    const stringifyingLlm: LlmClient = {
      provider: 'anthropic', model: 'claude-sonnet-5',
      async completeStructured() {
        return { data: { themes: JSON.stringify({ themes: [{ merge_ids: [1, 2], keep_id: 1 }] }) }, usage: emptyUsage() }
      },
    }
    const { applied } = await runThemeMerge(store, stringifyingLlm, noopLog)
    expect(applied).toBe(1)
    expect(store.allThemes().map((t) => t.id)).toEqual(['recurring-themes:global:a'])
  })

  it('drops out-of-range numeric refs instead of acting on the wrong theme', async () => {
    const { db, store } = setup()
    seedTheme(db, 'recurring-themes:global:a', 'A', null, 's1')
    seedTheme(db, 'recurring-themes:global:b', 'B', null, 's2')
    // [1] and [99] — 99 has no theme, so the merge has only one valid id → no-op (not a mis-merge).
    const badRefLlm: LlmClient = {
      provider: 'anthropic', model: 'claude-sonnet-5',
      async completeStructured() {
        return { data: { themes: [{ merge_ids: [1, 99], keep_id: 1 }] }, usage: emptyUsage() }
      },
    }
    const { applied } = await runThemeMerge(store, badRefLlm, noopLog)
    expect(applied).toBe(0)
    expect(store.allThemes()).toHaveLength(2)
  })

  it('skips a null/primitive cluster element (salvaged JSON) without throwing', async () => {
    const { db, store } = setup()
    seedTheme(db, 'recurring-themes:global:a', 'A', null, 's1')
    seedTheme(db, 'recurring-themes:global:b', 'B', null, 's2')
    // A malformed array (a null + a primitive alongside a valid merge) must not crash the pass.
    const messyLlm: LlmClient = {
      provider: 'anthropic', model: 'claude-sonnet-5',
      async completeStructured() {
        return { data: { themes: [null, 'oops', { merge_ids: [1, 2], keep_id: 1 }] }, usage: emptyUsage() }
      },
    }
    const { applied } = await runThemeMerge(store, messyLlm, noopLog)
    expect(applied).toBe(1) // the one valid cluster still applied
    expect(store.allThemes().map((t) => t.id)).toEqual(['recurring-themes:global:a'])
  })

  it('resolves orphan E-tokens (and drops a stray theme number placed in orphan_refs)', async () => {
    const { db, store } = setup()
    seedTheme(db, 'recurring-themes:global:known', 'Known', null, 's0')
    seedOrphan(db, 's1', 0, 'o/r', 'an occurrence of the known gap')
    // keep_id=1 (theme), orphan_refs mixes the real token "E1" with "1" (a theme number,
    // wrong namespace) — only the E-token should resolve.
    const tokenLlm: LlmClient = {
      provider: 'anthropic', model: 'claude-sonnet-5',
      async completeStructured() {
        return { data: { themes: [{ keep_id: 1, orphan_refs: ['E1', '1'] }] }, usage: emptyUsage() }
      },
    }
    const { applied } = await runThemeMerge(store, tokenLlm, noopLog)
    expect(applied).toBe(1) // exactly the E1 orphan attached; the stray "1" dropped
    const rows = store.queryAll('SELECT theme_id FROM theme_events WHERE session_id = ?', 's1') as Array<{ theme_id: string | null }>
    expect(rows[0]!.theme_id).toBe('recurring-themes:global:known')
  })

  it('runs even when the theme set is unchanged (orphans present), then gates once they are consumed', async () => {
    const { db, store } = setup()
    // Two themes remain after the orphan is assigned, so the SECOND call is gated by
    // the hash (not the "<2 themes && no orphans" short-circuit) — the real path.
    seedTheme(db, 'recurring-themes:global:known', 'Known', null, 's0')
    seedTheme(db, 'recurring-themes:global:other', 'Other', null, 's2')
    seedOrphan(db, 's1', 0, 'o/r', 'an occurrence of the known gap')
    let calls = 0
    const llm: LlmClient = {
      provider: 'anthropic', model: 'claude-fable-5',
      async completeStructured() {
        calls++
        return { data: { themes: [{ keep_id: 'recurring-themes:global:known', orphan_refs: ['s1#0'] }] }, usage: emptyUsage() }
      },
    }
    await runThemeMerge(store, llm, noopLog)
    expect(calls).toBe(1)
    // Orphan now assigned; a second pass sees an unchanged theme+orphan signature → hash-gated.
    await runThemeMerge(store, llm, noopLog)
    expect(calls).toBe(1)
  })
})
