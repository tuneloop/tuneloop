import type { CanonicalAction } from '../../core/model'

/**
 * Map Codex tool names to canonical actions. This is the ONE place that knows
 * Codex's tool vocabulary — common extractors stay vendor-neutral.
 *
 * Codex has no `Read`/`Skill`/MCP tools: files are read via the shell (`sed`/`cat`)
 * and skills are `SKILL.md` + scripts run through the shell, so neither surfaces as
 * a distinct tool
 * Anything unmapped falls through to `other`.
 */
export interface MappedAction {
  action: CanonicalAction
  target: { paths?: string[]; command?: string }
}

export function mapAction(name: string, input: unknown): MappedAction {
  switch (name) {
    case 'exec_command':
    case 'shell_command': {
      const obj = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
      const command = typeof obj.cmd === 'string' ? obj.cmd : typeof obj.command === 'string' ? obj.command : undefined
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
    default:
      return { action: 'other', target: {} }
  }
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
