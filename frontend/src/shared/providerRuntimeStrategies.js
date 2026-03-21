const CODEX_ACTIVE_CODES = new Set([200, 201, 400, 402, 403, 404, 409, 422]);
const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);
const QUOTA_LIMIT_KEYWORDS = ['usage_limit_reached', 'insufficient_quota', 'quota_exceeded', 'limit_reached', 'rate limit'];

function toText(value) {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function toStatusCode(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
}

function normalizeProbeText(response) {
  return [toText(response?.body), toText(response?.error)].join(' ');
}

function asRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value;
}

function parseJsonRecord(value) {
  const obj = asRecord(value);
  if (obj) return obj;
  if (typeof value !== 'string') return null;
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return null;
  }
}

function pickFirstVal(record, ...keys) {
  if (!record) return undefined;
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null) {
      return record[key];
    }
  }
  return undefined;
}

function toNumber(value) {
  if (value === null || value === undefined) return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function toPercent(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const text = String(value).trim().replace(/%$/, '');
  if (!text) return null;
  const num = Number(text);
  return Number.isFinite(num) ? num : null;
}

function toBoolean(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const lower = value.trim().toLowerCase();
    if (lower === 'true') return true;
    if (lower === 'false') return false;
  }
  return null;
}

function toUnixSeconds(value) {
  const num = toNumber(value);
  if (num !== null) {
    if (num > 1_000_000_000_000) return Math.floor(num / 1000);
    if (num > 0) return Math.floor(num);
    return null;
  }
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text) return null;
  const millis = Date.parse(text);
  if (Number.isFinite(millis)) {
    return Math.floor(millis / 1000);
  }
  return null;
}

function hasLimitKeyword(text) {
  const lower = text.toLowerCase();
  return QUOTA_LIMIT_KEYWORDS.some((keyword) => lower.includes(keyword));
}

function parseQuotaWindow(name, value) {
  const record = asRecord(value);
  if (!record) return null;
  return {
    name,
    usedPercent: toPercent(pickFirstVal(record, 'used_percent', 'usedPercent', 'used_percentage')),
    resetAt: toUnixSeconds(pickFirstVal(record, 'reset_at', 'resetAt', 'resets_at', 'resetsAt')),
    limitWindowSeconds: toNumber(pickFirstVal(record, 'limit_window_seconds', 'limitWindowSeconds', 'window_seconds', 'windowSeconds')),
    remaining: toNumber(record.remaining),
    limitReached: toBoolean(pickFirstVal(record, 'limit_reached', 'limitReached')),
  };
}

function chooseCodexQuotaWindows(rateLimit) {
  const keys = ['primary_window', 'secondary_window', 'individual_window', 'primaryWindow', 'secondaryWindow', 'individualWindow'];
  const windows = keys
    .map((key) => parseQuotaWindow(key, rateLimit[key]))
    .filter(Boolean);

  let weekly = windows.find((window) => window.name.toLowerCase().includes('individual')) || null;
  let short = windows.find((window) => window.name.toLowerCase().includes('secondary')) || null;

  const withSeconds = windows.filter((window) => typeof window.limitWindowSeconds === 'number');
  if (!weekly && withSeconds.length) {
    weekly = [...withSeconds].sort((a, b) => (b.limitWindowSeconds || 0) - (a.limitWindowSeconds || 0))[0] || null;
  }
  if (!short && withSeconds.length) {
    const sorted = [...withSeconds].sort((a, b) => (a.limitWindowSeconds || 0) - (b.limitWindowSeconds || 0));
    short = sorted.find((window) => !weekly || window.name !== weekly.name) || sorted[0] || null;
  }
  if (!weekly && windows.length) weekly = windows[0];
  if (!short && windows.length > 1) {
    short = windows.find((window) => !weekly || window.name !== weekly.name) || null;
  }

  if (!short && weekly && typeof weekly.limitWindowSeconds === 'number' && weekly.limitWindowSeconds <= 6 * 3600) {
    short = weekly;
    weekly = null;
  }

  return { weekly, short, windows };
}

function getQuotaWindowDisplayLabel(window, fallbackIndex) {
  const seconds = window.limitWindowSeconds || 0;
  if (seconds >= 6 * 24 * 3600) return 'Weekly';
  if (seconds > 0 && seconds <= 6 * 3600) return '5h';
  if (window.name.toLowerCase().includes('individual')) return 'Weekly';
  if (window.name.toLowerCase().includes('secondary')) return '5h';
  if (window.name.toLowerCase().includes('primary')) return fallbackIndex === 0 ? 'Primary' : `Primary ${fallbackIndex + 1}`;
  return `Window ${fallbackIndex + 1}`;
}

function buildQuotaCards(prefix, rateLimit) {
  if (!rateLimit) return [];
  const { windows } = chooseCodexQuotaWindows(rateLimit);
  return windows.map((window, index) => {
    const baseLabel = getQuotaWindowDisplayLabel(window, index);
    return {
      key: `${prefix}:${window.name}:${index}`,
      label: prefix ? `${prefix} ${baseLabel}` : baseLabel,
      usedPercent: window.usedPercent,
      resetAt: window.resetAt,
      limitWindowSeconds: window.limitWindowSeconds,
      limitReached: window.limitReached,
    };
  });
}

function buildAdditionalQuotaCards(value) {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => buildQuotaCards(`Extra ${index + 1}`, asRecord(item)));
  }
  const record = asRecord(value);
  if (!record) return [];
  return Object.entries(record).flatMap(([key, item]) => buildQuotaCards(`Extra ${key}`, asRecord(item)));
}

function extractCodexQuotaInfo(response) {
  const body = parseJsonRecord(response?.body);
  const statusMessage = parseJsonRecord(body?.status_message ?? body?.statusMessage);
  const statusError = asRecord(statusMessage?.error);
  const limitHintText = [toText(response?.body), toText(response?.error), toText(body?.status_message), toText(body?.statusMessage)].join(' ');
  const quotaMarkedByText = hasLimitKeyword(limitHintText);

  const rateLimit = asRecord(body?.rate_limit ?? body?.rateLimit);
  const statusResetAt = toUnixSeconds(
    pickFirstVal(
      statusError,
      'resets_at',
      'resetsAt',
      'reset_at',
      'resetAt',
    ) ?? pickFirstVal(statusMessage, 'resets_at', 'resetsAt', 'reset_at', 'resetAt') ?? pickFirstVal(body, 'resets_at', 'resetsAt', 'reset_at', 'resetAt'),
  );

  if (!rateLimit) {
    if (!quotaMarkedByText) return null;
    return {
      exhausted: true,
      lowRemaining: false,
      usedPercent: 100,
      weeklyUsedPercent: null,
      shortUsedPercent: null,
      resetAt: statusResetAt,
      source: 'status_message',
      cards: [],
    };
  }

  const { weekly, short, windows } = chooseCodexQuotaWindows(rateLimit);
  const codeReviewRateLimit = asRecord(body?.code_review_rate_limit ?? body?.codeReviewRateLimit);
  const cards = [
    ...buildQuotaCards('', rateLimit),
    ...buildQuotaCards('Code Review', codeReviewRateLimit),
    ...buildAdditionalQuotaCards(body?.additional_rate_limits ?? body?.additionalRateLimits),
  ];
  const weeklyUsed = weekly?.usedPercent ?? null;
  const shortUsed = short?.usedPercent ?? null;

  let source = null;
  let usedPercent = null;
  let exhausted = false;
  let selectedResetAt = null;

  if (weeklyUsed !== null || shortUsed !== null) {
    const preferShort = shortUsed !== null && (weeklyUsed === null || shortUsed >= weeklyUsed);
    if (preferShort) {
      source = '5hour';
      usedPercent = shortUsed;
      selectedResetAt = short?.resetAt ?? null;
    } else {
      source = 'weekly';
      usedPercent = weeklyUsed;
      selectedResetAt = weekly?.resetAt ?? null;
    }
    exhausted = (weeklyUsed !== null && weeklyUsed >= 100) || (shortUsed !== null && shortUsed >= 100);
  }

  if (usedPercent === null) {
    const weeklyLimitReached = weekly?.limitReached === true;
    const shortLimitReached = short?.limitReached === true;
    const remainingZero = windows.some((window) => window.remaining === 0);
    const rateLimitReached = toBoolean(pickFirstVal(rateLimit, 'limit_reached', 'limitReached')) === true;
    const rateAllowed = toBoolean(rateLimit.allowed);

    if (weeklyLimitReached) {
      source = 'weekly_limit';
      usedPercent = 100;
      exhausted = true;
    } else if (shortLimitReached) {
      source = '5hour_limit';
      usedPercent = 100;
      exhausted = true;
    } else if (remainingZero) {
      source = 'remaining';
      usedPercent = 100;
      exhausted = true;
    } else if (rateLimitReached || rateAllowed === false) {
      source = 'rate_limit_flag';
      usedPercent = 100;
      exhausted = true;
    } else if (quotaMarkedByText) {
      source = 'status_message';
      usedPercent = 100;
      exhausted = true;
    }
  }

  const resetAt = selectedResetAt ?? weekly?.resetAt ?? short?.resetAt ?? statusResetAt;

  return {
    exhausted,
    lowRemaining: false,
    usedPercent,
    weeklyUsedPercent: weeklyUsed,
    shortUsedPercent: shortUsed,
    resetAt,
    source,
    cards,
  };
}

function formatResetAtText(resetAt) {
  if (!resetAt) return 'unknown';
  const date = new Date(resetAt * 1000);
  if (!Number.isFinite(date.getTime())) return 'unknown';
  return date.toISOString().replace('T', ' ').slice(0, 16);
}

function isCodexInvalidated401(lower) {
  return lower.includes('token_invalidated')
    || lower.includes('token invalidated')
    || lower.includes('authentication token has been invalidated')
    || lower.includes('invalidated oauth token')
    || lower.includes('token_revoked')
    || lower.includes('invalidated');
}

function classifyCodexProbe(response, options) {
  const statusCode = toStatusCode(response?.status_code);
  const text = normalizeProbeText(response);
  const lower = text.toLowerCase();
  const quota = extractCodexQuotaInfo(response);
  const remainingThreshold = Math.max(0, Math.min(100, Math.floor(Number(options?.codexQuotaDisableRemainingPercent ?? 0) || 0)));

  if (statusCode === 401 && isCodexInvalidated401(lower)) {
    return { status: 'invalidated', reason: text || 'codex token invalidated', quota };
  }
  if (statusCode === 401 && lower.includes('deactivated')) {
    return { status: 'deactivated', reason: text || 'codex account deactivated', quota };
  }
  if (statusCode === 401) {
    return { status: 'unauthorized', reason: text || 'codex unauthorized', quota };
  }
  if (statusCode === 429) {
    return { status: 'rate_limited', reason: text || 'codex rate limited (429)', quota };
  }
  if (quota?.exhausted) {
    const reasonParts = ['codex quota exhausted'];
    if (typeof quota.usedPercent === 'number') {
      reasonParts.push(`used=${quota.usedPercent}%`);
    }
    reasonParts.push(`source=${quota.source || 'unknown'}`);
    reasonParts.push(`reset_at=${formatResetAtText(quota.resetAt)}`);
    return { status: 'quota_exhausted', reason: reasonParts.join(', '), quota };
  }
  if (quota && remainingThreshold > 0 && typeof quota.usedPercent === 'number') {
    const remainingPercent = Math.max(0, 100 - quota.usedPercent);
    if (remainingPercent <= remainingThreshold) {
      quota.lowRemaining = true;
      const reasonParts = ['codex quota remaining below threshold'];
      reasonParts.push(`remaining=${remainingPercent}%`);
      reasonParts.push(`threshold=${remainingThreshold}%`);
      reasonParts.push(`used=${quota.usedPercent}%`);
      reasonParts.push(`source=${quota.source || 'unknown'}`);
      reasonParts.push(`reset_at=${formatResetAtText(quota.resetAt)}`);
      return { status: 'quota_low_remaining', reason: reasonParts.join(', '), quota };
    }
  }
  if (CODEX_ACTIVE_CODES.has(statusCode)) {
    return { status: 'active', reason: '', quota };
  }
  return { status: 'unknown', reason: text || `unexpected response (${statusCode || 'n/a'})`, quota };
}

function classifyAntigravityProbe(response) {
  const statusCode = toStatusCode(response?.status_code);
  const text = normalizeProbeText(response);
  const lower = text.toLowerCase();

  if (lower.includes('额度获取失败') || lower.includes('请检查凭证状态') || lower.includes('refresh failed') || lower.includes('invalid_grant')) {
    return { status: 'expired_by_time', reason: text || 'antigravity token refresh failed' };
  }
  if (statusCode === 403 || lower.includes('service has been disabled') || lower.includes('disabled in this account') || lower.includes('violation of terms')) {
    return { status: 'deactivated', reason: text || 'antigravity service disabled' };
  }
  if (statusCode === 401 || REDIRECT_CODES.has(statusCode)) {
    return { status: 'unauthorized', reason: text || `antigravity unauthorized (${statusCode})` };
  }
  if (statusCode === 429) {
    return { status: 'rate_limited', reason: text || 'antigravity rate limited (429)' };
  }
  if (statusCode === 200 || statusCode === 201) {
    return { status: 'active', reason: '' };
  }
  if (statusCode === 400) {
    return { status: 'expired_by_time', reason: text || 'antigravity token refresh failed' };
  }
  return { status: 'unknown', reason: text || `unexpected response (${statusCode || 'n/a'})` };
}

function classifyDefaultProbe(response) {
  const statusCode = toStatusCode(response?.status_code);
  const text = normalizeProbeText(response);
  if (statusCode === 429) {
    return { status: 'rate_limited', reason: text || 'rate limited (429)' };
  }
  if (statusCode === 200 || statusCode === 201) {
    return { status: 'active', reason: '' };
  }
  return { status: 'unknown', reason: text || `unexpected response (${statusCode || 'n/a'})` };
}

export function classifyProviderProbe(provider, response, options) {
  const providerName = String(provider || '').toLowerCase();
  if (providerName === 'codex') {
    return classifyCodexProbe(response, options);
  }
  if (providerName === 'antigravity') {
    return classifyAntigravityProbe(response);
  }
  return classifyDefaultProbe(response);
}

export function canProbeCredential(cred) {
  return String(cred?.provider || '').toLowerCase() !== 'iflow';
}

export function shouldAutoDisable(status) {
  return status === 'invalidated'
    || status === 'deactivated'
    || status === 'unauthorized'
    || status === 'expired_by_time'
    || status === 'quota_exhausted'
    || status === 'quota_low_remaining'
    || status === 'rate_limited';
}

export function shouldAutoArchive(status) {
  return status === 'deactivated' || status === 'invalidated';
}

export function toProbeErrorResponse(error) {
  const errObj = error || {};
  return {
    status_code: toStatusCode(errObj?.response?.status),
    body: errObj?.response?.data,
    error: errObj?.message || 'Network error during probing',
  };
}
