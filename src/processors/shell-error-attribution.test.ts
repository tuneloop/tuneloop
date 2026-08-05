import { describe, expect, it } from 'vitest'
import { emptyUsage, type Session, type ToolCall } from '../core/model'
import { buildPrompt, collectFailures, normalizeVerdicts, shellErrorAttribution } from './shell-error-attribution'

function session(calls: ToolCall[]): Session {
  return {
    id: 'claude-code:s',
    sessionId: 's',
    source: 'claude-code',
    provider: 'anthropic',
    project: { cwd: '/repo', repo: 'o/r' },
    models: ['claude-haiku-4-5'],
    tokens: emptyUsage(),
    events: [],
    toolCalls: calls,
    raw: { path: '', contentHash: 'h' },
  }
}

const shell = (command: string, ok: boolean, raw = 'output'): ToolCall => ({
  id: 't',
  name: 'Bash',
  action: 'shell',
  input: {},
  target: { command },
  result: { ok, isError: !ok, raw },
  isSidechain: false,
})

describe('collectFailures', () => {
  it('takes only failed shell calls that involve more than one binary', () => {
    const s = session([
      shell('git status && npm test', false), // compound failure — the ambiguous case
      shell('git push', false), // single binary: already unambiguous, no model needed
      shell('git status && npm test', true), // succeeded
      { ...shell('x', false), action: 'file_read', target: { paths: ['a'] } }, // not shell
    ])
    expect(collectFailures(s).map((f) => f.idx)).toEqual([0])
  })

  it('carries the command, its output, and the binaries to choose between', () => {
    const f = collectFailures(session([shell('ls /nope && npx tsc', false, 'ls: /nope: No such file')]))[0]!
    expect(f).toMatchObject({ idx: 0, command: 'ls /nope && npx tsc', output: 'ls: /nope: No such file' })
    expect(f.binaries).toEqual(['ls', 'npx'])
  })
})

describe('buildPrompt', () => {
  it('shows the model the command, the output, and the closed list to choose from', () => {
    const { system, user } = buildPrompt(collectFailures(session([shell('ls /nope && npx tsc', false, 'ls: /nope: No such file')])))
    expect(user).toContain('ls /nope && npx tsc')
    expect(user).toContain('ls: /nope: No such file')
    expect(user).toContain('ls, npx')
    expect(system).toContain('&&') // the shell rules it has to reason with
  })

  it('asks one question per failure — no error taxonomy', () => {
    // Classification was dropped: nothing read it, and it disagreed with the regex
    // on 46% of failures in both directions.
    const { system, user } = buildPrompt(collectFailures(session([shell('ls /nope && npx tsc', false, 'boom')])))
    expect(user).not.toContain('not_found')
    expect(system).not.toMatch(/classif/i)
  })

  it('states all four join types — `||` was missing and its semantics are distinct', () => {
    const { system } = buildPrompt(collectFailures(session([shell('a && b', false)])))
    for (const join of ['A && B', 'A || B', 'A ; B', 'A | B']) expect(system).toContain(join)
    // The rule the whole thing rests on.
    expect(system).toMatch(/LAST command that actually RAN/)
  })

  it('tells the model a kill is not a verdict', () => {
    // Audit found a timeout blamed on a binary: the harness killed it, so no
    // command returned a verdict at all.
    const { system } = buildPrompt(collectFailures(session([shell('a && b', false)])))
    expect(system).toMatch(/timeout/i)
    expect(system).toMatch(/kill/i)
  })

  it('teaches by example, including cases that resolve to a trivial command', () => {
    // The observed failure mode is blaming whichever command looks weightiest, so
    // the examples have to include ones that don't resolve that way.
    const { system } = buildPrompt(collectFailures(session([shell('a && b', false)])))
    expect(system).toContain('answer:  echo —') // beats pkg-config in its example
    expect(system).toContain('answer:  null —') // abstaining is demonstrated, not just allowed
  })
})

describe('normalizeVerdicts', () => {
  const failures = collectFailures(session([shell('ls /nope && npx tsc', false), shell('cat a | wc -l', false)]))

  it('accepts a binary from that failure\'s own list', () => {
    expect(normalizeVerdicts({ failures: [{ idx: 0, binary: 'ls' }] }, failures)).toEqual([{ idx: 0, binary: 'ls' }])
  })

  it('refuses a binary the command never ran — the failure mode this exists to end', () => {
    // Inventing an entity out of an error message is exactly what the deterministic
    // rules refuse to do; the model gets no more latitude. Downgraded to null
    // rather than dropped: it answered, just unusably.
    expect(normalizeVerdicts({ failures: [{ idx: 0, binary: 'docker' }] }, failures)).toEqual([{ idx: 0, binary: null }])
  })

  it('refuses a binary borrowed from a DIFFERENT failure in the same batch', () => {
    expect(normalizeVerdicts({ failures: [{ idx: 0, binary: 'wc' }] }, failures)).toEqual([{ idx: 0, binary: null }])
  })

  it('drops verdicts for calls we did not ask about, and duplicates', () => {
    const out = normalizeVerdicts(
      { failures: [{ idx: 99, binary: 'ls' }, { idx: 0, binary: 'ls' }, { idx: 0, binary: 'npx' }] },
      failures,
    )
    expect(out).toEqual([{ idx: 0, binary: 'ls' }])
  })

  it('records null as a real answer — "asked, and the output does not say"', () => {
    // Kept, not dropped: it is what separates a failure the model declined to
    // attribute from one it never saw, which matters when auditing coverage.
    expect(normalizeVerdicts({ failures: [{ idx: 0, binary: null }] }, failures)).toEqual([{ idx: 0, binary: null }])
  })

  it('survives junk output rather than throwing', () => {
    expect(normalizeVerdicts({}, failures)).toEqual([])
    expect(normalizeVerdicts({ failures: 'nope' } as never, failures)).toEqual([])
    expect(normalizeVerdicts({ failures: [null, 7, { idx: 'x' }] } as never, failures)).toEqual([])
  })
})

describe('batching', () => {
  /** A session with `n` distinct compound failures. */
  const busy = (n: number) => session(Array.from({ length: n }, (_, i) => shell(`ls /nope${i} && npx tsc`, false, 'boom')))

  it('splits a busy session across calls instead of dropping the tail', async () => {
    // This started as a truncating cap and silently dropped 7 of 100 failures on
    // one real session — the exact silent-cap shape this feature exists to fix.
    const seen: number[] = []
    const llm = {
      model: 'test', provider: 'anthropic',
      completeStructured: async (req: { user: string }) => {
        const idxs = [...req.user.matchAll(/### failure idx=(\d+)/g)].map((m) => Number(m[1]))
        seen.push(...idxs)
        return { data: { failures: idxs.map((idx) => ({ idx, binary: 'ls' })) }, usage: emptyUsage() }
      },
    }
    const res = await shellErrorAttribution.run({ llm, session: busy(27), log: { warn() {}, debug() {} } } as never)
    // Two calls, and every failure judged — none left behind.
    expect(seen).toHaveLength(27)
    expect(res.annotations).toHaveLength(27)
  })

  it('keeps the verdicts from the batches that succeeded when one call fails', async () => {
    let call = 0
    const llm = {
      model: 'test', provider: 'anthropic',
      completeStructured: async (req: { user: string }) => {
        if (call++ === 0) throw new Error('provider hiccup')
        const idxs = [...req.user.matchAll(/### failure idx=(\d+)/g)].map((m) => Number(m[1]))
        return { data: { failures: idxs.map((idx) => ({ idx, binary: 'ls' })) }, usage: emptyUsage() }
      },
    }
    const res = await shellErrorAttribution.run({ llm, session: busy(27), log: { warn() {}, debug() {} } } as never)
    expect(res.annotations).toHaveLength(7) // the second batch survived
  })
})

describe('processor wiring', () => {
  it('is LLM-gated enrichment, so a store analyzed without a key is unchanged', () => {
    expect(shellErrorAttribution).toMatchObject({ name: 'shell-error-attribution', kind: 'enrichment', needs: { llm: true } })
  })

  it('does nothing without a client, and nothing when no call is ambiguous', async () => {
    const ctx = { llm: null, session: session([shell('git status && npm test', false)]), log: console } as never
    expect(await shellErrorAttribution.run(ctx)).toEqual({})
  })
})
