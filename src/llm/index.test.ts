import { afterEach, describe, expect, it, vi } from 'vitest'
import { createLlmClient, PROVIDERS } from './index'
import { loadConfig } from '../config'

afterEach(() => vi.unstubAllEnvs())

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

  it('builds a bedrock client, with and without a bearer key', () => {
    const withKey = createLlmClient({ provider: 'bedrock', model: 'us.anthropic.claude-haiku-4-5-20251001-v1:0', apiKey: 'bk' })
    expect(withKey?.provider).toBe('bedrock')
    // Keyless: the AWS credential chain authenticates at request time, not construction.
    const keyless = createLlmClient({ provider: 'bedrock', model: 'us.anthropic.claude-haiku-4-5-20251001-v1:0', apiKey: '' })
    expect(keyless?.provider).toBe('bedrock')
  })

  it('returns null when enrichment is not configured', () => {
    expect(createLlmClient(null)).toBeNull()
  })
})

describe('bedrock keyless probe', () => {
  // Only the positive direction: the negative depends on the machine's ambient
  // AWS state (~/.aws, instance metadata), which would make it flaky.
  it('reports configured when the AWS credential chain resolves', async () => {
    vi.stubEnv('AWS_ACCESS_KEY_ID', 'AKIATEST')
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'test-secret')
    const keyless = PROVIDERS.bedrock!.keyless!
    if (!('fallback' in keyless)) throw new Error('bedrock preset must be fallback-keyless')
    expect(await keyless.isConfigured()).toBe(true)
  })
})
