import type { ToolCall } from '../core/model'

/**
 * Build a synthesized `skill` tool call for an explicit skill invocation that a
 * harness records as a MESSAGE rather than a tool call.
 *
 * Three of the four harnesses expose an explicit skill trigger (Claude Code
 * `/skill-name`, Codex `$skill-name`, Pi `/skill:name`) that injects the skill body as
 * a user-role message with no accompanying tool call, so `capability_invocation` (which
 * reads `tool_calls`) would never see the invocation. Each adapter detects its own
 * envelope, pulls the skill name out, and pushes one of these into `session.toolCalls`
 * so the invocation is captured uniformly — but only when no real tool call already
 * covers it (CC also fires a `Skill` tool call for some invocations; see parse.ts).
 *
 * Only `action`/`name`/`isSidechain`/`ts` matter to the capability views; the rest are
 * filled with benign defaults. `id` must be unique within the session and must not
 * collide with a real tool_use id (callers key it off a per-session counter). Block
 * attribution has no matching `tool_use` block, so it falls back to nearest-by-ts
 * (core/blocks.ts) — which lands evidence on the invocation turn.
 */
export function synthSkillCall(
  name: string,
  opts: { id: string; ts?: string; isSidechain: boolean },
): ToolCall {
  return {
    id: opts.id,
    name,
    action: 'skill',
    input: { skill: name },
    target: {},
    result: { ok: true, isError: false },
    isSidechain: opts.isSidechain,
    ts: opts.ts,
  }
}
