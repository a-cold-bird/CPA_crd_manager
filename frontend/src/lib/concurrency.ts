export async function batchWithLimit<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
  limit: number = 5,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = [];
  const queue = [...items];

  async function worker() {
    while (queue.length) {
      const item = queue.shift()!;
      try {
        const value = await fn(item);
        results.push({ status: "fulfilled", value });
      } catch (error) {
        results.push({ status: "rejected", reason: error });
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}
