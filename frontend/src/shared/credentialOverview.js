const LIMITED_STATUSES = new Set([
  'quota_exhausted',
  'quota_low_remaining',
  'rate_limited',
]);

const ERROR_STATUSES = new Set([
  'invalidated',
  'deactivated',
  'workspace_deactivated',
  'unauthorized',
  'expired_by_time',
  'error',
]);

export function summarizeCredentialOverview(credentials, probeStatuses = {}, operationErrors = {}) {
  const summary = {
    available: 0,
    error: 0,
    limited: 0,
    total: credentials.length,
  };

  for (const credential of credentials) {
    const status = probeStatuses[credential.name]?.status;
    if (LIMITED_STATUSES.has(status)) {
      summary.limited += 1;
    } else if (credential.disabled || Boolean(operationErrors[credential.name]) || ERROR_STATUSES.has(status)) {
      summary.error += 1;
    } else {
      summary.available += 1;
    }
  }

  return summary;
}
