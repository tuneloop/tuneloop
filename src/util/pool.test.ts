import { describe, expect, it } from 'vitest'
import { runPool } from './pool'

const tick = (ms = 1) => new Promise((r) => setTimeout(r, ms))

describe('runPool', () => {
  it('processes every item exactly once, passing its index', async () => {
    const seen = new Map<number, number>()
    await runPool([10, 20, 30, 40, 50], 2, async (item, i) => {
      await tick()
      seen.set(item, i)
    })
    expect([...seen.keys()].sort((a, b) => a - b)).toEqual([10, 20, 30, 40, 50])
    expect(seen.get(10)).toBe(0) // index is the item's position, not completion order
    expect(seen.get(50)).toBe(4)
  })

  it('never exceeds the concurrency limit but does run concurrently', async () => {
    let active = 0
    let peak = 0
    await runPool(Array.from({ length: 30 }, (_, i) => i), 4, async () => {
      active++
      peak = Math.max(peak, active)
      await tick()
      active--
    })
    expect(peak).toBeLessThanOrEqual(4)
    expect(peak).toBeGreaterThan(1)
  })

  it('handles a concurrency larger than the item count', async () => {
    const seen: number[] = []
    await runPool([1, 2], 10, async (x) => {
      await tick()
      seen.push(x)
    })
    expect(seen.sort((a, b) => a - b)).toEqual([1, 2])
  })

  it('is a no-op on an empty item list', async () => {
    let called = false
    await runPool([], 4, async () => {
      called = true
    })
    expect(called).toBe(false)
  })

  it('stops scheduling new work after the first error and rethrows it', async () => {
    const started: number[] = []
    const p = runPool(Array.from({ length: 20 }, (_, i) => i), 2, async (x) => {
      started.push(x)
      if (x === 1) throw new Error('boom')
      await tick(5)
    })
    await expect(p).rejects.toThrow('boom')
    // The error surfaces early, so the pool must not have started all 20 items.
    expect(started.length).toBeLessThan(20)
  })
})
