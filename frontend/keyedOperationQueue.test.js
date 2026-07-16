import test from 'node:test';
import assert from 'node:assert/strict';

import { createKeyedInFlightDeduper, createKeyedOperationQueue } from './keyedOperationQueue.js';

test('same-key operations are serialized while different keys can proceed', async () => {
  const run = createKeyedOperationQueue();
  const calls = [];
  let releaseFirst;
  const firstGate = new Promise((resolve) => {
    releaseFirst = resolve;
  });

  const first = run('same', async () => {
    calls.push('first:start');
    await firstGate;
    calls.push('first:end');
  });
  const second = run('same', async () => {
    calls.push('second');
  });
  const parallel = run('other', async () => {
    calls.push('parallel');
  });

  await parallel;
  assert.deepEqual(calls, ['first:start', 'parallel']);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(calls, ['first:start', 'parallel', 'first:end', 'second']);
});

test('a rejected operation does not poison the key or create a rejected tail', async () => {
  const run = createKeyedOperationQueue();
  await assert.rejects(run('credential', async () => {
    throw new Error('failed');
  }), /failed/);

  const result = await run('credential', async () => 'recovered');
  assert.equal(result, 'recovered');
});

test('same-key in-flight work is shared but completed work is not cached', async () => {
  const run = createKeyedInFlightDeduper();
  let calls = 0;
  const operation = async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return calls;
  };

  const [first, second] = await Promise.all([
    run('probe', operation),
    run('probe', operation),
  ]);
  const third = await run('probe', operation);

  assert.equal(first, 1);
  assert.equal(second, 1);
  assert.equal(third, 2);
});
