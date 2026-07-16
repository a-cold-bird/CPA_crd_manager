import test from 'node:test';
import assert from 'node:assert/strict';

import { mapWithConcurrency } from './asyncConcurrency.js';

test('mapWithConcurrency preserves order and enforces the active limit', async () => {
  let active = 0;
  let maxActive = 0;
  const results = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (value) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    return value * 2;
  });

  assert.equal(maxActive, 2);
  assert.deepEqual(results, [
    { status: 'fulfilled', value: 2 },
    { status: 'fulfilled', value: 4 },
    { status: 'fulfilled', value: 6 },
    { status: 'fulfilled', value: 8 },
    { status: 'fulfilled', value: 10 },
  ]);
});

test('mapWithConcurrency records failures without stopping other work', async () => {
  const results = await mapWithConcurrency([1, 2, 3], 2, async (value) => {
    if (value === 2) throw new Error('failed');
    return value;
  });

  assert.equal(results[0].status, 'fulfilled');
  assert.equal(results[1].status, 'rejected');
  assert.equal(results[2].status, 'fulfilled');
});
