import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { createSerializedJsonStore } from './serializedJsonStore.js';

function createTestStore(filePath) {
  return createSerializedJsonStore({
    filePath,
    createDefault: () => ({ count: 0, entries: {} }),
    normalize: (value) => ({
      count: Number(value?.count) || 0,
      entries: value?.entries && typeof value.entries === 'object' ? { ...value.entries } : {},
    }),
  });
}

test('serialized JSON mutations preserve concurrent independent updates', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cpa-runtime-store-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'state.json');
  const store = createTestStore(filePath);
  assert.equal(Object.hasOwn(store, 'writeAtomic'), false);

  await Promise.all(Array.from({ length: 20 }, (_, index) => store.mutate((state) => {
    state.count += 1;
    state.entries[`item-${index}`] = index;
  })));

  const state = store.read();
  assert.equal(state.count, 20);
  assert.equal(Object.keys(state.entries).length, 20);
  assert.equal(state.entries['item-19'], 19);
});

test('a malformed live state is never replaced by an empty fallback', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cpa-runtime-store-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'state.json');
  fs.writeFileSync(filePath, '{broken', 'utf8');
  const store = createTestStore(filePath);

  await assert.rejects(store.mutate((state) => {
    state.count += 1;
  }));
  assert.equal(fs.readFileSync(filePath, 'utf8'), '{broken');
});
