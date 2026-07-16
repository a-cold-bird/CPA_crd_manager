import test from 'node:test';
import assert from 'node:assert/strict';

import {
  canCommitRuntimeArchive,
  CredentialStatusTransitionError,
  evaluateCredentialStatusTransitionPrecondition,
  executeCredentialStatusTransaction,
  isSameCredentialIdentity,
} from './credentialStatusTransaction.js';

test('runtime archive commits require ownership and an exact probe version', () => {
  const state = {
    disabled_by_runtime: true,
    archived_by_runtime: true,
    last_probe_at: 100,
  };
  assert.equal(canCommitRuntimeArchive(state, 100), true);
  assert.equal(canCommitRuntimeArchive(state, 99), false);
  assert.equal(canCommitRuntimeArchive({ ...state, disabled_by_runtime: false }, 100), false);
  assert.equal(canCommitRuntimeArchive({ ...state, archived_by_runtime: false }, 100), false);
});

test('credential identity fences delayed writes from same-name replacements', () => {
  assert.equal(isSameCredentialIdentity('auth-old', 'auth-old'), true);
  assert.equal(isSameCredentialIdentity('auth-new', 'auth-old'), false);
  assert.equal(isSameCredentialIdentity('', 'auth-old'), false);

  const staleRuntimeState = {
    auth_index: 'auth-old',
    disabled_by_runtime: true,
    last_probe_at: 100,
  };
  const identityBoundRuntimeState = isSameCredentialIdentity(staleRuntimeState.auth_index, 'auth-new')
    ? staleRuntimeState
    : null;
  assert.deepEqual(evaluateCredentialStatusTransitionPrecondition({
    previousDisabled: true,
    previousRuntimeState: identityBoundRuntimeState,
    expectedProbeAtMs: 100,
    claimRuntimeOwnership: true,
  }), { skipped: true, reason: 'credential_manually_disabled' });
});

test('newer probes and manual disables reject stale automatic transitions', () => {
  assert.deepEqual(evaluateCredentialStatusTransitionPrecondition({
    previousDisabled: false,
    previousRuntimeState: { last_probe_at: 200, disabled_by_runtime: false },
    expectedProbeAtMs: 100,
    claimRuntimeOwnership: true,
  }), { skipped: true, reason: 'newer_probe_exists' });

  assert.deepEqual(evaluateCredentialStatusTransitionPrecondition({
    previousDisabled: true,
    previousRuntimeState: { last_probe_at: 100, disabled_by_runtime: false },
    expectedProbeAtMs: 100,
    claimRuntimeOwnership: true,
  }), { skipped: true, reason: 'credential_manually_disabled' });

  assert.deepEqual(evaluateCredentialStatusTransitionPrecondition({
    previousDisabled: true,
    previousRuntimeState: { last_probe_at: 100, disabled_by_runtime: false },
    expectedProbeAtMs: 100,
    requireRuntimeOwnership: true,
  }), { skipped: true, reason: 'runtime_ownership_missing' });

  assert.deepEqual(evaluateCredentialStatusTransitionPrecondition({
    previousDisabled: true,
    previousRuntimeState: { last_probe_at: 200, disabled_by_runtime: true },
    expectedProbeAtMs: null,
  }), { skipped: false, reason: '' });

  assert.deepEqual(evaluateCredentialStatusTransitionPrecondition({
    previousDisabled: false,
    previousRuntimeState: { last_probe_at: 100, disabled_by_runtime: false },
    expectedProbeAtMs: 200,
    claimRuntimeOwnership: true,
    requireExactProbeVersion: true,
  }), { skipped: true, reason: 'probe_version_mismatch' });
});

test('automatic disable commits runtime ownership before CPA status', async () => {
  const calls = [];
  const result = await executeCredentialStatusTransaction({
    previousDisabled: false,
    targetDisabled: true,
    previousRuntimeState: { disabled_by_runtime: false },
    runtimeStatePatch: { disabled_by_runtime: true },
    applyRuntimeState: async (patch) => {
      calls.push('runtime:disable');
      return patch;
    },
    applyCredentialStatus: async () => {
      calls.push('cpa:disable');
    },
    restoreRuntimeState: async () => {
      calls.push('runtime:restore');
    },
  });

  assert.deepEqual(calls, ['runtime:disable', 'cpa:disable']);
  assert.equal(result.disabled, true);
  assert.equal(result.state.disabled_by_runtime, true);
});

test('failed CPA disable restores runtime ownership', async () => {
  const calls = [];
  await assert.rejects(
    executeCredentialStatusTransaction({
      previousDisabled: false,
      targetDisabled: true,
      previousRuntimeState: { disabled_by_runtime: false },
      runtimeStatePatch: { disabled_by_runtime: true },
      applyRuntimeState: async () => {
        calls.push('runtime:disable');
        return { disabled_by_runtime: true };
      },
      applyCredentialStatus: async () => {
        calls.push('cpa:disable');
        throw new Error('CPA failed');
      },
      restoreRuntimeState: async () => {
        calls.push('runtime:restore');
      },
    }),
    (error) => error instanceof CredentialStatusTransitionError && error.transition.rolled_back === true,
  );
  assert.deepEqual(calls, ['runtime:disable', 'cpa:disable', 'runtime:restore']);
});

test('failed ownership clear after recovery rolls CPA status back', async () => {
  const calls = [];
  await assert.rejects(
    executeCredentialStatusTransaction({
      previousDisabled: true,
      targetDisabled: false,
      previousRuntimeState: { disabled_by_runtime: true },
      runtimeStatePatch: { disabled_by_runtime: false },
      applyCredentialStatus: async (disabled) => {
        calls.push(disabled ? 'cpa:disable' : 'cpa:enable');
      },
      applyRuntimeState: async () => {
        calls.push('runtime:clear');
        throw new Error('runtime failed');
      },
      restoreRuntimeState: async () => {
        calls.push('runtime:restore');
      },
    }),
    (error) => error instanceof CredentialStatusTransitionError && error.transition.rolled_back === true,
  );
  assert.deepEqual(calls, ['cpa:enable', 'runtime:clear', 'cpa:disable']);
});

test('a timed-out CPA update succeeds when reconciliation observes the target status', async () => {
  const calls = [];
  const result = await executeCredentialStatusTransaction({
    previousDisabled: false,
    targetDisabled: true,
    previousRuntimeState: { disabled_by_runtime: false },
    runtimeStatePatch: { disabled_by_runtime: true },
    applyRuntimeState: async (patch) => {
      calls.push('runtime:disable');
      return patch;
    },
    applyCredentialStatus: async () => {
      calls.push('cpa:disable');
      throw new Error('timeout');
    },
    readCredentialDisabled: async () => {
      calls.push('cpa:read');
      return true;
    },
    restoreRuntimeState: async () => {
      calls.push('runtime:restore');
    },
  });

  assert.deepEqual(calls, ['runtime:disable', 'cpa:disable', 'cpa:read']);
  assert.equal(result.disabled, true);
  assert.equal(result.state.disabled_by_runtime, true);
});

test('an unreconciled CPA failure retains runtime ownership and reports inconsistency', async () => {
  const calls = [];
  await assert.rejects(
    executeCredentialStatusTransaction({
      previousDisabled: false,
      targetDisabled: true,
      previousRuntimeState: { disabled_by_runtime: false },
      runtimeStatePatch: { disabled_by_runtime: true },
      applyRuntimeState: async () => {
        calls.push('runtime:disable');
        return { disabled_by_runtime: true };
      },
      applyCredentialStatus: async () => {
        calls.push('cpa:disable');
        throw new Error('timeout');
      },
      readCredentialDisabled: async () => {
        calls.push('cpa:read');
        throw new Error('CPA unavailable');
      },
      restoreRuntimeState: async () => {
        calls.push('runtime:restore');
      },
    }),
    (error) => error instanceof CredentialStatusTransitionError
      && error.transition.inconsistent === true
      && error.transition.rolled_back === false,
  );
  assert.deepEqual(calls, ['runtime:disable', 'cpa:disable', 'cpa:read']);
});
