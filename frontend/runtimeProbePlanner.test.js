import test from 'node:test';
import assert from 'node:assert/strict';

import {
  canProbeCredentialInRuntime,
  hasRuntimeOwnershipForCredential,
  selectCredentialsForProbe,
  shouldAutoEnableRecoveredCredential,
} from './runtimeProbePlanner.js';

test('runtime probing skips manual disables but keeps identity-matched runtime disables eligible', () => {
  const manualDisabled = { name: 'manual.json', auth_index: 'manual-v1', disabled: true };
  const runtimeDisabled = { name: 'runtime.json', auth_index: 'runtime-v1', disabled: true };
  const replacement = { name: 'runtime.json', auth_index: 'runtime-v2', disabled: true };
  const enabled = { name: 'enabled.json', auth_index: 'enabled-v1', disabled: false };

  assert.equal(canProbeCredentialInRuntime(manualDisabled, { disabled_by_runtime: false }), false);
  assert.equal(canProbeCredentialInRuntime(runtimeDisabled, { auth_index: 'runtime-v1', disabled_by_runtime: true }), true);
  assert.equal(canProbeCredentialInRuntime(replacement, { auth_index: 'runtime-v1', disabled_by_runtime: true }), false);
  assert.equal(canProbeCredentialInRuntime(enabled, {}), true);
});

test('only a healthy runtime-disabled credential is eligible for automatic recovery', () => {
  const disabled = { name: 'quota.json', auth_index: 'quota-v1', disabled: true };
  const ownedRuntime = { auth_index: 'quota-v1', disabled_by_runtime: true };

  assert.equal(hasRuntimeOwnershipForCredential(disabled, ownedRuntime), true);
  assert.equal(shouldAutoEnableRecoveredCredential(disabled, ownedRuntime, 'active'), true);
  assert.equal(shouldAutoEnableRecoveredCredential(disabled, { disabled_by_runtime: false }, 'active'), false);
  assert.equal(shouldAutoEnableRecoveredCredential(disabled, { auth_index: 'quota-v2', disabled_by_runtime: true }, 'active'), false);
  assert.equal(shouldAutoEnableRecoveredCredential(disabled, ownedRuntime, 'quota_exhausted'), false);
  assert.equal(shouldAutoEnableRecoveredCredential({ ...disabled, disabled: false }, ownedRuntime, 'active'), false);
});

test('selectCredentialsForProbe picks due credentials first', () => {
  const credentials = [
    { name: 'b.json' },
    { name: 'a.json' },
    { name: 'c.json' },
  ];
  const result = selectCredentialsForProbe(credentials, {
    archivedNameSet: new Set(),
    bucketCredentials: {
      'a.json': { next_probe_at_ms: 10 },
      'b.json': { next_probe_at_ms: 999999 },
      'c.json': { next_probe_at_ms: 20 },
    },
    nowMs: 100,
    normalIntervalMs: 1000,
    cursorName: '',
    maxPerCycle: 2,
    resolveDueAtMs: (_credential, runtimeEntry) => runtimeEntry?.next_probe_at_ms ?? 0,
  });
  assert.deepEqual(result.selected.map((item) => item.name), ['a.json', 'c.json']);
  assert.equal(result.nextCursorName, 'c.json');
});

test('selectCredentialsForProbe does not select credentials before their due time', () => {
  const credentials = [
    { name: 'a.json' },
    { name: 'b.json' },
    { name: 'c.json' },
    { name: 'd.json' },
  ];
  const result = selectCredentialsForProbe(credentials, {
    archivedNameSet: new Set(),
    bucketCredentials: {
      'a.json': { next_probe_at_ms: 999999 },
      'b.json': { next_probe_at_ms: 999999 },
      'c.json': { next_probe_at_ms: 999999 },
      'd.json': { next_probe_at_ms: 999999 },
    },
    nowMs: 100,
    normalIntervalMs: 1000,
    cursorName: 'b.json',
    maxPerCycle: 2,
    resolveDueAtMs: (_credential, runtimeEntry) => runtimeEntry?.next_probe_at_ms ?? 0,
  });
  assert.deepEqual(result.selected, []);
  assert.equal(result.nextCursorName, 'b.json');
});
