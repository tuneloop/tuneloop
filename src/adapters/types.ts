import type { Session } from '../core/model'

/** Translates a vendor's transcripts into the normalized session model. */
export interface SourceAdapter {
  /** Stable adapter id, e.g. `claude-code`. */
  id: string
  /** LLM vendor family, e.g. `anthropic`. */
  provider: string
  /** Locations to scan when the user passes no directories. */
  defaultRoots(): string[]
  /** Find candidate session files under the given roots. */
  discover(roots: string[]): Promise<string[]>
  /** Parse one file into a Session; null if it isn't a session this adapter owns. */
  parse(path: string): Promise<Session | null>
}
