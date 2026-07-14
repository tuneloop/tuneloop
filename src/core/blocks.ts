/**
 * Block-level attribution (handling_long_sessions). A long session is no longer
 * one unit of work — it ships several PRs, advances several features, moves
 * through several use-cases. We split each session's MAIN thread into a
 * deterministic partition of contiguous **blocks** so cost attributes at block
 * grain instead of being charged whole-session to every artifact it touched.
 *
 * Everything here is a pure function of the normalized `Session`, so it is
 * vendor-neutral (a new harness works once its adapter produces canonical
 * actions + sidechain links — see ARCHITECTURE.md). The partition is owned by the
 * `segment-blocks` processor, but `deterministicBlocks` is shared: outcomes-git
 * (block→PR) and enrich-session (block→use_case/feature) recompute it to know
 * which block their links/labels attach to, so all agree on `idx` without
 * cross-processor store reads.
 */
import type { Event, Session, ToolCall } from './model'
import { isRealUserText, stripReminders } from './turns'

/** A tool action that closes a block (cost-attribution boundary). */
export type BoundaryKind = 'commit' | 'pr_create' | 'pr_merge' | 'pr_review'

export interface Block {
  idx: number
  /** Inclusive main-thread seq of the block's first event. */
  startSeq: number
  /** Inclusive main-thread seq of the block's last event. */
  endSeq: number
  /** What closed the block. */
  boundaryKind: BoundaryKind | 'user_turn' | 'session_end'
  tsStart?: string
  tsEnd?: string
}

/** Block index per usage_facts.idx and per tool_calls.idx (a total partition). */
export interface BlockMembership {
  /** usage[k] = block idx for the k-th assistant message (== usage_facts.idx). */
  usage: number[]
  /** tool[i] = block idx for session.toolCalls[i] (== tool_calls.idx). */
  tool: number[]
}

/**
 * Version of the shared, vendor-neutral normalization applied post-parse
 * (`assignSeq` + `mergeSessions`) whose output rides the session blob. Bumped when
 * that normalization changes, so EVERY vendor's sessions re-ingest. Combined with
 * each adapter's own `parseVersion` into the stored `parse_version` (see analyze.ts).
 */
export const NORMALIZE_VERSION = 5 // 5: backfill sessions.first_prompt (opening-prompt title fallback)


/**
 * Assign a dense ordinal `seq` to every MAIN-THREAD event, in order. Sidechain
 * events get none (they're clumped per-file by merge and roll up to the block
 * that spawned them). Run once, post-merge, before ingest — `seq` then rides the
 * session blob and is the coordinate the partition is defined in.
 */
export function assignSeq(session: Session): void {
  let seq = 0
  for (const ev of session.events) {
    if (ev.isSidechain) {
      ev.seq = undefined
      continue
    }
    ev.seq = seq++
  }
}

/** Classify a tool call as a block-closing boundary (shared with outcomes-git). */
export function boundaryKind(tc: ToolCall): BoundaryKind | null {
  if (tc.action === 'shell' && typeof tc.target.command === 'string') {
    const cmd = tc.target.command
    if (/\bgh\s+pr\s+merge\b/.test(cmd)) return 'pr_merge'
    if (/\bgh\s+pr\s+create\b/.test(cmd)) return 'pr_create'
    // Posting a review closes a block too: the reading/analysis leading up to it is
    // its own unit of work, so it doesn't bleed into the next (produce-a-PR) stretch.
    if (/\bgh\s+pr\s+review\b/.test(cmd)) return 'pr_review'
    if (/\bgit\b[^\n]*\bcommit\b/.test(cmd)) return 'commit'
    return null
  }
  if (tc.action === 'mcp_call' && /pull_request/i.test(tc.name)) {
    // Review FIRST — `create_pull_request_review` contains "create" but is a POSTED
    // review, not a PR creation (mirrors parsePrRefs' ordering). A review READ
    // (get/list ...review) closes nothing.
    if (/review/i.test(tc.name)) return /(?:create|submit|add)/i.test(tc.name) ? 'pr_review' : null
    if (/merge/i.test(tc.name)) return 'pr_merge'
    if (/create/i.test(tc.name)) return 'pr_create'
  }
  return null
}

/**
 * The deterministic block partition. A new block starts at session start, at each
 * real human user turn, and immediately after each commit / PR-create / PR-merge
 * tool call. Blocks are contiguous, non-overlapping, and exhaustive over the
 * main-thread seq range. Requires `assignSeq` to have run.
 */
export function deterministicBlocks(session: Session): Block[] {
  const main = session.events.filter((e): e is Event => !e.isSidechain && e.seq != null)
  main.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0)) // defensive; already in order
  const m = main.length
  if (m === 0) return []

  const idToTool = new Map<string, ToolCall>()
  for (const tc of session.toolCalls) idToTool.set(tc.id, tc)

  // Per main event: does it START a block (real user turn), and does a boundary
  // tool call CLOSE it (cut after)?
  const userStart: boolean[] = new Array(m).fill(false)
  const closeKind: (BoundaryKind | null)[] = new Array(m).fill(null)
  for (let i = 0; i < m; i++) {
    const ev = main[i]!
    if (ev.kind === 'user' && isRealUserText(ev.text)) userStart[i] = true
    else if (ev.kind === 'assistant') {
      let bk: BoundaryKind | null = null
      for (const b of ev.blocks) {
        if (b.type !== 'tool_use') continue
        const tc = idToTool.get(b.id)
        if (!tc) continue
        const k = boundaryKind(tc)
        if (k === 'pr_merge' || k === 'pr_create') { bk = k; break } // producing a PR dominates a same-message review/commit
        if (k === 'pr_review') bk = 'pr_review' // a review outranks a bare commit in the same message
        else if (k === 'commit' && bk !== 'pr_review') bk = 'commit'
      }
      closeKind[i] = bk
    }
  }

  // Block start positions (indices into `main`).
  const starts = new Set<number>([0])
  for (let i = 0; i < m; i++) {
    if (userStart[i]) starts.add(i)
    if (closeKind[i] && i + 1 < m) starts.add(i + 1)
  }
  const sorted = [...starts].sort((a, b) => a - b)

  const blocks: Block[] = []
  for (let s = 0; s < sorted.length; s++) {
    const startPos = sorted[s]!
    const endPos = (s + 1 < sorted.length ? sorted[s + 1]! : m) - 1
    const startEv = main[startPos]!
    const endEv = main[endPos]!
    const boundary: Block['boundaryKind'] =
      closeKind[endPos] ?? (endPos === m - 1 ? 'session_end' : 'user_turn')
    blocks.push({
      idx: blocks.length,
      startSeq: startEv.seq!,
      endSeq: endEv.seq!,
      boundaryKind: boundary,
      tsStart: startEv.ts,
      tsEnd: endEv.ts,
    })
  }
  return blocks
}

/**
 * Attribute every block to the PR it fed into: each block belongs to the nearest
 * PR-closing block at or after it (a backward fill over `closingBlockToArtifact`,
 * which maps a PR-closing block idx → its PR artifact id). Blocks after the last
 * PR belong to none. This gives cost-per-PR the FULL cost of producing a PR
 * (all the commit-bounded blocks that led up to its create/merge), not just the
 * one block the `gh pr create` sat in.
 */
export function attributeBlocksToPrs(
  blocks: Block[],
  closingBlockToArtifact: Map<number, string>,
): Array<{ blockIdx: number; artifactId: string }> {
  const out: Array<{ blockIdx: number; artifactId: string }> = []
  let nextPr: string | undefined
  for (let i = blocks.length - 1; i >= 0; i--) {
    const closing = closingBlockToArtifact.get(i)
    if (closing) nextPr = closing
    if (nextPr) out.push({ blockIdx: i, artifactId: nextPr })
  }
  return out
}

/**
 * Map every usage_facts / tool_calls row to its block. Main-thread rows map by
 * seq; sidechain rows roll up to the block that holds their spawning `Task` call
 * (`agentId → SubagentMeta.toolUseId → seq`); orphan sidechain rows (workflow
 * subagents with no spawning call) fall back to the nearest block by timestamp,
 * so the partition stays exhaustive (the master Σ-invariant depends on it).
 */
export function blockMembership(session: Session, blocks: Block[]): BlockMembership {
  const usage: number[] = []
  const tool: number[] = []
  if (blocks.length === 0) return { usage, tool }

  const maxSeq = blocks[blocks.length - 1]!.endSeq
  const seqToBlock = new Array<number>(maxSeq + 1).fill(0)
  for (const b of blocks) for (let s = b.startSeq; s <= b.endSeq; s++) seqToBlock[s] = b.idx

  // tool_use id -> its containing main-thread seq / sidechain agentId
  const idToSeq = new Map<string, number>()
  const idToAgent = new Map<string, string>()
  for (const ev of session.events) {
    if (ev.kind !== 'assistant') continue
    for (const b of ev.blocks) {
      if (b.type !== 'tool_use') continue
      if (!ev.isSidechain && ev.seq != null) idToSeq.set(b.id, ev.seq)
      else if (ev.agentId) idToAgent.set(b.id, ev.agentId)
    }
  }

  // agentId -> block, via the spawning Task tool_use's seq
  const agentToBlock = new Map<string, number>()
  for (const sa of session.subagents ?? []) {
    if (!sa.toolUseId) continue
    const seq = idToSeq.get(sa.toolUseId)
    if (seq != null) agentToBlock.set(sa.agentId, seqToBlock[seq]!)
  }

  const nearestByTs = (ts?: string): number => {
    if (!ts) return 0
    let best = 0
    let bestTs = ''
    for (const b of blocks) {
      if (b.tsStart != null && b.tsStart <= ts && b.tsStart >= bestTs) {
        best = b.idx
        bestTs = b.tsStart
      }
    }
    return best
  }

  for (const ev of session.events) {
    if (ev.kind !== 'assistant') continue
    if (!ev.isSidechain && ev.seq != null) usage.push(seqToBlock[ev.seq]!)
    else usage.push((ev.agentId ? agentToBlock.get(ev.agentId) : undefined) ?? nearestByTs(ev.ts))
  }

  for (const tc of session.toolCalls) {
    const seq = idToSeq.get(tc.id)
    if (seq != null) tool.push(seqToBlock[seq]!)
    else {
      const agent = idToAgent.get(tc.id)
      tool.push((agent ? agentToBlock.get(agent) : undefined) ?? nearestByTs(tc.ts))
    }
  }

  return { usage, tool }
}

/**
 * A complete numbered digest of the blocks for the segmentation prompt — every
 * block on one line: its opening user turn (truncated) + a compact action
 * summary. NOT truncated by block count: the idx labels must map 1:1 to the
 * model's runs, so this is the one place the digest can't elide the middle.
 */
export function blockSpine(session: Session, blocks: Block[]): string {
  if (blocks.length === 0) return '(no blocks)'
  const { tool } = blockMembership(session, blocks)
  const toolsByBlock = new Map<number, ToolCall[]>()
  session.toolCalls.forEach((tc, i) => {
    const b = tool[i]
    if (b == null) return
    const arr = toolsByBlock.get(b) ?? []
    arr.push(tc)
    toolsByBlock.set(b, arr)
  })
  const bySeq = new Map<number, Event>()
  for (const ev of session.events) if (!ev.isSidechain && ev.seq != null) bySeq.set(ev.seq, ev)

  const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '…' : s)
  const lines: string[] = []
  for (const b of blocks) {
    let opener = ''
    for (let s = b.startSeq; s <= b.endSeq; s++) {
      const ev = bySeq.get(s)
      if (ev && ev.kind === 'user' && isRealUserText(ev.text)) {
        opener = stripReminders(ev.text).replace(/\s+/g, ' ')
        break
      }
    }
    const tcs = toolsByBlock.get(b.idx) ?? []
    const writes = tcs.filter((t) => t.action === 'file_write').length
    const shells = tcs.filter((t) => t.action === 'shell').length
    const acts = [writes ? `${writes} file write${writes > 1 ? 's' : ''}` : '', shells ? `${shells} shell` : '']
      .filter(Boolean)
      .join(', ')
    const tag =
      b.boundaryKind === 'pr_create'
        ? ' · opened a PR'
        : b.boundaryKind === 'pr_merge'
          ? ' · merged a PR'
          : b.boundaryKind === 'pr_review'
            ? ' · reviewed a PR'
            : b.boundaryKind === 'commit'
              ? ' · git commit'
              : ''
    const head = opener ? `user: "${clip(opener, 200)}"` : '(continued work — no new prompt)'
    lines.push(`[${b.idx}] ${head}${acts ? ` · ${acts}` : ''}${tag}`)
  }
  return lines.join('\n')
}
