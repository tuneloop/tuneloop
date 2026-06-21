import { createHash } from 'node:crypto'

/** Content hash of a session's raw transcript — the cache key input. */
export function contentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 32)
}
