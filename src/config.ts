import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { PROVIDERS } from './llm/providers'

/** Resolved runtime configuration for a single invocation. */
export interface AivueConfig {
  /** Directory holding the SQLite store and other local state. */
  dataDir: string
  dbPath: string
  /** LLM provider for enrichment (BYO key), or null when not configured. */
  llm: { provider: string; model: string; apiKey: string; baseURL?: string } | null
}

/** Non-secret LLM knobs settable via CLI flags; they override env. The API key is env-only. */
export interface LlmOverrides {
  provider?: string
  model?: string
  baseURL?: string
}

function resolveLlm(o?: LlmOverrides): AivueConfig['llm'] {
  const provider = (o?.provider ?? process.env.AIVUE_LLM_PROVIDER)?.toLowerCase()
  if (!provider) return null
  const preset = PROVIDERS[provider]

  // Key is env-only: AIVUE_LLM_API_KEY wins, else the preset's conventional env.
  // Keyless local endpoints (Ollama) get a placeholder the SDK accepts.
  const apiKey =
    process.env.AIVUE_LLM_API_KEY ?? (preset ? process.env[preset.keyEnv] : undefined) ?? (preset?.requiresKey === false ? 'local' : '')
  // Needs-a-key but none → stay static-only (the analyze hint covers it). resolveLlm
  // never throws: unknown provider / missing base-URL / empty model are recoverable
  // misconfig that createLlmClient validates inside analyze's graceful try/catch, so a
  // typo can't abort the run — nor the read-only `serve`, which builds no client.
  if (preset && preset.requiresKey !== false && !apiKey) return null

  const model = o?.model ?? process.env.AIVUE_LLM_MODEL ?? preset?.defaultModel ?? ''
  const baseURL = o?.baseURL ?? process.env.AIVUE_LLM_BASE_URL ?? preset?.baseURL
  return { provider, model, apiKey, baseURL }
}

export function loadConfig(opts?: { dataDir?: string; db?: string; llm?: LlmOverrides }): AivueConfig {
  const dataDir = resolve(opts?.dataDir ?? process.env.AIVUE_DATA_DIR ?? join(homedir(), '.aivue'))
  const dbPath = resolve(opts?.db ?? join(dataDir, 'aivue.sqlite'))
  return { dataDir, dbPath, llm: resolveLlm(opts?.llm) }
}
