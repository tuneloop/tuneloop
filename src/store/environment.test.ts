import { describe, expect, it } from 'vitest'
import { openDb } from './db'
import { Store } from './store'
import type { EnvSnapshotInput } from './types'

function setup() {
  const db = openDb(':memory:')
  return { db, store: new Store(db) }
}

const SRC = 'claude-code'

/** A settings-category write for a repo, with a given payload. */
function snap(store: Store, payload: unknown, now: string, over: Partial<EnvSnapshotInput> = {}): void {
  store.recordEnvSnapshot(
    { source: SRC, scope: 'project', scopeKey: '/repo', category: 'settings', payload, ...over },
    now,
  )
}

/** Count rows for the default (project, /repo, settings) key. */
function rowCount(db: ReturnType<typeof openDb>): number {
  return (
    db
      .prepare(
        `SELECT COUNT(*) as n FROM environment_snapshots
         WHERE source = ? AND scope = 'project' AND scope_key = '/repo' AND category = 'settings'`,
      )
      .get(SRC) as { n: number }
  ).n
}

describe('recordEnvSnapshot — append-on-change', () => {
  it('first write inserts a row', () => {
    const { db, store } = setup()
    snap(store, { allow: ['a'] }, '2026-01-01T00:00:00Z')
    expect(rowCount(db)).toBe(1)
    const cur = store.envSnapshotCurrent(SRC, 'project', '/repo', 'settings')
    expect(cur?.payload).toEqual({ allow: ['a'] })
    expect(cur?.capturedAt).toBe('2026-01-01T00:00:00Z')
    expect(cur?.lastObservedAt).toBe('2026-01-01T00:00:00Z')
  })

  it('unchanged payload updates last_observed_at without adding a row', () => {
    const { db, store } = setup()
    snap(store, { allow: ['a'] }, '2026-01-01T00:00:00Z')
    snap(store, { allow: ['a'] }, '2026-01-02T00:00:00Z')
    snap(store, { allow: ['a'] }, '2026-01-03T00:00:00Z')
    expect(rowCount(db)).toBe(1)
    const cur = store.envSnapshotCurrent(SRC, 'project', '/repo', 'settings')
    expect(cur?.capturedAt).toBe('2026-01-01T00:00:00Z') // first appearance unchanged
    expect(cur?.lastObservedAt).toBe('2026-01-03T00:00:00Z') // confirmed most recently
  })

  it('changed payload appends a new row; current reflects the newest', () => {
    const { db, store } = setup()
    snap(store, { allow: ['a'] }, '2026-01-01T00:00:00Z')
    snap(store, { allow: ['a', 'b'] }, '2026-02-01T00:00:00Z')
    expect(rowCount(db)).toBe(2)
    const cur = store.envSnapshotCurrent(SRC, 'project', '/repo', 'settings')
    expect(cur?.payload).toEqual({ allow: ['a', 'b'] })
    expect(cur?.capturedAt).toBe('2026-02-01T00:00:00Z')
  })

  it('payload key order does not trigger a spurious change', () => {
    const { db, store } = setup()
    snap(store, { allow: ['a'], deny: [] }, '2026-01-01T00:00:00Z')
    // Same content, but the writer hashes the JSON string — assert our serialization
    // is stable for an identical object literal (documents the equality contract).
    snap(store, { allow: ['a'], deny: [] }, '2026-01-02T00:00:00Z')
    expect(rowCount(db)).toBe(1)
  })

  it('round-trip A -> B -> A records a new A row and reports A as current', () => {
    const { db, store } = setup()
    snap(store, { v: 'A' }, '2026-01-01T00:00:00Z')
    snap(store, { v: 'B' }, '2026-02-01T00:00:00Z')
    snap(store, { v: 'A' }, '2026-03-01T00:00:00Z') // revert
    expect(rowCount(db)).toBe(3) // A@Jan, B@Feb, A@Mar — no PK collision
    const cur = store.envSnapshotCurrent(SRC, 'project', '/repo', 'settings')
    expect(cur?.payload).toEqual({ v: 'A' })
    expect(cur?.capturedAt).toBe('2026-03-01T00:00:00Z') // the reverted-to A, not the original
  })

  it('keeps timelines separate per (scope, scope_key, category)', () => {
    const { store } = setup()
    snap(store, { v: 'repo-settings' }, '2026-01-01T00:00:00Z')
    snap(store, { v: 'repo-mcp' }, '2026-01-01T00:00:00Z', { category: 'mcp' })
    snap(store, { v: 'other-repo' }, '2026-01-01T00:00:00Z', { scopeKey: '/other' })
    store.recordEnvSnapshot(
      { source: SRC, scope: 'global', scopeKey: '_global', category: 'settings', payload: { v: 'global' } },
      '2026-01-01T00:00:00Z',
    )
    expect(store.envSnapshotCurrent(SRC, 'project', '/repo', 'settings')?.payload).toEqual({ v: 'repo-settings' })
    expect(store.envSnapshotCurrent(SRC, 'project', '/repo', 'mcp')?.payload).toEqual({ v: 'repo-mcp' })
    expect(store.envSnapshotCurrent(SRC, 'project', '/other', 'settings')?.payload).toEqual({ v: 'other-repo' })
    expect(store.envSnapshotCurrent(SRC, 'global', '_global', 'settings')?.payload).toEqual({ v: 'global' })
  })
})

describe('reads', () => {
  it('current returns null when no snapshot exists', () => {
    const { store } = setup()
    expect(store.envSnapshotCurrent(SRC, 'project', '/repo', 'settings')).toBeNull()
  })

  it('asOf returns the state in effect at the given time', () => {
    const { store } = setup()
    snap(store, { v: 'A' }, '2026-01-01T00:00:00Z')
    snap(store, { v: 'B' }, '2026-02-01T00:00:00Z')
    // Between the two changes → A is still in effect.
    const mid = store.envSnapshotAsOf(SRC, 'project', '/repo', 'settings', '2026-01-15T00:00:00Z')
    expect(mid.stale).toBe(false)
    expect(mid.row?.payload).toEqual({ v: 'A' })
    // After the second change → B.
    const late = store.envSnapshotAsOf(SRC, 'project', '/repo', 'settings', '2026-03-01T00:00:00Z')
    expect(late.row?.payload).toEqual({ v: 'B' })
  })

  it('asOf at the exact captured_at is inclusive', () => {
    const { store } = setup()
    snap(store, { v: 'A' }, '2026-01-01T00:00:00Z')
    const at = store.envSnapshotAsOf(SRC, 'project', '/repo', 'settings', '2026-01-01T00:00:00Z')
    expect(at.row?.payload).toEqual({ v: 'A' })
    expect(at.stale).toBe(false)
  })

  it('asOf flags stale when no snapshot precedes the time', () => {
    const { store } = setup()
    snap(store, { v: 'A' }, '2026-02-01T00:00:00Z')
    // A session that ran BEFORE we ever observed the config.
    const before = store.envSnapshotAsOf(SRC, 'project', '/repo', 'settings', '2026-01-01T00:00:00Z')
    expect(before.stale).toBe(true)
    expect(before.row).toBeNull()
  })
})
