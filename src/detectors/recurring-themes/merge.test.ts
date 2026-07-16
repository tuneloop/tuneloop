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

function mergeLlm(merges: Array<{ keep_id: string; drop_id: string }>): LlmClient {
  return {
    provider: 'anthropic',
    model: 'claude-fable-5',
    async completeStructured(_req: StructuredRequest): Promise<LlmResult> {
      return { data: { merges }, usage: emptyUsage() }
    },
  }
}

describe('runThemeMerge', () => {
  it('absorbs a duplicate: events re-pointed to the keeper, the drop deleted', async () => {
    const { db, store } = setup()
    seedTheme(db, 'recurring-themes:o-r:db-config-path', 'Db Config Path', 'o/r', 's1')
    seedTheme(db, 'recurring-themes:o-r:where-is-db-config', 'Where Is Db Config', 'o/r', 's2')
    const llm = mergeLlm([{ keep_id: 'recurring-themes:o-r:db-config-path', drop_id: 'recurring-themes:o-r:where-is-db-config' }])
    const { applied } = await runThemeMerge(store, llm, noopLog)
    expect(applied).toBe(1)
    const themes = store.allThemes()
    expect(themes.map((t) => t.id)).toEqual(['recurring-themes:o-r:db-config-path'])
    // Both events now belong to the keeper.
    expect(store.themesWithEvents().find((t) => t.id === 'recurring-themes:o-r:db-config-path')!.eventCount).toBe(2)
  })

  it('refuses an illegal cross-repo merge (keeper repo-scoped, drop in another repo)', async () => {
    const { db, store } = setup()
    seedTheme(db, 'recurring-themes:o-a:x', 'X', 'o/a', 's1')
    seedTheme(db, 'recurring-themes:o-b:y', 'Y', 'o/b', 's2')
    const llm = mergeLlm([{ keep_id: 'recurring-themes:o-a:x', drop_id: 'recurring-themes:o-b:y' }])
    const { applied } = await runThemeMerge(store, llm, noopLog)
    expect(applied).toBe(0)
    expect(store.allThemes()).toHaveLength(2)
  })

  it('a global keeper may absorb a repo-scoped duplicate', async () => {
    const { db, store } = setup()
    seedTheme(db, 'recurring-themes:global:changelog-format', 'Changelog Format', null, 's1')
    seedTheme(db, 'recurring-themes:o-r:changelog-style', 'Changelog Style', 'o/r', 's2')
    const llm = mergeLlm([{ keep_id: 'recurring-themes:global:changelog-format', drop_id: 'recurring-themes:o-r:changelog-style' }])
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
      async completeStructured() { calls++; return { data: { merges: [] }, usage: emptyUsage() } },
    }
    await runThemeMerge(store, countingLlm, noopLog)
    const afterFirst = calls
    expect(afterFirst).toBeGreaterThan(0)
    await runThemeMerge(store, countingLlm, noopLog) // unchanged set → gated
    expect(calls).toBe(afterFirst)
  })
})
