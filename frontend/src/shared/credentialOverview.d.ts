import type { Credential } from '../lib/api';
import type { ProbeUiState } from '../pages/dashboard/credential-manager/types';

export interface CredentialOverviewSummary {
  available: number;
  error: number;
  limited: number;
  total: number;
}

export function summarizeCredentialOverview(
  credentials: Credential[],
  probeStatuses?: Record<string, ProbeUiState>,
  operationErrors?: Record<string, string>,
): CredentialOverviewSummary;
