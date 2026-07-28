/**
 * Run an async `worker` over `items` with at most `concurrency` in flight.
 *
 * A fixed set of workers each pull the next index until the list is exhausted, so
 * peak concurrency never exceeds `concurrency` (or the item count, whichever is
 * smaller). Fail-fast: on the first worker error the pool stops scheduling new
 * items, waits for the in-flight ones to settle, then rethrows that error.
 */
export async function runPool<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return
  const limit = Math.max(1, Math.min(concurrency, items.length))
  let next = 0
  let firstError: unknown
  const runWorker = async (): Promise<void> => {
    // Pull the next index until exhausted (or an error is latched). `next++` is a
    // single synchronous op, so no two workers can claim the same index.
    while (next < items.length && firstError === undefined) {
      const i = next++
      try {
        await worker(items[i]!, i)
      } catch (err) {
        if (firstError === undefined) firstError = err
      }
    }
  }
  await Promise.all(Array.from({ length: limit }, () => runWorker()))
  if (firstError !== undefined) throw firstError
}
