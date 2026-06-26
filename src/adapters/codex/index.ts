import { homedir } from 'node:os'
import { join } from 'node:path'
import { registerAdapter } from '../../core/registry'
import { walkFiles } from '../../util/walk'
import type { SourceAdapter } from '../types'
import { parseCodex, PARSE_VERSION } from './parse'

export const codexAdapter: SourceAdapter = {
  id: 'codex',
  provider: 'openai',
  parseVersion: PARSE_VERSION,
  defaultRoots: () => [join(homedir(), '.codex', 'sessions')],
  discover: async (roots) => {
    const all: string[] = []
    for (const root of roots) all.push(...(await walkFiles(root, '.jsonl')))
    return all
  },
  parse: parseCodex,
}

registerAdapter(codexAdapter)
