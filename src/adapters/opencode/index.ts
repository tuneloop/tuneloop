import { homedir } from 'node:os'
import { join } from 'node:path'
import { registerAdapter } from '../../core/registry'
import type { Session } from '../../core/model'
import type { SourceAdapter } from '../types'
import { dbPathFor, openOpencodeDb } from './db'
import { buildSessions, PARSE_VERSION, SOURCE } from './parse'

/**
 * OpenCode adapter. OpenCode keeps every session in a single `opencode.db`
 * (SQLite, since v1.2.0), so this is a store-backed adapter: it implements
 * `discoverSessions` rather than the file-oriented discover/parse pair. A root
 * without an `opencode.db` is simply skipped (the user just doesn't use OpenCode).
 */
export const opencodeAdapter: SourceAdapter = {
  id: SOURCE,
  provider: SOURCE,
  parseVersion: PARSE_VERSION,
  defaultRoots: () => [join(homedir(), '.local', 'share', 'opencode')],
  // Unused for store-backed adapters, but required by the interface.
  discover: async () => [],
  parse: async () => null,
  discoverSessions: async (roots) => {
    const out: Session[] = []
    for (const root of roots) {
      const path = dbPathFor(root)
      if (!path) continue
      const db = openOpencodeDb(path)
      try {
        out.push(...buildSessions(db, path))
      } finally {
        db.close()
      }
    }
    return out
  },
}

registerAdapter(opencodeAdapter)
