import test from 'node:test';
import assert from 'node:assert/strict';

import { createKeyedAsyncRequestCache } from './asyncRequestCache.js';

test('concurrent loads for one key are coalesced and cloned', async () => {
  const cache = createKeyedAsyncRequestCache({
    ttlMs: 1000,
    clone: (value) => value.map((item) => ({ ...item })),
  });
  let loads = 0;
  const loader = async () => {
    loads += 1;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return [{ value: 1 }];
  };

  const [first, second] = await Promise.all([
    cache.get('cpa', loader),
    cache.get('cpa', loader),
  ]);
  first[0].value = 2;

  assert.equal(loads, 1);
  assert.equal(second[0].value, 1);
  assert.equal((await cache.get('cpa', loader))[0].value, 1);
});

test('invalidating a key forces the next load', async () => {
  let nowMs = 100;
  const cache = createKeyedAsyncRequestCache({ ttlMs: 1000, now: () => nowMs });
  let loads = 0;
  const loader = async () => ({ load: ++loads });

  assert.equal((await cache.get('cpa', loader)).load, 1);
  nowMs += 500;
  assert.equal((await cache.get('cpa', loader)).load, 1);
  cache.invalidate('cpa');
  assert.equal((await cache.get('cpa', loader)).load, 2);
});

test('an invalidated in-flight load cannot repopulate stale cache data', async () => {
  const cache = createKeyedAsyncRequestCache({ ttlMs: 1000 });
  let releaseFirst;
  const firstGate = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const first = cache.get('cpa', async () => {
    await firstGate;
    return 'stale';
  });

  await Promise.resolve();
  cache.invalidate('cpa');
  const fresh = cache.get('cpa', async () => 'fresh');
  releaseFirst();

  assert.equal(await first, 'stale');
  assert.equal(await fresh, 'fresh');
  assert.equal(await cache.get('cpa', async () => 'unexpected'), 'fresh');
});

test('invalidated readers share one queued refresh instead of overlapping loads', async () => {
  const cache = createKeyedAsyncRequestCache({ ttlMs: 1000 });
  let releaseFirst;
  let activeLoads = 0;
  let maxActiveLoads = 0;
  let loadCount = 0;
  const firstGate = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const loader = async () => {
    loadCount += 1;
    activeLoads += 1;
    maxActiveLoads = Math.max(maxActiveLoads, activeLoads);
    if (loadCount === 1) await firstGate;
    activeLoads -= 1;
    return loadCount;
  };

  const first = cache.get('cpa', loader);
  await Promise.resolve();
  cache.invalidate('cpa');
  const readers = [cache.get('cpa', loader), cache.get('cpa', loader), cache.get('cpa', loader)];
  releaseFirst();

  assert.equal(await first, 1);
  assert.deepEqual(await Promise.all(readers), [2, 2, 2]);
  assert.equal(loadCount, 2);
  assert.equal(maxActiveLoads, 1);
});

test('a second invalidation queues another refresh behind the active generation', async () => {
  const cache = createKeyedAsyncRequestCache({ ttlMs: 1000 });
  let releaseFirst;
  let releaseSecond;
  let markSecondStarted;
  let loadCount = 0;
  const firstGate = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const secondGate = new Promise((resolve) => {
    releaseSecond = resolve;
  });
  const secondStarted = new Promise((resolve) => {
    markSecondStarted = resolve;
  });
  const loader = async () => {
    loadCount += 1;
    if (loadCount === 1) await firstGate;
    if (loadCount === 2) {
      markSecondStarted();
      await secondGate;
    }
    return loadCount;
  };

  const first = cache.get('cpa', loader);
  await Promise.resolve();
  cache.invalidate('cpa');
  const firstRefresh = cache.get('cpa', loader);
  releaseFirst();
  await secondStarted;
  cache.invalidate('cpa');
  const secondRefresh = cache.get('cpa', loader);
  releaseSecond();

  assert.equal(await first, 1);
  assert.equal(await firstRefresh, 2);
  assert.equal(await secondRefresh, 3);
  assert.equal(loadCount, 3);
});
