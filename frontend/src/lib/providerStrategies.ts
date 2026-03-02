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

type ProbeClassification = { status: CheckStatus; reason: string };

type ProviderStrategy = {
  canProbe: (cred: Credential) => boolean;
  classifyProbe: (response: ProbeResponse) => ProbeClassification;
  tierFromCredential: (cred: Credential) => ProbeTier;
  tierFromProbe?: (response: ProbeResponse) => ProbeTier;
};

const codexStrategy: ProviderStrategy = {
  canProbe: (cred) => (cred.provider || '').toLowerCase() !== 'iflow',
  classifyProbe: (response) => {
    const statusCode = toStatusCode(response.status_code);
    const text = normalizeProbeText(response);
    const lower = text.toLowerCase();

    if (statusCode === 401 && (lower.includes('token_invalidated') || lower.includes('invalidated'))) {
      return { status: 'invalidated', reason: text || 'codex token invalidated' };
    }
    if (statusCode === 401 && lower.includes('deactivated')) {
      return { status: 'deactivated', reason: text || 'codex account deactivated' };
    }
    if (statusCode === 401) {
      return { status: 'unauthorized', reason: text || 'codex unauthorized' };
    }
    if (CODEX_ACTIVE_CODES.has(statusCode)) {
      return { status: 'active', reason: '' };
    }
    return { status: 'unknown', reason: text || `unexpected response (${statusCode || 'n/a'})` };
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

export function classifyProviderProbe(provider: string, response: ProbeResponse): ProbeClassification {
  return getProviderStrategy(provider).classifyProbe(response);
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
  return status === 'invalidated' || status === 'deactivated' || status === 'unauthorized' || status === 'expired_by_time';
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
