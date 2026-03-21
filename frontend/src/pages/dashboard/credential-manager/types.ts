import type { Dispatch, SetStateAction } from 'react';
import type { CodexQuotaCard, ProbeTier, ProbeUiStatus } from '../../../lib/providerStrategies';

export interface ProbeUiState {
    status: ProbeUiStatus;
    time: string;
    reason?: string;
    tier?: ProbeTier;
    detail?: string;
    quotaResetAt?: number | null;
    quotaSource?: string | null;
    quotaUsedPercent?: number | null;
    quotaCards?: CodexQuotaCard[];
}

export interface CodexQuotaResumeEntry {
    resetAt: number | null;
    source: string | null;
    usedPercent: number | null;
    nextProbeAtMs: number;
}

export type AutoProbeConfigStatus = 'idle' | 'loaded' | 'saving' | 'saved' | 'error';

export type StatusFilter = 'all' | 'enabled' | 'disabled';

export interface CredentialManagerProps {
    cpaReady: boolean;
    cpaUrl: string;
    autoProbeEnabled: boolean;
    setAutoProbeEnabled: Dispatch<SetStateAction<boolean>>;
    autoProbeIntervalMinutes: number;
    setAutoProbeIntervalMinutes: Dispatch<SetStateAction<number>>;
    codexQuotaDisableRemainingPercent: number;
    setCodexQuotaDisableRemainingPercent: Dispatch<SetStateAction<number>>;
    autoProbeConfigStatus: AutoProbeConfigStatus;
}
