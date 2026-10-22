/**
 * Bounded-concurrency helpers for fan-outs over independent work.
 */

/**
 * Run `fn` over `items` with at most `limit` concurrent invocations.
 *
 * Results come back in input order, so a caller whose items are independent
 * still emits a deterministic sequence regardless of which finishes first.
 * `limit` below 1 is treated as 1; a limit above the item count simply runs
 * every item at once.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  // Workers pull the next index as they finish, so a slow item never stalls
  // the others and no item is started twice.
  const cap = Math.max(1, Math.min(Math.floor(limit), items.length));
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: cap }, worker));
  return results;
}
