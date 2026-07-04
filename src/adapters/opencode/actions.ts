import type { CanonicalAction } from '../../core/model'

/**
 * Map OpenCode tool names to canonical actions. This is the ONE place that knows
 * OpenCode's tool vocabulary — common extractors stay vendor-neutral. OpenCode
 * tool names are lowercase (`bash`, `read`, `edit`, …); MCP tools are namespaced
 * `<server>_<tool>` but we can't reliably distinguish those from built-ins by
 * name, so only the known built-ins are mapped and the rest fall through.
 */
// OpenCode's registered file-mutating tool ids: `write` ({filePath,content}),
// `edit` ({filePath,oldString,newString}), and `apply_patch` ({patchText} in the
// Codex `*** Begin Patch` format). `apply_patch` is mutually exclusive with edit/write
// and only enabled for gpt-5-class models (registry `usePatch` gate); a MultiEditTool
// exists in the source but is registered nowhere, so `multiedit` is intentionally omitted.
const FILE_WRITE = new Set(['write', 'edit', 'apply_patch'])
const FILE_READ = new Set(['read'])
const SEARCH = new Set(['grep', 'glob', 'list'])
const WEB = new Set(['webfetch', 'websearch'])
const SHELL = new Set(['bash'])
const TODO = new Set(['todowrite', 'todoread'])

export interface MappedAction {
  action: CanonicalAction
  target: { paths?: string[]; command?: string }
  /** Refined identity for the tool-call `name` (e.g. the specific skill). */
  name?: string
}

export function mapAction(name: string, input: unknown): MappedAction {
  const obj = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  const tool = name.toLowerCase()
  if (FILE_WRITE.has(tool)) return { action: 'file_write', target: { paths: filePaths(obj) } }
  if (FILE_READ.has(tool)) return { action: 'file_read', target: { paths: filePaths(obj) } }
  if (SHELL.has(tool)) {
    return { action: 'shell', target: { command: typeof obj.command === 'string' ? obj.command : undefined } }
  }
  if (SEARCH.has(tool)) return { action: 'search', target: {} }
  if (tool === 'task') return { action: 'task_spawn', target: {} }
  if (TODO.has(tool)) return { action: 'todo', target: {} }
  if (tool === 'skill') {
    const skill = typeof obj.name === 'string' ? obj.name : typeof obj.skill === 'string' ? obj.skill : undefined
    return { action: 'skill', target: {}, name: skill }
  }
  if (WEB.has(tool)) return { action: 'web', target: {} }
  return { action: 'other', target: {} }
}

function filePaths(obj: Record<string, unknown>): string[] | undefined {
  const p = obj.filePath ?? obj.file_path ?? obj.path
  return typeof p === 'string' ? [p] : undefined
}
