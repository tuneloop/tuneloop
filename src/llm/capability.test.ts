import { describe, expect, it } from 'vitest'
import { meetsMinTier, modelTier } from './capability'

describe('modelTier', () => {
  it.each([
    // Anthropic — direct ids and Bedrock inference-profile ARNs
    ['claude-opus-4-8', 'strong'],
    ['claude-fable-5', 'strong'],
    ['claude-sonnet-5', 'strong'],
    ['us.anthropic.claude-sonnet-5-20250930-v1:0', 'strong'],
    ['claude-haiku-4-5', 'weak'],
    ['us.anthropic.claude-haiku-4-5-20251001-v1:0', 'weak'],
    // OpenAI — full vs mini/nano, incl. OpenRouter prefix
    ['gpt-5', 'strong'],
    ['gpt-5.4', 'strong'],
    ['gpt-5.4-mini', 'weak'],
    ['gpt-5-nano', 'weak'],
    ['openai/gpt-5-mini', 'weak'],
    ['gpt-4o', 'weak'],
    // Gemini — pro vs flash
    ['gemini-2.5-pro', 'strong'],
    ['gemini-2.5-flash', 'weak'],
    ['gemini-2.5-flash-lite', 'weak'],
    // xAI
    ['grok-4', 'strong'],
    // Unrecognised → unknown (fail-closed)
    ['deepseek-chat', 'unknown'],
    ['llama-3.3-70b-versatile', 'unknown'],
    ['qwen2.5', 'unknown'],
    ['', 'unknown'],
  ] as const)('classifies %s as %s', (model, tier) => {
    expect(modelTier(model)).toBe(tier)
  })

  it('is case-insensitive', () => {
    expect(modelTier('Claude-Sonnet-5')).toBe('strong')
    expect(modelTier('GPT-5-MINI')).toBe('weak')
  })
})

describe('meetsMinTier(strong) — the Sonnet-class floor', () => {
  it('passes strong models', () => {
    expect(meetsMinTier('claude-opus-4-8', 'strong')).toBe(true)
    expect(meetsMinTier('claude-sonnet-5', 'strong')).toBe(true)
    expect(meetsMinTier('gemini-2.5-pro', 'strong')).toBe(true)
  })
  it('fails weak and unknown models', () => {
    expect(meetsMinTier('claude-haiku-4-5', 'strong')).toBe(false)
    expect(meetsMinTier('gpt-5.4-mini', 'strong')).toBe(false)
    expect(meetsMinTier('gemini-2.5-flash', 'strong')).toBe(false)
    expect(meetsMinTier('deepseek-chat', 'strong')).toBe(false)
    expect(meetsMinTier('', 'strong')).toBe(false)
  })
})
