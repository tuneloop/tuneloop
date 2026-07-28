import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { PROVIDERS, type ProviderPreset } from './llm/providers'
import { meetsMinTier } from './llm/capability'

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

// Bedrock inference profiles are geography-scoped (`us.` / `eu.` / `apac.`). The
// preset's default heavy model is a `us.` profile, so if the base model targets a
// different region, retarget the heavy profile to match — a cross-region profile id
// 400s (docs.aws.amazon.com/bedrock geographic cross-region inference).
function alignBedrockRegion(heavy: string, base: string): string {
  const region = base.match(/^(us|eu|apac)\./)?.[1]
  return region ? heavy.replace(/^(us|eu|apac)\./, `${region}.`) : heavy
}

/** Truthy-ish env flag: set to anything but ''/'0'/'false' to enable. */
function envFlagEnabled(name: string): boolean {
  const v = process.env[name]
  return v != null && v !== '' && v !== '0' && v.toLowerCase() !== 'false'
}

// Resolve the detector-pass ("heavy") model. Precedence: an explicit flag/env ▸
// TUNELOOP_DISABLE_DEFAULT_LLM_HEAVY opt-out (skip the auto default) ▸ an already-strong
// base (reuse it — don't downgrade e.g. opus to the preset's Sonnet default) ▸ the
// provider's strong sibling (region-matched for Bedrock) ▸ undefined, which leaves
// detectors on the base `model`. Same provider/key/URL as `model` — only ever a sibling
// id on the same endpoint.
function resolveHeavyModel(o: LlmOverrides | undefined, preset: ProviderPreset | undefined, model: string): string | undefined {
  const explicit = o?.heavyModel ?? process.env.TUNELOOP_LLM_MODEL_HEAVY
  if (explicit) return explicit
  // Opt-out for users who don't want the auto strong-sibling default silently raising
  // their analysis spend. Only suppresses the DEFAULT — an explicit heavy model above
  // still wins. With no heavy model, detectors run on the base model and the
  // Sonnet-class-gated ones (recurring-themes) skip themselves.
  if (envFlagEnabled('TUNELOOP_DISABLE_DEFAULT_LLM_HEAVY')) return undefined
  if (model && meetsMinTier(model, 'strong')) return undefined
  const def = preset?.defaultHeavyModel
  if (!def) return undefined
  return preset.shape === 'bedrock' ? alignBedrockRegion(def, model) : def
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
  const heavyModel = resolveHeavyModel(o, preset, model)
  const baseURL = o?.baseURL ?? process.env.TUNELOOP_LLM_BASE_URL ?? preset?.baseURL
  return { provider, model, apiKey, baseURL, heavyModel }
}

export function loadConfig(opts?: { dataDir?: string; db?: string; llm?: LlmOverrides }): TuneloopConfig {
  const dataDir = resolve(opts?.dataDir ?? process.env.TUNELOOP_DATA_DIR ?? join(homedir(), '.tuneloop'))
  const dbPath = resolve(opts?.db ?? join(dataDir, 'tuneloop.sqlite'))
  return { dataDir, dbPath, llm: resolveLlm(opts?.llm) }
}
