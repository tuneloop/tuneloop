import { describe, expect, it } from 'vitest'
import { collectFollowups, enrichFriction } from './enrich-friction'
import { emptyUsage } from '../core/model'
import type { ContentBlock, Event, Session, ToolCall } from '../core/model'
import type { ProcessorContext } from '../core/processor'
import type { LlmClient } from '../llm/types'

/**
 * Alternating user / assistant events with explicit seqs. An assistant step may
 * carry a failing tool call (for the error-alignment tests).
 */
function buildSession(
  steps: Array<{ user?: string; assistantText?: string; toolError?: string }>,
  repo: string | null = 'o/r',
): Session {
  const events: Event[] = []
  const toolCalls: ToolCall[] = []
  steps.forEach((s, i) => {
    if (s.user != null) {
      events.push({ kind: 'user', text: s.user, blocks: [], isSidechain: false, seq: i })
      return
    }
    const blocks: ContentBlock[] = []
    if (s.assistantText) blocks.push({ type: 'text', text: s.assistantText })
    if (s.toolError) {
      const id = `t${i}`
      blocks.push({ type: 'tool_use', id, name: 'Bash', input: {} })
      toolCalls.push({
        id,
        name: 'Bash',
        action: 'shell',
        input: {},
        target: {},
        result: { ok: false, isError: true, raw: s.toolError },
        isSidechain: false,
      })
    }
    events.push({ kind: 'assistant', blocks, usage: emptyUsage(), isSidechain: false, seq: i })
  })
  return {
    id: 'claude-code:s',
    sessionId: 's',
    source: 'claude-code',
    provider: 'anthropic',
    project: { cwd: '/repo', repo: repo ?? undefined },
    models: [],
    tokens: emptyUsage(),
    events,
    toolCalls,
    raw: { path: '', contentHash: 'h' },
  }
}

function stubLlm(events: unknown[]): LlmClient {
  return {
    provider: 'anthropic',
    model: 'claude-sonnet-5',
    async completeStructured() {
      return { data: { events }, usage: emptyUsage() }
    },
  }
}

const explodingLlm: LlmClient = {
  provider: 'anthropic',
  model: 'claude-sonnet-5',
  async completeStructured(): Promise<never> {
    throw new Error('LLM must not be called for a session with no follow-ups')
  },
}

const noopLog = { debug() {}, info() {}, warn() {}, error() {} }

function ctx(session: Session, llm: LlmClient, existingTopics: ProcessorContext['existingTopics'] = []): ProcessorContext {
  return {
    session,
    log: noopLog,
    llmEnabled: true,
    llm,
    existingFeatures: [],
    existingTopics,
    rejectedFeatureTitles: [],
    userLinkedArtifacts: [],
    prBlockAttributions: [],
    sh: async () => null,
  }
}

function annotation(res: { annotations?: Array<{ key: string; value: unknown }> }, key: string): unknown {
  return res.annotations?.find((a) => a.key === key)?.value
}

describe('collectFollowups', () => {
  it('aligns tool errors to the follow-up turn they precede', () => {
    const session = buildSession([
      { user: 'build the feature' },
      { toolError: 'FAIL tests: 3 failed' }, // error after the opener
      { user: 'the tests are failing, fix the assertion' }, // followup 1 — sees the error
      { assistantText: 'fixed' },
      { user: 'now also update the docs' }, // followup 2 — no errors before it
    ])
    const followups = collectFollowups(session)
    expect(followups).toHaveLength(2)
    expect(followups[0]!.errors).toEqual(['test_failure'])
    expect(followups[0]!.seq).toBe(2)
    expect(followups[1]!.errors).toEqual([])
  })

  it('drops bare approvals and returns [] for an opener-only session', () => {
    const session = buildSession([{ user: 'do the thing' }, { assistantText: 'done' }, { user: 'lgtm' }])
    expect(collectFollowups(session)).toEqual([])
  })

  it('tags a follow-up when the user pressed interrupt, capturing what the agent was doing', () => {
    const session = buildSession([
      { user: 'fix the bug' },
      { assistantText: 'I will start by refactoring the whole adapter layer' },
      { user: '[Request interrupted by user]' }, // synthetic marker: dropped from turns, kept as signal
      { user: 'no — do not refactor, just patch the bug' },
      { assistantText: 'patched' },
      { user: 'now add a regression test' },
    ])
    const followups = collectFollowups(session)
    expect(followups).toHaveLength(2)
    expect(followups[0]!.interrupted).toBe('saying: "I will start by refactoring the whole adapter layer"')
    expect(followups[1]!.interrupted).toBeUndefined() // no interrupt in its window
  })
})

describe('enrich-friction', () => {
  it('skips the LLM entirely when there are no follow-ups, emitting zero rollups', async () => {
    const session = buildSession([{ user: 'fix typo' }, { assistantText: 'done' }])
    const res = await enrichFriction.run(ctx(session, explodingLlm))
    expect(annotation(res, 'friction_count')).toBe(0)
    expect(annotation(res, 'friction_type')).toEqual([])
    expect(res.frictionEvents ?? []).toEqual([])
  })

  it('mints a repo-scoped topic and maps the event to its turn seq', async () => {
    const session = buildSession([
      { user: 'analyze the data' },
      { assistantText: 'looked at csv' },
      { user: 'no — always use the default sqlite db for analysis' }, // seq 2
    ])
    const llm = stubLlm([
      {
        turn: 1,
        type: 'context-supply',
        description: 'User had to point the agent at the default sqlite db.',
        matched_topic_id: '',
        new_topic_label: 'Default Sqlite Db Not Known',
        remedy_hint: 'add_doc',
        trigger: 'unprompted',
      },
    ])
    const res = await enrichFriction.run(ctx(session, llm))
    expect(res.frictionTopics).toEqual([
      expect.objectContaining({ id: 'friction:derived:o-r:default-sqlite-db-not-known', repo: 'o/r', type: 'context-supply' }),
    ])
    expect(res.frictionEvents).toEqual([
      expect.objectContaining({
        idx: 0,
        turnSeq: 2,
        type: 'context-supply',
        topicId: 'friction:derived:o-r:default-sqlite-db-not-known',
        remedyHint: 'add_doc',
      }),
    ])
    expect(annotation(res, 'friction_count')).toBe(1)
    expect(annotation(res, 'friction_type')).toEqual(['context-supply'])
  })

  it('preference topics are minted global (repo-less id)', async () => {
    const session = buildSession([{ user: 'open a PR' }, { assistantText: 'ok' }, { user: 'PR descriptions must be OSS-compatible, as always' }])
    const llm = stubLlm([
      { turn: 1, type: 'preference', description: 'User restated the OSS-compatible PR description convention.', new_topic_label: 'OSS Compatible PR Descriptions', remedy_hint: 'add_skill', trigger: 'unprompted' },
    ])
    const res = await enrichFriction.run(ctx(session, llm))
    expect(res.frictionTopics?.[0]).toMatchObject({ id: 'friction:derived:global:oss-compatible-pr-descriptions', repo: undefined })
  })

  it('matches an existing topic instead of minting, and ignores a bogus matched id', async () => {
    const session = buildSession([
      { user: 'analyze' },
      { assistantText: 'hm' },
      { user: 'use the default sqlite db' },
      { assistantText: 'ok' },
      { user: 'that whole approach is wrong, redo it' },
    ])
    const existing = [{ id: 'friction:derived:o-r:default-sqlite-db-not-known', label: 'Default Sqlite Db Not Known', type: 'context-supply' as const, repo: 'o/r' }]
    const llm = stubLlm([
      { turn: 1, type: 'context-supply', description: 'User had to point the agent at the default sqlite db.', matched_topic_id: 'friction:derived:o-r:default-sqlite-db-not-known', remedy_hint: 'add_doc', trigger: 'unprompted' },
      { turn: 2, type: 'rework', description: 'User rejected the produced approach and asked for a redo.', matched_topic_id: 'friction:derived:o-r:does-not-exist', new_topic_label: '', remedy_hint: 'none', trigger: 'unprompted' },
    ])
    const res = await enrichFriction.run(ctx(session, llm, existing))
    // The matched topic is re-emitted (not re-minted): INSERT OR IGNORE keeps its
    // identity, and re-emitting heals a topic orphan-pruned mid-run (no FK break).
    expect(res.frictionTopics).toEqual([
      expect.objectContaining({ id: 'friction:derived:o-r:default-sqlite-db-not-known', label: 'Default Sqlite Db Not Known', repo: 'o/r' }),
    ])
    expect(res.frictionEvents?.[0]?.topicId).toBe('friction:derived:o-r:default-sqlite-db-not-known')
    expect(res.frictionEvents?.[1]?.topicId).toBeUndefined() // bogus id ignored, no label → topicless
  })

  it('gates junk topic labels (event survives topicless) and drops events with bad turn refs', async () => {
    const session = buildSession([{ user: 'go' }, { assistantText: 'ok' }, { user: 'not like that, re-read the adapter first' }])
    const llm = stubLlm([
      { turn: 1, type: 're-steer', description: 'User had to redirect the agent to read the adapter before editing.', new_topic_label: 'agent did many wrong things, including this, that, and more', remedy_hint: 'add_doc', trigger: 'unprompted' },
      { turn: 99, type: 'rework', description: 'Out-of-range turn reference.', remedy_hint: 'none', trigger: 'unprompted' },
      { turn: 1, type: 'rework', description: '', remedy_hint: 'none', trigger: 'unprompted' }, // empty description
    ])
    const res = await enrichFriction.run(ctx(session, llm))
    expect(res.frictionTopics).toEqual([])
    expect(res.frictionEvents).toHaveLength(1)
    expect(res.frictionEvents?.[0]).toMatchObject({ type: 're-steer', topicId: undefined })
  })

  it('an empty LLM payload throws (failure, not zero friction — prior events survive, retry stays open)', async () => {
    const session = buildSession([{ user: 'go' }, { assistantText: 'ok' }, { user: 'substantive follow-up here' }])
    const empty: LlmClient = {
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      async completeStructured() {
        return { data: {}, usage: emptyUsage() }
      },
    }
    await expect(enrichFriction.run(ctx(session, empty))).rejects.toThrow('empty LLM output')
  })
})
