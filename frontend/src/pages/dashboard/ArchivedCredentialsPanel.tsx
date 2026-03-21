import { RefreshCw, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  clearAuthFilesCache,
  deleteCredential,
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

export default function ArchivedCredentialsPanel({ cpaReady, cpaUrl }: ArchivedCredentialsPanelProps) {
  const { t } = useTranslation();
  const { showAlert, showConfirm } = useGlobalModal();
  const queryClient = useQueryClient();
  const [archivedNames, setArchivedNames] = useState<string[]>([]);
  const [selectedNames, setSelectedNames] = useState<Set<string>>(new Set());
  const [isBusy, setIsBusy] = useState(false);
  const [runningEnableNames, setRunningEnableNames] = useState<Set<string>>(new Set());
  const [runningDeleteNames, setRunningDeleteNames] = useState<Set<string>>(new Set());

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

  useEffect(() => {
    const valid = new Set(archivedCredentials.map((item) => item.name));
    setSelectedNames((prev) => {
      const next = new Set<string>();
      prev.forEach((name) => {
        if (valid.has(name)) {
          next.add(name);
        }
      });
      return next;
    });
  }, [archivedCredentials]);

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
      setSelectedNames(new Set(archivedCredentials.map((item) => item.name)));
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
          message: `以下凭证再启用失败：${failed.join(', ')}`,
          confirmText: t('Confirm', 'Confirm'),
        });
      }
    } finally {
      setIsBusy(false);
    }
  };

  const deleteArchivedTargets = async (targets: string[]) => {
    if (!targets.length) return;
    setIsBusy(true);
    try {
      const deletedNames: string[] = [];
      const failed: string[] = [];
      for (const name of targets) {
        setRunningDeleteNames((prev) => new Set(prev).add(name));
        try {
          await deleteCredential(name);
          deletedNames.push(name);
        } catch {
          failed.push(name);
        } finally {
          setRunningDeleteNames((prev) => {
            const next = new Set(prev);
            next.delete(name);
            return next;
          });
        }
      }
      if (deletedNames.length) {
        const result = await runCredentialArchiveRemove({ cpa_url: cpaUrl, names: deletedNames });
        setArchivedNamesFromPayload(result.payload || null);
        setSelectedNames((prev) => {
          const next = new Set(prev);
          deletedNames.forEach((name) => next.delete(name));
          return next;
        });
      }
      await refreshCredentialList();
      if (failed.length) {
        showAlert({
          title: t('Error'),
          message: `以下凭证删除失败：${failed.join(', ')}`,
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
      title: '再启用归档凭证',
      message: `将再启用 ${targets.length} 个归档凭证并移出归档，是否继续？`,
      confirmText: t('Confirm', 'Confirm'),
      cancelText: t('Cancel', 'Cancel'),
    });
    if (!confirmed) return;
    await enableAndUnarchive(targets);
  };

  const handleEnableSingle = async (name: string) => {
    const confirmed = await showConfirm({
      title: '再启用归档凭证',
      message: `将再启用 ${name} 并移出归档，是否继续？`,
      confirmText: t('Confirm', 'Confirm'),
      cancelText: t('Cancel', 'Cancel'),
    });
    if (!confirmed) return;
    await enableAndUnarchive([name]);
  };

  const handleDeleteSelected = async () => {
    const targets = Array.from(selectedNames);
    if (!targets.length) return;
    const confirmed = await showConfirm({
      title: '批量删除归档凭证',
      message: `将永久删除 ${targets.length} 个归档凭证，是否继续？`,
      confirmText: t('Confirm', 'Confirm'),
      cancelText: t('Cancel', 'Cancel'),
    });
    if (!confirmed) return;
    await deleteArchivedTargets(targets);
  };

  const handleDeleteSingle = async (name: string) => {
    const confirmed = await showConfirm({
      title: '删除归档凭证',
      message: `将永久删除 ${name}，是否继续？`,
      confirmText: t('Confirm', 'Confirm'),
      cancelText: t('Cancel', 'Cancel'),
    });
    if (!confirmed) return;
    await deleteArchivedTargets([name]);
  };

  return (
    <div className="space-y-6">
      <div className="rounded-xl border border-border bg-card p-6 shadow-sm">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div>
            <h2 className="mb-1 flex items-center gap-2 text-xl font-semibold">
              <Trash2 className="h-5 w-5 text-primary" />
              归档回收站
            </h2>
            <p className="text-sm text-muted-foreground">归档凭证不会在主列表中使用，可在这里再启用或永久删除。</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => { void refreshAll(); }}
              disabled={!cpaReady || isBusy}
              className="inline-flex h-9 items-center justify-center rounded-md border border-input bg-transparent px-4 py-2 text-sm font-medium hover:bg-accent hover:text-accent-foreground disabled:opacity-50"
            >
              <RefreshCw className="mr-2 h-4 w-4" />
              刷新
            </button>
            <button
              onClick={handleEnableSelected}
              disabled={!cpaReady || isBusy || selectedNames.size === 0}
              className="inline-flex h-9 items-center justify-center rounded-md border border-input bg-transparent px-4 py-2 text-sm font-medium hover:bg-accent hover:text-accent-foreground disabled:opacity-50"
            >
              再启用选中
            </button>
            <button
              onClick={handleDeleteSelected}
              disabled={!cpaReady || isBusy || selectedNames.size === 0}
              className="inline-flex h-9 items-center justify-center rounded-md border border-destructive/30 bg-destructive/10 px-4 py-2 text-sm font-medium text-destructive hover:bg-destructive/20 disabled:opacity-50"
            >
              批量删除
            </button>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
          <span className="inline-flex items-center rounded-full border border-border bg-muted/40 px-2.5 py-1 font-medium text-foreground/90">
            归档总数 {archivedCredentials.length}
          </span>
          <span className="inline-flex items-center rounded-full border border-border bg-background px-2.5 py-1 font-medium text-foreground/90">
            已选 {selectedNames.size}
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
                    checked={archivedCredentials.length > 0 && archivedCredentials.every((item) => selectedNames.has(item.name))}
                    onChange={(e) => handleSelectAll(e.target.checked)}
                  />
                </th>
                <th className="px-4 py-3">凭证</th>
                <th className="px-4 py-3">Provider</th>
                <th className="px-4 py-3">当前状态</th>
                <th className="px-4 py-3 text-right">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {!cpaReady ? (
                <tr><td colSpan={5} className="px-6 py-8 text-center text-muted-foreground">Initializing connection...</td></tr>
              ) : isLoading ? (
                <tr><td colSpan={5} className="px-6 py-8 text-center text-muted-foreground">Loading credentials...</td></tr>
              ) : isError ? (
                <tr><td colSpan={5} className="px-6 py-8 text-center text-destructive">{String((error as { message?: string })?.message || 'Failed to load credentials.')}</td></tr>
              ) : archivedCredentials.length === 0 ? (
                <tr><td colSpan={5} className="px-6 py-8 text-center text-muted-foreground">暂无归档凭证</td></tr>
              ) : (
                archivedCredentials.map((cred) => {
                  const enabling = runningEnableNames.has(cred.name);
                  const deleting = runningDeleteNames.has(cred.name);
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
                          {cred.disabled ? '已禁用(归档)' : '已归档(未禁用)'}
                        </span>
                      </td>
                      <td className="space-x-2 px-4 py-3 text-right">
                        <button
                          onClick={() => { void handleEnableSingle(cred.name); }}
                          disabled={isBusy || enabling || deleting}
                          className="inline-flex h-8 items-center justify-center rounded-md border border-input bg-transparent px-2.5 text-xs font-medium hover:bg-accent hover:text-accent-foreground disabled:opacity-50"
                        >
                          {enabling ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : '再启用'}
                        </button>
                        <button
                          onClick={() => { void handleDeleteSingle(cred.name); }}
                          disabled={isBusy || deleting || enabling}
                          className="inline-flex h-8 items-center justify-center rounded-md border border-destructive/30 bg-destructive/10 px-2.5 text-xs font-medium text-destructive hover:bg-destructive/20 disabled:opacity-50"
                        >
                          {deleting ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : '删除'}
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
