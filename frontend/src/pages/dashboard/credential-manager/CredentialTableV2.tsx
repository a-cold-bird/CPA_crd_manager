import { AlertTriangle, CheckCircle2, Clock, Play, RefreshCw, XCircle } from 'lucide-react';
import type { TFunction } from 'i18next';
import type { Credential } from '../../../lib/api';
import { canProbeCredential, resolveTierFromCredential, type ProbeUiStatus } from '../../../lib/providerStrategies';
import type { CodexQuotaResumeEntry, ProbeUiState } from './types';

interface CredentialTableProps {
  t: TFunction;
  i18nLanguage: string;
  cpaReady: boolean;
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  filteredCredentials: Credential[];
  pagedCredentials: Credential[];
  selectedItems: Set<string>;
  onToggleSelectAll: (checked: boolean) => void;
  onToggleItem: (name: string) => void;
  probeStatuses: Record<string, ProbeUiState>;
  codexQuotaResumeMap: Record<string, CodexQuotaResumeEntry>;
  isLocked: (key: string) => boolean;
  deletingNames: Set<string>;
  togglingNames: Set<string>;
  onProbeSingle: (cred: Credential) => void;
  onToggleStatus: (cred: Credential) => void;
  onDeleteSingle: (name: string) => void;
  onShowProbeDetail: (detail: string) => void;
  onRetryLoad: () => void;
  totalItems: number;
  pageStart: number;
  pageEnd: number;
  pageSize: number;
  onPageSizeChange: (value: number) => void;
  currentPage: number;
  totalPages: number;
  onPageChange: (page: number) => void;
}

function formatResetAtText(resetAt: number | null | undefined, t: TFunction): string {
  if (typeof resetAt !== 'number' || !Number.isFinite(resetAt) || resetAt <= 0) return t('Unknown');
  const date = new Date(resetAt * 1000);
  if (!Number.isFinite(date.getTime())) return t('Unknown');
  return date.toLocaleString();
}

function normalizePercent(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, value));
}

function toRemainingPercent(usedPercent: number | null): number | null {
  if (usedPercent === null) return null;
  return Math.max(0, Math.min(100, 100 - usedPercent));
}

function getQuotaMeterClass(remainingPercent: number): string {
  if (remainingPercent <= 5) return 'bg-rose-500';
  if (remainingPercent <= 20) return 'bg-amber-500';
  return 'bg-emerald-500';
}

function isQuotaRecoveryStatus(status: ProbeUiStatus | undefined): boolean {
  return status === 'quota_exhausted' || status === 'quota_low_remaining' || status === 'rate_limited';
}

function getDisabledBadgeMeta(status: ProbeUiStatus | undefined, hasQuotaResume: boolean, t: TFunction) {
  if (status === 'rate_limited') {
    return {
      label: t('Temp Disabled (429)'),
      detail: hasQuotaResume ? t('Auto Enable Scheduled') : t('429 Rate Limited'),
    };
  }
  if (hasQuotaResume && isQuotaRecoveryStatus(status)) {
    return {
      label: t('Temp Disabled (Quota)'),
      detail: t('Auto Enable Scheduled'),
    };
  }
  if (status === 'invalidated' || status === 'unauthorized' || status === 'deactivated' || status === 'expired_by_time' || status === 'error') {
    return {
      label: t('Auto Disabled (Status)'),
      detail: t('Auto Disabled (Status)'),
    };
  }
  return {
    label: t('Disabled'),
    detail: t('Manual Disabled'),
  };
}

export default function CredentialTableV2({
  t,
  cpaReady,
  isLoading,
  isError,
  error,
  filteredCredentials,
  pagedCredentials,
  selectedItems,
  onToggleSelectAll,
  onToggleItem,
  probeStatuses,
  codexQuotaResumeMap,
  isLocked,
  deletingNames,
  togglingNames,
  onProbeSingle,
  onToggleStatus,
  onDeleteSingle,
  onShowProbeDetail,
  onRetryLoad,
  totalItems,
  pageStart,
  pageEnd,
  pageSize,
  onPageSizeChange,
  currentPage,
  totalPages,
  onPageChange,
}: CredentialTableProps) {
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
      <div className="overflow-x-auto">
        <table className="min-w-[1680px] w-full whitespace-nowrap text-left text-sm">
          <thead className="border-b border-border bg-muted/50 text-xs font-medium uppercase text-muted-foreground">
            <tr>
              <th className="w-12 px-4 py-4">
                <input
                  type="checkbox"
                  className="h-4 w-4 rounded border-input bg-background/50 text-primary focus:ring-primary"
                  checked={pagedCredentials.length > 0 && pagedCredentials.every((item) => selectedItems.has(item.name))}
                  onChange={(e) => onToggleSelectAll(e.target.checked)}
                />
              </th>
              <th className="px-6 py-4">{t('ID / Index')}</th>
              <th className="px-6 py-4">{t('Provider')}</th>
              <th className="px-6 py-4">{t('Status')}</th>
              <th className="px-6 py-4">{t('Quota')}</th>
              <th className="px-6 py-4">{t('Last Checked')}</th>
              <th className="px-6 py-4 text-right">{t('Actions')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {!cpaReady ? (
              <tr><td colSpan={7} className="px-6 py-8 text-center text-muted-foreground">{t('Initializing connection...')}</td></tr>
            ) : isLoading ? (
              <tr><td colSpan={7} className="px-6 py-8 text-center text-muted-foreground">{t('Loading credentials...')}</td></tr>
            ) : isError ? (
              <tr>
                <td colSpan={7} className="px-6 py-8 text-center text-muted-foreground">
                  <div className="space-y-2">
                    <div>{t('Failed to load credentials.')}</div>
                    <div className="text-xs text-destructive">{String((error as { message?: string })?.message || '')}</div>
                    <button
                      onClick={onRetryLoad}
                      className="inline-flex h-8 items-center justify-center rounded-md border border-input bg-transparent px-3 text-xs font-medium hover:bg-accent hover:text-accent-foreground"
                    >
                      {t('Retry')}
                    </button>
                  </div>
                </td>
              </tr>
            ) : filteredCredentials.length === 0 ? (
              <tr><td colSpan={7} className="px-6 py-8 text-center text-muted-foreground">{t('No credentials found.')}</td></tr>
            ) : (
              pagedCredentials.map((cred) => {
                const st = probeStatuses[cred.name];
                const quotaResume = codexQuotaResumeMap[cred.name];
                const probeLockKey = `probe-single:${cred.name}`;
                const isProbeRunning = st?.status === 'running' || isLocked(probeLockKey);
                const canProbe = canProbeCredential(cred);
                const quotaCards = Array.isArray(st?.quotaCards) ? st.quotaCards : [];
                const fallbackQuotaPercent = normalizePercent((st?.quotaUsedPercent ?? quotaResume?.usedPercent) as number | null | undefined);
                const fallbackQuotaRemainingPercent = toRemainingPercent(fallbackQuotaPercent);
                const quotaResetAt = st?.quotaResetAt ?? quotaResume?.resetAt ?? null;
                const remainingLabel = t('Remaining');

                const displayQuotaCards = quotaCards.length
                  ? quotaCards.filter((card) => toRemainingPercent(normalizePercent(card.usedPercent)) !== null)
                  : (fallbackQuotaRemainingPercent !== null
                    ? [{ key: 'fallback', label: t('Quota'), usedPercent: fallbackQuotaPercent, resetAt: quotaResetAt }]
                    : []);

                const quotaCardBlock = displayQuotaCards.length ? (
                  <div className="flex min-w-[360px] max-w-[420px] flex-wrap gap-2">
                    {displayQuotaCards.map((card) => {
                      const remainingPercent = toRemainingPercent(normalizePercent(card.usedPercent));
                      if (remainingPercent === null) return null;
                      return (
                        <div key={card.key} className="min-w-[170px] rounded-md border border-border/60 bg-background/80 px-3 py-2.5 shadow-sm">
                          <div className="flex items-center justify-between gap-2 text-[10px] font-medium text-foreground/90">
                            <span className="truncate">{card.label}</span>
                            <span>{Math.round(remainingPercent)}%</span>
                          </div>
                          <div className="mt-1 h-1.5 overflow-hidden rounded bg-muted">
                            <div className={`h-full ${getQuotaMeterClass(remainingPercent)}`} style={{ width: `${remainingPercent}%` }} />
                          </div>
                          <div className="mt-1 truncate text-[10px] text-muted-foreground">
                            {remainingLabel}
                          </div>
                          {(card.resetAt || quotaResetAt) ? (
                            <div className="mt-1 truncate text-[10px] text-muted-foreground">
                              {t('Reset At')}: {formatResetAtText(card.resetAt ?? quotaResetAt, t)}
                            </div>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                ) : null;

                const getProviderBadge = (provider: string) => {
                  switch (provider.toLowerCase()) {
                    case 'antigravity':
                      return <span className="inline-flex items-center rounded-full border border-teal-500/20 bg-teal-500/15 px-2.5 py-0.5 text-[11px] font-semibold text-teal-600 dark:text-teal-400">Antigravity</span>;
                    case 'codex':
                      return <span className="inline-flex items-center rounded-full border border-amber-500/20 bg-amber-500/15 px-2.5 py-0.5 text-[11px] font-semibold text-amber-600 dark:text-amber-500">Codex</span>;
                    case 'iflow':
                      return <span className="inline-flex items-center rounded-full border border-purple-500/20 bg-purple-500/15 px-2.5 py-0.5 text-[11px] font-semibold text-purple-600 dark:text-purple-400">iFlow</span>;
                    default:
                      return <span className="inline-flex items-center rounded-full bg-secondary px-2.5 py-0.5 text-[11px] font-semibold text-secondary-foreground">{provider}</span>;
                  }
                };

                const getTierBadge = (row: Credential) => {
                  const tier = st?.tier || resolveTierFromCredential(row);
                  if (tier === 'PLUS') return <span className="inline-flex items-center rounded-sm border border-fuchsia-500/20 bg-fuchsia-500/15 px-1.5 py-0.5 text-[10px] font-bold text-fuchsia-700 dark:text-fuchsia-400">PLUS</span>;
                  if (tier === 'TEAM') return <span className="inline-flex items-center rounded-sm border border-blue-500/20 bg-blue-500/15 px-1.5 py-0.5 text-[10px] font-bold text-blue-700 dark:text-blue-400">TEAM</span>;
                  if (tier === 'PRO') return <span className="inline-flex items-center rounded-sm border border-indigo-500/20 bg-indigo-500/15 px-1.5 py-0.5 text-[10px] font-bold text-indigo-700 dark:text-indigo-400">PRO</span>;
                  if (tier === 'FREE') return <span className="inline-flex items-center rounded-sm border border-zinc-500/20 bg-zinc-500/15 px-1.5 py-0.5 text-[10px] font-bold text-zinc-700 dark:text-zinc-400">FREE</span>;
                  return null;
                };

                return (
                  <tr key={cred.id} className={`transition-all duration-300 hover:bg-muted/30 ${selectedItems.has(cred.name) ? 'bg-primary/5' : ''} ${deletingNames.has(cred.name) ? 'pointer-events-none scale-[0.98] opacity-0' : 'scale-100 opacity-100'} ${togglingNames.has(cred.name) ? 'pointer-events-none opacity-50' : ''}`}>
                    <td className="px-4 py-4">
                      <input
                        type="checkbox"
                        className="h-4 w-4 rounded border-input bg-background/50 text-primary focus:ring-primary"
                        checked={selectedItems.has(cred.name)}
                        onChange={() => onToggleItem(cred.name)}
                      />
                    </td>
                    <td className="px-6 py-4">
                      <div className="font-medium text-foreground">{cred.id}</div>
                      <div className="mt-0.5 font-mono text-xs text-muted-foreground" title={cred.auth_index}>{cred.auth_index.substring(0, 16)}...</div>
                    </td>
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-2">
                        {getProviderBadge(cred.provider)}
                        {getTierBadge(cred)}
                      </div>
                    </td>
                    <td className="px-6 py-4">
                      {cred.disabled ? (
                        <div className="flex flex-col items-start gap-1">
                          {(() => {
                            const showQuotaResume = Boolean(quotaResume && isQuotaRecoveryStatus(st?.status));
                            const disabledBadge = getDisabledBadgeMeta(st?.status, showQuotaResume, t);
                            const quotaRemainingPercent = toRemainingPercent(normalizePercent(quotaResume?.usedPercent));
                            return (
                              <>
                                <div className="inline-flex items-center rounded-md border border-destructive/20 bg-destructive/10 px-2 py-1 text-xs font-medium text-destructive/90" title={st?.reason}>
                                  <XCircle className="mr-1 h-3.5 w-3.5" />
                                  {disabledBadge.label}
                                  <span className="ml-1.5 border-l border-destructive/20 pl-1.5 text-[10px] text-destructive/50">
                                    {disabledBadge.detail}
                                  </span>
                                </div>
                                {showQuotaResume && (
                                  <div className="max-w-[280px] break-words whitespace-normal text-[11px] font-medium leading-tight text-destructive/90">
                                    {t('Auto Enable At')}: {formatResetAtText(quotaResume.resetAt, t)}
                                    {quotaRemainingPercent !== null ? ` | ${t('Remaining')}: ${quotaRemainingPercent}%` : ''}
                                  </div>
                                )}
                              </>
                            );
                          })()}
                          {st?.reason && (
                            <div className="max-w-[280px] break-words whitespace-normal text-[11px] font-medium leading-tight text-destructive/90" title={st.reason}>
                              {st.reason}
                            </div>
                          )}
                          {st?.detail && (
                            <button onClick={() => onShowProbeDetail(st.detail || t('No detail'))} className="text-[11px] text-primary hover:underline">
                              {t('View Body')}
                            </button>
                          )}
                        </div>
                      ) : (
                        <div className="flex flex-col items-start gap-1">
                          <div className="flex items-center gap-2">
                            {st?.status === 'active' ? (
                              <span className="flex items-center text-emerald-500"><CheckCircle2 className="mr-1.5 h-4 w-4" /> {t('Active')}</span>
                            ) : st?.status === 'invalidated' || st?.status === 'unauthorized' || st?.status === 'deactivated' || st?.status === 'expired_by_time' || st?.status === 'quota_exhausted' || st?.status === 'quota_low_remaining' || st?.status === 'rate_limited' || st?.status === 'error' ? (
                              <span className="flex items-center text-destructive" title={st.reason}>
                                <AlertTriangle className="mr-1.5 h-4 w-4" />
                                {st.status === 'quota_low_remaining'
                                  ? t('Low Remaining Quota')
                                  : st.status === 'rate_limited'
                                    ? t('429 Rate Limited')
                                    : t(st.status)}
                              </span>
                            ) : st?.status === 'unknown' ? (
                              <span className="flex items-center text-amber-500"><AlertTriangle className="mr-1.5 h-4 w-4" /> {t('Unknown')}</span>
                            ) : (
                              <span className="flex items-center text-primary"><Clock className="mr-1.5 h-4 w-4" /> {t('Normal')}</span>
                            )}
                          </div>
                          {st?.reason && (
                            <div className="max-w-[280px] break-words whitespace-normal text-[11px] font-medium leading-tight text-destructive/90" title={st.reason}>
                              {st.reason}
                            </div>
                          )}
                          {st?.detail && (
                            <button onClick={() => onShowProbeDetail(st.detail || t('No detail'))} className="text-[11px] text-primary hover:underline">
                              {t('View Body')}
                            </button>
                          )}
                        </div>
                      )}
                    </td>
                    <td className="px-6 py-4 align-top">
                      {quotaCardBlock || <span className="text-xs text-muted-foreground">-</span>}
                    </td>
                    <td className="px-6 py-4 text-muted-foreground">
                      {st?.time || t('Never')}
                    </td>
                    <td className="space-x-2 px-6 py-4 text-right">
                      <button
                        onClick={() => onProbeSingle(cred)}
                        disabled={isProbeRunning || !canProbe}
                        className="inline-flex h-8 items-center justify-center rounded-md border border-input bg-transparent px-2.5 text-xs font-medium hover:bg-accent hover:text-accent-foreground disabled:opacity-50"
                        title={!canProbe ? t('noProbeNeeded') : ''}
                      >
                        {isProbeRunning ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
                      </button>
                      <button
                        onClick={() => onToggleStatus(cred)}
                        className={`inline-flex h-8 items-center justify-center rounded-md px-2.5 text-xs font-medium transition-colors ${cred.disabled ? 'bg-primary text-primary-foreground hover:bg-primary/90' : 'bg-secondary text-secondary-foreground hover:bg-secondary/80'} ${togglingNames.has(cred.name) ? 'animate-pulse' : ''}`}
                      >
                        {togglingNames.has(cred.name) ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : (cred.disabled ? t('Enable') : t('Disable'))}
                      </button>
                      <button
                        onClick={() => onDeleteSingle(cred.name)}
                        disabled={deletingNames.has(cred.name)}
                        className="inline-flex h-8 items-center justify-center rounded-md border border-destructive/30 bg-destructive/10 px-2.5 text-xs font-medium text-destructive hover:bg-destructive/20"
                      >
                        {deletingNames.has(cred.name) ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : t('Delete')}
                      </button>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
      <div className="flex flex-col items-start justify-between gap-3 border-t border-border bg-muted/20 px-4 py-3 md:flex-row md:items-center">
        <div className="text-xs text-muted-foreground">
          {t('Showing range', { start: totalItems === 0 ? 0 : pageStart + 1, end: pageEnd, total: totalItems })}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="text-xs text-muted-foreground">{t('Per page')}</label>
          <input
            type="number"
            min={1}
            max={100}
            value={pageSize}
            onChange={(e) => onPageSizeChange(Number(e.target.value || 1))}
            className="h-8 w-20 rounded-md border border-input bg-background px-2 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <button onClick={() => onPageSizeChange(20)} className="h-8 rounded-md border border-input px-2 text-xs hover:bg-accent">20</button>
          <button onClick={() => onPageSizeChange(50)} className="h-8 rounded-md border border-input px-2 text-xs hover:bg-accent">50</button>
          <button onClick={() => onPageSizeChange(100)} className="h-8 rounded-md border border-input px-2 text-xs hover:bg-accent">100</button>
          <div className="mx-1 text-xs text-muted-foreground">{t('Page X of Y', { page: currentPage, totalPages })}</div>
          <button
            onClick={() => onPageChange(Math.max(1, currentPage - 1))}
            disabled={currentPage <= 1}
            className="h-8 rounded-md border border-input px-3 text-xs hover:bg-accent disabled:opacity-50"
          >
            {t('Prev')}
          </button>
          <button
            onClick={() => onPageChange(Math.min(totalPages, currentPage + 1))}
            disabled={currentPage >= totalPages}
            className="h-8 rounded-md border border-input px-3 text-xs hover:bg-accent disabled:opacity-50"
          >
            {t('Next')}
          </button>
        </div>
      </div>
    </div>
  );
}
