import test from 'node:test';
import assert from 'node:assert/strict';

import { summarizeCredentialOverview } from './src/shared/credentialOverview.js';

function credential(name, disabled = false) {
  return { name, disabled };
}

test('credential overview partitions every credential exactly once', () => {
  const credentials = [
    credential('active'),
    credential('unknown'),
    credential('manual-disabled', true),
    credential('fatal'),
    credential('operation-error'),
    credential('quota-disabled', true),
    credential('quota-low'),
    credential('rate-limited'),
  ];
  const probeStatuses = {
    active: { status: 'active' },
    unknown: { status: 'unknown' },
    fatal: { status: 'unauthorized' },
    'quota-disabled': { status: 'quota_exhausted' },
    'quota-low': { status: 'quota_low_remaining' },
    'rate-limited': { status: 'rate_limited' },
  };
  const summary = summarizeCredentialOverview(credentials, probeStatuses, {
    'operation-error': 'transition failed',
  });

  assert.deepEqual(summary, {
    available: 2,
    error: 3,
    limited: 3,
    total: 8,
  });
  assert.equal(summary.available + summary.error + summary.limited, summary.total);
});

test('limited status takes precedence over disabled and operation errors', () => {
  const summary = summarizeCredentialOverview(
    [credential('limited', true)],
    { limited: { status: 'rate_limited' } },
    { limited: 'operation failed' },
  );

  assert.deepEqual(summary, {
    available: 0,
    error: 0,
    limited: 1,
    total: 1,
  });
});
