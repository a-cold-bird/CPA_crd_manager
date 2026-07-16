export async function mapWithConcurrency(items, concurrency, worker) {
  const source = Array.isArray(items) ? items : [];
  const results = new Array(source.length);
  const limit = Math.max(1, Math.min(source.length || 1, Math.floor(Number(concurrency)) || 1));
  let cursor = 0;

  const run = async () => {
    while (cursor < source.length) {
      const index = cursor;
      cursor += 1;
      try {
        results[index] = { status: 'fulfilled', value: await worker(source[index], index) };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  };

  await Promise.all(Array.from({ length: limit }, () => run()));
  return results;
}
