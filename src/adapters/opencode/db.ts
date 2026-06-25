import { existsSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'

/**
 * Read-only access to OpenCode's SQLite store. Since v1.2.0 (~Feb 2026) OpenCode
 * keeps all sessions in one `opencode.db` under its data dir (default
 * `~/.local/share/opencode`), not one file per session — so the adapter reads
 * sessions out of the DB rather than walking files. We open the DB read-only and
 * query-only so we never contend with OpenCode's live connection / WAL.
 */

export const DB_FILENAME = 'opencode.db'

/** A row from the `session` table, with the workspace branch joined in. */
export interface OcSession {
  id: string
  parent_id: string | null
  directory: string
  title: string
  agent: string | null
  model: string | null
  version: string
  cost: number
  tokens_input: number
  tokens_output: number
  tokens_reasoning: number
  tokens_cache_read: number
  tokens_cache_write: number
  time_created: number
  time_updated: number
  branch: string | null
}

/** A row from the `message` table; `data` is a JSON blob (role, tokens, model, …). */
export interface OcMessage {
  id: string
  session_id: string
  time_created: number
  data: string
}

/** A row from the `part` table; `data` is a JSON blob (type, tool, state, …). */
export interface OcPart {
  id: string
  message_id: string
  session_id: string
  time_created: number
  data: string
}

export type OcDb = Database.Database

/** Resolve the `opencode.db` path under a data-dir root, or null if absent. */
export function dbPathFor(root: string): string | null {
  const p = join(root, DB_FILENAME)
  return existsSync(p) ? p : null
}

/** Open an OpenCode DB read-only. Caller closes it. */
export function openOpencodeDb(path: string): OcDb {
  const db = new Database(path, { readonly: true, fileMustExist: true })
  db.pragma('query_only = true')
  return db
}

/** All sessions, with `branch` joined from the owning workspace. */
export function allSessions(db: OcDb): OcSession[] {
  return db
    .prepare(
      `SELECT s.id, s.parent_id, s.directory, s.title, s.agent, s.model, s.version,
              s.cost, s.tokens_input, s.tokens_output, s.tokens_reasoning,
              s.tokens_cache_read, s.tokens_cache_write, s.time_created, s.time_updated,
              w.branch AS branch
         FROM session s
         LEFT JOIN workspace w ON w.id = s.workspace_id
        ORDER BY s.time_created ASC`,
    )
    .all() as OcSession[]
}

/** Messages for a session, oldest first. */
export function messagesFor(db: OcDb, sessionId: string): OcMessage[] {
  return db
    .prepare(
      `SELECT id, session_id, time_created, data FROM message
        WHERE session_id = ? ORDER BY time_created ASC, id ASC`,
    )
    .all(sessionId) as OcMessage[]
}

/** Parts for a session, oldest first (grouped by message by the caller). */
export function partsFor(db: OcDb, sessionId: string): OcPart[] {
  return db
    .prepare(
      `SELECT id, message_id, session_id, time_created, data FROM part
        WHERE session_id = ? ORDER BY time_created ASC, id ASC`,
    )
    .all(sessionId) as OcPart[]
}
