import { registerProcessor } from '../core/registry'
import type { Processor, ProcessorContext, ProcessorResult } from '../core/processor'
import { blockMembership, deterministicBlocks } from '../core/blocks'

/**
 * Segment a session's main thread into the deterministic block partition and map
 * every usage_facts / tool_calls row to its block (handling_long_sessions). This
 * is the substrate the read path attributes cost on; it runs without an LLM, so
 * cost-per-PR is exact on a fresh install. The partition is a pure function of
 * the normalized session (core/blocks.ts), so it's vendor-neutral.
 *
 * Owns `blocks` + `block_usage` + `block_tool`. Labels (use_case) and feature
 * links are layered on by enrich-session; PR/commit links by outcomes-git — all
 * recompute the same `deterministicBlocks` so block indices agree.
 */
export const segmentBlocks: Processor = {
  name: 'segment-blocks',
  version: 1,
  kind: 'static',
  run(ctx: ProcessorContext): ProcessorResult {
    const { session } = ctx
    const blocks = deterministicBlocks(session)
    if (blocks.length === 0) return {} // all-sidechain fragment / no main thread → read path falls back to session grain
    const membership = blockMembership(session, blocks)
    return {
      blocks: blocks.map((b) => ({
        idx: b.idx,
        startSeq: b.startSeq,
        endSeq: b.endSeq,
        boundaryKind: b.boundaryKind,
        tsStart: b.tsStart,
        tsEnd: b.tsEnd,
      })),
      blockUsage: membership.usage.map((blockIdx, usageIdx) => ({ usageIdx, blockIdx })),
      blockTool: membership.tool.map((blockIdx, toolIdx) => ({ toolIdx, blockIdx })),
    }
  },
}

registerProcessor(segmentBlocks)
