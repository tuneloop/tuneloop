import type { CanonicalAction } from '../../core/model'

/**
 * Map Codex tool names to canonical actions. This is the ONE place that knows
 * Codex's tool vocabulary — common extractors stay vendor-neutral.
 *
 * Codex has no `Read`/MCP tools (files are read via the shell). Skills are also
 * shell-based — `SKILL.md` + scripts — but a skill is loaded by reading its
 * `SKILL.md`, which we recognize and reclassify to `action='skill'` so Codex skills
 * join Claude's in one facet. Anything unmapped falls through to `other`.
 */
export interface MappedAction {
  action: CanonicalAction
  target: { paths?: string[]; command?: string }
  /** Refined identity for `action='skill'` (the specific skill name) */
  name?: string
}

// A skill is engaged by reading `<agent-home>/skills/[.system/]<name>/SKILL.md`. The
// home is NOT fixed — `.codex` (default), `.agents` (shared), or a relocated CODEX_HOME
// — so anchor on a dot-prefixed home dir: matches any `.X/skills/`, excludes ordinary
// project `skills/` dirs. A non-dot relocated home is the documented residual.
const SKILL_RE = /\/\.[\w-]+\/skills\/(?:\.system\/)?([\w-]+)\/SKILL\.md\b/

export function mapAction(name: string, input: unknown): MappedAction {
  switch (name) {
    case 'exec_command':
    case 'shell_command': {
      const obj = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
      const command = typeof obj.cmd === 'string' ? obj.cmd : typeof obj.command === 'string' ? obj.command : undefined
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
