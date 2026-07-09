import { homedir } from 'node:os'
import { join } from 'node:path'
import { registerAdapter } from '../../core/registry'
import { walkFiles } from '../../util/walk'
import type { SourceAdapter } from '../types'
import { parsePi, PARSE_VERSION } from './parse'

export const piAdapter: SourceAdapter = {
  id: 'pi',
  provider: 'multi',
  parseVersion: PARSE_VERSION,
  defaultRoots: () => [join(homedir(), '.pi', 'agent', 'sessions')],
  discover: async (roots) => {
    const all: string[] = []
    for (const root of roots) all.push(...(await walkFiles(root, '.jsonl')))
    return all
  },
  parse: parsePi,
}

registerAdapter(piAdapter)
