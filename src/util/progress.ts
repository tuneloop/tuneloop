export interface ProgressState {
  current: number
  total: number
  needingWork: number
  worked: number
  avgMs: number | null
  costUsd: number
}

export class Progress {
  private state: ProgressState
  private stream: NodeJS.WriteStream

  constructor(total: number, needingWork: number, stream: NodeJS.WriteStream = process.stderr) {
    this.stream = stream
    this.state = { current: 0, total, needingWork, worked: 0, avgMs: null, costUsd: 0 }
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
    this.render()
  }

  clear() {
    if (!this.stream.isTTY) return
    this.stream.clearLine(0)
    this.stream.cursorTo(0)
  }

  private render() {
    if (!this.stream.isTTY) return
    const { current, total, needingWork, worked, avgMs, costUsd } = this.state
    const pct = Math.round((current / total) * 100)
    const barLen = 20
    const filled = Math.round((current / total) * barLen)
    const bar = '█'.repeat(filled) + '░'.repeat(barLen - filled)

    let line = `  [${bar}] ${current}/${total} (${pct}%)`

    if (avgMs != null) {
      const avgSec = (avgMs / 1000).toFixed(1)
      const remaining = needingWork - worked
      const etaMs = remaining * avgMs
      line += ` | ${avgSec}s/session | ETA: ${formatDuration(etaMs)}`
    }

    if (costUsd > 0) {
      const remaining = needingWork - worked
      const avgCost = costUsd / worked
      const estTotal = costUsd + remaining * avgCost
      line += ` | Cost: $${costUsd.toFixed(4)} (est. total $${estTotal.toFixed(2)})`
    }

    this.stream.clearLine(0)
    this.stream.cursorTo(0)
    this.stream.write(line)
  }
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
