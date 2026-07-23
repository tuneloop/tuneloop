/**
 * Run an async mapper over `items` with at most `concurrency` in flight at once,
 * preserving input order in the result. Used to bound the LLM calls a P/X-tier
 * detector fires across its session delta — one call per session would otherwise
 * open as many sockets as there are sessions.
 *
 * The mapper's rejections propagate (the returned promise rejects on the first
 * error), matching Promise.all semantics; callers that want per-item tolerance
 * should catch inside the mapper.
 */
export async function mapPool<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const limit = Math.max(1, Math.floor(concurrency))
  const results = new Array<R>(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (true) {
      const i = next++
      if (i >= items.length) return
      results[i] = await mapper(items[i]!, i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}
