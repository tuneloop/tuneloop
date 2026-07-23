export interface ProgressState {
  current: number
  total: number
  needingWork: number
  worked: number
  avgMs: number | null
  costUsd: number
}

/**
 * At most one progress bar owns the terminal line at a time. The logger clears it
 * before writing so a log line never garbles the bar — the bar redraws on its next
 * tick, leaving the log cleanly above it. Set only while a bar is actually rendering
 * to a TTY (piped output has no bar, so logs pass straight through).
 */
let activeBar: Progress | null = null

/** Clear the live progress bar (if any) so a caller can write cleanly to the terminal. */
export function clearActiveProgress(): void {
  activeBar?.clear()
}

export class Progress {
  private state: ProgressState
  private stream: NodeJS.WriteStream
  private label: string

  /**
   * @param total       denominator of the bar (all units scanned).
   * @param needingWork  units that actually incur work (ETA/cost extrapolate over these).
   * @param stream       output stream (stderr by default).
   * @param label        optional prefix, e.g. "Step 1/2 · Processing sessions".
   * Both `total` and `needingWork` can grow after construction via addUnits() —
   * the detector phase discovers its deltas as parallel detectors start.
   */
  constructor(total: number, needingWork: number, stream: NodeJS.WriteStream = process.stderr, label = '') {
    this.stream = stream
    this.label = label
    this.state = { current: 0, total, needingWork, worked: 0, avgMs: null, costUsd: 0 }
  }

  /** Grow the denominator — a unit of real work discovered after construction (detector delta). */
  addUnits(n: number) {
    if (n <= 0) return
    this.state.total += n
    this.state.needingWork += n
    this.render()
  }

  /**
   * One unit of real work finished. `totalElapsedMs` is wall-clock since the phase
   * started (not per-unit) so ETA extrapolates correctly even when units run in
   * parallel — a rough estimate by nature. `costUsd` is that unit's incremental spend.
   */
  unitDone(totalElapsedMs: number, costUsd: number) {
    this.state.current++
    this.state.worked++
    this.state.costUsd += costUsd
    this.state.avgMs = this.state.worked > 0 ? totalElapsedMs / this.state.worked : null
    this.absorbOverrun()
    this.render()
  }

  /** Spend not tied to a unit tick (e.g. an X-tier cross-session reconcile/fix tail). */
  addCost(costUsd: number) {
    if (costUsd <= 0) return
    this.state.costUsd += costUsd
    this.render()
  }

  tick(didWork: boolean, elapsedMs: number, costUsd: number) {
    this.state.current++
    this.state.costUsd += costUsd
    if (didWork) {
      this.state.worked++
      this.state.avgMs =
        this.state.avgMs == null
          ? elapsedMs
          : this.state.avgMs + (elapsedMs - this.state.avgMs) / this.state.worked
    }
    this.absorbOverrun()
    this.render()
  }

  /**
   * Let the denominator catch up when more units complete than were declared.
   *
   * Callers declare a total up front from cheap metadata (the recurring-themes
   * detector weights its delta by the windows implied by a stored followup count)
   * but tick from live data (windows actually run against the hydrated transcript).
   * When those disagree the ticks win — they're what really happened — so the bar
   * grows to match instead of reading 21/20. Growing only, like addUnits(): the
   * bar must never regress.
   */
  private absorbOverrun() {
    if (this.state.current > this.state.total) this.state.total = this.state.current
    if (this.state.worked > this.state.needingWork) this.state.needingWork = this.state.worked
  }

  /** Erase the bar line. Deregisters this bar so the logger stops clearing for it. */
  clear() {
    if (activeBar === this) activeBar = null
    if (!this.stream.isTTY) return
    this.stream.clearLine(0)
    this.stream.cursorTo(0)
  }

  private render() {
    if (!this.stream.isTTY) return
    activeBar = this // this bar now owns the line; the logger clears it before writing
    const { current, total, needingWork, worked, avgMs, costUsd } = this.state
    // Clamped independently of absorbOverrun(): rendering must not be able to throw,
    // whatever state it is handed. An unclamped fill throws RangeError on a negative
    // repeat count, and in the detector phase that lands in runDetectors' catch —
    // costing the detector every insight of a run it had already paid for.
    const pct = total > 0 ? Math.min(100, Math.round((current / total) * 100)) : 0
    const barLen = 20
    const filled = total > 0 ? clamp(Math.round((current / total) * barLen), 0, barLen) : 0
    const bar = '█'.repeat(filled) + '░'.repeat(barLen - filled)

    let line = this.label ? `  ${this.label} ` : '  '
    line += `[${bar}] ${current}/${total} (${pct}%)`

    if (avgMs != null) {
      const avgSec = (avgMs / 1000).toFixed(1)
      const remaining = Math.max(0, needingWork - worked)
      const etaMs = remaining * avgMs
      line += ` | ${avgSec}s/session | ~ETA: ${formatDuration(etaMs)}`
    }

    if (costUsd > 0) {
      // Per-unit cost varies widely (e.g. windowed large sessions cost ~10x small
      // ones) and cheaper units often finish first, so an early est-total can read
      // ~10x low. Only show it once enough units have landed for the average to
      // settle; until then show spend-so-far alone rather than a misleading figure
      const remaining = Math.max(0, needingWork - worked)
      const estReady = worked >= Math.max(3, Math.ceil(0.1 * needingWork))
      if (estReady) {
        const estTotal = costUsd + remaining * (costUsd / worked)
        line += ` | Cost: $${costUsd.toFixed(4)} (est. total $${estTotal.toFixed(2)})`
      } else {
        line += ` | Cost: $${costUsd.toFixed(4)}`
      }
    }

    this.stream.clearLine(0)
    this.stream.cursorTo(0)
    this.stream.write(line)
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n))
}

function formatDuration(ms: number): string {
  const secs = Math.round(ms / 1000)
  if (secs < 60) return `${secs}s`
  const mins = Math.floor(secs / 60)
  const rem = secs % 60
  if (mins < 60) return `${mins}m ${rem}s`
  const hrs = Math.floor(mins / 60)
  return `${hrs}h ${mins % 60}m`
}
