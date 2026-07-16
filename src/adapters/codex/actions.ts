import type { CanonicalAction } from '../../core/model'

/**
 * Map Codex tool names to canonical actions. This is the ONE place that knows
 * Codex's tool vocabulary — common extractors stay vendor-neutral.
 *
 * Codex reads files via the shell (no `Read` tool). MCP tools arrive as namespaced
 * `function_call`s (`mcp__<server>`) and map to `action='mcp_call'`. Skills are
 * shell-based — `SKILL.md` + scripts — but a skill is loaded by reading its
 * `SKILL.md`, which we recognize and reclassify to `action='skill'` so Codex skills
 * join Claude's in one facet. Anything unmapped falls through to `other`.
 */
export interface MappedAction {
  action: CanonicalAction
  target: { paths?: string[]; command?: string }
  /** Refined tool-call identity: the skill name for `skill`, the `mcp__server__tool` id for `mcp_call`. */
  name?: string
}

// A skill is engaged by reading `<agent-home>/skills/[.system/]<name>/SKILL.md`. The
// home is NOT fixed — `.codex` (default), `.agents` (shared), or a relocated CODEX_HOME
// — so anchor on a dot-prefixed home dir: matches any `.X/skills/`, excludes ordinary
// project `skills/` dirs. A non-dot relocated home is the documented residual.
const SKILL_RE = /\/\.[\w-]+\/skills\/(?:\.system\/)?([\w-]+)\/SKILL\.md\b/

export function mapAction(name: string, input: unknown, namespace?: string): MappedAction {
  // MCP tools carry a `mcp__<server>` namespace with the bare tool in `name` (built-ins
  // also have namespaces, e.g. `multi_agent_v1`, so match the prefix, not mere presence).
  // Rebuild Claude's `mcp__<server>__<tool>` identity so both harnesses share one facet.
  if (namespace?.startsWith('mcp__')) {
    return { action: 'mcp_call', name: `${namespace}__${name}`, target: {} }
  }
  // Unified `exec` envelopes expose namespaced tools as JavaScript properties,
  // so there is no separate `namespace` field to rebuild in that format.
  if (name.startsWith('mcp__')) return { action: 'mcp_call', name, target: {} }
  switch (name) {
    case 'exec_command':
    case 'shell_command': {
      const obj = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
      const command = typeof obj.cmd === 'string' ? obj.cmd : typeof obj.command === 'string' ? obj.command : undefined
      // Models without an `apply_patch` tool (e.g. gpt-5.6 in classic mode) instead run
      // `apply_patch <<'PATCH' … PATCH` as a shell command. That is a file write, not a
      // shell op — reclassify so it reaches the same file_write path as the native tool.
      const patchPathsFromShell = command ? shellApplyPatchPaths(command) : undefined
      if (patchPathsFromShell) return { action: 'file_write', target: { paths: patchPathsFromShell } }
      // The SKILL.md read = a skill being engaged; its later script runs stay 'shell'.
      // May occasionally catch a skill inspected/edited rather than used
      const skill = command ? SKILL_RE.exec(command)?.[1] : undefined
      if (skill) return { action: 'skill', name: skill, target: { command } }
      return { action: 'shell', target: { command } }
    }
    case 'apply_patch':
      // `input` is the raw patch text ("*** Begin Patch ... *** End Patch").
      return { action: 'file_write', target: { paths: patchPaths(typeof input === 'string' ? input : '') } }
    case 'spawn_agent':
      return { action: 'task_spawn', target: {} }
    case 'update_plan':
      return { action: 'todo', target: {} }
    case 'view_image':
      return { action: 'file_read', target: {} }
    case 'web__run':
      return { action: 'web', target: {} }
    default:
      return { action: 'other', target: {} }
  }
}

// `apply_patch` invoked as a shell command: at a command boundary (line start or after
// a `;`/`&&`/`||`/`|`/`(` separator), followed by a heredoc/redirect/quoted-arg opener.
// Anchoring on the boundary + opener avoids matching the literal phrase inside an echo or
// a comment. The patch body must still contain real `*** ... File:` headers to count.
const SHELL_APPLY_PATCH = /(?:^|[\n;&|(])\s*apply_patch\s*(?:<<-?\s*['"]?[A-Za-z_]|<|["'])/

/** Paths from an `apply_patch <<'PATCH' … PATCH` shell command, or undefined if it isn't one. */
function shellApplyPatchPaths(command: string): string[] | undefined {
  if (!SHELL_APPLY_PATCH.test(command) || !command.includes('*** Begin Patch')) return undefined
  return patchPaths(command)
}

/**
 * The `*** Begin Patch … *** End Patch` body embedded in an `apply_patch` shell command,
 * so downstream apply_patch consumers (file diffs, PR content-match) see the same raw
 * patch string the native tool would carry. Slices to end-of-string if the close marker
 * is missing (truncated capture). Returns undefined when there is no patch envelope.
 */
export function shellPatchBody(command: string): string | undefined {
  const start = command.indexOf('*** Begin Patch')
  if (start === -1 || !SHELL_APPLY_PATCH.test(command)) return undefined
  const endMarker = '*** End Patch'
  const endIdx = command.indexOf(endMarker, start)
  return endIdx === -1 ? command.slice(start) : command.slice(start, endIdx + endMarker.length)
}

/** Files touched by an apply_patch, from its `*** Add/Update/Delete File:` + `*** Move to:` headers. */
function patchPaths(patch: string): string[] | undefined {
  const paths: string[] = []
  for (const line of patch.split('\n')) {
    const m = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/.exec(line) ?? /^\*\*\* Move to: (.+)$/.exec(line)
    if (m && m[1]) paths.push(m[1].trim())
  }
  return paths.length ? paths : undefined
}
