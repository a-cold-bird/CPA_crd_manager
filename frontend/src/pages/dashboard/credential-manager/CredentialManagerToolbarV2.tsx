import { RefreshCw, ShieldAlert } from 'lucide-react';
import type { TFunction } from 'i18next';
import type { StatusFilter } from './types';

interface CredentialManagerToolbarProps {
  t: TFunction;
  totalCredentialCount: number;
  disabledCredentialCount: number;
  archivedCredentialCount: number;
  availableProviders: string[];
  providerStats: Record<string, { total: number; disabled: number }>;
  filterProvider: string;
  setFilterProvider: (value: string) => void;
  statusFilter: StatusFilter;
  setStatusFilter: (value: StatusFilter) => void;
  searchKeyword: string;
  setSearchKeyword: (value: string) => void;
  isAutoDisable: boolean;
  setIsAutoDisable: (value: boolean) => void;
  cpaReady: boolean;
  isFetching: boolean;
  onRefreshList: () => void;
  isProbingAll: boolean;
  filteredCredentialCount: number;
  onProbeAll: () => void;
  probeCancelRequested: boolean;
  onCancelProbeAll: () => void;
  isArchiveBusy: boolean;
  disabledFilteredCount: number;
  onArchiveDisabled: () => void;
  onDeleteDisabled: () => void;
  autoProbeEnabled: boolean;
  setAutoProbeEnabled: (value: boolean) => void;
  autoProbeIntervalMinutes: number;
  onAutoProbeIntervalChange: (value: number) => void;
  probeBatchSize: number;
  onProbeBatchSizeChange: (value: number) => void;
  probeBatchIntervalMs: number;
  onProbeBatchIntervalChange: (value: number) => void;
  quotaDisableThresholdLabel: string;
  quotaDisableThresholdHint: string;
  codexQuotaDisableRemainingPercent: number;
  onQuotaDisableRemainingPercentChange: (value: number) => void;
  autoProbeConfigHint: string;
  backendAutomationHint: string;
}

export default function CredentialManagerToolbarV2({
  t,
  totalCredentialCount,
  disabledCredentialCount,
  archivedCredentialCount,
  availableProviders,
  providerStats,
  filterProvider,
  setFilterProvider,
  statusFilter,
  setStatusFilter,
  searchKeyword,
  setSearchKeyword,
  isAutoDisable,
  setIsAutoDisable,
  cpaReady,
  isFetching,
  onRefreshList,
  isProbingAll,
  filteredCredentialCount,
  onProbeAll,
  probeCancelRequested,
  onCancelProbeAll,
  isArchiveBusy,
  disabledFilteredCount,
  onArchiveDisabled,
  onDeleteDisabled,
  autoProbeEnabled,
  setAutoProbeEnabled,
  autoProbeIntervalMinutes,
  onAutoProbeIntervalChange,
  probeBatchSize,
  onProbeBatchSizeChange,
  probeBatchIntervalMs,
  onProbeBatchIntervalChange,
  quotaDisableThresholdLabel,
  quotaDisableThresholdHint,
  codexQuotaDisableRemainingPercent,
  onQuotaDisableRemainingPercentChange,
  autoProbeConfigHint,
  backendAutomationHint,
}: CredentialManagerToolbarProps) {
  return (
    <div className="flex flex-col items-start justify-between gap-4 rounded-xl border border-border bg-card p-6 shadow-sm md:flex-row md:items-center">
      <div>
        <h2 className="mb-1 flex items-center gap-2 text-xl font-semibold">
          <ShieldAlert className="h-5 w-5 text-primary" /> {t('Authentication Keys')}
        </h2>
        <p className="text-sm text-muted-foreground">{t('Manage and auto-disable your API keys effectively.')}</p>
        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
          <span className="inline-flex items-center rounded-full border border-border bg-muted/40 px-2.5 py-1 font-medium text-foreground/90">
            {t('Total')} {totalCredentialCount}
          </span>
          <span className="inline-flex items-center rounded-full border border-border bg-rose-50 px-2.5 py-1 font-medium text-rose-700 dark:bg-rose-900/20 dark:text-rose-300">
            {t('Disabled')} {disabledCredentialCount}
          </span>
          <span className="inline-flex items-center rounded-full border border-border bg-amber-50 px-2.5 py-1 font-medium text-amber-700 dark:bg-amber-900/20 dark:text-amber-300">
            {t('Archived')} {archivedCredentialCount}
          </span>
        </div>
        {availableProviders.length > 0 && (
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
            {availableProviders.map((provider) => {
              const stats = providerStats[provider] || { total: 0, disabled: 0 };
              return (
                <span key={`summary-${provider}`} className="inline-flex items-center rounded-full border border-border bg-background px-2.5 py-1 font-medium text-foreground/90">
                  {provider} {stats.total}/{stats.disabled}
                </span>
              );
            })}
          </div>
        )}
      </div>
      <div className="flex w-full flex-col gap-2 md:flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <div className="mr-1 flex items-center space-x-1 overflow-x-auto rounded-full border border-border bg-background/50 p-1">
            <button
              onClick={() => setFilterProvider('all')}
              className={`flex items-center whitespace-nowrap rounded-full px-3 py-1 text-xs font-bold transition-all ${filterProvider === 'all' ? 'bg-primary text-primary-foreground shadow-sm' : 'text-muted-foreground hover:bg-muted'}`}
            >
              {t('All')} <span className={`ml-1.5 rounded-full px-1.5 text-[10px] ${filterProvider === 'all' ? 'bg-background/20 text-white' : 'bg-foreground/10 text-foreground/70'}`}>{totalCredentialCount}</span>
            </button>
            {availableProviders.map((provider) => {
              const count = providerStats[provider]?.total || 0;
              const isSelected = filterProvider === provider;
              let activeBg = 'bg-secondary text-secondary-foreground shadow-sm';
              if (provider.toLowerCase() === 'antigravity') activeBg = 'bg-teal-500 text-white shadow-[0_0_10px_rgba(20,184,166,0.3)] shadow-sm';
              else if (provider.toLowerCase() === 'codex') activeBg = 'bg-amber-500 text-white shadow-[0_0_10px_rgba(245,158,11,0.3)] shadow-sm';
              else if (provider.toLowerCase() === 'iflow') activeBg = 'bg-purple-600 text-white shadow-[0_0_10px_rgba(147,51,234,0.3)] shadow-sm';

              return (
                <button
                  key={provider}
                  onClick={() => setFilterProvider(provider)}
                  className={`flex items-center whitespace-nowrap rounded-full px-3 py-1 text-xs font-bold transition-all ${isSelected ? activeBg : 'text-muted-foreground hover:bg-muted'}`}
                >
                  {provider} <span className={`ml-1.5 rounded-full px-1.5 text-[10px] ${isSelected ? 'bg-black/20 text-white' : 'bg-foreground/10 text-foreground/70'}`}>{count}</span>
                </button>
              );
            })}
          </div>

          <div className="flex items-center gap-2 whitespace-nowrap text-xs text-muted-foreground">
            <span>{t('Status Filter')}</span>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
              className="h-8 rounded-md border border-input bg-background px-2 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <option value="all">{t('All')}</option>
              <option value="enabled">{t('Enabled Only')}</option>
              <option value="disabled">{t('Disabled Only')}</option>
            </select>
          </div>

          <div className="flex items-center gap-2 whitespace-nowrap text-xs text-muted-foreground">
            <input
              type="text"
              value={searchKeyword}
              onChange={(e) => setSearchKeyword(e.target.value)}
              placeholder={t('Search Credentials')}
              className="h-8 w-56 rounded-md border border-input bg-background px-2 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </div>

          <label className="mr-1 flex cursor-pointer items-center gap-2 whitespace-nowrap text-sm text-muted-foreground">
            <input type="checkbox" checked={isAutoDisable} onChange={(e) => setIsAutoDisable(e.target.checked)} className="h-4 w-4 rounded border-input bg-background/50 text-primary focus:ring-primary" />
            {t('Auto-disable')}
          </label>

          <button
            onClick={onRefreshList}
            disabled={!cpaReady || isFetching}
            className="inline-flex h-9 shrink-0 items-center justify-center rounded-md border border-input bg-transparent px-4 py-2 text-sm font-medium hover:bg-accent hover:text-accent-foreground disabled:opacity-50"
          >
            {isFetching ? <RefreshCw className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
            {t('Refresh List')}
          </button>
          <button
            onClick={onProbeAll}
            disabled={!cpaReady || isProbingAll || filteredCredentialCount === 0}
            className="inline-flex h-9 shrink-0 items-center justify-center rounded-md border border-input bg-transparent px-4 py-2 text-sm font-medium hover:bg-accent hover:text-accent-foreground disabled:opacity-50"
          >
            {isProbingAll ? <RefreshCw className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
            {t('Probe List')}
          </button>
          {isProbingAll && (
            <button
              onClick={onCancelProbeAll}
              className="inline-flex h-9 shrink-0 items-center justify-center rounded-md border border-destructive/40 bg-destructive/10 px-4 py-2 text-sm font-medium text-destructive hover:bg-destructive/20"
            >
              {probeCancelRequested ? t('Cancelling...') : t('Cancel Probe')}
            </button>
          )}
          <button
            onClick={onArchiveDisabled}
            disabled={isArchiveBusy || disabledFilteredCount === 0}
            className="inline-flex h-9 shrink-0 items-center justify-center rounded-md border border-input bg-transparent px-4 py-2 text-sm font-medium hover:bg-accent hover:text-accent-foreground disabled:opacity-50"
          >
            {t('Archive Disabled')}
          </button>
          <button
            onClick={onDeleteDisabled}
            disabled={isArchiveBusy || disabledFilteredCount === 0}
            className="inline-flex h-9 shrink-0 items-center justify-center rounded-md border border-destructive/30 bg-destructive/10 px-4 py-2 text-sm font-medium text-destructive hover:bg-destructive/20 disabled:opacity-50"
          >
            {t('Delete Disabled')}
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-2 md:justify-end">
          <div className="flex items-center gap-2 whitespace-nowrap rounded-md border border-border bg-background/50 px-2 py-1 text-xs text-muted-foreground">
            <input
              id="auto-probe-enabled"
              type="checkbox"
              checked={autoProbeEnabled}
              onChange={(e) => setAutoProbeEnabled(e.target.checked)}
              className="h-4 w-4 rounded border-input bg-background/50 text-primary focus:ring-primary"
            />
            <label htmlFor="auto-probe-enabled" className="cursor-pointer">{t('Auto Probe')}</label>
          </div>
          <div className="flex items-center gap-2 whitespace-nowrap text-xs text-muted-foreground">
            <span>{t('Auto Probe Interval(min)')}</span>
            <input
              type="number"
              min={1}
              max={1440}
              value={autoProbeIntervalMinutes}
              onChange={(e) => onAutoProbeIntervalChange(Number(e.target.value || 1))}
              className="h-8 w-20 rounded-md border border-input bg-background px-2 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </div>
          <div className="flex items-center gap-2 whitespace-nowrap text-xs text-muted-foreground">
            <span>{t('Probe batch size')}</span>
            <input
              type="number"
              min={1}
              max={100}
              value={probeBatchSize}
              onChange={(e) => onProbeBatchSizeChange(Number(e.target.value || 1))}
              className="h-8 w-16 rounded-md border border-input bg-background px-2 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </div>
          <div className="flex items-center gap-2 whitespace-nowrap text-xs text-muted-foreground">
            <span>{t('Probe batch interval(ms)')}</span>
            <input
              type="number"
              min={0}
              max={10000}
              value={probeBatchIntervalMs}
              onChange={(e) => onProbeBatchIntervalChange(Number(e.target.value || 0))}
              className="h-8 w-20 rounded-md border border-input bg-background px-2 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </div>
          <div className="flex items-center gap-2 whitespace-nowrap text-xs text-muted-foreground">
            <span>{quotaDisableThresholdLabel}</span>
            <input
              type="number"
              min={0}
              max={100}
              value={codexQuotaDisableRemainingPercent}
              onChange={(e) => onQuotaDisableRemainingPercentChange(Number(e.target.value || 0))}
              className="h-8 w-20 rounded-md border border-input bg-background px-2 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              title={quotaDisableThresholdHint}
            />
          </div>
          {autoProbeConfigHint && (
            <div className="w-full text-right text-[11px] text-muted-foreground md:pr-1">
              {autoProbeConfigHint}
            </div>
          )}
          {backendAutomationHint && (
            <div className="w-full text-right text-[11px] text-muted-foreground md:pr-1">
              {backendAutomationHint}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
