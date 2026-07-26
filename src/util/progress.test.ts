import { describe, it, expect } from 'vitest'
import { Progress, clearActiveProgress } from './progress'

/** A fake TTY stream that records every write so we can assert on the rendered line. */
function fakeStream() {
  const writes: string[] = []
  const stream = {
    isTTY: true,
    clearLine() {},
    cursorTo() {},
    write(s: string) {
      writes.push(s)
      return true
    },
  } as unknown as NodeJS.WriteStream
  return { stream, writes, last: () => writes[writes.length - 1] ?? '' }
}

describe('Progress', () => {
  it('renders a label prefix when given one', () => {
    const f = fakeStream()
    const p = new Progress(2, 2, f.stream, 'Step 1/2 · Processing sessions')
    p.tick(true, 1000, 0)
    expect(f.last()).toContain('Step 1/2 · Processing sessions')
    expect(f.last()).toContain('1/2')
  })

  it('omits the prefix when no label is given (back-compat with processor phase)', () => {
    const f = fakeStream()
    const p = new Progress(2, 2, f.stream)
    p.tick(true, 1000, 0)
    // Same leading shape as before: two spaces then the bar.
    expect(f.last()).toMatch(/^ {2}\[/)
  })

  it('grows the denominator with addUnits (parallel detectors declaring deltas)', () => {
    const f = fakeStream()
    const p = new Progress(0, 0, f.stream, 'Step 2/2')
    p.addUnits(3)
    expect(f.last()).toContain('0/3')
    p.addUnits(2)
    expect(f.last()).toContain('0/5')
  })

  it('advances count + cost on unitDone and shows a running est. total once the estimate settles', () => {
    const f = fakeStream()
    const p = new Progress(0, 0, f.stream, 'Step 2/2')
    p.addUnits(6)
    p.unitDone(1000, 0.5) // 1/6 — below the settle gate (needs >= max(3, ceil(0.6))=3)
    expect(f.last()).toContain('1/6')
    expect(f.last()).toContain('Cost: $0.5000')
    expect(f.last()).not.toContain('est. total') // suppressed until enough units land
    p.unitDone(2000, 0.5)
    p.unitDone(3000, 0.5) // 3/6 done, $1.50 spent — gate now crossed
    const line = f.last()
    expect(line).toContain('3/6')
    // avg $0.50/unit × 3 remaining + $1.50 spent = $3.00 est total
    expect(line).toContain('est. total $3.00')
  })

  it('suppresses est. total until enough units complete (avoids a misleading early figure)', () => {
    const f = fakeStream()
    const p = new Progress(0, 0, f.stream, 'Step 2/2')
    p.addUnits(4)
    p.unitDone(1000, 0.02) // cheap unit first — extrapolating now would read ~10x low
    p.unitDone(2000, 0.02) // 2/4, still below the 3-unit floor
    expect(f.last()).not.toContain('est. total')
    expect(f.last()).toContain('Cost: $0.0400')
  })

  it('addCost moves the cost line without advancing the unit count', () => {
    const f = fakeStream()
    const p = new Progress(0, 0, f.stream, 'Step 2/2')
    p.addUnits(2)
    p.unitDone(500, 1.0) // 1/2 done, $1 spent
    p.addCost(0.25) // tail spend, no unit tick
    const line = f.last()
    expect(line).toContain('1/2') // count unchanged by addCost
    expect(line).toContain('Cost: $1.2500')
  })

  it('ignores non-positive addUnits / addCost', () => {
    const f = fakeStream()
    const p = new Progress(1, 1, f.stream)
    const before = f.writes.length
    p.addUnits(0)
    p.addUnits(-3)
    p.addCost(0)
    p.addCost(-1)
    expect(f.writes.length).toBe(before) // no re-render for no-ops
  })

  it('handles a zero-total phase without dividing by zero', () => {
    const f = fakeStream()
    const p = new Progress(0, 0, f.stream, 'Step 2/2')
    // No units ever added (e.g. only S-tier detectors ran) — render must not throw.
    expect(() => p.clear()).not.toThrow()
    p.addCost(0) // no-op, no render
    expect(f.writes.length).toBe(0)
  })

  it('registers as the active bar on render and clearActiveProgress erases it', () => {
    const f = fakeStream()
    let cleared = 0
    ;(f.stream as unknown as { clearLine: () => void }).clearLine = () => { cleared++ }
    const p = new Progress(2, 2, f.stream, 'Step 1/2')
    p.tick(true, 1000, 0) // renders → becomes the active bar
    clearActiveProgress() // logger would call this before writing
    expect(cleared).toBeGreaterThan(0)
  })

  it('clear() deregisters the bar so a later clearActiveProgress is a no-op', () => {
    const f = fakeStream()
    const p = new Progress(2, 2, f.stream, 'Step 1/2')
    p.tick(true, 1000, 0)
    p.clear() // phase over — bar deregistered
    let cleared = 0
    ;(f.stream as unknown as { clearLine: () => void }).clearLine = () => { cleared++ }
    clearActiveProgress()
    expect(cleared).toBe(0) // nothing to clear; no stray erase
  })

  it('a non-TTY bar never becomes active (piped output → logs pass straight through)', () => {
    const writes: string[] = []
    const stream = {
      isTTY: false,
      clearLine() { writes.push('CLEAR') },
      cursorTo() {},
      write() { return true },
    } as unknown as NodeJS.WriteStream
    const p = new Progress(2, 2, stream, 'Step 2/2')
    p.tick(true, 1000, 1.0)
    clearActiveProgress()
    expect(writes).not.toContain('CLEAR') // no active bar registered for non-TTY
  })

  it('does not render to a non-TTY stream', () => {
    const writes: string[] = []
    const stream = {
      isTTY: false,
      clearLine() {},
      cursorTo() {},
      write(s: string) {
        writes.push(s)
        return true
      },
    } as unknown as NodeJS.WriteStream
    const p = new Progress(2, 2, stream, 'Step 1/2')
    p.tick(true, 1000, 1.0)
    p.unitDone(1000, 1.0)
    expect(writes.length).toBe(0)
  })
})

describe('Progress — unit overflow', () => {
  // A detector declares its total from stored annotations but ticks from live data,
  // so actual units can exceed declared. The bar is a display: it must absorb that,
  // never throw. A throw here is swallowed into persistDetectorError, costing the
  // detector its whole run — and it re-spends and re-crashes on the next analyze.
  it('does not throw when more units complete than were declared', () => {
    const f = fakeStream()
    const p = new Progress(0, 0, f.stream, 'Step 2/2')
    p.addUnits(1)
    expect(() => {
      p.unitDone(1000, 0.1)
      p.unitDone(2000, 0.1) // one past the declared total
      p.unitDone(3000, 0.1)
    }).not.toThrow()
  })

  it('keeps the bar coherent on overrun — no negative fill, no >100%', () => {
    const f = fakeStream()
    const p = new Progress(0, 0, f.stream, 'Step 2/2')
    p.addUnits(1)
    p.unitDone(1000, 0)
    p.unitDone(2000, 0)
    const line = f.last()
    expect(line).toContain('2/2') // total absorbed the extra unit rather than reading 2/1
    expect(line).toContain('(100%)')
    expect(line).toMatch(/\[█{20}\]/) // full bar, not a truncated or padded-negative one
  })

  it('never shows a negative ETA', () => {
    const f = fakeStream()
    const p = new Progress(0, 0, f.stream, 'Step 2/2')
    p.addUnits(1)
    p.unitDone(1000, 0)
    p.unitDone(2000, 0)
    expect(f.last()).not.toMatch(/ETA: -/)
  })

  it('never estimates a total below what has already been spent', () => {
    const f = fakeStream()
    const p = new Progress(0, 0, f.stream, 'Step 2/2')
    p.addUnits(3)
    for (let i = 1; i <= 5; i++) p.unitDone(i * 1000, 0.1) // 5 units against a declared 3
    const m = f.last().match(/Cost: \$([\d.]+) \(est\. total \$([\d.]+)\)/)
    if (m) expect(Number(m[2])).toBeGreaterThanOrEqual(Number(m[1]))
  })

  it('tick() absorbs overrun too (processor phase, same failure mode)', () => {
    const f = fakeStream()
    const p = new Progress(1, 1, f.stream)
    expect(() => {
      p.tick(true, 100, 0)
      p.tick(true, 100, 0)
    }).not.toThrow()
    expect(f.last()).toContain('2/2')
  })
})
