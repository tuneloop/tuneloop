import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultHeavyModel, loadConfig } from './config'

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
  it('is undefined when nothing sets it (detectors reuse the base client)', () => {
    vi.stubEnv('TUNELOOP_LLM_MODEL_HEAVY', undefined)
    const llm = loadConfig({ llm: { provider: 'ollama' } }).llm
    expect(llm?.heavyModel).toBeUndefined()
  })

  it('reads TUNELOOP_LLM_MODEL_HEAVY', () => {
    vi.stubEnv('TUNELOOP_LLM_MODEL_HEAVY', 'claude-opus-4-8')
    const llm = loadConfig({ llm: { provider: 'anthropic', apiKey: 'sk-x' } }).llm
    expect(llm?.heavyModel).toBe('claude-opus-4-8')
    expect(llm?.model).toBe('claude-haiku-4-5') // base model untouched
  })

  it('the heavyModel override wins over env', () => {
    vi.stubEnv('TUNELOOP_LLM_MODEL_HEAVY', 'from-env')
    const llm = loadConfig({ llm: { provider: 'anthropic', apiKey: 'sk-x', heavyModel: 'from-flag' } }).llm
    expect(llm?.heavyModel).toBe('from-flag')
  })
})

describe('defaultHeavyModel (interactive enrichment setup)', () => {
  const unsetHeavy = () => vi.stubEnv('TUNELOOP_LLM_MODEL_HEAVY', undefined)

  it('seeds Sonnet-class for anthropic so strong-gated detectors run', () => {
    unsetHeavy()
    expect(defaultHeavyModel('anthropic')).toBe('claude-sonnet-5')
  })

  it('seeds the US Sonnet-5 inference profile for bedrock', () => {
    unsetHeavy()
    expect(defaultHeavyModel('bedrock')).toBe('us.anthropic.claude-sonnet-5-20260203-v1:0')
  })

  it('seeds a strong sibling for openai/openrouter/gemini', () => {
    unsetHeavy()
    expect(defaultHeavyModel('openai')).toBe('gpt-5.4')
    expect(defaultHeavyModel('openrouter')).toBe('openai/gpt-5')
    expect(defaultHeavyModel('gemini')).toBe('gemini-3.1-pro-preview')
  })

  it('returns undefined when the provider has no strong sibling (or is already strong)', () => {
    unsetHeavy()
    expect(defaultHeavyModel('ollama')).toBeUndefined()
    expect(defaultHeavyModel('groq')).toBeUndefined()
    expect(defaultHeavyModel('xai')).toBeUndefined() // grok-4 already clears the gate
  })

  it('TUNELOOP_LLM_MODEL_HEAVY wins over the preset default', () => {
    vi.stubEnv('TUNELOOP_LLM_MODEL_HEAVY', 'claude-opus-4-8')
    expect(defaultHeavyModel('anthropic')).toBe('claude-opus-4-8')
  })

  it('an explicit override wins over env and the preset default', () => {
    vi.stubEnv('TUNELOOP_LLM_MODEL_HEAVY', 'from-env')
    expect(defaultHeavyModel('anthropic', { heavyModel: 'from-flag' })).toBe('from-flag')
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
