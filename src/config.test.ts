import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadConfig } from './config'

// stubEnv(name, undefined) deletes the var for the test; unstubAllEnvs restores.
const unsetKeys = () => {
  vi.stubEnv('TUNELOOP_LLM_API_KEY', undefined)
  vi.stubEnv('OPENROUTER_API_KEY', undefined)
}

afterEach(() => vi.unstubAllEnvs())

describe('LLM key resolution', () => {
  it('resolves to null when the provider needs a key and none is set', () => {
    unsetKeys()
    expect(loadConfig({ llm: { provider: 'openrouter' } }).llm).toBeNull()
  })

  it('an in-process apiKey override enables the provider without any env key', () => {
    unsetKeys()
    const llm = loadConfig({ llm: { provider: 'openrouter', apiKey: 'sk-prompted' } }).llm
    expect(llm?.apiKey).toBe('sk-prompted')
    expect(llm?.provider).toBe('openrouter')
    expect(llm?.model).toBeTruthy() // preset default model applies as usual
  })

  it('the apiKey override wins over both env sources', () => {
    vi.stubEnv('TUNELOOP_LLM_API_KEY', 'sk-generic-env')
    vi.stubEnv('OPENROUTER_API_KEY', 'sk-preset-env')
    const llm = loadConfig({ llm: { provider: 'openrouter', apiKey: 'sk-prompted' } }).llm
    expect(llm?.apiKey).toBe('sk-prompted')
  })

  it('env keys still work when no override is given', () => {
    unsetKeys()
    vi.stubEnv('OPENROUTER_API_KEY', 'sk-preset-env')
    expect(loadConfig({ llm: { provider: 'openrouter' } }).llm?.apiKey).toBe('sk-preset-env')
  })
})

describe('heavy model resolution', () => {
  const unsetHeavy = () => vi.stubEnv('TUNELOOP_LLM_MODEL_HEAVY', undefined)

  it("falls back to the provider's default heavy model when nothing sets it, so strong-gated detectors run", () => {
    unsetHeavy()
    const llm = loadConfig({ llm: { provider: 'anthropic', apiKey: 'sk-x' } }).llm
    expect(llm?.heavyModel).toBe('claude-sonnet-5')
    expect(llm?.model).toBe('claude-haiku-4-5') // base model untouched
  })

  it('seeds the right strong sibling per provider', () => {
    unsetHeavy()
    expect(loadConfig({ llm: { provider: 'bedrock' } }).llm?.heavyModel).toBe('us.anthropic.claude-sonnet-5')
    expect(loadConfig({ llm: { provider: 'openai', apiKey: 'sk-x' } }).llm?.heavyModel).toBe('gpt-5.4')
    expect(loadConfig({ llm: { provider: 'openrouter', apiKey: 'sk-x' } }).llm?.heavyModel).toBe('openai/gpt-5')
    expect(loadConfig({ llm: { provider: 'gemini', apiKey: 'sk-x' } }).llm?.heavyModel).toBe('gemini-3.1-pro-preview')
  })

  it('is undefined when the provider has no strong sibling (detectors reuse the base client)', () => {
    unsetHeavy()
    expect(loadConfig({ llm: { provider: 'ollama' } }).llm?.heavyModel).toBeUndefined()
    expect(loadConfig({ llm: { provider: 'groq', apiKey: 'sk-x' } }).llm?.heavyModel).toBeUndefined()
    expect(loadConfig({ llm: { provider: 'xai', apiKey: 'sk-x' } }).llm?.heavyModel).toBeUndefined() // grok-4 already clears the gate
  })

  it('TUNELOOP_LLM_MODEL_HEAVY overrides the preset default', () => {
    vi.stubEnv('TUNELOOP_LLM_MODEL_HEAVY', 'claude-opus-4-8')
    const llm = loadConfig({ llm: { provider: 'anthropic', apiKey: 'sk-x' } }).llm
    expect(llm?.heavyModel).toBe('claude-opus-4-8')
    expect(llm?.model).toBe('claude-haiku-4-5') // base model untouched
  })

  it('an explicit heavyModel override wins over env and the preset default', () => {
    vi.stubEnv('TUNELOOP_LLM_MODEL_HEAVY', 'from-env')
    const llm = loadConfig({ llm: { provider: 'anthropic', apiKey: 'sk-x', heavyModel: 'from-flag' } }).llm
    expect(llm?.heavyModel).toBe('from-flag')
  })

  it('reuses an already-strong base model instead of downgrading to the preset default', () => {
    unsetHeavy()
    const llm = loadConfig({ llm: { provider: 'anthropic', apiKey: 'sk-x', model: 'claude-opus-4-8' } }).llm
    expect(llm?.heavyModel).toBeUndefined() // opus already clears the strong tier — detectors reuse it
    expect(llm?.model).toBe('claude-opus-4-8')
  })

  it('an explicit heavy still applies over an already-strong base', () => {
    unsetHeavy()
    const llm = loadConfig({ llm: { provider: 'anthropic', apiKey: 'sk-x', model: 'claude-opus-4-8', heavyModel: 'claude-sonnet-5' } }).llm
    expect(llm?.heavyModel).toBe('claude-sonnet-5')
  })

  it('aligns the Bedrock default heavy profile to the base model region', () => {
    unsetHeavy()
    const eu = loadConfig({ llm: { provider: 'bedrock', model: 'eu.anthropic.claude-haiku-4-5-20251001-v1:0' } }).llm
    expect(eu?.heavyModel).toBe('eu.anthropic.claude-sonnet-5')
    const apac = loadConfig({ llm: { provider: 'bedrock', model: 'apac.anthropic.claude-haiku-4-5-20251001-v1:0' } }).llm
    expect(apac?.heavyModel).toBe('apac.anthropic.claude-sonnet-5')
  })
})

describe('keyless presets', () => {
  it('ollama gets its placeholder key (the OpenAI SDK rejects an empty one)', () => {
    unsetKeys()
    vi.stubEnv('OLLAMA_API_KEY', undefined)
    expect(loadConfig({ llm: { provider: 'ollama' } }).llm?.apiKey).toBe('local')
  })

  it('bedrock resolves keyless with an empty key (AWS credential chain handles auth)', () => {
    unsetKeys()
    vi.stubEnv('AWS_BEARER_TOKEN_BEDROCK', undefined)
    const llm = loadConfig({ llm: { provider: 'bedrock' } }).llm
    expect(llm?.apiKey).toBe('')
    expect(llm?.model).toMatch(/anthropic\.claude/) // US inference-profile default
  })

  it('bedrock picks up a bearer API key from its conventional env', () => {
    unsetKeys()
    vi.stubEnv('AWS_BEARER_TOKEN_BEDROCK', 'bedrock-api-key')
    expect(loadConfig({ llm: { provider: 'bedrock' } }).llm?.apiKey).toBe('bedrock-api-key')
  })
})
