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
const MAX_COMMAND_CHARS = 20_000
const MAX_OUTPUT_CHARS = 20_000

/**
 * What the model is asked to decide about one failed call.
 *
 * A `null` binary is a RECORDED answer, not an absent one: it means the model was
 * shown this failure and said the output doesn't identify a culprit. Keeping those
 * rows is what separates "asked and declined" from "never asked" when auditing.
 */
export interface ShellBlameVerdict {
  /** tool_calls.idx within the session. */
  idx: number
  /** The binary at fault, or null when the output genuinely doesn't say. */
  binary: string | null
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

/**
 * The system prompt.
 *
 * Worked examples rather than prose rules, because the observed failure mode is
 * not ignorance of the rules — it is reasoning from PLAUSIBILITY. Audited against
 * real verdicts, the model reliably blamed whichever command looked most
 * substantial instead of the one the output implicates. Every example below
 * therefore turns on something only the output can tell you, and two of them
 * deliberately resolve to a trivial command (`echo`, `true`) over a weighty one.
 *
 * Kept generic on purpose: these are textbook shell shapes, not commands lifted
 * from any particular corpus, so the model learns the semantics rather than a
 * house style.
 */
const SYSTEM_PROMPT = [
  'You are given shell commands that FAILED, and the output each one produced. For every failure, say which single',
  'binary caused it. The whole chain is currently blamed for every failure, which is wrong — a command that never',
  'ran cannot have failed.',
  '',
  'How the shell decides the exit code:',
  '  A && B   runs B only if A SUCCEEDED. If A failed, B never ran.',
  '  A || B   runs B only if A FAILED. If A succeeded, B never ran.',
  '  A ; B    always runs both, whatever A did. Same for a newline.',
  '  A | B    always runs both; the pipeline reports B\'s status, so A failing may not show up at all.',
  'The command\'s exit code is the status of the LAST command that actually RAN.',
  '',
  'Work ONLY from the output shown. Do not reason about which command looks more important or more likely to',
  'break — the trivial ones fail too, and blaming the substantial one is the most common way to get this wrong.',
  'If the error came from the SHELL itself (a word it could not resolve, a syntax error) rather than from a',
  'program, it belongs to the segment containing the text the shell complained about.',
  '',
  'Answer null — a perfectly good answer — when the output does not identify a culprit, when nothing ran at all',
  '(the user declined the call, or the shell failed to parse it), or when the command was killed from outside',
  '(a timeout, an interrupt); a kill is not a verdict on any command. A wrong attribution is worse than null,',
  'because it moves a failure onto a tool that did its job.',
  '',
  'Examples:',
  '',
  '  command: mkdir -p out && cp notes.txt out/ && echo done',
  '  output:  cp: notes.txt: No such file or directory',
  '  answer:  cp — it names itself. mkdir must have succeeded for cp to run; echo never ran.',
  '',
  '  command: ./configure && make && make install',
  '  output:  ./configure: line 12: no acceptable C compiler found',
  '  answer:  ./configure — the first link failed, so neither make ran.',
  '',
  '  command: rm -f stale.lock; flock lockfile true',
  '  output:  flock: lockfile: No such file or directory',
  '  answer:  flock — `;` runs both, and the exit code is the last one.',
  '',
  '  command: pkg-config --exists libfoo || echo "libfoo missing" > report.txt',
  '  output:  /bin/sh: report.txt: Read-only file system',
  '  answer:  echo — pkg-config FAILED, which is what made the `||` right-hand side run; its redirect is the error.',
  '',
  '  command: tar -cf - data | ssh backup-host "cat > data.tar"',
  '  output:  ssh: connect to host backup-host port 22: Connection refused',
  '  answer:  ssh — a pipeline reports the last element\'s status.',
  '',
  '  command: make clean && make build',
  '  output:  Error: Exit code 2',
  '  answer:  null — both are plausible and nothing here distinguishes them. Do not guess.',
  '',
  `Answer via the ${TOOL_NAME} tool.`,
].join('\n')

export function buildPrompt(failures: Failure[]): { system: string; user: string } {
  const system = SYSTEM_PROMPT

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

  return { system, user: body }
}

/**
 * Keep only verdicts that answer a failure we actually asked about, and whose
 * binary is one of that failure's own. The model naming something outside the
 * list would invent an entity, which is the exact failure mode this exists to end.
 */
export function normalizeVerdicts(data: Record<string, unknown>, failures: Failure[]): ShellBlameVerdict[] {
  const byIdx = new Map(failures.map((f) => [f.idx, f]))
  const raw = Array.isArray(data.failures) ? data.failures : []
  const out: ShellBlameVerdict[] = []
  const seen = new Set<number>()
  for (const item of raw) {
    const o = (item ?? {}) as Record<string, unknown>
    const idx = typeof o.idx === 'number' ? o.idx : NaN
    const f = byIdx.get(idx)
    if (!f || seen.has(idx)) continue
    seen.add(idx)
    // A name outside this failure's own binaries is downgraded to null rather than
    // dropped: the model still answered, it just answered unusably.
    const binary = typeof o.binary === 'string' && f.binaries.includes(o.binary) ? o.binary : null
    out.push({ idx, binary })
  }
  return out
}

export const shellErrorAttribution: Processor = {
  name: 'shell-error-attribution',
  // 2: batching replaced a truncating cap. v1 runs judged only the first 20
  //    failures of a session, so a busy one was left partly attributed — and the
  //    cache would happily keep that partial result forever without this bump.
  // 3: dropped error-category classification. Nothing read it, and asking for it
  //    disagreed with the regex on 46% of failures in both directions — the model
  //    refining `command_failed` into something specific, but also overriding an
  //    unmistakable `user_rejected`. Removing it also removes the taxonomy from
  //    the prompt, leaving one question per failure instead of two.
  // 4: rewrote the prompt around worked examples, after auditing real verdicts
  //    showed the model reasoning from plausibility rather than from the output.
  //    Adds the missing `||` rule and the timeout case (a kill is not a verdict).
  version: 4,
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
      value: { binary: v.binary, model: llm.model },
    }))
    return { annotations, selfCost }
  },
}

registerProcessor(shellErrorAttribution)
