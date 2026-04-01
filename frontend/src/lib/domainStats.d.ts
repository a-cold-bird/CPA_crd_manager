export interface EmailDomainStat {
  total: number;
  success: number;
  fail: number;
}

export declare function buildEmailDomainStats(
  batches: Array<{ accounts?: Array<{ email?: string; status?: string; register_ok?: boolean }> }> | null | undefined,
  configuredDomains: string[] | null | undefined,
): Record<string, EmailDomainStat>;
