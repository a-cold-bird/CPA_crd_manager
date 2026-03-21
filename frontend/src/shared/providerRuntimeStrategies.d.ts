import type { CheckStatus, Credential, ProbeResponse } from '../lib/api';

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

export type ProbeClassifyOptions = {
  codexQuotaDisableRemainingPercent?: number | null;
};

export type ProbeClassification = {
  status: CheckStatus;
  reason: string;
  quota?: CodexQuotaInfo | null;
};

export function classifyProviderProbe(provider: string, response: ProbeResponse, options?: ProbeClassifyOptions): ProbeClassification;
export function canProbeCredential(cred: Credential): boolean;
export function shouldAutoDisable(status: string): boolean;
export function shouldAutoArchive(status: string): boolean;
export function toProbeErrorResponse(error: unknown): ProbeResponse;
