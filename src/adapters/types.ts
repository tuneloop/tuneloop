import type { Session } from '../core/model'

/** Translates a vendor's transcripts into the normalized session model. */
export interface SourceAdapter {
  /** Stable adapter id, e.g. `claude-code`. */
  id: string
  /** LLM vendor family, e.g. `anthropic`. */
  provider: string
  /**
   * Bump when ingest-time derivation changes so stored sessions are rebuilt on the
   * same source bytes (see analyze.ts's re-ingest gate). Keyed per-adapter so each
   * source owns its own cache invalidation.
   */
  parseVersion: number
  /** Locations to scan when the user passes no directories. */
  defaultRoots(): string[]
  /** Find candidate session files under the given roots. */
  discover(roots: string[]): Promise<string[]>
  /** Parse one file into a Session; null if it isn't a session this adapter owns. */
  parse(path: string): Promise<Session | null>
  /**
   * Store-backed alternative to discover/parse. Adapters whose sessions live in a
   * single database (not one file per session) implement this to yield sessions
   * directly; analyze.ts prefers it over the discover→parse file loop when present.
   */
  discoverSessions?(roots: string[]): Promise<Session[]>
}
