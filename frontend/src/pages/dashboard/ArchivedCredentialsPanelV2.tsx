import { RefreshCw, Search, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  clearAuthFilesCache,
  fetchAuthFiles,
  runCredentialArchiveList,
  runCredentialArchiveRemove,
  updateCredentialStatus,
} from '../../lib/api';
import type { Credential } from '../../lib/api';
import { useGlobalModal } from '../../components/global-modal/useGlobalModal';

interface ArchivedCredentialsPanelProps {
  cpaReady: boolean;
  cpaUrl: string;
}

export default function ArchivedCredentialsPanelV2({ cpaReady, cpaUrl }: ArchivedCredentialsPanelProps) {
  const { t } = useTranslation();
  const { showAlert, showConfirm } = useGlobalModal();
  const queryClient = useQueryClient();
  const [archivedNames, setArchivedNames] = useState<string[]>([]);
  const [selectedNames, setSelectedNames] = useState<Set<string>>(new Set());
  const [searchKeyword, setSearchKeyword] = useState('');
  const [isBusy, setIsBusy] = useState(false);
  const [runningEnableNames, setRunningEnableNames] = useState<Set<string>>(new Set());

  const {
    data: credentials = [],
    isLoading,
    isError,
    error,
  } = useQuery({
    queryKey: ['credentials', cpaUrl],
    queryFn: () => fetchAuthFiles(),
    enabled: cpaReady,
    retry: 0,
    refetchOnWindowFocus: false,
  });

  const setArchivedNamesFromPayload = (payload: unknown) => {
    const record = payload as { names?: unknown } | null;
    const names = Array.isArray(record?.names)
      ? record.names.map((item) => String(item || '').trim()).filter(Boolean)
      : [];
    setArchivedNames(Array.from(new Set(names)));
  };

  const loadArchive = useCallback(async () => {
    if (!cpaReady || !cpaUrl) {
      setArchivedNames([]);
      return;
    }
    try {
      const result = await runCredentialArchiveList({ cpa_url: cpaUrl });
      setArchivedNamesFromPayload(result.payload || null);
    } catch {
      setArchivedNames([]);
    }
  }, [cpaReady, cpaUrl]);

  useEffect(() => {
    void loadArchive();
  }, [loadArchive]);

  const archivedNameSet = useMemo(() => new Set(archivedNames), [archivedNames]);
  const archivedCredentials = useMemo(
    () => credentials.filter((cred: Credential) => archivedNameSet.has(cred.name)),
    [credentials, archivedNameSet],
  );

  const filteredArchivedCredentials = useMemo(() => {
    const keyword = searchKeyword.trim().toLowerCase();
    if (!keyword) return archivedCredentials;
    return archivedCredentials.filter((cred) => {
      const haystack = [
        cred.name,
        cred.provider,
        cred.auth_index,
        cred.id,
      ].map((part) => String(part || '').toLowerCase()).join(' ');
      return haystack.includes(keyword);
    });
  }, [archivedCredentials, searchKeyword]);

  useEffect(() => {
    const valid = new Set(filteredArchivedCredentials.map((item) => item.name));
    setSelectedNames((prev) => {
      const next = new Set<string>();
      prev.forEach((name) => {
        if (valid.has(name)) {
          next.add(name);
        }
      });
      return next;
    });
  }, [filteredArchivedCredentials]);

  const refreshCredentialList = async () => {
    clearAuthFilesCache();
    await queryClient.invalidateQueries({ queryKey: ['credentials', cpaUrl] });
  };

  const refreshAll = async () => {
    await refreshCredentialList();
    await loadArchive();
  };

  const handleSelectAll = (checked: boolean) => {
    if (checked) {
      setSelectedNames(new Set(filteredArchivedCredentials.map((item) => item.name)));
      return;
    }
    setSelectedNames(new Set());
  };

  const handleToggleSelect = (name: string) => {
    setSelectedNames((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const enableAndUnarchive = async (targets: string[]) => {
    if (!targets.length) return;
    setIsBusy(true);
    try {
      const enabledNames: string[] = [];
      const failed: string[] = [];

      for (const name of targets) {
        setRunningEnableNames((prev) => new Set(prev).add(name));
        try {
          await updateCredentialStatus(name, false);
          enabledNames.push(name);
        } catch {
          failed.push(name);
        } finally {
          setRunningEnableNames((prev) => {
            const next = new Set(prev);
            next.delete(name);
            return next;
          });
        }
      }

      if (enabledNames.length) {
        const result = await runCredentialArchiveRemove({ cpa_url: cpaUrl, names: enabledNames });
        setArchivedNamesFromPayload(result.payload || null);
        setSelectedNames((prev) => {
          const next = new Set(prev);
          enabledNames.forEach((name) => next.delete(name));
          return next;
        });
      }

      await refreshCredentialList();
      if (failed.length) {
        showAlert({
          title: t('Error'),
          message: `${t('Delete Failed Credentials Prefix')}: ${failed.join(', ')}`,
          confirmText: t('Confirm', 'Confirm'),
        });
      }
    } finally {
      setIsBusy(false);
    }
  };

  const handleEnableSelected = async () => {
    const targets = Array.from(selectedNames);
    if (!targets.length) return;
    const confirmed = await showConfirm({
      title: t('Restore Archived Credentials'),
      message: t('Restore Archived Credentials Message', { count: targets.length }),
      confirmText: t('Confirm', 'Confirm'),
      cancelText: t('Cancel', 'Cancel'),
    });
    if (!confirmed) return;
    await enableAndUnarchive(targets);
  };

  const handleEnableSingle = async (name: string) => {
    const confirmed = await showConfirm({
      title: t('Restore Archived Credential'),
      message: t('Restore Archived Credential Message', { name }),
      confirmText: t('Confirm', 'Confirm'),
      cancelText: t('Cancel', 'Cancel'),
    });
    if (!confirmed) return;
    await enableAndUnarchive([name]);
  };

  return (
    <div className="space-y-6">
      <div className="rounded-xl border border-border bg-card p-6 shadow-sm">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="space-y-2">
            <h2 className="flex items-center gap-2 text-xl font-semibold">
              <Trash2 className="h-5 w-5 text-primary" />
              {t('Archive')}
            </h2>
            <p className="text-sm text-muted-foreground">
              {t('Archived credentials are excluded from the main list. Restore them here before any further manual action.')}
            </p>
            <p className="text-xs text-amber-600 dark:text-amber-400">
              {t('Archived credentials cannot be deleted directly from this page.')}
            </p>
          </div>

          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => { void refreshAll(); }}
              disabled={!cpaReady || isBusy}
              className="inline-flex h-9 items-center justify-center rounded-md border border-input bg-transparent px-4 py-2 text-sm font-medium hover:bg-accent hover:text-accent-foreground disabled:opacity-50"
            >
              <RefreshCw className="mr-2 h-4 w-4" />
              {t('Refresh')}
            </button>
            <button
              onClick={handleEnableSelected}
              disabled={!cpaReady || isBusy || selectedNames.size === 0}
              className="inline-flex h-9 items-center justify-center rounded-md border border-input bg-transparent px-4 py-2 text-sm font-medium hover:bg-accent hover:text-accent-foreground disabled:opacity-50"
            >
              {t('Restore Selected')}
            </button>
          </div>
        </div>

        <div className="mt-4 grid gap-3 lg:grid-cols-[1fr_auto_auto] lg:items-center">
          <label className="relative block">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              type="text"
              value={searchKeyword}
              onChange={(e) => setSearchKeyword(e.target.value)}
              placeholder={t('Search archived credentials')}
              className="h-10 w-full rounded-md border border-input bg-background pl-9 pr-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </label>
          <span className="inline-flex items-center rounded-full border border-border bg-muted/40 px-2.5 py-1 text-xs font-medium text-foreground/90">
            {t('Archived')} {archivedCredentials.length}
          </span>
          <span className="inline-flex items-center rounded-full border border-border bg-background px-2.5 py-1 text-xs font-medium text-foreground/90">
            {t('Selected')} {selectedNames.size}
          </span>
        </div>
      </div>

      <div className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
        <div className="overflow-x-auto">
          <table className="min-w-[980px] w-full whitespace-nowrap text-left text-sm">
            <thead className="border-b border-border bg-muted/50 text-xs font-medium uppercase text-muted-foreground">
              <tr>
                <th className="w-10 px-4 py-3">
                  <input
                    type="checkbox"
                    className="h-4 w-4 rounded border-input bg-background/50 text-primary focus:ring-primary"
                    checked={filteredArchivedCredentials.length > 0 && filteredArchivedCredentials.every((item) => selectedNames.has(item.name))}
                    onChange={(e) => handleSelectAll(e.target.checked)}
                  />
                </th>
                <th className="px-4 py-3">{t('Credential')}</th>
                <th className="px-4 py-3">{t('Provider')}</th>
                <th className="px-4 py-3">{t('Current State')}</th>
                <th className="px-4 py-3 text-right">{t('Actions')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {!cpaReady ? (
                <tr><td colSpan={5} className="px-6 py-8 text-center text-muted-foreground">{t('Initializing connection...')}</td></tr>
              ) : isLoading ? (
                <tr><td colSpan={5} className="px-6 py-8 text-center text-muted-foreground">{t('Loading credentials...')}</td></tr>
              ) : isError ? (
                <tr><td colSpan={5} className="px-6 py-8 text-center text-destructive">{String((error as { message?: string })?.message || t('Failed to load credentials.'))}</td></tr>
              ) : filteredArchivedCredentials.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-6 py-8 text-center text-muted-foreground">
                    {searchKeyword.trim() ? t('No archived credentials match the current search.') : t('No archived credentials.')}
                  </td>
                </tr>
              ) : (
                filteredArchivedCredentials.map((cred) => {
                  const enabling = runningEnableNames.has(cred.name);
                  return (
                    <tr key={`archive-row-${cred.name}`} className="hover:bg-muted/20">
                      <td className="px-4 py-3">
                        <input
                          type="checkbox"
                          className="h-4 w-4 rounded border-input bg-background/50 text-primary focus:ring-primary"
                          checked={selectedNames.has(cred.name)}
                          onChange={() => handleToggleSelect(cred.name)}
                        />
                      </td>
                      <td className="px-4 py-3">
                        <div className="font-medium text-foreground">{cred.name}</div>
                        <div className="mt-0.5 font-mono text-xs text-muted-foreground">{String(cred.auth_index || '').slice(0, 16)}...</div>
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">{cred.provider}</td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex items-center rounded-md px-2 py-0.5 text-[11px] font-medium ${cred.disabled ? 'border border-destructive/20 bg-destructive/10 text-destructive/90' : 'border border-amber-300/30 bg-amber-100/60 text-amber-700 dark:bg-amber-900/20 dark:text-amber-300'}`}>
                          {cred.disabled ? t('Disabled and archived') : t('Archived only')}
                        </span>
                      </td>
                      <td className="space-x-2 px-4 py-3 text-right">
                        <button
                          onClick={() => { void handleEnableSingle(cred.name); }}
                          disabled={isBusy || enabling}
                        className="inline-flex h-8 items-center justify-center rounded-md border border-input bg-transparent px-2.5 text-xs font-medium hover:bg-accent hover:text-accent-foreground disabled:opacity-50"
                      >
                          {enabling ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : t('Restore')}
                        </button>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
