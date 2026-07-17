import type { Session } from '../core/model'
import type { EnvCategorySnapshot } from '../store/types'

/** Translates a vendor's transcripts into the normalized session model. */
export interface SourceAdapter {
  /** Stable adapter id, e.g. `claude-code`. */
  id: string
  /** LLM vendor family, e.g. `anthropic`. */
  provider: string
  /**
   * Version of THIS adapter's parse output. Bumped when the adapter extracts more
   * (or different) data from the same transcript bytes. Combined with the shared
   * `NORMALIZE_VERSION` into the stored `parse_version` (see analyze.ts), so a
   * per-vendor bump re-ingests only that vendor's sessions.
   */
  parseVersion: number
  /** Locations to scan when the user passes no directories. */
  defaultRoots(): string[]
  /** Find candidate session files under the given roots. */
  discover(roots: string[]): Promise<string[]>
  /** Parse one file into a Session (or multiple for branched transcripts); null if it isn't a session this adapter owns. */
  parse(path: string): Promise<Session | Session[] | null>
  /**
   * Store-backed alternative to discover/parse. Adapters whose sessions live in a
   * single database (not one file per session) implement this to yield sessions
   * directly; analyze.ts prefers it over the discover→parse file loop when present.
   */
  discoverSessions?(roots: string[]): Promise<Session[]>
  /**
   * Read this harness's config surface. Called once for the global scope
   * (`projectPath` undefined → read the harness home) and once per unique project
   * path (→ read that repo's project config). Returns one entry per category
   * present; the caller (analyze) stores each as an environment snapshot. The path
   * is always passed in — the adapter never explores for projects itself. Omitted
   * by adapters that don't yet read config (they contribute no snapshots).
   */
  readEnvironment?(projectPath?: string): Promise<EnvCategorySnapshot[]>
}
