import type { CanonicalAction } from '../../core/model'

export interface MappedAction {
  action: CanonicalAction
  target: { paths?: string[]; command?: string }
  /** Refined tool-call identity (the specific skill name for `action='skill'`). */
  name?: string
}

export function mapAction(name: string, args: unknown): MappedAction {
  const obj = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>
  if (name.startsWith('mcp__')) return { action: 'mcp_call', target: {} }
  switch (name) {
    case 'write':
    case 'edit':
      return { action: 'file_write', target: { paths: pathsFrom(obj) } }
    case 'read': {
      // Pi engages a skill IMPLICITLY by reading its SKILL.md — reclassify that read as
      // a skill invocation so it reaches capability usage (the explicit `/skill:` path is
      // handled in parse.ts from the injected message envelope).
      const path = typeof obj.path === 'string' ? obj.path : typeof obj.file_path === 'string' ? obj.file_path : ''
      const skill = skillFromReadPath(path)
      if (skill) return { action: 'skill', name: skill, target: {} }
      return { action: 'file_read', target: { paths: pathsFrom(obj) } }
    }
    case 'bash':
      return { action: 'shell', target: { command: typeof obj.command === 'string' ? obj.command : undefined } }
    case 'grep':
    case 'find':
    case 'ls':
      return { action: 'search', target: {} }
    default:
      return { action: 'other', target: {} }
  }
}

/**
 * The skill name if `path` is a skill file Pi loads to ENGAGE a skill (its implicit
 * path: the model `read`s the SKILL.md), else null. A `<…>/skills/<name>/SKILL.md` (dir
 * skill or package skill) → the SKILL.md's parent dir; a `<…>/.pi/skills/<name>.md` (Pi's
 * root-`.md` individual-skill form) → that file's basename. Requires a `skills/` segment
 * so ordinary file reads never match. Like Codex's heuristic, this may occasionally catch
 * a skill being inspected/edited rather than used — an accepted trade-off.
 */
export function skillFromReadPath(path: string): string | null {
  const p = path.split('\\').join('/')
  if (!/(?:^|\/)skills\//.test(p)) return null
  const dirSkill = /\/([^/]+)\/SKILL\.md$/.exec(p)
  if (dirSkill) return dirSkill[1]!
  const rootMd = /\/\.pi\/skills\/([^/]+)\.md$/.exec(p)
  if (rootMd) return rootMd[1]!
  return null
}

/**
 * The skill name from an explicit `/skill:name` invocation, or null. Pi injects the
 * skill body as a user message `<skill name="NAME" location="…">…</skill>`; the `name`
 * attribute is authoritative. Pi's counterpart to the CC/Codex explicit-invocation
 * envelopes — parse.ts synthesizes a skill tool call when this returns a name.
 */
export function explicitSkillName(text: string): string | null {
  const m = /^\s*<skill\s+name="([^"]+)"/.exec(text)
  return m ? m[1]! : null
}

function pathsFrom(obj: Record<string, unknown>): string[] | undefined {
  const p = obj.path ?? obj.file_path
  return typeof p === 'string' ? [p] : undefined
}
