import { describe, expect, it } from 'vitest'
import { mapPool } from './pool'

describe('mapPool', () => {
  it('preserves input order regardless of completion order', async () => {
    const out = await mapPool([30, 10, 20], 3, async (ms, i) => {
      await new Promise((r) => setTimeout(r, ms))
      return i
    })
    expect(out).toEqual([0, 1, 2])
  })

  it('never exceeds the concurrency cap', async () => {
    let inFlight = 0
    let peak = 0
    await mapPool(Array.from({ length: 10 }, (_, i) => i), 3, async () => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise((r) => setTimeout(r, 5))
      inFlight--
    })
    expect(peak).toBeLessThanOrEqual(3)
  })

  it('handles an empty list without spawning workers', async () => {
    expect(await mapPool([], 4, async () => 1)).toEqual([])
  })

  it('a concurrency below 1 is clamped to 1 (runs sequentially, not never)', async () => {
    const out = await mapPool([1, 2, 3], 0, async (x) => x * 2)
    expect(out).toEqual([2, 4, 6])
  })

  it('propagates a mapper rejection', async () => {
    await expect(
      mapPool([1, 2, 3], 2, async (x) => {
        if (x === 2) throw new Error('boom')
        return x
      }),
    ).rejects.toThrow('boom')
  })
})
