import type { CanonicalAction } from '../../core/model'

export interface MappedAction {
  action: CanonicalAction
  target: { paths?: string[]; command?: string }
  name?: string
}

export function mapAction(name: string, args: unknown): MappedAction {
  const obj = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>
  if (name.startsWith('mcp__')) return { action: 'mcp_call', target: {} }
  switch (name) {
    case 'write':
    case 'edit':
      return { action: 'file_write', target: { paths: pathsFrom(obj) } }
    case 'read':
      return { action: 'file_read', target: { paths: pathsFrom(obj) } }
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

function pathsFrom(obj: Record<string, unknown>): string[] | undefined {
  const p = obj.path ?? obj.file_path
  return typeof p === 'string' ? [p] : undefined
}
