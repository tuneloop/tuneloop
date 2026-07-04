import { describe, expect, it } from 'vitest'
import { runFrictionMerge } from './friction-merge'
import { emptyUsage } from '../core/model'
import { openDb } from '../store/db'
import { Store } from '../store/store'
import type { LlmClient } from '../llm/types'
import type { FrictionEventInput, FrictionTopicInput } from '../store/types'

const noopLog = { debug() {}, info() {}, warn() {}, error() {} }

function seedSession(db: ReturnType<typeof openDb>, id: string) {
  db.prepare('INSERT INTO sessions (id, session_id, source, provider) VALUES (?,?,?,?)').run(id, id, 'claude-code', 'anthropic')
}

const topic = (id: string, label: string, repo?: string): FrictionTopicInput => ({
  id,
  label,
  type: 'context-supply',
  repo,
})
const ev = (idx: number, topicId: string): FrictionEventInput => ({
  idx,
  type: 'context-supply',
  trigger: 'unprompted',
  remedyHint: 'add_doc',
  description: `event ${idx}`,
  topicId,
})

function stubLlm(merges: Array<{ keep_id: string; drop_id: string }>, calls?: string[]): LlmClient {
  return {
    provider: 'anthropic',
    model: 'claude-sonnet-5',
    async completeStructured(req) {
      calls?.push(req.user)
      return { data: { merges }, usage: emptyUsage() }
    },
  }
}

function setup() {
  const db = openDb(':memory:')
  const store = new Store(db)
  seedSession(db, 's1')
  seedSession(db, 's2')
  store.persistResult('s1', 'enrich-friction', 1, 'h1', 'm', {
    frictionTopics: [topic('t:a:sqlite-db', 'Default Sqlite Db Not Known', 'a'), topic('t:a:sqlite-database', 'Sqlite Database Location Unclear', 'a')],
    frictionEvents: [ev(0, 't:a:sqlite-db'), ev(1, 't:a:sqlite-database')],
  })
  store.persistResult('s2', 'enrich-friction', 1, 'h2', 'm', {
    frictionTopics: [topic('t:b:tool-inventory', 'Tool Inventory Not Documented', 'b')],
    frictionEvents: [ev(0, 't:b:tool-inventory')],
  })
  return { db, store }
}

describe('friction merge pass', () => {
  it('applies a legal same-repo merge: events re-pointed, topic absorbed, counts conserved', async () => {
    const { db, store } = setup()
    await runFrictionMerge(store, stubLlm([{ keep_id: 't:a:sqlite-db', drop_id: 't:a:sqlite-database' }]), noopLog)

    expect(store.allFrictionTopics().map((t) => t.id).sort()).toEqual(['t:a:sqlite-db', 't:b:tool-inventory'])
    expect(db.prepare("SELECT COUNT(*) c FROM friction_events WHERE topic_id = 't:a:sqlite-db'").get()).toMatchObject({ c: 2 })
    expect(db.prepare('SELECT COUNT(*) c FROM friction_events').get()).toMatchObject({ c: 3 })
  })

  it('rejects a cross-repo merge proposal', async () => {
    const { store } = setup()
    await runFrictionMerge(store, stubLlm([{ keep_id: 't:a:sqlite-db', drop_id: 't:b:tool-inventory' }]), noopLog)
    expect(store.allFrictionTopics()).toHaveLength(3) // nothing merged
  })

  it('a global keeper may absorb a repo-scoped duplicate, but not the reverse', async () => {
    const db = openDb(':memory:')
    const store = new Store(db)
    seedSession(db, 's1')
    store.persistResult('s1', 'enrich-friction', 1, 'h1', 'm', {
      frictionTopics: [topic('t:g:oss-pr', 'OSS Compatible PR Descriptions'), topic('t:a:oss-pr', 'OSS PR Description Convention', 'a')],
      frictionEvents: [ev(0, 't:g:oss-pr'), ev(1, 't:a:oss-pr')],
    })
    // Reverse direction (repo keeper absorbing a global) is rejected...
    await runFrictionMerge(store, stubLlm([{ keep_id: 't:a:oss-pr', drop_id: 't:g:oss-pr' }]), noopLog)
    expect(store.allFrictionTopics()).toHaveLength(2)
    // ...but hash-stamping already happened; reset the gate to test the legal direction.
    store.setMeta('friction_merge_input_hash', '')
    await runFrictionMerge(store, stubLlm([{ keep_id: 't:g:oss-pr', drop_id: 't:a:oss-pr' }]), noopLog)
    expect(store.allFrictionTopics().map((t) => t.id)).toEqual(['t:g:oss-pr'])
  })

  it('hash gate: a second run with an unchanged topic set never calls the LLM', async () => {
    const { store } = setup()
    await runFrictionMerge(store, stubLlm([]), noopLog) // stamps the hash
    const exploding: LlmClient = {
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      async completeStructured(): Promise<never> {
        throw new Error('must not be called — topic set unchanged')
      },
    }
    await expect(runFrictionMerge(store, exploding, noopLog)).resolves.toBeUndefined()
  })

  it('a failed LLM call degrades to no merges and does NOT stamp the gate — the pass retries next run', async () => {
    const { store } = setup()
    const failing: LlmClient = {
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      async completeStructured(): Promise<never> {
        throw new Error('boom')
      },
    }
    await runFrictionMerge(store, failing, noopLog)
    expect(store.allFrictionTopics()).toHaveLength(3)
    // Same topic set, next analyze: the gate must still be open (a stamp here would
    // permanently suppress merging the failed group's duplicates).
    const calls: string[] = []
    await runFrictionMerge(store, stubLlm([], calls), noopLog)
    expect(calls.length).toBeGreaterThan(0)
  })
})
