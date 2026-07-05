import { describe, expect, it } from 'vitest'
import { runFrictionAdvise } from './friction-advise'
import { emptyUsage } from '../core/model'
import { openDb } from '../store/db'
import { Store } from '../store/store'
import type { LlmClient } from '../llm/types'
import type { FrictionEventInput, FrictionTopicInput } from '../store/types'

const noopLog = { debug() {}, info() {}, warn() {}, error() {} }

const topic = (id: string, label: string, repo?: string): FrictionTopicInput => ({
  id,
  label,
  type: 'context-supply',
  repo,
})
const ev = (idx: number, topicId: string, description = `event ${idx}`): FrictionEventInput => ({
  idx,
  type: 'context-supply',
  trigger: 'unprompted',
  remedyHint: 'add_doc',
  description,
  topicId,
})

function stubLlm(advice: Array<{ topic_id: string; advice: string }>, calls?: string[]): LlmClient {
  return {
    provider: 'anthropic',
    model: 'claude-sonnet-5',
    async completeStructured(req) {
      calls?.push(req.user)
      return { data: { advice }, usage: emptyUsage() }
    },
  }
}

function setup() {
  const db = openDb(':memory:')
  const store = new Store(db)
  db.prepare('INSERT INTO sessions (id, session_id, source, provider) VALUES (?,?,?,?)').run('s1', 's1', 'claude-code', 'anthropic')
  store.persistResult('s1', 'enrich-friction', 1, 'h1', 'm', {
    frictionTopics: [topic('t:a:sqlite-db', 'Default Sqlite Db Not Known', 'a')],
    frictionEvents: [ev(0, 't:a:sqlite-db', 'user had to point the agent at the default sqlite db')],
  })
  return { db, store }
}

describe('friction advise pass', () => {
  it('writes advice for a topic and stamps its hash', async () => {
    const { db, store } = setup()
    await runFrictionAdvise(store, stubLlm([{ topic_id: 't:a:sqlite-db', advice: 'Add a CLAUDE.md line naming the default sqlite db path.' }]), noopLog)
    const row = db.prepare('SELECT advice, advice_hash AS h FROM friction_topics').get() as { advice: string; h: string }
    expect(row.advice).toContain('CLAUDE.md')
    expect(row.h).toBeTruthy()
  })

  it('hash gate: unchanged member set never calls the LLM; a new event reopens it', async () => {
    const { db, store } = setup()
    await runFrictionAdvise(store, stubLlm([{ topic_id: 't:a:sqlite-db', advice: 'Do the thing.' }]), noopLog)
    const exploding: LlmClient = {
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      async completeStructured(): Promise<never> {
        throw new Error('must not be called — member set unchanged')
      },
    }
    await expect(runFrictionAdvise(store, exploding, noopLog)).resolves.toBeUndefined()

    // A new member event with a NEW description changes the hash → regenerates.
    db.prepare('INSERT INTO sessions (id, session_id, source, provider) VALUES (?,?,?,?)').run('s2', 's2', 'claude-code', 'anthropic')
    store.persistResult('s2', 'enrich-friction', 1, 'h2', 'm', {
      frictionTopics: [topic('t:a:sqlite-db', 'Default Sqlite Db Not Known', 'a')],
      frictionEvents: [ev(0, 't:a:sqlite-db', 'user pasted the db schema the agent could have read')],
    })
    const calls: string[] = []
    await runFrictionAdvise(store, stubLlm([{ topic_id: 't:a:sqlite-db', advice: 'Updated advice.' }], calls), noopLog)
    expect(calls.length).toBe(1)
    const row = db.prepare('SELECT advice FROM friction_topics').get() as { advice: string }
    expect(row.advice).toBe('Updated advice.')
  })

  it('a failed call leaves the topic unstamped — retried next run; junk output is gated', async () => {
    const { db, store } = setup()
    const failing: LlmClient = {
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      async completeStructured(): Promise<never> {
        throw new Error('boom')
      },
    }
    await runFrictionAdvise(store, failing, noopLog)
    expect((db.prepare('SELECT advice FROM friction_topics').get() as { advice: string | null }).advice).toBeNull()

    // Over-long advice (model rambling) is skipped, also unstamped.
    await runFrictionAdvise(store, stubLlm([{ topic_id: 't:a:sqlite-db', advice: 'x'.repeat(401) }]), noopLog)
    expect((db.prepare('SELECT advice_hash AS h FROM friction_topics').get() as { h: string | null }).h).toBeNull()

    const calls: string[] = []
    await runFrictionAdvise(store, stubLlm([{ topic_id: 't:a:sqlite-db', advice: 'Fine now.' }], calls), noopLog)
    expect(calls.length).toBe(1)
  })
})
