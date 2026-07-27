import { describe, expect, it } from 'vitest'
import { getGlobalDispatcher } from 'undici'
import { tuneHttpForConcurrentLlm } from './http-transport'

// Each test file runs in its own fork (default vitest isolation), so the global
// dispatcher starts as Node's default here — a clean before/after.
describe('tuneHttpForConcurrentLlm', () => {
  it('replaces the default global dispatcher, once (idempotent)', () => {
    const before = getGlobalDispatcher()
    tuneHttpForConcurrentLlm()
    const after = getGlobalDispatcher()
    expect(after).not.toBe(before) // installed our HTTP/1.1 pool in place of the default
    tuneHttpForConcurrentLlm()
    expect(getGlobalDispatcher()).toBe(after) // second call is a no-op — no new Agent leaked
  })
})
