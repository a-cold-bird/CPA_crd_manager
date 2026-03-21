import { RefreshCw, Search, Trash2 } from 'lucide-react';
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

interface ArchiveEntry {
  name: string;
  archived_at: number | null;
  archived_at_iso: string;
}

interface ArchiveRow {
  entry: ArchiveEntry;
  credential: Credential | null;
}

function normalizeArchiveEntries(payload: unknown): ArchiveEntry[] {
  const source = payload && typeof payload === 'object'
    ? payload as { entries?: unknown; names?: unknown }
    : null;
  const rawEntries = Array.isArray(source?.entries) ? source.entries : [];

  if (rawEntries.length > 0) {
    return rawEntries
      .map((item) => {
        const record = item && typeof item === 'object'
          ? item as { name?: unknown; archived_at?: unknown; archived_at_iso?: unknown }
          : null;
        const name = String(record?.name || '').trim();
        if (!name) return null;
        const archivedAt = Number(record?.archived_at);
        return {
          name,
          archived_at: Number.isFinite(archivedAt) && archivedAt > 0 ? archivedAt : null,
          archived_at_iso: String(record?.archived_at_iso || '').trim(),
        };
      })
      .filter((item): item is ArchiveEntry => Boolean(item));
  }

  const rawNames = Array.isArray(source?.names) ? source.names : [];
  return rawNames
    .map((item) => String(item || '').trim())
    .filter(Boolean)
    .map((name) => ({
      name,
      archived_at: null,
      archived_at_iso: '',
    }));
}

function formatArchivedAt(entry: ArchiveEntry, language: string): string {
  const ts = entry.archived_at;
  if (!ts) return language.startsWith('zh') ? '\u672a\u77e5' : 'Unknown';
  const date = new Date(ts);
  if (!Number.isFinite(date.getTime())) {
    return language.startsWith('zh') ? '\u672a\u77e5' : 'Unknown';
  }
  return date.toLocaleString(language.startsWith('zh') ? 'zh-CN' : 'en-US');
}

export default function ArchivedCredentialsPanelV3({ cpaReady, cpaUrl }: ArchivedCredentialsPanelProps) {
  const { i18n } = useTranslation();
  const isZh = i18n.language.startsWith('zh');
  const zhText: Record<string, string> = {
    Error: '\u9519\u8bef',
    Confirm: '\u786e\u8ba4',
    Cancel: '\u53d6\u6d88',
    Archive: '\u5f52\u6863',
    Refresh: '\u5237\u65b0',
    'Restore Selected': '\u6062\u590d\u9009\u4e2d',
    'Delete Selected': '\u5220\u9664\u9009\u4e2d',
    'Search archived credentials': '\u641c\u7d22\u5f52\u6863\u51ed\u8bc1',
    Archived: '\u5f52\u6863',
    Selected: '\u5df2\u9009\u4e2d',
    Credential: '\u51ed\u8bc1',
    Provider: '\u63d0\u4f9b\u65b9',
    'Archived At': '\u5f52\u6863\u65f6\u95f4',
    'Current State': '\u5f53\u524d\u72b6\u6001',
    Actions: '\u64cd\u4f5c',
    'Initializing connection...': '\u6b63\u5728\u521d\u59cb\u5316\u8fde\u63a5...',
    'Loading credentials...': '\u6b63\u5728\u52a0\u8f7d\u51ed\u8bc1...',
    'Failed to load credentials.': '\u52a0\u8f7d\u51ed\u8bc1\u5931\u8d25\u3002',
    'No archived credentials match the current search.': '\u6ca1\u6709\u5f52\u6863\u51ed\u8bc1\u5339\u914d\u5f53\u524d\u641c\u7d22\u6761\u4ef6\u3002',
    'No archived credentials.': '\u6682\u65e0\u5f52\u6863\u51ed\u8bc1\u3002',
    'Credential not currently loaded': '\u5f53\u524d\u672a\u52a0\u8f7d\u5230\u8be5\u51ed\u8bc1',
    'Disabled and archived': '\u5df2\u7981\u7528\u5e76\u5f52\u6863',
    'Archived only': '\u4ec5\u5f52\u6863',
    Restore: '\u6062\u590d',
    Delete: '\u5220\u9664',
    'Failed to restore': '\u6062\u590d\u5931\u8d25',
    'Failed to delete': '\u5220\u9664\u5931\u8d25',
    'Restore Archived Credentials': '\u6062\u590d\u5f52\u6863\u51ed\u8bc1',
    'Delete Archived Credentials': '\u5220\u9664\u5f52\u6863\u51ed\u8bc1',
    'Restore Archived Credential': '\u6062\u590d\u5f52\u6863\u51ed\u8bc1',
    'Delete Archived Credential': '\u5220\u9664\u5f52\u6863\u51ed\u8bc1',
    'Archived credentials are hidden from the main list. You can restore or delete them here.': '\u5f52\u6863\u51ed\u8bc1\u4e0d\u4f1a\u51fa\u73b0\u5728\u4e3b\u5217\u8868\u4e2d\u3002\u4f60\u53ef\u4ee5\u5728\u8fd9\u91cc\u6062\u590d\u6216\u5220\u9664\u5b83\u4eec\u3002',
  };
  const text = (en: string, zhFallback?: string) => (isZh ? (zhText[en] ?? zhFallback ?? en) : en);
  const { showAlert, showConfirm } = useGlobalModal();
  const queryClient = useQueryClient();
  const [archiveEntries, setArchiveEntries] = useState<ArchiveEntry[]>([]);
  const [selectedNames, setSelectedNames] = useState<Set<string>>(new Set());
  const [searchKeyword, setSearchKeyword] = useState('');
  const [isBusy, setIsBusy] = useState(false);
  const [runningRestoreNames, setRunningRestoreNames] = useState<Set<string>>(new Set());
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

  const setArchiveEntriesFromPayload = useCallback((payload: unknown) => {
    setArchiveEntries(normalizeArchiveEntries(payload));
  }, []);

  const loadArchive = useCallback(async () => {
    if (!cpaReady || !cpaUrl) {
      setArchiveEntries([]);
      return;
    }
    try {
      const result = await runCredentialArchiveList({ cpa_url: cpaUrl });
      setArchiveEntriesFromPayload(result.payload || null);
    } catch {
      setArchiveEntries([]);
    }
  }, [cpaReady, cpaUrl, setArchiveEntriesFromPayload]);

  useEffect(() => {
    void loadArchive();
  }, [loadArchive]);

  const credentialByName = useMemo(() => {
    const next = new Map<string, Credential>();
    credentials.forEach((credential) => {
      next.set(credential.name, credential);
    });
    return next;
  }, [credentials]);

  const archiveRows = useMemo<ArchiveRow[]>(() => (
    archiveEntries.map((entry) => ({
      entry,
      credential: credentialByName.get(entry.name) || null,
    }))
  ), [archiveEntries, credentialByName]);

  const filteredRows = useMemo(() => {
    const keyword = searchKeyword.trim().toLowerCase();
    if (!keyword) return archiveRows;
    return archiveRows.filter(({ entry, credential }) => {
      const haystack = [
        entry.name,
        credential?.provider,
        credential?.auth_index,
        credential?.id,
      ].map((part) => String(part || '').toLowerCase()).join(' ');
      return haystack.includes(keyword);
    });
  }, [archiveRows, searchKeyword]);

  useEffect(() => {
    const valid = new Set(filteredRows.map((item) => item.entry.name));
    setSelectedNames((prev) => {
      const next = new Set<string>();
      prev.forEach((name) => {
        if (valid.has(name)) next.add(name);
      });
      return next;
    });
  }, [filteredRows]);

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
      setSelectedNames(new Set(filteredRows.map((item) => item.entry.name)));
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

  const removeFromArchive = async (names: string[]) => {
    const uniqueNames = Array.from(new Set(names.map((item) => String(item || '').trim()).filter(Boolean)));
    if (!uniqueNames.length) return;
    const result = await runCredentialArchiveRemove({ cpa_url: cpaUrl, names: uniqueNames });
    setArchiveEntriesFromPayload(result.payload || null);
    setSelectedNames((prev) => {
      const next = new Set(prev);
      uniqueNames.forEach((name) => next.delete(name));
      return next;
    });
  };

  const restoreArchived = async (targets: string[]) => {
    if (!targets.length) return;
    setIsBusy(true);
    try {
      const removableNames: string[] = [];
      const failedNames: string[] = [];

      for (const name of targets) {
        setRunningRestoreNames((prev) => new Set(prev).add(name));
        try {
          const credential = credentialByName.get(name) || null;
          if (credential) {
            await updateCredentialStatus(name, false);
          }
          removableNames.push(name);
        } catch {
          failedNames.push(name);
        } finally {
          setRunningRestoreNames((prev) => {
            const next = new Set(prev);
            next.delete(name);
            return next;
          });
        }
      }

      if (removableNames.length) {
        await removeFromArchive(removableNames);
      }

      await refreshCredentialList();
      if (failedNames.length) {
        showAlert({
          title: text('Error', '閿欒'),
          message: `${text('Failed to restore', '鎭㈠澶辫触')}: ${failedNames.join(', ')}`,
          confirmText: text('Confirm', '纭'),
        });
      }
    } finally {
      setIsBusy(false);
    }
  };

  const deleteArchived = async (targets: string[]) => {
    if (!targets.length) return;
    setIsBusy(true);
    try {
      const removableNames: string[] = [];
      const failedNames: string[] = [];

      for (const name of targets) {
        setRunningDeleteNames((prev) => new Set(prev).add(name));
        try {
          const credential = credentialByName.get(name) || null;
          if (credential) {
            await deleteCredential(name);
          }
          removableNames.push(name);
        } catch {
          failedNames.push(name);
        } finally {
          setRunningDeleteNames((prev) => {
            const next = new Set(prev);
            next.delete(name);
            return next;
          });
        }
      }

      if (removableNames.length) {
        await removeFromArchive(removableNames);
      }

      await refreshCredentialList();
      if (failedNames.length) {
        showAlert({
          title: text('Error', '閿欒'),
          message: `${text('Failed to delete', '鍒犻櫎澶辫触')}: ${failedNames.join(', ')}`,
          confirmText: text('Confirm', '纭'),
        });
      }
    } finally {
      setIsBusy(false);
    }
  };

  const handleRestoreSelected = async () => {
    const targets = Array.from(selectedNames);
    if (!targets.length) return;
    const confirmed = await showConfirm({
      title: text('Restore Archived Credentials', '鎭㈠褰掓。鍑瘉'),
      message: text(`Restore ${targets.length} archived credential(s)?`, `\u6062\u590d ${targets.length} \u4e2a\u5f52\u6863\u51ed\u8bc1\uff1f`),
      confirmText: text('Confirm', '纭'),
      cancelText: text('Cancel', '鍙栨秷'),
    });
    if (!confirmed) return;
    await restoreArchived(targets);
  };

  const handleDeleteSelected = async () => {
    const targets = Array.from(selectedNames);
    if (!targets.length) return;
    const confirmed = await showConfirm({
      title: text('Delete Archived Credentials', '鍒犻櫎褰掓。鍑瘉'),
      message: text(`Permanently delete ${targets.length} archived credential(s)?`, `\u6c38\u4e45\u5220\u9664 ${targets.length} \u4e2a\u5f52\u6863\u51ed\u8bc1\uff1f`),
      confirmText: text('Delete', '鍒犻櫎'),
      cancelText: text('Cancel', '鍙栨秷'),
    });
    if (!confirmed) return;
    await deleteArchived(targets);
  };

  const handleRestoreSingle = async (name: string) => {
    const confirmed = await showConfirm({
      title: text('Restore Archived Credential', '鎭㈠褰掓。鍑瘉'),
      message: text(`Restore ${name}?`, `\u6062\u590d ${name}\uff1f`),
      confirmText: text('Confirm', '纭'),
      cancelText: text('Cancel', '鍙栨秷'),
    });
    if (!confirmed) return;
    await restoreArchived([name]);
  };

  const handleDeleteSingle = async (name: string) => {
    const confirmed = await showConfirm({
      title: text('Delete Archived Credential', '鍒犻櫎褰掓。鍑瘉'),
      message: text(`Permanently delete ${name}?`, `\u6c38\u4e45\u5220\u9664 ${name}\uff1f`),
      confirmText: text('Delete', '鍒犻櫎'),
      cancelText: text('Cancel', '鍙栨秷'),
    });
    if (!confirmed) return;
    await deleteArchived([name]);
  };

  return (
    <div className="space-y-6">
      <div className="rounded-xl border border-border bg-card p-6 shadow-sm">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="space-y-2">
            <h2 className="flex items-center gap-2 text-xl font-semibold">
              <Trash2 className="h-5 w-5 text-primary" />
              {text('Archive', '\u5f52\u6863')}
            </h2>
            <p className="text-sm text-muted-foreground">
              {text(
                'Archived credentials are hidden from the main list. You can restore or delete them here.',
                '\u5f52\u6863\u51ed\u8bc1\u4e0d\u4f1a\u51fa\u73b0\u5728\u4e3b\u5217\u8868\u4e2d\u3002\u4f60\u53ef\u4ee5\u5728\u8fd9\u91cc\u6062\u590d\u6216\u5220\u9664\u5b83\u4eec\u3002',
              )}
            </p>
          </div>

          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => { void refreshAll(); }}
              disabled={!cpaReady || isBusy}
              className="inline-flex h-9 items-center justify-center rounded-md border border-input bg-transparent px-4 py-2 text-sm font-medium hover:bg-accent hover:text-accent-foreground disabled:opacity-50"
            >
              <RefreshCw className="mr-2 h-4 w-4" />
              {text('Refresh', '\u5237\u65b0')}
            </button>
            <button
              onClick={() => { void handleRestoreSelected(); }}
              disabled={!cpaReady || isBusy || selectedNames.size === 0}
              className="inline-flex h-9 items-center justify-center rounded-md border border-input bg-transparent px-4 py-2 text-sm font-medium hover:bg-accent hover:text-accent-foreground disabled:opacity-50"
            >
              {text('Restore Selected', '\u6062\u590d\u9009\u4e2d')}
            </button>
            <button
              onClick={() => { void handleDeleteSelected(); }}
              disabled={!cpaReady || isBusy || selectedNames.size === 0}
              className="inline-flex h-9 items-center justify-center rounded-md border border-destructive/40 bg-destructive/5 px-4 py-2 text-sm font-medium text-destructive hover:bg-destructive/10 disabled:opacity-50"
            >
              {text('Delete Selected', '\u5220\u9664\u9009\u4e2d')}
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
              placeholder={text('Search archived credentials', '\u641c\u7d22\u5f52\u6863\u51ed\u8bc1')}
              className="h-10 w-full rounded-md border border-input bg-background pl-9 pr-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </label>
          <span className="inline-flex items-center rounded-full border border-border bg-muted/40 px-2.5 py-1 text-xs font-medium text-foreground/90">
            {text('Archived', '\u5f52\u6863')} {archiveRows.length}
          </span>
          <span className="inline-flex items-center rounded-full border border-border bg-background px-2.5 py-1 text-xs font-medium text-foreground/90">
            {text('Selected', '\u5df2\u9009\u4e2d')} {selectedNames.size}
          </span>
        </div>
      </div>

      <div className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
        <div className="overflow-x-auto">
          <table className="min-w-[1120px] w-full whitespace-nowrap text-left text-sm">
            <thead className="border-b border-border bg-muted/50 text-xs font-medium uppercase text-muted-foreground">
              <tr>
                <th className="w-10 px-4 py-3">
                  <input
                    type="checkbox"
                    className="h-4 w-4 rounded border-input bg-background/50 text-primary focus:ring-primary"
                    checked={filteredRows.length > 0 && filteredRows.every((item) => selectedNames.has(item.entry.name))}
                    onChange={(e) => handleSelectAll(e.target.checked)}
                  />
                </th>
                <th className="px-4 py-3">{text('Credential', '\u51ed\u8bc1')}</th>
                <th className="px-4 py-3">{text('Provider', '\u63d0\u4f9b\u65b9')}</th>
                <th className="px-4 py-3">{text('Archived At', '\u5f52\u6863\u65f6\u95f4')}</th>
                <th className="px-4 py-3">{text('Current State', '\u5f53\u524d\u72b6\u6001')}</th>
                <th className="px-4 py-3 text-right">{text('Actions', '\u64cd\u4f5c')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {!cpaReady ? (
                <tr><td colSpan={6} className="px-6 py-8 text-center text-muted-foreground">{text('Initializing connection...', '\u6b63\u5728\u521d\u59cb\u5316\u8fde\u63a5...')}</td></tr>
              ) : isLoading ? (
                <tr><td colSpan={6} className="px-6 py-8 text-center text-muted-foreground">{text('Loading credentials...', '\u6b63\u5728\u52a0\u8f7d\u51ed\u8bc1...')}</td></tr>
              ) : isError ? (
                <tr><td colSpan={6} className="px-6 py-8 text-center text-destructive">{String((error as { message?: string })?.message || text('Failed to load credentials.', '\u52a0\u8f7d\u51ed\u8bc1\u5931\u8d25\u3002'))}</td></tr>
              ) : filteredRows.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-6 py-8 text-center text-muted-foreground">
                    {searchKeyword.trim()
                      ? text('No archived credentials match the current search.', '\u6ca1\u6709\u5f52\u6863\u51ed\u8bc1\u5339\u914d\u5f53\u524d\u641c\u7d22\u6761\u4ef6\u3002')
                      : text('No archived credentials.', '\u6682\u65e0\u5f52\u6863\u51ed\u8bc1\u3002')}
                  </td>
                </tr>
              ) : (
                filteredRows.map(({ entry, credential }) => {
                  const restoring = runningRestoreNames.has(entry.name);
                  const deleting = runningDeleteNames.has(entry.name);
                  return (
                    <tr key={`archive-row-${entry.name}`} className="hover:bg-muted/20">
                      <td className="px-4 py-3">
                        <input
                          type="checkbox"
                          className="h-4 w-4 rounded border-input bg-background/50 text-primary focus:ring-primary"
                          checked={selectedNames.has(entry.name)}
                          onChange={() => handleToggleSelect(entry.name)}
                        />
                      </td>
                      <td className="px-4 py-3">
                        <div className="font-medium text-foreground">{entry.name}</div>
                        <div className="mt-0.5 font-mono text-xs text-muted-foreground">
                          {credential ? String(credential.auth_index || '').slice(0, 18) || '-' : text('Credential not currently loaded', '\u5f53\u524d\u672a\u52a0\u8f7d\u5230\u8be5\u51ed\u8bc1')}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">{credential?.provider || '-'}</td>
                      <td className="px-4 py-3 text-muted-foreground">{formatArchivedAt(entry, i18n.language)}</td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex items-center rounded-md px-2 py-0.5 text-[11px] font-medium ${credential?.disabled ? 'border border-destructive/20 bg-destructive/10 text-destructive/90' : 'border border-amber-300/30 bg-amber-100/60 text-amber-700 dark:bg-amber-900/20 dark:text-amber-300'}`}>
                          {credential?.disabled ? text('Disabled and archived', '\u5df2\u7981\u7528\u5e76\u5f52\u6863') : text('Archived only', '\u4ec5\u5f52\u6863')}
                        </span>
                      </td>
                      <td className="space-x-2 px-4 py-3 text-right">
                        <button
                          onClick={() => { void handleRestoreSingle(entry.name); }}
                          disabled={isBusy || restoring || deleting}
                          className="inline-flex h-8 items-center justify-center rounded-md border border-input bg-transparent px-2.5 text-xs font-medium hover:bg-accent hover:text-accent-foreground disabled:opacity-50"
                        >
                          {restoring ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : text('Restore', '\u6062\u590d')}
                        </button>
                        <button
                          onClick={() => { void handleDeleteSingle(entry.name); }}
                          disabled={isBusy || restoring || deleting}
                          className="inline-flex h-8 items-center justify-center rounded-md border border-destructive/40 bg-destructive/5 px-2.5 text-xs font-medium text-destructive hover:bg-destructive/10 disabled:opacity-50"
                        >
                          {deleting ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : text('Delete', '\u5220\u9664')}
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

