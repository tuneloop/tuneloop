import { describe, expect, it } from 'vitest'
import { openDb } from '../store/db'
import { Store } from '../store/store'
import { captureEnvironment } from './analyze'
import { createLogger } from '../util/log'
import type { SourceAdapter } from '../adapters/types'
import type { EnvCategorySnapshot } from '../store/types'

const log = createLogger('info')

function setup() {
  return new Store(openDb(':memory:'))
}

/** A minimal adapter whose readEnvironment returns per-path payloads from a map. */
function stubAdapter(
  id: string,
  read?: (projectPath?: string) => EnvCategorySnapshot[],
): SourceAdapter {
  return {
    id,
    provider: 'anthropic',
    parseVersion: 1,
    defaultRoots: () => [],
    discover: async () => [],
    parse: async () => null,
    ...(read ? { readEnvironment: async (p?: string) => read(p) } : {}),
  }
}

describe('captureEnvironment', () => {
  it('does nothing for an adapter without readEnvironment', async () => {
    const store = setup()
    const n = await captureEnvironment(stubAdapter('claude-code'), store, new Set(['/repo']), log)
    expect(n).toBe(0)
    expect(store.envSnapshotCurrent('claude-code', 'global', '_global', 'settings')).toBeNull()
  })

  it('captures global scope with no repos', async () => {
    const store = setup()
    const adapter = stubAdapter('claude-code', (p) =>
      p === undefined ? [{ category: 'settings', payload: { allow: ['a'] } }] : [],
    )
    const n = await captureEnvironment(adapter, store, new Set(), log)
    expect(n).toBe(1)
    expect(store.envSnapshotCurrent('claude-code', 'global', '_global', 'settings')?.payload).toEqual({ allow: ['a'] })
  })

  it('captures global once and each repo once, keyed by root', async () => {
    const store = setup()
    const adapter = stubAdapter('claude-code', (p) => {
      if (p === undefined) return [{ category: 'settings', payload: { scope: 'global' } }]
      return [
        { category: 'settings', payload: { scope: p } },
        { category: 'mcp', payload: { servers: {} } },
      ]
    })
    const n = await captureEnvironment(adapter, store, new Set(['/repo-a', '/repo-b']), log)
    expect(n).toBe(5) // 1 global + 2 categories × 2 repos
    expect(store.envSnapshotCurrent('claude-code', 'global', '_global', 'settings')?.payload).toEqual({ scope: 'global' })
    expect(store.envSnapshotCurrent('claude-code', 'project', '/repo-a', 'settings')?.payload).toEqual({ scope: '/repo-a' })
    expect(store.envSnapshotCurrent('claude-code', 'project', '/repo-b', 'settings')?.payload).toEqual({ scope: '/repo-b' })
    expect(store.envSnapshotCurrent('claude-code', 'project', '/repo-a', 'mcp')?.payload).toEqual({ servers: {} })
  })

  it('passes the project path to the reader (not global) for repo scope', async () => {
    const store = setup()
    const seen: Array<string | undefined> = []
    const adapter = stubAdapter('claude-code', (p) => {
      seen.push(p)
      return []
    })
    await captureEnvironment(adapter, store, new Set(['/repo-a']), log)
    expect(seen).toEqual([undefined, '/repo-a']) // global call first, then the repo
  })

  it('a read failure for one scope is skipped, not fatal', async () => {
    const store = setup()
    const adapter = stubAdapter('claude-code', (p) => {
      if (p === '/bad') throw new Error('boom')
      return [{ category: 'settings', payload: { p: p ?? 'global' } }]
    })
    const n = await captureEnvironment(adapter, store, new Set(['/bad', '/good']), log)
    expect(n).toBe(2) // global + /good; /bad threw and was skipped
    expect(store.envSnapshotCurrent('claude-code', 'project', '/good', 'settings')?.payload).toEqual({ p: '/good' })
    expect(store.envSnapshotCurrent('claude-code', 'project', '/bad', 'settings')).toBeNull()
  })
})
