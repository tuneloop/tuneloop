import { homedir } from 'node:os'
import { join } from 'node:path'
import { registerAdapter } from '../../core/registry'
import { walkFiles } from '../../util/walk'
import type { SourceAdapter } from '../types'
import { parseClaudeCode, PARSE_VERSION } from './parse'

export const claudeCodeAdapter: SourceAdapter = {
  id: 'claude-code',
  provider: 'anthropic',
  parseVersion: PARSE_VERSION,
  defaultRoots: () => [join(homedir(), '.claude', 'projects')],
  discover: async (roots) => {
    const all: string[] = []
    for (const root of roots) all.push(...(await walkFiles(root, '.jsonl')))
    return all
  },
  parse: parseClaudeCode,
}

registerAdapter(claudeCodeAdapter)
