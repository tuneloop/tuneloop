/**
 * Which part of a failed shell command actually failed — read by an LLM.
 *
 * A compound command is attributed to every binary it involved, because the
 * deterministic parser usually can't tell which segment broke. Measured on a real
 * store, that leaves **80% of every shell binary's error count** as "was present
 * in a failing command": `git`, `cat`, `rg`, `docker`, `sleep` and `tail` were at
 * 100% — every error they carried was someone else's.
 *
 * The deterministic rules (core/shell-blame.ts) close about a third of that, and
 * they are provably stuck: inside an `&&` chain the shell's own exit code can't
 * say where the chain stopped, and the most promising output-based inference
 * recovered 2 of 79 unattributed failures when measured. Reading the output is
 * the remaining move, and reading is what a model is for.
 *
 * Only failed SHELL calls, only when a provider is configured — so a store
 * analyzed without a key behaves exactly as before, just coarser. Never overrules
 * a deterministic verdict: those come from verified shell semantics, this is a
 * reading of prose.
 */
import { addUsage, emptyUsage } from '../core/model'
import { registerProcessor } from '../core/registry'
import { costOfUsage } from '../pricing/pricing'
import { ERROR_CATEGORIES } from '../core/error-category'
import { resultText } from '../core/result-text'
import { shellSegments } from '../core/shell-binaries'
import type { AnnotationInput } from '../store/types'
import type { Processor, ProcessorContext, ProcessorResult } from '../core/processor'
import type { JsonSchema } from '../llm/types'
import type { Session } from '../core/model'

const TOOL_NAME = 'attribute_shell_failures'

/** Annotation key per attributed call; `blame:<tool_call idx>` so SQL can join on it. */
export const BLAME_KEY_PREFIX = 'blame:'

/**
 * Failures per LLM CALL, not per session. It bounds one request's size; a session
 * with more simply takes more calls, so coverage is never capped. It started as a
 * truncating cap and dropped 7 of 100 failures on one busy session — the same
 * silent-cap shape this feature exists to correct.
 */
const FAILURES_PER_CALL = 20

/** Command and output budget per failure, so one enormous dump can't dominate the call. */
const MAX_COMMAND_CHARS = 2_000
const MAX_OUTPUT_CHARS = 2_000

/** What the model is asked to decide about one failed call. */
export interface ShellBlameVerdict {
  /** tool_calls.idx within the session. */
  idx: number
  /** The binary at fault, or null when the output genuinely doesn't say. */
  binary: string | null
  /** A key from the shared taxonomy, or null. */
  category: string | null
}

function outputSchema(): JsonSchema {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['failures'],
    properties: {
      failures: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['idx', 'binary'],
          properties: {
            idx: { type: 'integer', description: 'The idx of the failure you are answering about.' },
            binary: {
              type: ['string', 'null'],
              description:
                'EXACTLY one of the binaries listed for that failure — the one whose own execution produced the error. null if the output does not make it clear, or if nothing ran (a user decline, a shell parse error). Never a name that is not in the list.',
            },
            category: {
              type: ['string', 'null'],
              description: 'One of the allowed category keys, or null if none fits.',
            },
          },
        },
      },
    },
  }
}

/** One failed shell call, prepared for the prompt. */
interface Failure {
  idx: number
  command: string
  output: string
  binaries: string[]
}

/** The session's failed shell calls that involve more than one binary — the only
 *  ones where attribution is a question. A single-binary failure is already
 *  unambiguous, so spending a model on it would buy nothing. */
export function collectFailures(session: Session): Failure[] {
  const out: Failure[] = []
  session.toolCalls.forEach((tc, idx) => {
    if (tc.action !== 'shell' || tc.result.ok || !tc.target.command) return
    const binaries = shellSegments(tc.target.command).map((s) => s.binary).filter((b): b is string => !!b)
    if (new Set(binaries).size < 2) return
    out.push({
      idx,
      command: tc.target.command.slice(0, MAX_COMMAND_CHARS),
      output: resultText(tc.result.raw).trim().slice(0, MAX_OUTPUT_CHARS),
      binaries: [...new Set(binaries)],
    })
  })
  return out
}

export function buildPrompt(failures: Failure[]): { system: string; user: string } {
  const system =
    'You read the output of failed shell commands and say which part failed. Each command chains several ' +
    'binaries, and the whole chain is currently blamed for every failure, which is wrong: in `ls missing && tsc`, ' +
    '`tsc` never ran. Work ONLY from the output shown. Attribute to a binary when the output makes it clear — a ' +
    'tool naming itself, a stack trace from a known runtime, a usage dump, an exit code that can only have come ' +
    'from one command. Answer null when it genuinely does not say, when the user declined the call, or when the ' +
    'shell failed to parse the command so nothing ran. A wrong attribution is worse than null: it moves a failure ' +
    'onto a tool that did its job. Remember the shell rules — `&&` stops at the first failure so later commands ' +
    'never ran, `;` and `|` always continue, and the exit code is the last command that RAN. ' +
    `Also classify each failure into the taxonomy below. Answer via the ${TOOL_NAME} tool.`

  const taxonomy = ERROR_CATEGORIES.map((c) => `- ${c.key}: ${c.description}`).join('\n')
  const body = failures
    .map(
      (f) =>
        [
          `### failure idx=${f.idx}`,
          `binaries involved (answer with exactly one of these, or null): ${f.binaries.join(', ')}`,
          'command:',
          f.command,
          'output:',
          f.output || '(no output captured)',
        ].join('\n'),
    )
    .join('\n\n')

  return { system, user: `Error categories:\n${taxonomy}\n\n${body}` }
}

/**
 * Keep only verdicts that answer a failure we actually asked about, and whose
 * binary is one of that failure's own. The model naming something outside the
 * list would invent an entity, which is the exact failure mode this exists to end.
 */
export function normalizeVerdicts(data: Record<string, unknown>, failures: Failure[]): ShellBlameVerdict[] {
  const byIdx = new Map(failures.map((f) => [f.idx, f]))
  const allowed = new Set(ERROR_CATEGORIES.map((c) => c.key))
  const raw = Array.isArray(data.failures) ? data.failures : []
  const out: ShellBlameVerdict[] = []
  const seen = new Set<number>()
  for (const item of raw) {
    const o = (item ?? {}) as Record<string, unknown>
    const idx = typeof o.idx === 'number' ? o.idx : NaN
    const f = byIdx.get(idx)
    if (!f || seen.has(idx)) continue
    seen.add(idx)
    const binary = typeof o.binary === 'string' && f.binaries.includes(o.binary) ? o.binary : null
    const category = typeof o.category === 'string' && allowed.has(o.category) ? o.category : null
    if (!binary && !category) continue // nothing usable — leave the call unattributed
    out.push({ idx, binary, category })
  }
  return out
}

export const shellErrorAttribution: Processor = {
  name: 'shell-error-attribution',
  // 2: batching replaced a truncating cap. v1 runs judged only the first 20
  // failures of a session, so a busy one was left partly attributed — and the
  // cache would happily keep that partial result forever without this bump.
  version: 2,
  kind: 'enrichment',
  needs: { llm: true },
  async run(ctx: ProcessorContext): Promise<ProcessorResult> {
    const { llm, session } = ctx
    if (!llm) return {}

    const failures = collectFailures(session)
    if (failures.length === 0) return {}

    let usage = emptyUsage()
    const verdicts: ShellBlameVerdict[] = []
    for (let i = 0; i < failures.length; i += FAILURES_PER_CALL) {
      const batch = failures.slice(i, i + FAILURES_PER_CALL)
      const { system, user } = buildPrompt(batch)
      try {
        const res = await llm.completeStructured({ system, user, schema: outputSchema(), toolName: TOOL_NAME, maxTokens: 2048 })
        usage = addUsage(usage, res.usage)
        verdicts.push(...normalizeVerdicts(res.data, batch))
      } catch (e) {
        // One bad chunk shouldn't lose the verdicts the others produced.
        ctx.log.warn(`shell-error-attribution: ${session.id} batch ${i / FAILURES_PER_CALL + 1} failed: ${String(e)}`)
      }
    }
    const selfCost = { tokens: usage, usd: costOfUsage(llm.provider, llm.model, usage) }
    if (verdicts.length === 0) return { selfCost }

    // One annotation per call rather than one map per session, so the read model
    // can join on `blame:<idx>` instead of picking JSON apart per row.
    const annotations: AnnotationInput[] = verdicts.map((v) => ({
      key: BLAME_KEY_PREFIX + v.idx,
      value: { binary: v.binary, category: v.category, model: llm.model },
    }))
    return { annotations, selfCost }
  },
}

registerProcessor(shellErrorAttribution)
