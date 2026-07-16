import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyProviderProbe,
  resolveRuntimeNextProbeAtMs,
  shouldAutoArchive,
  shouldAutoDisable,
} from './src/shared/providerRuntimeStrategies.js';

function codexResponse(rateLimit) {
  return {
    status_code: 200,
    body: {
      rate_limit: rateLimit,
    },
  };
}

test('deactivated Codex workspaces are disabled and archived', () => {
  const result = classifyProviderProbe('codex', {
    status_code: 402,
    body: {
      detail: {
        code: 'deactivated_workspace',
      },
    },
  });

  assert.equal(result.status, 'workspace_deactivated');
  assert.equal(shouldAutoDisable(result.status), true);
  assert.equal(shouldAutoArchive(result.status), true);
});

test('codex quota classification uses window duration instead of primary/secondary names', () => {
  const result = classifyProviderProbe('codex', codexResponse({
    allowed: false,
    limit_reached: true,
    primary_window: {
      used_percent: 100,
      limit_window_seconds: 18_000,
      reset_at: 2_000,
    },
    secondary_window: {
      used_percent: 73,
      limit_window_seconds: 604_800,
      reset_at: 9_000,
    },
  }));

  assert.equal(result.status, 'quota_exhausted');
  assert.equal(result.quota?.source, '5hour');
  assert.equal(result.quota?.usedPercent, 100);
  assert.equal(result.quota?.shortUsedPercent, 100);
  assert.equal(result.quota?.weeklyUsedPercent, 73);
  assert.equal(result.quota?.resetAt, 2_000);
});

test('codex quota classification honors global limit flags even with percentage data', () => {
  const result = classifyProviderProbe('codex', codexResponse({
    allowed: false,
    limit_reached: true,
    primary_window: {
      used_percent: 80,
      limit_window_seconds: 18_000,
      reset_at: 2_000,
    },
    secondary_window: {
      used_percent: 60,
      limit_window_seconds: 604_800,
      reset_at: 9_000,
    },
  }));

  assert.equal(result.status, 'quota_exhausted');
  assert.equal(result.quota?.source, 'rate_limit_flag');
  assert.equal(result.quota?.usedPercent, 100);
});

test('codex quota classification returns active after quota recovery', () => {
  const result = classifyProviderProbe('codex', codexResponse({
    allowed: true,
    limit_reached: false,
    primary_window: {
      used_percent: 20,
      limit_window_seconds: 18_000,
      reset_at: 2_000,
    },
    secondary_window: {
      used_percent: 30,
      limit_window_seconds: 604_800,
      reset_at: 9_000,
    },
  }));

  assert.equal(result.status, 'active');
  assert.equal(result.quota?.exhausted, false);
});

test('structured false flags and negated rate-limit text do not mark quota exhausted', () => {
  const result = classifyProviderProbe('codex', {
    status_code: 200,
    body: {
      status_message: {
        limit_reached: false,
        message: 'rate limit not reached',
      },
      rate_limit: {
        allowed: true,
        limit_reached: false,
        primary_window: {
          used_percent: 20,
          limit_window_seconds: 18_000,
        },
      },
    },
  });

  assert.equal(result.status, 'active');
  assert.equal(result.quota?.exhausted, false);
});

test('window duration remains authoritative when primary and secondary roles are reversed', () => {
  const result = classifyProviderProbe('codex', codexResponse({
    allowed: true,
    limit_reached: false,
    primary_window: {
      used_percent: 60,
      limit_window_seconds: 604_800,
      reset_at: 9_000,
    },
    secondary_window: {
      used_percent: 100,
      limit_window_seconds: 18_000,
      reset_at: 2_000,
    },
  }));

  assert.equal(result.status, 'quota_exhausted');
  assert.equal(result.quota?.source, '5hour');
  assert.equal(result.quota?.resetAt, 2_000);
});

test('per-window limit flags are authoritative even without a 100 percent value', () => {
  const result = classifyProviderProbe('codex', codexResponse({
    allowed: true,
    limit_reached: false,
    primary_window: {
      used_percent: 80,
      limit_reached: true,
      limit_window_seconds: 18_000,
      reset_at: 2_000,
    },
  }));

  assert.equal(result.status, 'quota_exhausted');
  assert.equal(result.quota?.source, '5hour_limit');
  assert.equal(result.quota?.resetAt, 2_000);
});

test('quota retry scheduling waits for reset and rate limits use a conservative delay', () => {
  const nowMs = 1_000_000;
  const quotaResetAt = Math.floor((nowMs + 120_000) / 1000);

  assert.equal(
    resolveRuntimeNextProbeAtMs('quota_exhausted', { resetAt: quotaResetAt }, 600_000, nowMs),
    quotaResetAt * 1000,
  );
  assert.equal(
    resolveRuntimeNextProbeAtMs('rate_limited', null, 600_000, nowMs),
    nowMs + 30 * 60_000,
  );
});
