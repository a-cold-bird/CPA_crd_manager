import type { CheckStatus, Credential, ProbeResponse } from './api';

export type ProbeTier = 'FREE' | 'PRO' | 'PLUS' | 'TEAM' | null;
export type ProbeUiStatus = CheckStatus | 'running' | 'error';

const CODEX_ACTIVE_CODES = new Set([200, 201, 400, 402, 403, 404, 409, 422, 429]);
const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);
const TIER_PRIORITY: Array<Exclude<ProbeTier, null>> = ['TEAM', 'PLUS', 'PRO', 'FREE'];

function toText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function toStatusCode(value: unknown): number {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
}

function normalizeProbeText(response: ProbeResponse): string {
  return [toText(response.body), toText(response.error)].join(' ');
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function parseJsonRecord(value: unknown): Record<string, unknown> | null {
  const obj = asRecord(value);
  if (obj) return obj;
  if (typeof value !== 'string') return null;
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return null;
  }
}

function pickFirstVal(record: Record<string, unknown> | null, ...keys: string[]): unknown {
  if (!record) return undefined;
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null) {
      return record[key];
    }
  }
  return undefined;
}

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function toPercent(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const text = String(value).trim().replace(/%$/, '');
  if (!text) return null;
  const num = Number(text);
  return Number.isFinite(num) ? num : null;
}

function toBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const lower = value.trim().toLowerCase();
    if (lower === 'true') return true;
    if (lower === 'false') return false;
  }
  return null;
}

function toUnixSeconds(value: unknown): number | null {
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

type CodexQuotaWindow = {
  name: string;
  usedPercent: number | null;
  resetAt: number | null;
  limitWindowSeconds: number | null;
  remaining: number | null;
  limitReached: boolean | null;
};

export type CodexQuotaCard = {
  key: string;
  label: string;
  usedPercent: number | null;
  resetAt: number | null;
  limitWindowSeconds: number | null;
  limitReached: boolean | null;
};

export type CodexQuotaInfo = {
  exhausted: boolean;
  lowRemaining: boolean;
  usedPercent: number | null;
  weeklyUsedPercent: number | null;
  shortUsedPercent: number | null;
  resetAt: number | null;
  source: 'weekly' | '5hour' | 'weekly_limit' | '5hour_limit' | 'remaining' | 'rate_limit_flag' | 'status_message' | null;
  cards: CodexQuotaCard[];
};

type ProbeClassifyOptions = {
  codexQuotaDisableRemainingPercent?: number | null;
};

const QUOTA_LIMIT_KEYWORDS = ['usage_limit_reached', 'insufficient_quota', 'quota_exceeded', 'limit_reached', 'rate limit'];

function hasLimitKeyword(text: string): boolean {
  const lower = text.toLowerCase();
  return QUOTA_LIMIT_KEYWORDS.some((keyword) => lower.includes(keyword));
}

function parseQuotaWindow(name: string, value: unknown): CodexQuotaWindow | null {
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

function chooseCodexQuotaWindows(rateLimit: Record<string, unknown>): { weekly: CodexQuotaWindow | null; short: CodexQuotaWindow | null; windows: CodexQuotaWindow[] } {
  const keys = ['primary_window', 'secondary_window', 'individual_window', 'primaryWindow', 'secondaryWindow', 'individualWindow'];
  const windows = keys
    .map((key) => parseQuotaWindow(key, rateLimit[key]))
    .filter((item): item is CodexQuotaWindow => Boolean(item));

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

  // Single short-window accounts should be treated as the primary short quota instead of weekly quota.
  if (!short && weekly && typeof weekly.limitWindowSeconds === 'number' && weekly.limitWindowSeconds <= 6 * 3600) {
    short = weekly;
    weekly = null;
  }

  return { weekly, short, windows };
}

function getQuotaWindowDisplayLabel(window: CodexQuotaWindow, fallbackIndex: number): string {
  const seconds = window.limitWindowSeconds || 0;
  if (seconds >= 6 * 24 * 3600) return 'Weekly';
  if (seconds > 0 && seconds <= 6 * 3600) return '5h';
  if (window.name.toLowerCase().includes('individual')) return 'Weekly';
  if (window.name.toLowerCase().includes('secondary')) return '5h';
  if (window.name.toLowerCase().includes('primary')) return fallbackIndex === 0 ? 'Primary' : `Primary ${fallbackIndex + 1}`;
  return `Window ${fallbackIndex + 1}`;
}

function buildQuotaCards(prefix: string, rateLimit: Record<string, unknown> | null): CodexQuotaCard[] {
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

function buildAdditionalQuotaCards(value: unknown): CodexQuotaCard[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => buildQuotaCards(`Extra ${index + 1}`, asRecord(item)));
  }
  const record = asRecord(value);
  if (!record) return [];
  return Object.entries(record).flatMap(([key, item]) => buildQuotaCards(`Extra ${key}`, asRecord(item)));
}

function extractCodexQuotaInfo(response: ProbeResponse): CodexQuotaInfo | null {
  const body = parseJsonRecord(response.body);
  const statusMessage = parseJsonRecord(body?.status_message ?? body?.statusMessage);
  const statusError = asRecord(statusMessage?.error);
  const limitHintText = [toText(response.body), toText(response.error), toText(body?.status_message), toText(body?.statusMessage)].join(' ');
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

  let source: CodexQuotaInfo['source'] = null;
  let usedPercent: number | null = null;
  let exhausted = false;
  let selectedResetAt: number | null = null;

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

function formatResetAtText(resetAt: number | null): string {
  if (!resetAt) return 'unknown';
  const date = new Date(resetAt * 1000);
  if (!Number.isFinite(date.getTime())) return 'unknown';
  return date.toISOString().replace('T', ' ').slice(0, 16);
}

function hasWholeWord(text: string, word: 'free' | 'pro' | 'plus' | 'team' | 'premium'): boolean {
  const pattern = new RegExp(`(^|[^a-z0-9])${word}([^a-z0-9]|$)`);
  return pattern.test(text);
}

function pickTierByPriority(candidates: ProbeTier[]): ProbeTier {
  for (const tier of TIER_PRIORITY) {
    if (candidates.includes(tier)) return tier;
  }
  return null;
}

function extractTierFromText(text: string): ProbeTier {
  const lower = (text || '').toLowerCase();
  if (!lower) return null;
  if (lower.includes('enterprise-tier') || hasWholeWord(lower, 'team')) return 'TEAM';
  if (hasWholeWord(lower, 'plus')) return 'PLUS';
  if (lower.includes('pro-tier') || lower.includes('premium-tier') || hasWholeWord(lower, 'pro') || hasWholeWord(lower, 'premium')) return 'PRO';
  if (lower.includes('standard-tier') || hasWholeWord(lower, 'free')) return 'FREE';
  return null;
}

function extractTierFromValues(values: unknown[], parser: (text: string) => ProbeTier = extractTierFromText): ProbeTier {
  const candidates: ProbeTier[] = [];
  for (const value of values) {
    const tier = parser(toText(value));
    if (tier) candidates.push(tier);
  }
  return pickTierByPriority(candidates);
}

function extractCodexTierFromCredential(cred: Credential): ProbeTier {
  const fieldTier = extractTierFromValues([
    cred.id_token?.plan_type,
    cred['plan_type'],
    cred['tier'],
    cred['subscription_tier'],
    cred['account_tier'],
  ]);
  if (fieldTier) return fieldTier;

  const joined = `${cred.name || ''} ${cred.id || ''}`.toLowerCase();
  const suffixMatch = joined.match(/(?:^|[-_])(free|plus|pro|team)(?:\.json)?(?:\s|$)/);
  if (!suffixMatch?.[1]) return null;
  return suffixMatch[1].toUpperCase() as Exclude<ProbeTier, null>;
}

function extractAntigravityTierFromCredential(cred: Credential): ProbeTier {
  const idToken = asRecord(cred.id_token) || {};
  return extractTierFromValues([
    idToken['plan_type'],
    idToken['planType'],
    idToken['plan'],
    idToken['tier'],
    idToken['subscription_tier'],
    idToken['subscriptionTier'],
    idToken['account_tier'],
    idToken['accountTier'],
    idToken['account_type'],
    idToken['accountType'],
    cred['tier'],
    cred['plan_type'],
    cred['planType'],
    cred['plan'],
    cred['subscription_tier'],
    cred['subscriptionTier'],
    cred['account_tier'],
    cred['accountTier'],
    cred['account_type'],
    cred['accountType'],
  ]);
}

function extractAntigravityTierFromProbe(response: ProbeResponse): ProbeTier {
  const bodyObj = parseJsonRecord(response.body);
  const candidates: ProbeTier[] = [];

  const collect = (value: unknown) => {
    const tier = extractTierFromText(toText(value));
    if (tier) candidates.push(tier);
  };

  if (bodyObj) {
    const currentTier = asRecord(bodyObj.currentTier || bodyObj.current_tier);
    if (currentTier) {
      collect(`${toText(currentTier.id)} ${toText(currentTier.name)} ${toText(currentTier.tier)} ${toText(currentTier.planType)} ${toText(currentTier.plan_type)}`);
    }

    const paidTier = asRecord(bodyObj.paidTier || bodyObj.paid_tier);
    if (paidTier) {
      collect(`${toText(paidTier.id)} ${toText(paidTier.name)} ${toText(paidTier.tier)} ${toText(paidTier.planType)} ${toText(paidTier.plan_type)}`);
    }

    const allowedTiersRaw = bodyObj.allowedTiers || bodyObj.allowed_tiers;
    const allowedTiers = Array.isArray(allowedTiersRaw) ? allowedTiersRaw : [];
    for (const item of allowedTiers) {
      const tierObj = asRecord(item);
      if (!tierObj) continue;
      collect(`${toText(tierObj.id)} ${toText(tierObj.name)} ${toText(tierObj.tier)} ${toText(tierObj.planType)} ${toText(tierObj.plan_type)}`);
    }

    const paidTiersRaw = bodyObj.paidTiers || bodyObj.paid_tiers;
    const paidTiers = Array.isArray(paidTiersRaw) ? paidTiersRaw : [];
    for (const item of paidTiers) {
      const tierObj = asRecord(item);
      if (!tierObj) continue;
      collect(`${toText(tierObj.id)} ${toText(tierObj.name)} ${toText(tierObj.tier)} ${toText(tierObj.planType)} ${toText(tierObj.plan_type)}`);
    }

    collect(bodyObj.tier);
    collect(bodyObj.planType);
    collect(bodyObj.plan_type);
    collect(bodyObj.subscriptionTier);
    collect(bodyObj.subscription_tier);
    collect(bodyObj.accountTier);
    collect(bodyObj.account_tier);
    collect(bodyObj.accountType);
    collect(bodyObj.account_type);
  }

  return pickTierByPriority(candidates);
}

type ProbeClassification = { status: CheckStatus; reason: string; quota?: CodexQuotaInfo | null };

type ProviderStrategy = {
  canProbe: (cred: Credential) => boolean;
  classifyProbe: (response: ProbeResponse, options?: ProbeClassifyOptions) => ProbeClassification;
  tierFromCredential: (cred: Credential) => ProbeTier;
  tierFromProbe?: (response: ProbeResponse) => ProbeTier;
};

const codexStrategy: ProviderStrategy = {
  canProbe: (cred) => (cred.provider || '').toLowerCase() !== 'iflow',
  classifyProbe: (response, options) => {
    const statusCode = toStatusCode(response.status_code);
    const text = normalizeProbeText(response);
    const lower = text.toLowerCase();
    const quota = extractCodexQuotaInfo(response);
    const remainingThreshold = Math.max(0, Math.min(100, Math.floor(Number(options?.codexQuotaDisableRemainingPercent ?? 0) || 0)));

    if (statusCode === 401 && (lower.includes('token_invalidated') || lower.includes('invalidated'))) {
      return { status: 'invalidated', reason: text || 'codex token invalidated', quota };
    }
    if (statusCode === 401 && lower.includes('deactivated')) {
      return { status: 'deactivated', reason: text || 'codex account deactivated', quota };
    }
    if (statusCode === 401) {
      return { status: 'unauthorized', reason: text || 'codex unauthorized', quota };
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
  },
  tierFromCredential: extractCodexTierFromCredential,
};

const antigravityStrategy: ProviderStrategy = {
  canProbe: (cred) => (cred.provider || '').toLowerCase() !== 'iflow',
  classifyProbe: (response) => {
    const statusCode = toStatusCode(response.status_code);
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
    if (statusCode === 200 || statusCode === 201) {
      return { status: 'active', reason: '' };
    }
    if (statusCode === 400) {
      return { status: 'expired_by_time', reason: text || 'antigravity token refresh failed' };
    }
    return { status: 'unknown', reason: text || `unexpected response (${statusCode || 'n/a'})` };
  },
  tierFromCredential: extractAntigravityTierFromCredential,
  tierFromProbe: extractAntigravityTierFromProbe,
};

const defaultStrategy: ProviderStrategy = {
  canProbe: () => true,
  classifyProbe: (response) => {
    const statusCode = toStatusCode(response.status_code);
    const text = normalizeProbeText(response);
    if (statusCode === 200 || statusCode === 201) {
      return { status: 'active', reason: '' };
    }
    return { status: 'unknown', reason: text || `unexpected response (${statusCode || 'n/a'})` };
  },
  tierFromCredential: () => null,
};

const strategyFactory: Record<string, ProviderStrategy> = {
  codex: codexStrategy,
  antigravity: antigravityStrategy,
};

export function getProviderStrategy(provider: string): ProviderStrategy {
  const providerName = (provider || '').toLowerCase();
  return strategyFactory[providerName] || defaultStrategy;
}

export function classifyProviderProbe(provider: string, response: ProbeResponse, options?: ProbeClassifyOptions): ProbeClassification {
  return getProviderStrategy(provider).classifyProbe(response, options);
}

export function resolveTierFromCredential(cred: Credential): ProbeTier {
  return getProviderStrategy(cred.provider).tierFromCredential(cred);
}

export function resolveTierAfterProbe(cred: Credential, response: ProbeResponse): ProbeTier {
  const strategy = getProviderStrategy(cred.provider);
  const probeTier = strategy.tierFromProbe?.(response) || null;
  const credentialTier = strategy.tierFromCredential(cred);
  return pickTierByPriority([probeTier, credentialTier]);
}

export function canProbeCredential(cred: Credential): boolean {
  return getProviderStrategy(cred.provider).canProbe(cred);
}

export function shouldAutoDisable(status: ProbeUiStatus): boolean {
  return status === 'invalidated' || status === 'deactivated' || status === 'unauthorized' || status === 'expired_by_time' || status === 'quota_exhausted' || status === 'quota_low_remaining';
}

export function toProbeErrorResponse(error: unknown): ProbeResponse {
  const errObj = error as {
    message?: string;
    response?: {
      status?: number;
      data?: unknown;
    };
  };

  return {
    status_code: toStatusCode(errObj.response?.status),
    body: errObj.response?.data,
    error: errObj.message || 'Network error during probing',
  };
}
