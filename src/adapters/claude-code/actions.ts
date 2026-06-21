import type { CanonicalAction } from '../../core/model'

/**
 * Map Claude Code tool names to canonical actions. This is the ONE place that
 * knows Claude Code's tool vocabulary — common extractors stay vendor-neutral.
 */
const FILE_WRITE = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])
const FILE_READ = new Set(['Read', 'NotebookRead'])
const SEARCH = new Set(['Glob', 'Grep'])
const WEB = new Set(['WebFetch', 'WebSearch'])
const SHELL = new Set(['Bash', 'BashOutput', 'KillShell', 'KillBash'])

export interface MappedAction {
  action: CanonicalAction
  target: { paths?: string[]; command?: string }
  /**
   * Optional refined identity for the tool-call `name`. Used for skills, whose
   * raw tool name is the generic `Skill` — we surface the specific skill (e.g.
   * `frontend-design:frontend-design`) so it's groupable/filterable, mirroring
   * how MCP keeps the specific tool in `name` under `action='mcp_call'`.
   */
  name?: string
}

export function mapAction(name: string, input: unknown): MappedAction {
  const obj = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  if (name.startsWith('mcp__')) return { action: 'mcp_call', target: {} }
  if (FILE_WRITE.has(name)) return { action: 'file_write', target: { paths: filePaths(obj) } }
  if (FILE_READ.has(name)) return { action: 'file_read', target: { paths: filePaths(obj) } }
  if (SHELL.has(name)) {
    return { action: 'shell', target: { command: typeof obj.command === 'string' ? obj.command : undefined } }
  }
  if (SEARCH.has(name)) return { action: 'search', target: {} }
  if (name === 'Task') return { action: 'task_spawn', target: {} }
  if (name === 'TodoWrite') return { action: 'todo', target: {} }
  if (name === 'Skill') {
    const skill = typeof obj.skill === 'string' ? obj.skill : undefined
    return { action: 'skill', target: {}, name: skill }
  }
  if (WEB.has(name)) return { action: 'web', target: {} }
  return { action: 'other', target: {} }
}

function filePaths(obj: Record<string, unknown>): string[] | undefined {
  const p = obj.file_path ?? obj.notebook_path ?? obj.path
  return typeof p === 'string' ? [p] : undefined
}
