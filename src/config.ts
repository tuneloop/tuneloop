import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { PROVIDERS } from './llm/providers'

/** Resolved runtime configuration for a single invocation. */
export interface TuneloopConfig {
  /** Directory holding the SQLite store and other local state. */
  dataDir: string
  dbPath: string
  /** LLM provider for enrichment (BYO key), or null when not configured. */
  llm: { provider: string; model: string; apiKey: string; baseURL?: string; heavyModel?: string } | null
}

/**
 * Non-secret LLM knobs settable via CLI flags; they override env. The API key
 * deliberately has no flag — argv leaks into shell history and `ps` — so it
 * comes from env, or from `apiKey` when the caller collected it interactively
 * (analyze's run-only enrichment setup).
 */
export interface LlmOverrides {
  provider?: string
  model?: string
  /** Optional stronger model for the detector pass; unset = the provider's default
   * heavy model, or the base `model` when the provider has no strong sibling. */
  heavyModel?: string
  baseURL?: string
  /** In-process override (interactive prompt); never exposed as a CLI flag. */
  apiKey?: string
}

function resolveLlm(o?: LlmOverrides): TuneloopConfig['llm'] {
  const provider = (o?.provider ?? process.env.TUNELOOP_LLM_PROVIDER)?.toLowerCase()
  if (!provider) return null
  const preset = PROVIDERS[provider]

  // Key precedence: an in-process override (interactive prompt) wins, then
  // TUNELOOP_LLM_API_KEY, then the preset's conventional env. Keyless presets
  // get their placeholder (Ollama's SDK rejects an empty key) or '' (Bedrock:
  // empty means "let the SDK use the AWS credential chain").
  const apiKey =
    o?.apiKey ??
    process.env.TUNELOOP_LLM_API_KEY ??
    (preset ? process.env[preset.keyEnv] : undefined) ??
    (preset?.keyless && 'placeholder' in preset.keyless ? preset.keyless.placeholder : '')
  // Needs-a-key but none → stay static-only (the analyze hint covers it). resolveLlm
  // never throws: unknown provider / missing base-URL / empty model are recoverable
  // misconfig that createLlmClient validates inside analyze's graceful try/catch, so a
  // typo can't abort the run — nor the read-only `serve`, which builds no client.
  if (preset && !preset.keyless && !apiKey) return null

  const model = o?.model ?? process.env.TUNELOOP_LLM_MODEL ?? preset?.defaultModel ?? ''
  // Second tier for the cross-session detector pass: per-session processors keep the
  // cheap `model`, while detectors that opt in (model: 'heavy', e.g. recurring-themes)
  // run on this one. When nothing sets it, fall back to the provider's strong sibling
  // (`defaultHeavyModel`) so the Sonnet-class-or-stronger detectors run by default
  // instead of being silently gated out; providers with no strong sibling (or one
  // already strong) resolve to undefined and reuse the base `model`. Same
  // provider/key/URL as `model` — only ever a sibling id on the same endpoint.
  const heavyModel = o?.heavyModel ?? process.env.TUNELOOP_LLM_MODEL_HEAVY ?? preset?.defaultHeavyModel
  const baseURL = o?.baseURL ?? process.env.TUNELOOP_LLM_BASE_URL ?? preset?.baseURL
  return { provider, model, apiKey, baseURL, heavyModel }
}

export function loadConfig(opts?: { dataDir?: string; db?: string; llm?: LlmOverrides }): TuneloopConfig {
  const dataDir = resolve(opts?.dataDir ?? process.env.TUNELOOP_DATA_DIR ?? join(homedir(), '.tuneloop'))
  const dbPath = resolve(opts?.db ?? join(dataDir, 'tuneloop.sqlite'))
  return { dataDir, dbPath, llm: resolveLlm(opts?.llm) }
}
