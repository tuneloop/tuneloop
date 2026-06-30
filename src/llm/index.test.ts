import { describe, expect, it } from 'vitest'
import { createLlmClient } from './index'
import { loadConfig } from '../config'

// resolveLlm (inside loadConfig) must stay total: recoverable, non-secret misconfig
// is validated by createLlmClient inside analyze's graceful try/catch — never thrown
// during config resolution, which would also abort the read-only `serve`
describe('LLM config resolution is non-fatal', () => {
  it('loadConfig does not throw on an unknown provider', () => {
    const cfg = loadConfig({ llm: { provider: 'cohere' } })
    expect(cfg.llm?.provider).toBe('cohere')
  })
})

describe('createLlmClient is the sole validator', () => {
  it('throws on an unknown provider', () => {
    expect(() => createLlmClient({ provider: 'claude', model: 'm', apiKey: 'k' })).toThrow(/unknown LLM provider/)
  })

  it('throws when openai-compatible has no base URL', () => {
    expect(() => createLlmClient({ provider: 'openai-compatible', model: 'm', apiKey: 'k' })).toThrow(/base URL/)
  })

  it('throws on an empty model', () => {
    expect(() => createLlmClient({ provider: 'openai', model: '', apiKey: 'k' })).toThrow(/needs a model/)
  })

  it('builds a client for valid config', () => {
    expect(createLlmClient({ provider: 'anthropic', model: 'claude-haiku-4-5', apiKey: 'k' })?.provider).toBe('anthropic')
  })

  it('returns null when enrichment is not configured', () => {
    expect(createLlmClient(null)).toBeNull()
  })
})
