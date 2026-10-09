/**
 * `fn` over `items`, at most `limit` in flight, results in input order. Bounds
 * what a walk over many repos or directories puts in flight at once — file
 * descriptors for the scan, git processes for reap.
 */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const queue = items.entries();
  const results: R[] = [];
  const worker = async (): Promise<void> => {
    // oxlint-disable-next-line no-await-in-loop -- sequential inside one worker is the point; the fan-out is the worker pool
    for (const [index, item] of queue) results[index] = await fn(item);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
