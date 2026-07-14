import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { assignSeq, deterministicBlocks } from '../../core/blocks'
import { mergeSessions, trimInheritedPrefix } from '../../core/merge'
import { computeSessionCost } from '../../pricing/pricing'
import { filesTouched } from '../../processors/files-touched'
import { outcomesGit } from '../../processors/outcomes-git'
import type { ProcessorContext, ShResult } from '../../core/processor'
import type { Session } from '../../core/model'
import { parseCodex } from './parse'

describe('Codex token usage and cost', () => {
  it('splits cached input and ignores repeated cumulative-total events', async () => {
    const firstUsage = {
      input_tokens: 2_000_000,
      cached_input_tokens: 1_000_000,
      output_tokens: 100_000,
      reasoning_output_tokens: 20_000,
    }
    const records = [
      { type: 'session_meta', payload: { id: 's', cwd: '/repo' } },
      { type: 'turn_context', payload: { model: 'gpt-5.2-codex' } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'first' }] } },
      tokenCount(firstUsage, firstUsage),
      // Older Codex versions re-emitted the last usage at turn finalization.
      tokenCount(firstUsage, firstUsage),
      tokenCount(
        {
          input_tokens: 3_000_000,
          cached_input_tokens: 1_500_000,
          output_tokens: 300_000,
          reasoning_output_tokens: 70_000,
        },
        {
          input_tokens: 1_000_000,
          cached_input_tokens: 500_000,
          output_tokens: 200_000,
          reasoning_output_tokens: 50_000,
        },
      ),
    ]
    const dir = await mkdtemp(join(tmpdir(), 'tuneloop-codex-'))
    const path = join(dir, 'rollout.jsonl')
    await writeFile(path, records.map((record) => JSON.stringify(record)).join('\n'))

    const session = await parseCodex(path)
    expect(session?.tokens).toEqual({
      input: 1_500_000,
      output: 300_000,
      cacheCreate5m: 0,
      cacheCreate1h: 0,
      cacheRead: 1_500_000,
    })

    const cost = computeSessionCost(session!)
    expect(cost.facts).toHaveLength(2)
    // 1.5M input @ $1.75 + 1.5M cached @ $0.175 + 0.3M output @ $14.
    expect(cost.usd).toBeCloseTo(7.0875, 6)
  })

  it('removes a child rollout inherited prefix before merging usage', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tuneloop-codex-'))
    const parentPath = join(dir, 'parent.jsonl')
    const childPath = join(dir, 'child.jsonl')
    const parentUsage = { input_tokens: 100, cached_input_tokens: 40, output_tokens: 10 }
    await writeFile(
      parentPath,
      [
        { type: 'session_meta', payload: { id: 'parent', cwd: '/repo' } },
        { type: 'turn_context', payload: { model: 'gpt-5.2-codex' } },
        tokenCount(parentUsage, parentUsage),
      ].map((record) => JSON.stringify(record)).join('\n'),
    )
    await writeFile(
      childPath,
      [
        { type: 'session_meta', payload: { id: 'child', cwd: '/repo', thread_source: 'subagent', forked_from_id: 'parent' } },
        { type: 'turn_context', payload: { model: 'gpt-5.2-codex' } },
        tokenCount(parentUsage, parentUsage),
        tokenCount(
          { input_tokens: 300, cached_input_tokens: 120, output_tokens: 30 },
          { input_tokens: 200, cached_input_tokens: 80, output_tokens: 20 },
        ),
      ].map((record) => JSON.stringify(record)).join('\n'),
    )
    const parent = (await parseCodex(parentPath))!
    const child = (await parseCodex(childPath))!

    trimInheritedPrefix(child, parent)
    const merged = mergeSessions([parent, child])

    expect(child.tokens).toEqual({ input: 120, output: 20, cacheCreate5m: 0, cacheCreate1h: 0, cacheRead: 80 })
    expect(merged.tokens).toEqual({ input: 180, output: 30, cacheCreate5m: 0, cacheCreate1h: 0, cacheRead: 120 })
  })
})

describe('Codex unified exec envelopes', () => {
  it('keeps legacy direct function calls working', async () => {
    const session = await parseRecords([
      meta('legacy'),
      call('legacy-call', 'exec_command', JSON.stringify({ cmd: 'git status', workdir: '/repo' })),
      functionOutput('legacy-call', { output: 'clean', metadata: { exit_code: 0 } }),
    ])

    expect(session.toolCalls).toHaveLength(1)
    expect(session.toolCalls[0]).toMatchObject({
      id: 'legacy-call',
      name: 'exec_command',
      action: 'shell',
      target: { command: 'git status' },
      result: { ok: true },
    })
  })

  it('expands single shell and bound apply_patch calls into semantic children', async () => {
    const patch = [
      '*** Begin Patch',
      '*** Update File: /repo/src/a.ts',
      '@@',
      '-old',
      '+new',
      '*** Add File: /repo/src/b.ts',
      '+export {}',
      '*** End Patch',
    ].join('\n')
    const session = await parseRecords([
      meta('single'),
      customExec(
        'shell-outer',
        'const r = await tools.exec_command({"cmd":"gh pr create --fill","workdir":"/repo"});\ntext(r.output);\n',
      ),
      customOutput('shell-outer', outputBlocks('https://github.com/o/r/pull/76\n')),
      customExec(
        'patch-outer',
        `const patch = ${JSON.stringify(patch)};\ntext(await tools.apply_patch(patch));\n`,
      ),
      customOutput('patch-outer', outputBlocks('{}')),
    ])

    expect(session.toolCalls).toHaveLength(2)
    expect(session.toolCalls[0]).toMatchObject({
      id: 'shell-outer:0',
      parentId: 'shell-outer',
      name: 'exec_command',
      action: 'shell',
      target: { command: 'gh pr create --fill' },
    })
    expect(String(session.toolCalls[0]?.result.raw)).toContain('/pull/76')
    expect(session.toolCalls[1]).toMatchObject({
      id: 'patch-outer:0',
      parentId: 'patch-outer',
      name: 'apply_patch',
      action: 'file_write',
      target: { paths: ['/repo/src/a.ts', '/repo/src/b.ts'] },
      input: patch,
    })

    const fileResult = await filesTouched.run(processorContext(session))
    expect(fileResult.files?.map((f) => f.path)).toEqual(['/repo/src/a.ts', '/repo/src/b.ts'])

    assignSeq(session)
    expect(deterministicBlocks(session)[0]?.boundaryKind).toBe('pr_create')
    const gitResult = await outcomesGit.run(processorContext(session))
    expect(gitResult.sessionArtifacts).toContainEqual(
      expect.objectContaining({ artifactId: 'pr:o/r:76', role: 'created', source: 'explicit' }),
    )
    expect(gitResult.outcomes).toContainEqual(expect.objectContaining({ type: 'pr_created', artifactId: 'pr:o/r:76' }))
  })

  it('expands Promise.all in source order, maps unambiguous outputs, and ignores tool-like strings', async () => {
    const source = [
      'const results = await Promise.all([',
      '  tools.exec_command({"cmd":"printf \'tools.apply_patch(fake)\'","workdir":"/repo"}),',
      '  tools.exec_command({cmd:"gh pr create --fill",workdir:"/repo"}),',
      '  tools.web__run({open:[{ref_id:"https://github.com/o/r/pull/9"}],response_length:"short"})',
      ']);',
      'for (const r of results) text(r.output ?? r);',
      '',
    ].join('\n')
    const session = await parseRecords([
      meta('parallel'),
      customExec('parallel-outer', source),
      customOutput('parallel-outer', outputBlocks('tools.apply_patch(fake)', 'https://github.com/o/r/pull/88\n', '{"ok":true}')),
    ])

    expect(session.toolCalls.map((t) => [t.name, t.action])).toEqual([
      ['exec_command', 'shell'],
      ['exec_command', 'shell'],
      ['web__run', 'web'],
    ])
    expect(session.toolCalls.map((t) => t.id)).toEqual(['parallel-outer:0', 'parallel-outer:1', 'parallel-outer:2'])
    expect(String(session.toolCalls[0]?.result.raw)).not.toContain('/pull/88')
    expect(String(session.toolCalls[1]?.result.raw)).toContain('/pull/88')
    expect(session.toolCalls.some((t) => t.name === 'apply_patch')).toBe(false)
  })

  it('joins a deferred exec result from wait back to the originating shell call', async () => {
    const session = await parseRecords([
      meta('deferred'),
      customExec(
        'deferred-outer',
        'const r = await tools.exec_command({cmd:"gh pr create --fill",workdir:"/repo"}); text(r.output);',
      ),
      customOutput('deferred-outer', 'Script running with cell ID 16\nWall time 13.6 seconds\nOutput:\n'),
      call('wait-call', 'wait', JSON.stringify({ cell_id: '16', yield_time_ms: 30_000 })),
      functionOutput('wait-call', outputBlocks('https://github.com/o/r/pull/77\n')),
    ])

    expect(session.toolCalls).toHaveLength(1)
    expect(session.toolCalls[0]).toMatchObject({
      id: 'deferred-outer:0',
      parentId: 'deferred-outer',
      action: 'shell',
    })
    expect(String(session.toolCalls[0]?.result.raw)).toContain('/pull/77')

    assignSeq(session)
    const result = await outcomesGit.run(processorContext(session))
    expect(result.sessionArtifacts).toContainEqual(expect.objectContaining({ artifactId: 'pr:o/r:77', role: 'created' }))
  })
})

async function parseRecords(records: unknown[]): Promise<Session> {
  const dir = await mkdtemp(join(tmpdir(), 'tuneloop-codex-tools-'))
  const path = join(dir, 'rollout.jsonl')
  await writeFile(path, records.map((record) => JSON.stringify(record)).join('\n'))
  const session = await parseCodex(path)
  expect(session).not.toBeNull()
  return session!
}

function meta(id: string) {
  return { timestamp: '2026-07-14T20:00:00.000Z', type: 'session_meta', payload: { id, cwd: '/repo' } }
}

function call(callId: string, name: string, args: string) {
  return {
    timestamp: '2026-07-14T20:00:01.000Z',
    type: 'response_item',
    payload: { type: 'function_call', name, arguments: args, call_id: callId },
  }
}

function customExec(callId: string, input: string) {
  return {
    timestamp: '2026-07-14T20:00:01.000Z',
    type: 'response_item',
    payload: { type: 'custom_tool_call', name: 'exec', input, call_id: callId },
  }
}

function customOutput(callId: string, output: unknown) {
  return { timestamp: '2026-07-14T20:00:02.000Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: callId, output } }
}

function functionOutput(callId: string, output: unknown) {
  return { timestamp: '2026-07-14T20:00:02.000Z', type: 'response_item', payload: { type: 'function_call_output', call_id: callId, output } }
}

function outputBlocks(...parts: string[]) {
  return [
    { type: 'input_text', text: 'Script completed\nWall time 0.1 seconds\nOutput:\n' },
    ...parts.map((text) => ({ type: 'input_text', text })),
  ]
}

const noopLog = { debug() {}, info() {}, warn() {}, error() {} }
const ghSh = async (cmd: string, args: string[]): Promise<ShResult | null> => {
  if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'view') {
    return { stdout: JSON.stringify({ title: 'Created PR', state: 'OPEN' }), code: 0 }
  }
  return null
}

function processorContext(session: Session): ProcessorContext {
  return {
    session,
    log: noopLog,
    llmEnabled: false,
    llm: null,
    existingFeatures: [],
    rejectedFeatureTitles: [],
    userLinkedArtifacts: [],
    prBlockAttributions: [],
    sh: ghSh,
  }
}

function tokenCount(total: Record<string, number>, last: Record<string, number>) {
  return {
    type: 'event_msg',
    payload: { type: 'token_count', info: { total_token_usage: total, last_token_usage: last } },
  }
}
