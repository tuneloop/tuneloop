import { describe, expect, it } from 'vitest'
import { openrouterKeys } from './openrouter'

describe('openrouterKeys', () => {
  it('maps gemini → google, the OpenRouter vendor prefix (else the model prices at $0)', () => {
    expect(openrouterKeys('gemini', 'gemini-3.1-pro-preview')).toContain('google/gemini-3.1-pro-preview')
  })

  it('maps xai → x-ai', () => {
    expect(openrouterKeys('xai', 'grok-4')).toContain('x-ai/grok-4')
  })

  it('tries the provider-prefixed key then the bare model when the vendor already matches', () => {
    expect(openrouterKeys('deepseek', 'deepseek-chat')).toEqual(['deepseek/deepseek-chat', 'deepseek-chat'])
  })
})
