import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/** Resolved runtime configuration for a single invocation. */
export interface AivueConfig {
  /** Directory holding the SQLite store and other local state. */
  dataDir: string
  dbPath: string
  /** LLM provider for enrichment (BYO key), or null when not configured. */
  llm: { provider: string; model: string; apiKey: string } | null
}

const DEFAULT_MODELS: Record<string, string> = {
  anthropic: 'claude-haiku-4-5',
  openai: 'gpt-5-mini',
}

function resolveLlm(): AivueConfig['llm'] {
  const provider = process.env.AIVUE_LLM_PROVIDER?.toLowerCase()
  if (!provider) return null
  const keyEnv = provider === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY'
  const apiKey = process.env.AIVUE_LLM_API_KEY ?? process.env[keyEnv]
  if (!apiKey) return null
  const model = process.env.AIVUE_LLM_MODEL ?? DEFAULT_MODELS[provider] ?? ''
  return { provider, model, apiKey }
}

export function loadConfig(opts?: { dataDir?: string; db?: string }): AivueConfig {
  const dataDir = resolve(opts?.dataDir ?? process.env.AIVUE_DATA_DIR ?? join(homedir(), '.aivue'))
  const dbPath = resolve(opts?.db ?? join(dataDir, 'aivue.sqlite'))
  return { dataDir, dbPath, llm: resolveLlm() }
}
