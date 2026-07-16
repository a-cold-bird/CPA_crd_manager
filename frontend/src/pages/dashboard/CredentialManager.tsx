import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
    clearAuthFilesCache,
    deleteCredential,
    fetchAuthFiles,
    fetchAuthFilesForceRefresh,
    fetchRuntimeStatus,
    probeCredential,
    runCredentialArchiveAdd,
    runCredentialArchiveList,
    upsertRuntimeCredentialState,
    updateCredentialStatus,
} from '../../lib/api';
import { batchWithLimit } from '../../lib/concurrency';
import type {
    Credential,
    CredentialArchivePayload,
    CredentialStatusTransitionOptions,
    LocalCliResult,
    ProbeResponse,
    RuntimeCredentialState,
    RuntimeStatusPayload,
} from '../../lib/api';
import {
    resolveTierAfterProbe,
    resolveTierFromCredential,
    type CodexQuotaInfo,
    type ProbeTier,
    type ProbeUiStatus,
} from '../../lib/providerStrategies';
import {
    canProbeCredential,
    classifyProviderProbe,
    resolveRuntimeNextProbeAtMs,
    shouldAutoArchive,
    shouldAutoDisable,
    toProbeErrorResponse,
} from '../../shared/providerRuntimeStrategies.js';
import { summarizeCredentialOverview } from '../../shared/credentialOverview.js';
import { useRunLock } from '../../hooks/useRunLock';
import { useLockedInterval } from '../../hooks/useLockedInterval';
import { useGlobalModal } from '../../components/global-modal/useGlobalModal';
import CredentialTable from './credential-manager/CredentialTableV2';
import CredentialManagerToolbar from './credential-manager/CredentialManagerToolbarV2';
import CredentialSelectionBar from './credential-manager/CredentialSelectionBarV2';
import CredentialOverview from './credential-manager/CredentialOverview';
import type {
    CodexQuotaResumeEntry,
    CredentialManagerProps,
    ProbeUiState,
    StatusFilter,
} from './credential-manager/types';

const AUTO_DISABLE_STORAGE_KEY = 'credential_auto_disable';
const AUTOMATION_RETRY_DELAY_MS = 30_000;
const PROBE_MAX_CONCURRENCY = 5;

interface CredentialOperationError {
    message: string;
    authIndex: string;
}

type ArchiveLoadStatus = 'idle' | 'loading' | 'loaded' | 'error';

function stripProbeErrorDetail(detail: string): string {
    return detail.replace(/\r?\n\r?\nerror:\r?\n[\s\S]*$/, '');
}

function isQuotaRecoveryStatus(status: ProbeUiStatus): boolean {
    return status === 'quota_exhausted' || status === 'quota_low_remaining' || status === 'rate_limited';
}

export default function CredentialManager({
    cpaReady,
    cpaUrl,
    autoProbeEnabled,
    setAutoProbeEnabled,
    autoProbeIntervalMinutes,
    setAutoProbeIntervalMinutes,
    codexQuotaDisableRemainingPercent,
    setCodexQuotaDisableRemainingPercent,
    autoProbeConfigStatus,
}: CredentialManagerProps) {
    const queryClient = useQueryClient();
    const { t, i18n } = useTranslation();
    const { showAlert, showConfirm } = useGlobalModal();
    const { runWithLock, isLocked } = useRunLock();
    const [probeBatchSize, setProbeBatchSize] = useState<number>(() => {
        const raw = Number(localStorage.getItem('probe_batch_size') || 5);
        if (!Number.isFinite(raw)) return 5;
        return Math.max(1, Math.min(100, Math.floor(raw)));
    });
    const [probeBatchIntervalMs, setProbeBatchIntervalMs] = useState<number>(() => {
        const raw = Number(localStorage.getItem('probe_batch_interval_ms') || 400);
        if (!Number.isFinite(raw)) return 400;
        return Math.max(0, Math.min(10000, Math.floor(raw)));
    });
    const quotaDisableThresholdLabel = i18n.language === 'zh' ? '剩余额度阈值(%)' : 'Quota Remaining Threshold(%)';
    const quotaDisableThresholdHint = i18n.language === 'zh'
        ? '0 表示仅在额度耗尽时禁用'
        : '0 means disable only when quota is exhausted';
    // API Data
    const {
        data: credentials = [],
        isLoading,
        isError,
        error,
        refetch,
        isFetching,
    } = useQuery({
        queryKey: ['credentials', cpaUrl],
        queryFn: () => fetchAuthFiles(),
        enabled: cpaReady,
        retry: 0,
        refetchOnWindowFocus: false,
    });

    const { data: runtimeStatusResult } = useQuery({
        queryKey: ['runtime-status', cpaUrl],
        queryFn: () => fetchRuntimeStatus(),
        enabled: cpaReady,
        retry: 0,
        refetchInterval: 15000,
        refetchOnWindowFocus: false,
    });

    // Status memory hook (store probing status in UI state since it's not natively returned in list)
    // In actual CPA, we fetch auth list, but it does not tell "active/dead" directly smoothly until probe
    const [probeStatuses, setProbeStatuses] = useState<Record<string, ProbeUiState>>({});
    const [isProbingAll, setIsProbingAll] = useState(false);
    const [probeCancelRequested, setProbeCancelRequested] = useState(false);
    const probeCancelRequestedRef = useRef(false);
    const probeAbortControllersRef = useRef<Map<string, AbortController>>(new Map());
    const [isAutoDisable, setIsAutoDisable] = useState(() => localStorage.getItem(AUTO_DISABLE_STORAGE_KEY) !== '0');
    const isAutoDisableRef = useRef(isAutoDisable);
    const [operationErrors, setOperationErrors] = useState<Record<string, CredentialOperationError>>({});

    const handleAutoDisableChange = (value: boolean) => {
        isAutoDisableRef.current = value;
        localStorage.setItem(AUTO_DISABLE_STORAGE_KEY, value ? '1' : '0');
        setIsAutoDisable(value);
    };

    // Batch Selection Data
    const [selectedItems, setSelectedItems] = useState<Set<string>>(new Set());
    const [archivedNames, setArchivedNames] = useState<string[]>([]);
    const [archiveLoadStatus, setArchiveLoadStatus] = useState<ArchiveLoadStatus>('idle');
    const [isArchiveBusy, setIsArchiveBusy] = useState(false);
    const [filterProvider, setFilterProvider] = useState<string>('all');
    const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
    const [searchKeyword, setSearchKeyword] = useState('');
    const [page, setPage] = useState(1);
    const [pageSize, setPageSize] = useState<number>(() => {
        const raw = Number(localStorage.getItem('credential_page_size') || 20);
        if (!Number.isFinite(raw)) return 20;
        return Math.max(1, Math.min(100, Math.floor(raw)));
    });

    // UI Loading states
    const [deletingNames, setDeletingNames] = useState<Set<string>>(new Set());
    const [togglingNames, setTogglingNames] = useState<Set<string>>(new Set());

    const runtimeStatusPayload = runtimeStatusResult?.payload || null;

    const updateRuntimeCredentialStateCache = useCallback((name: string, state: RuntimeCredentialState) => {
        queryClient.setQueryData<LocalCliResult<RuntimeStatusPayload>>(['runtime-status', cpaUrl], (old) => {
            if (!old?.payload) return old;
            return {
                ...old,
                payload: {
                    ...old.payload,
                    credentials: {
                        ...old.payload.credentials,
                        [name]: state,
                    },
                },
            };
        });
    }, [cpaUrl, queryClient]);

    const toggleStatusMutation = useMutation({
        mutationFn: ({
            name,
            disabled,
            options,
        }: {
            name: string;
            disabled: boolean;
            options: CredentialStatusTransitionOptions;
        }) => updateCredentialStatus(name, disabled, options),
    });

    const deleteMutation = useMutation({
        mutationFn: ({ name, expectedAuthIndex }: { name: string; expectedAuthIndex: string }) => (
            deleteCredential(name, expectedAuthIndex)
        ),
        onSuccess: () => {
            clearAuthFilesCache();
            queryClient.invalidateQueries({ queryKey: ['credentials'] });
        }
    });

    const runCredentialDelete = (name: string) => {
        const credential = credentials.find((item) => item.name === name || item.id === name);
        const expectedAuthIndex = String(credential?.auth_index || '');
        if (!expectedAuthIndex) {
            return Promise.reject(new Error(`Credential identity is unavailable: ${name}`));
        }
        return deleteMutation.mutateAsync({ name, expectedAuthIndex });
    };

    const forceRefreshCredentials = useCallback(async () => {
        const fresh = await fetchAuthFilesForceRefresh();
        queryClient.setQueryData(['credentials', cpaUrl], fresh);
        return fresh;
    }, [queryClient, cpaUrl]);

    const setCredentialDisabledInCache = (name: string, disabled: boolean) => {
        queryClient.setQueryData<Credential[]>(['credentials', cpaUrl], (old) => {
            if (!old) return old;
            return old.map((item) => {
                if (item.name === name || item.id === name) {
                    return { ...item, disabled };
                }
                return item;
            });
        });
    };

    const runStatusUpdate = async (name: string, disabled: boolean, options: CredentialStatusTransitionOptions) => {
        setTogglingNames(prev => new Set(prev).add(name));
        try {
            const payload = await toggleStatusMutation.mutateAsync({ name, disabled, options });
            setCredentialDisabledInCache(name, payload.disabled);
            updateRuntimeCredentialStateCache(name, payload.state);
            setOperationErrors((prev) => {
                if (!prev[name]) return prev;
                const next = { ...prev };
                delete next[name];
                return next;
            });
            return payload;
        } finally {
            setTogglingNames(prev => { const n = new Set(prev); n.delete(name); return n; });
        }
    };

    const handleToggleStatus = async (cred: Credential) => {
        try {
            await runStatusUpdate(cred.name, !cred.disabled, {
                cpaUrl,
                expectedAuthIndex: String(cred.auth_index || ''),
            });
        } catch (error: unknown) {
            const message = String((error as { message?: string })?.message || error || t('Credential update failed'));
            setOperationErrors((prev) => ({
                ...prev,
                [cred.name]: { message, authIndex: String(cred.auth_index || '') },
            }));
            showAlert({ title: t('Error'), message, confirmText: t('Confirm', 'Confirm') });
        }
    };

    const handleDeleteSingle = async (name: string) => {
        const confirmed = await showConfirm({
            title: t('Delete Confirmation'),
            message: t('confirmDeleteSingle'),
            confirmText: t('Confirm', 'Confirm'),
            cancelText: t('Cancel', 'Cancel'),
        });
        if (!confirmed) return;

        setDeletingNames(prev => new Set(prev).add(name));
        try {
            await runCredentialDelete(name);
        } catch {
            setDeletingNames(prev => { const n = new Set(prev); n.delete(name); return n; });
            showAlert({ title: t('Error'), message: t('Delete failed'), confirmText: t('Confirm', 'Confirm') });
        }
    };

    const truncateText = (text: string, max: number = 180): string => {
        if (!text) return '';
        return text.length > max ? `${text.slice(0, max)}...` : text;
    };

    const toPrettyText = (value: unknown): string => {
        if (typeof value === 'string') return value;
        if (value === null || value === undefined) return '';
        try {
            return JSON.stringify(value, null, 2);
        } catch {
            return String(value);
        }
    };

    const formatProbeDetail = (response: { status_code?: unknown; body?: unknown; error?: unknown }) => {
        const parts = [
            `status_code: ${Number(response.status_code) || 0}`,
            `body:\n${toPrettyText(response.body) || '(empty)'}`,
        ];
        const errText = toPrettyText(response.error);
        if (errText) {
            parts.push(`error:\n${errText}`);
        }
        return parts.join('\n\n');
    };

    const persistRuntimeProbeSnapshot = useCallback(async (
        cred: Credential,
        state: Partial<RuntimeCredentialState>,
    ): Promise<RuntimeCredentialState> => {
        if (!cpaUrl || !cred.name) {
            throw new Error('Runtime state persistence requires a CPA URL and credential name');
        }
        const result = await upsertRuntimeCredentialState({
            cpa_url: cpaUrl,
            name: cred.name,
            auth_index: String(cred.auth_index || ''),
            state,
        });
        if (!result.ok || !result.payload?.state) {
            throw new Error(String(result.error || 'Runtime state persistence failed'));
        }
        updateRuntimeCredentialStateCache(cred.name, result.payload.state);
        return result.payload.state;
    }, [cpaUrl, updateRuntimeCredentialStateCache]);

    const formatRuntimeProbeTime = (value: number | null | undefined): string => {
        if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return '';
        return new Date(value).toLocaleTimeString();
    };

    const isAbortError = (error: unknown): boolean => {
        const err = error as { code?: string; message?: string; name?: string };
        const msg = String(err?.message || '').toLowerCase();
        return err?.code === 'ERR_CANCELED' || err?.name === 'CanceledError' || msg.includes('canceled') || msg.includes('aborted');
    };

    const isCodexProvider = (provider: string): boolean => (provider || '').toLowerCase() === 'codex';

    const applyProbeAutomation = async (
        cred: Credential,
        status: ProbeUiStatus,
        quota: CodexQuotaInfo | null | undefined,
        probeAtMs: number,
        runtimeEntry: RuntimeCredentialState,
    ) => {
        const codexProvider = isCodexProvider(String(cred.provider || ''));
        const expectedAuthIndex = String(cred.auth_index || '');
        const hasRuntimeOwnership = Boolean(runtimeEntry?.disabled_by_runtime);
        const normalNextProbeAtMs = probeAtMs + Math.max(1, autoProbeIntervalMinutes) * 60 * 1000;

        if (status === 'active') {
            if (hasRuntimeOwnership) {
                await runStatusUpdate(cred.name, false, {
                    cpaUrl,
                    requireRuntimeOwnership: true,
                    expectedProbeAtMs: probeAtMs,
                    expectedAuthIndex,
                    runtimeState: {
                        disabled_by_runtime: false,
                        archived_by_runtime: false,
                        next_probe_at_ms: normalNextProbeAtMs,
                    },
                });
            }
            return;
        }

        if (codexProvider && isQuotaRecoveryStatus(status)) {
            if (!hasRuntimeOwnership && (!isAutoDisableRef.current || cred.disabled)) {
                return;
            }
            await runStatusUpdate(cred.name, true, {
                cpaUrl,
                requireRuntimeOwnership: hasRuntimeOwnership,
                expectedProbeAtMs: probeAtMs,
                expectedAuthIndex,
                runtimeState: {
                    disabled_by_runtime: true,
                    archived_by_runtime: false,
                    next_probe_at_ms: resolveRuntimeNextProbeAtMs(
                        status,
                        quota,
                        Math.max(1, autoProbeIntervalMinutes) * 60 * 1000,
                        probeAtMs,
                    ),
                },
            });
            return;
        }

        if (hasRuntimeOwnership && runtimeEntry.archived_by_runtime && !shouldAutoArchive(status)) {
            await runStatusUpdate(cred.name, true, {
                cpaUrl,
                requireRuntimeOwnership: true,
                expectedProbeAtMs: probeAtMs,
                expectedAuthIndex,
                runtimeState: {
                    disabled_by_runtime: true,
                    archived_by_runtime: false,
                    next_probe_at_ms: normalNextProbeAtMs,
                },
            });
            return;
        }

        if (isAutoDisableRef.current && shouldAutoArchive(status) && !archivedNames.includes(cred.name)) {
            await archiveCredentialNames([cred.name], true, probeAtMs, expectedAuthIndex, hasRuntimeOwnership);
        } else if (isAutoDisableRef.current && shouldAutoDisable(status) && !cred.disabled) {
            await runStatusUpdate(cred.name, true, {
                cpaUrl,
                requireRuntimeOwnership: hasRuntimeOwnership,
                expectedProbeAtMs: probeAtMs,
                expectedAuthIndex,
                runtimeState: {
                    disabled_by_runtime: true,
                    archived_by_runtime: false,
                    next_probe_at_ms: resolveRuntimeNextProbeAtMs(
                        status,
                        quota,
                        Math.max(1, autoProbeIntervalMinutes) * 60 * 1000,
                        probeAtMs,
                    ),
                },
            });
        }
    };

    const handleProbeSingle = async (cred: Credential, options?: { signal?: AbortSignal; fromBatch?: boolean }) => {
        const lockKey = `probe-single:${cred.name}`;
        await runWithLock(lockKey, async () => {
            const startedAtMs = Date.now();
            setProbeStatuses(prev => ({
                ...prev,
                [cred.name]: {
                    status: 'running',
                    time: new Date().toLocaleTimeString(),
                    updatedAtMs: startedAtMs,
                    authIndex: String(cred.auth_index || ''),
                    reason: '',
                    tier: resolveTierFromCredential(cred),
                    detail: '',
                },
            }));

            let response: ProbeResponse;
            let finalStatus: ProbeUiStatus;
            let finalReason = '';
            let tier: ProbeTier = resolveTierFromCredential(cred);
            let quota: CodexQuotaInfo | null | undefined;
            let detail = '';

            try {
                response = await probeCredential(cred.auth_index, cred.provider as string, options?.signal);
                const result = classifyProviderProbe(cred.provider, response, {
                    codexQuotaDisableRemainingPercent,
                });
                finalStatus = result.status;
                finalReason = result.reason || '';
                quota = result.quota;
                tier = resolveTierAfterProbe(cred, response);
                const rawDetail = formatProbeDetail(response);
                detail = finalStatus === 'active' ? stripProbeErrorDetail(rawDetail) : rawDetail;
            } catch (error: unknown) {
                if (isAbortError(error)) {
                    if (options?.fromBatch) {
                        const cancelledAtMs = Date.now();
                        setProbeStatuses(prev => ({
                            ...prev,
                            [cred.name]: {
                                status: 'unknown',
                                time: new Date().toLocaleTimeString(),
                                updatedAtMs: cancelledAtMs,
                                authIndex: String(cred.auth_index || ''),
                                reason: t('Probe cancelled'),
                                tier: resolveTierFromCredential(cred),
                                detail: t('Probe cancelled'),
                            },
                        }));
                    }
                    return;
                }

                response = toProbeErrorResponse(error);
                const result = classifyProviderProbe(cred.provider, response, {
                    codexQuotaDisableRemainingPercent,
                });
                finalStatus = result.status === 'unknown' ? 'error' : result.status;
                finalReason = finalStatus === 'active'
                    ? ''
                    : (result.reason || 'Network error during probing');
                quota = result.quota;
                const rawDetail = formatProbeDetail(response);
                detail = finalStatus === 'active' ? stripProbeErrorDetail(rawDetail) : rawDetail;
            }

            const completedAtMs = Date.now();
            setProbeStatuses(prev => ({
                ...prev,
                [cred.name]: {
                    status: finalStatus,
                    time: new Date(completedAtMs).toLocaleTimeString(),
                    updatedAtMs: completedAtMs,
                    authIndex: String(cred.auth_index || ''),
                    reason: truncateText(finalReason),
                    tier,
                    detail,
                    quotaResetAt: quota?.resetAt ?? null,
                    quotaSource: quota?.source ?? null,
                    quotaUsedPercent: quota?.usedPercent ?? null,
                    quotaCards: quota?.cards ?? [],
                },
            }));

            let persistedState: RuntimeCredentialState | null = null;
            try {
                persistedState = await persistRuntimeProbeSnapshot(cred, {
                    provider: String(cred.provider || ''),
                    last_status: finalStatus,
                    last_reason: finalReason,
                    last_probe_at: completedAtMs,
                    last_probe_detail: detail,
                    last_reset_at: quota?.resetAt ?? null,
                    last_quota_source: quota?.source ?? '',
                    last_quota_used_percent: quota?.usedPercent ?? null,
                    last_quota_cards: quota?.cards ?? [],
                    next_probe_at_ms: resolveRuntimeNextProbeAtMs(
                        finalStatus,
                        quota,
                        Math.max(1, autoProbeIntervalMinutes) * 60 * 1000,
                        completedAtMs,
                    ),
                });
                if (persistedState.last_probe_at === completedAtMs) {
                    await applyProbeAutomation(cred, finalStatus, quota, completedAtMs, persistedState);
                }
                setOperationErrors((prev) => {
                    if (!prev[cred.name]) return prev;
                    const next = { ...prev };
                    delete next[cred.name];
                    return next;
                });
            } catch (error: unknown) {
                let message = String((error as { message?: string })?.message || error || 'Credential automation failed');
                if (persistedState?.last_probe_at === completedAtMs) {
                    try {
                        await persistRuntimeProbeSnapshot(cred, {
                            last_probe_at: completedAtMs,
                            next_probe_at_ms: Date.now() + AUTOMATION_RETRY_DELAY_MS,
                        });
                    } catch (retryError) {
                        message = `${message}; retry scheduling failed: ${String((retryError as { message?: string })?.message || retryError)}`;
                    }
                }
                setOperationErrors((prev) => ({
                    ...prev,
                    [cred.name]: { message, authIndex: String(cred.auth_index || '') },
                }));
                queryClient.invalidateQueries({ queryKey: ['credentials'] });
                queryClient.invalidateQueries({ queryKey: ['runtime-status', cpaUrl] });
            }
        });
    };

    const runtimeCredentialStates = useMemo<Record<string, RuntimeCredentialState>>(() => {
        return runtimeStatusPayload?.credentials || {};
    }, [runtimeStatusPayload]);

    const credentialAuthIndexByName = useMemo(
        () => new Map(credentials.map((cred) => [cred.name, String(cred.auth_index || '')])),
        [credentials],
    );

    const runtimeStateMatchesCredential = useCallback((name: string, state: RuntimeCredentialState): boolean => {
        const currentAuthIndex = credentialAuthIndexByName.get(name);
        const storedAuthIndex = String(state.auth_index || '');
        return Boolean(currentAuthIndex && storedAuthIndex && currentAuthIndex === storedAuthIndex);
    }, [credentialAuthIndexByName]);

    const runtimeProbeStatuses = useMemo<Record<string, ProbeUiState>>(() => {
        const next: Record<string, ProbeUiState> = {};
        Object.entries(runtimeCredentialStates).forEach(([name, state]) => {
            if (!state?.last_status || !runtimeStateMatchesCredential(name, state)) return;
            const detail = state.last_status === 'active'
                ? stripProbeErrorDetail(state.last_probe_detail || '')
                : (state.last_probe_detail || state.last_reason || '');
            next[name] = {
                status: state.last_status,
                time: formatRuntimeProbeTime(state.last_probe_at),
                updatedAtMs: state.last_probe_at || 0,
                authIndex: String(state.auth_index || ''),
                reason: state.last_status === 'active' ? '' : truncateText(state.last_reason || ''),
                detail,
                quotaResetAt: state.last_reset_at,
                quotaSource: state.last_quota_source || null,
                quotaUsedPercent: state.last_quota_used_percent,
                quotaCards: state.last_quota_cards || [],
            };
        });
        return next;
    }, [runtimeCredentialStates, runtimeStateMatchesCredential]);

    const runtimeOwnedNames = useMemo(
        () => new Set(
            Object.entries(runtimeCredentialStates)
                .filter(([name, state]) => Boolean(state?.disabled_by_runtime) && runtimeStateMatchesCredential(name, state))
                .map(([name]) => name),
        ),
        [runtimeCredentialStates, runtimeStateMatchesCredential],
    );

    const runtimeCodexQuotaResumeMap = useMemo<Record<string, CodexQuotaResumeEntry>>(() => {
        const next: Record<string, CodexQuotaResumeEntry> = {};
        Object.entries(runtimeCredentialStates).forEach(([name, state]) => {
            const isQuotaRecoveryState = state?.last_status === 'quota_exhausted'
                || state?.last_status === 'quota_low_remaining'
                || state?.last_status === 'rate_limited';
            if (!runtimeStateMatchesCredential(name, state) || !state?.disabled_by_runtime || state.next_probe_at_ms === null || !isQuotaRecoveryState) return;
            next[name] = {
                resetAt: state.last_reset_at,
                usedPercent: state.last_quota_used_percent,
                source: state.last_quota_source || null,
                nextProbeAtMs: state.next_probe_at_ms,
            };
        });
        return next;
    }, [runtimeCredentialStates, runtimeStateMatchesCredential]);

    const mergedProbeStatuses = useMemo<Record<string, ProbeUiState>>(() => {
        const next: Record<string, ProbeUiState> = {};
        const names = new Set([...Object.keys(runtimeProbeStatuses), ...Object.keys(probeStatuses)]);
        names.forEach((name) => {
            const currentAuthIndex = credentialAuthIndexByName.get(name);
            const runtimeCandidate = runtimeProbeStatuses[name];
            const localCandidate = probeStatuses[name];
            const runtimeState = runtimeCandidate && currentAuthIndex && runtimeCandidate.authIndex === currentAuthIndex
                ? runtimeCandidate
                : undefined;
            const localState = localCandidate && currentAuthIndex && localCandidate.authIndex === currentAuthIndex
                ? localCandidate
                : undefined;
            if (!runtimeState) {
                if (localState) next[name] = localState;
                return;
            }
            if (!localState) {
                next[name] = runtimeState;
                return;
            }
            next[name] = localState.updatedAtMs > runtimeState.updatedAtMs ? localState : runtimeState;
        });
        return next;
    }, [credentialAuthIndexByName, runtimeProbeStatuses, probeStatuses]);

    const runProbeForTargets = async (targets: Credential[]) => {
        if (!targets.length || isProbingAll) return;
        probeCancelRequestedRef.current = false;
        setProbeCancelRequested(false);
        probeAbortControllersRef.current.clear();
        await runWithLock('probe-all', async () => {
            setIsProbingAll(true);
            try {
                const probeTargets = targets.filter((cred: Credential) => canProbeCredential(cred));
                for (let i = 0; i < probeTargets.length; i += probeBatchSize) {
                    if (probeCancelRequestedRef.current) {
                        break;
                    }
                    const chunk = probeTargets.slice(i, i + probeBatchSize);
                    await batchWithLimit(chunk, async (cred) => {
                        if (probeCancelRequestedRef.current) return;
                        const controller = new AbortController();
                        probeAbortControllersRef.current.set(cred.name, controller);
                        try {
                            await handleProbeSingle(cred, { signal: controller.signal, fromBatch: true });
                        } finally {
                            probeAbortControllersRef.current.delete(cred.name);
                        }
                    }, PROBE_MAX_CONCURRENCY);
                    if (probeCancelRequestedRef.current) {
                        break;
                    }
                    if (i + probeBatchSize < probeTargets.length) {
                        let waitedMs = 0;
                        while (waitedMs < probeBatchIntervalMs && !probeCancelRequestedRef.current) {
                            const step = Math.min(100, probeBatchIntervalMs - waitedMs);
                            await new Promise((resolve) => setTimeout(resolve, step));
                            waitedMs += step;
                        }
                    }
                }
                await forceRefreshCredentials();
            } finally {
                setIsProbingAll(false);
                setProbeCancelRequested(false);
                probeCancelRequestedRef.current = false;
                probeAbortControllersRef.current.clear();
            }
        });
    };

    const handleProbeAll = async () => {
        await runProbeForTargets(filteredCredentials);
    };

    const handleCancelProbeAll = () => {
        if (!isProbingAll) return;
        setProbeCancelRequested(true);
        probeCancelRequestedRef.current = true;
        for (const controller of probeAbortControllersRef.current.values()) {
            controller.abort();
        }
    };

    const [isDeletingSelection, setIsDeletingSelection] = useState(false);

    const archivedNameSet = useMemo(() => new Set(archivedNames), [archivedNames]);
    const activeCredentials = useMemo(
        () => credentials.filter((cred: Credential) => !archivedNameSet.has(cred.name)),
        [credentials, archivedNameSet],
    );

    const loadCredentialArchive = useCallback(async () => {
        if (!cpaReady || !cpaUrl) {
            setArchivedNames([]);
            setArchiveLoadStatus('idle');
            return;
        }
        setArchivedNames([]);
        setArchiveLoadStatus('loading');
        try {
            const result = await runCredentialArchiveList({ cpa_url: cpaUrl });
            const payload = result.payload as { names?: unknown } | undefined;
            const names = Array.isArray(payload?.names)
                ? payload.names.map((item) => String(item || '').trim()).filter(Boolean)
                : [];
            setArchivedNames(Array.from(new Set(names)));
            setArchiveLoadStatus('loaded');
        } catch {
            setArchiveLoadStatus('error');
        }
    }, [cpaReady, cpaUrl]);

    useEffect(() => {
        void loadCredentialArchive();
    }, [loadCredentialArchive]);

    // Filtered data computing
    const filteredCredentials = useMemo(() => {
        const keyword = searchKeyword.trim().toLowerCase();
        return activeCredentials.filter((cred: Credential) => {
            if (filterProvider !== 'all' && cred.provider !== filterProvider) {
                return false;
            }
            if (statusFilter === 'enabled' && cred.disabled) {
                return false;
            }
            if (statusFilter === 'disabled' && !cred.disabled) {
                return false;
            }
            if (!keyword) {
                return true;
            }

            const haystack = [
                cred.name,
                cred.id,
                cred.provider,
                cred.auth_index,
            ]
                .map((part) => String(part || '').toLowerCase())
                .join(' ');
            return haystack.includes(keyword);
        });
    }, [activeCredentials, filterProvider, statusFilter, searchKeyword]);
    const totalCredentialCount = activeCredentials.length;
    const disabledCredentialCount = useMemo(
        () => activeCredentials.filter((cred: Credential) => Boolean(cred.disabled)).length,
        [activeCredentials],
    );
    const archivedCredentialCount = archivedNames.length;
    const currentOperationErrors = useMemo<Record<string, string>>(() => {
        const next: Record<string, string> = {};
        for (const cred of activeCredentials) {
            const entry = operationErrors[cred.name];
            if (!entry || entry.authIndex !== String(cred.auth_index || '')) continue;
            next[cred.name] = entry.message;
        }
        return next;
    }, [activeCredentials, operationErrors]);
    const credentialOverview = useMemo(
        () => summarizeCredentialOverview(activeCredentials, mergedProbeStatuses, currentOperationErrors),
        [activeCredentials, currentOperationErrors, mergedProbeStatuses],
    );
    const providerStats = useMemo(() => {
        const stats: Record<string, { total: number; disabled: number }> = {};
        for (const cred of activeCredentials) {
            const key = String(cred.provider || 'unknown');
            if (!stats[key]) {
                stats[key] = { total: 0, disabled: 0 };
            }
            stats[key].total += 1;
            if (cred.disabled) {
                stats[key].disabled += 1;
            }
        }
        return stats;
    }, [activeCredentials]);

    // Derived providers list dynamically
    const availableProviders = useMemo(() => {
        return Object.keys(providerStats);
    }, [providerStats]);

    const totalItems = filteredCredentials.length;
    const disabledFilteredItems = useMemo(
        () => filteredCredentials.filter((cred: Credential) => cred.disabled),
        [filteredCredentials],
    );
    const disabledFilteredCount = disabledFilteredItems.length;
    const totalPages = Math.max(1, Math.ceil(Math.max(1, totalItems) / pageSize));
    const currentPage = Math.min(page, totalPages);
    const pageStart = (currentPage - 1) * pageSize;
    const pageEnd = Math.min(totalItems, pageStart + pageSize);
    const pagedCredentials = filteredCredentials.slice(pageStart, pageStart + pageSize);

    useEffect(() => {
        localStorage.setItem('credential_page_size', String(pageSize));
    }, [pageSize]);

    useEffect(() => {
        localStorage.setItem('probe_batch_size', String(probeBatchSize));
    }, [probeBatchSize]);

    useEffect(() => {
        localStorage.setItem('probe_batch_interval_ms', String(probeBatchIntervalMs));
    }, [probeBatchIntervalMs]);

    useEffect(() => {
        isAutoDisableRef.current = isAutoDisable;
        localStorage.setItem(AUTO_DISABLE_STORAGE_KEY, isAutoDisable ? '1' : '0');
    }, [isAutoDisable]);

    useEffect(() => {
        setPage(1);
        setSelectedItems(new Set());
    }, [filterProvider, statusFilter, searchKeyword, pageSize, cpaUrl]);

    useEffect(() => {
        setProbeStatuses({});
        setOperationErrors({});
    }, [cpaUrl]);

    useEffect(() => {
        if (page > totalPages) {
            setPage(totalPages);
        }
    }, [page, totalPages]);

    const setSafePageSize = (nextSize: number) => {
        if (!Number.isFinite(nextSize)) return;
        const resolved = Math.max(1, Math.min(100, Math.floor(nextSize)));
        setPageSize(resolved);
        setPage(1);
    };

    const setSafeProbeBatchSize = (nextSize: number) => {
        if (!Number.isFinite(nextSize)) return;
        setProbeBatchSize(Math.max(1, Math.min(100, Math.floor(nextSize))));
    };

    const setSafeProbeBatchIntervalMs = (nextValue: number) => {
        if (!Number.isFinite(nextValue)) return;
        setProbeBatchIntervalMs(Math.max(0, Math.min(10000, Math.floor(nextValue))));
    };

    const setSafeAutoProbeIntervalMinutes = (nextValue: number) => {
        if (!Number.isFinite(nextValue)) return;
        setAutoProbeIntervalMinutes(Math.max(1, Math.min(1440, Math.floor(nextValue))));
    };

    const setSafeQuotaDisableRemainingPercent = (nextValue: number) => {
        if (!Number.isFinite(nextValue)) return;
        setCodexQuotaDisableRemainingPercent(Math.max(0, Math.min(100, Math.floor(nextValue))));
    };

    const autoProbeConfigHint = useMemo(() => {
        const isZh = i18n.language === 'zh';
        if (autoProbeConfigStatus === 'saving') {
            return isZh ? '正在保存自动探针配置到 config.yaml...' : 'Saving auto probe config to config.yaml...';
        }
        if (autoProbeConfigStatus === 'saved') {
            return isZh ? '自动探针配置已保存到 config.yaml' : 'Auto probe config saved to config.yaml';
        }
        if (autoProbeConfigStatus === 'error') {
            return isZh ? '自动探针配置保存失败，请检查 config.yaml 写入权限' : 'Failed to save auto probe config. Check config.yaml write permission';
        }
        if (autoProbeConfigStatus === 'loaded') {
            return isZh
                ? `已从 config.yaml 加载自动探针间隔：${autoProbeIntervalMinutes} 分钟，剩余额度阈值：${codexQuotaDisableRemainingPercent}%`
                : `Loaded auto probe interval: ${autoProbeIntervalMinutes} min, remaining quota threshold: ${codexQuotaDisableRemainingPercent}%`;
        }
        return '';
    }, [autoProbeConfigStatus, autoProbeIntervalMinutes, codexQuotaDisableRemainingPercent, i18n.language]);

    const backendAutomationHint = useMemo(() => {
        const runtime = runtimeStatusPayload?.runtime;
        if (!runtime) return '';
        const isZh = i18n.language === 'zh';
        if (!runtime.auto_probe_enabled) {
            return isZh ? '后端自动化：已关闭（config.yaml auto_probe_enabled=false）' : 'Backend automation: disabled by config.yaml';
        }
        if (!runtime.has_runtime_config) {
            return isZh ? '后端自动化：待命（缺少 cpa_url 或 management_key）' : 'Backend automation: idle, missing cpa_url or management_key';
        }
        const lastFinished = runtime.last_cycle_finished_at_iso
            ? new Date(runtime.last_cycle_finished_at_iso).toLocaleString()
            : (isZh ? '暂无' : 'n/a');
        if (runtime.last_error) {
            return isZh
                ? `后端自动化：异常，最近错误 ${runtime.last_error}`
                : `Backend automation: error, last error ${runtime.last_error}`;
        }
        return isZh
            ? `后端自动化：运行中 | 周期 ${runtime.wake_interval_ms / 1000}s | ${runtime.cycle_in_progress ? '本轮执行中' : `最近完成 ${lastFinished}`}`
            : `Backend automation: active | wake ${runtime.wake_interval_ms / 1000}s | ${runtime.cycle_in_progress ? 'cycle in progress' : `last finished ${lastFinished}`}`;
    }, [runtimeStatusPayload, i18n.language]);

    const refreshListWithLock = useCallback(async (force: boolean = false) => {
        await runWithLock('refresh-list', async () => {
            const credentialRefresh = force ? forceRefreshCredentials() : refetch();
            const archiveRefresh = force || archiveLoadStatus === 'error'
                ? loadCredentialArchive()
                : Promise.resolve();
            await Promise.all([credentialRefresh, archiveRefresh]);
        });
    }, [archiveLoadStatus, forceRefreshCredentials, loadCredentialArchive, refetch, runWithLock]);

    useLockedInterval(
        async () => {
            if (!cpaReady || isProbingAll || isFetching) return;
            await refreshListWithLock(false);
        },
        15000,
        cpaReady,
        false,
    );

    const handleSelectAll = (checked: boolean) => {
        if (checked) {
            setSelectedItems(new Set(pagedCredentials.map((c: Credential) => c.name)));
        } else {
            setSelectedItems(new Set());
        }
    };

    const handleToggleItem = (name: string) => {
        const next = new Set(selectedItems);
        if (next.has(name)) next.delete(name);
        else next.add(name);
        setSelectedItems(next);
    };

    const handleBatchDelete = async () => {
        if (selectedItems.size === 0) return;
        const confirmed = await showConfirm({
            title: t('Delete Multiple'),
            message: t('confirmDeleteBatch', { count: selectedItems.size }),
            confirmText: t('Confirm', 'Confirm'),
            cancelText: t('Cancel', 'Cancel'),
        });
        if (!confirmed) return;

        setIsDeletingSelection(true);
        try {
            await batchWithLimit(Array.from(selectedItems), (name) => runCredentialDelete(name), 5);
            setSelectedItems(new Set());
            await forceRefreshCredentials();
        } finally {
            setIsDeletingSelection(false);
        }
    };

    const setArchivedNamesFromPayload = (payload: unknown) => {
        const record = payload as { names?: unknown } | null;
        const names = Array.isArray(record?.names)
            ? record.names.map((item) => String(item || '').trim()).filter(Boolean)
            : [];
        setArchivedNames(Array.from(new Set(names)));
        setArchiveLoadStatus('loaded');
    };

    const archiveCredentialNames = async (
        names: string[],
        runtimeOwned: boolean = false,
        expectedProbeAtMs?: number,
        expectedAuthIndex?: string,
        requireExistingRuntimeOwnership: boolean = false,
    ) => {
        const targets = Array.from(new Set(names.map((item) => String(item || '').trim()).filter(Boolean)));
        const automaticAuthIndex = String(expectedAuthIndex || '');
        if (!targets.length) return;
        if (runtimeOwned && (typeof expectedProbeAtMs !== 'number' || !Number.isFinite(expectedProbeAtMs) || expectedProbeAtMs <= 0)) {
            throw new Error('Automatic archive requires a persisted probe version');
        }
        if (runtimeOwned && !automaticAuthIndex) {
            throw new Error('Automatic archive requires a credential identity');
        }
        setIsArchiveBusy(true);
        try {
            const archiveTargets: string[] = [];
            const archiveAuthIndices: Record<string, string> = {};
            for (const name of targets) {
                const cred = activeCredentials.find((item) => item.name === name);
                if (!cred) continue;
                const transition = await runStatusUpdate(name, true, runtimeOwned
                    ? {
                        cpaUrl,
                        requireRuntimeOwnership: requireExistingRuntimeOwnership,
                        expectedProbeAtMs,
                        expectedAuthIndex: automaticAuthIndex,
                        runtimeState: {
                            disabled_by_runtime: true,
                            archived_by_runtime: true,
                            next_probe_at_ms: null,
                        },
                    }
                    : {
                        cpaUrl,
                        expectedAuthIndex: String(cred.auth_index || ''),
                    });
                if (!transition.skipped) {
                    archiveTargets.push(name);
                    archiveAuthIndices[name] = String(cred.auth_index || '');
                }
            }
            if (!archiveTargets.length) return;
            let result: LocalCliResult<CredentialArchivePayload>;
            try {
                result = await runCredentialArchiveAdd({
                    cpa_url: cpaUrl,
                    names: archiveTargets,
                    require_runtime_ownership: runtimeOwned,
                    expected_probe_at_ms: runtimeOwned ? expectedProbeAtMs : undefined,
                    expected_auth_index: runtimeOwned ? automaticAuthIndex : undefined,
                    auth_indices: archiveAuthIndices,
                });
            } catch (error) {
                if (runtimeOwned) {
                    const compensationResults = await Promise.allSettled(archiveTargets.map((name) => runStatusUpdate(name, true, {
                        cpaUrl,
                        requireRuntimeOwnership: true,
                        expectedProbeAtMs,
                        expectedAuthIndex: automaticAuthIndex,
                        runtimeState: {
                            disabled_by_runtime: true,
                            archived_by_runtime: false,
                            next_probe_at_ms: Date.now() + AUTOMATION_RETRY_DELAY_MS,
                        },
                    })));
                    const compensationErrors = compensationResults
                        .filter((item): item is PromiseRejectedResult => item.status === 'rejected')
                        .map((item) => String((item.reason as { message?: string })?.message || item.reason));
                    if (compensationErrors.length) {
                        throw new Error(`${String((error as { message?: string })?.message || error)}; archive compensation failed: ${compensationErrors.join('; ')}`);
                    }
                }
                throw error;
            }
            const skippedNames = new Set(result.payload?.skipped || []);
            const committedTargets = archiveTargets.filter((name) => !skippedNames.has(name));
            setArchivedNamesFromPayload(result.payload || null);
            setSelectedItems((prev) => {
                const next = new Set(prev);
                committedTargets.forEach((name) => next.delete(name));
                return next;
            });
            await forceRefreshCredentials();
            if (!runtimeOwned && skippedNames.size > 0) {
                throw new Error(`Archive skipped because credential state changed: ${Array.from(skippedNames).join(', ')}`);
            }
        } finally {
            setIsArchiveBusy(false);
        }
    };

    const handleArchiveDisabled = async () => {
        const disabledTargets = disabledFilteredItems.map((cred: Credential) => cred.name);
        if (!disabledTargets.length) {
            showAlert({ title: t('Error'), message: t('No disabled credentials to archive in current filter.'), confirmText: t('Confirm', 'Confirm') });
            return;
        }
        const confirmed = await showConfirm({
            title: t('Archive Disabled Credentials'),
            message: t('Archive Disabled Credentials Message', { count: disabledTargets.length }),
            confirmText: t('Confirm', 'Confirm'),
            cancelText: t('Cancel', 'Cancel'),
        });
        if (!confirmed) return;
        try {
            await archiveCredentialNames(disabledTargets);
        } catch (error: unknown) {
            showAlert({
                title: t('Error'),
                message: String((error as { message?: string })?.message || error || t('Archive failed')),
                confirmText: t('Confirm', 'Confirm'),
            });
        }
    };

    const handleDeleteDisabled = async () => {
        const targets = disabledFilteredItems.map((cred: Credential) => cred.name);
        if (!targets.length) {
            showAlert({ title: t('Error'), message: t('No disabled credentials to delete in current filter.'), confirmText: t('Confirm', 'Confirm') });
            return;
        }
        const confirmed = await showConfirm({
            title: t('Batch Delete Disabled Credentials'),
            message: t('Batch Delete Disabled Credentials Message', { count: targets.length }),
            confirmText: t('Confirm', 'Confirm'),
            cancelText: t('Cancel', 'Cancel'),
        });
        if (!confirmed) return;

        setIsArchiveBusy(true);
        try {
            const settled = await Promise.allSettled(targets.map((name) => runCredentialDelete(name).then(() => name)));
            const deleted: string[] = [];
            const failed: string[] = [];
            settled.forEach((item, idx) => {
                if (item.status === 'fulfilled') {
                    deleted.push(item.value);
                } else {
                    failed.push(targets[idx]);
                }
            });
            if (deleted.length) {
                setSelectedItems((prev) => {
                    const next = new Set(prev);
                    deleted.forEach((name) => next.delete(name));
                    return next;
                });
                await forceRefreshCredentials();
            }
            if (failed.length) {
                showAlert({
                    title: t('Error'),
                    message: `${t('Delete Failed Credentials Prefix')}: ${failed.join(', ')}`,
                    confirmText: t('Confirm', 'Confirm'),
                });
            }
        } finally {
            setIsArchiveBusy(false);
        }
    };

    const handleArchiveSelected = async () => {
        const targets = Array.from(selectedItems);
        if (!targets.length) return;
        const confirmed = await showConfirm({
            title: t('Archive Selected Credentials'),
            message: t('Archive Selected Credentials Message', { count: targets.length }),
            confirmText: t('Confirm', 'Confirm'),
            cancelText: t('Cancel', 'Cancel'),
        });
        if (!confirmed) return;
        try {
            await archiveCredentialNames(targets);
        } catch (error: unknown) {
            showAlert({
                title: t('Error'),
                message: String((error as { message?: string })?.message || error || t('Archive failed')),
                confirmText: t('Confirm', 'Confirm'),
            });
        }
    };

    return (
        <div className="space-y-6">
            <CredentialOverview
                t={t}
                {...credentialOverview}
                unavailable={isLoading || isError || archiveLoadStatus !== 'loaded'}
            />

            <CredentialManagerToolbar
                t={t}
                totalCredentialCount={totalCredentialCount}
                disabledCredentialCount={disabledCredentialCount}
                archivedCredentialCount={archivedCredentialCount}
                availableProviders={availableProviders}
                providerStats={providerStats}
                filterProvider={filterProvider}
                setFilterProvider={setFilterProvider}
                statusFilter={statusFilter}
                setStatusFilter={setStatusFilter}
                searchKeyword={searchKeyword}
                setSearchKeyword={setSearchKeyword}
                isAutoDisable={isAutoDisable}
                setIsAutoDisable={handleAutoDisableChange}
                cpaReady={cpaReady}
                isFetching={isFetching}
                onRefreshList={() => { void refreshListWithLock(true); }}
                isProbingAll={isProbingAll}
                filteredCredentialCount={filteredCredentials.length}
                onProbeAll={() => { void handleProbeAll(); }}
                probeCancelRequested={probeCancelRequested}
                onCancelProbeAll={handleCancelProbeAll}
                isArchiveBusy={isArchiveBusy}
                disabledFilteredCount={disabledFilteredCount}
                onArchiveDisabled={() => { void handleArchiveDisabled(); }}
                onDeleteDisabled={() => { void handleDeleteDisabled(); }}
                autoProbeEnabled={autoProbeEnabled}
                setAutoProbeEnabled={setAutoProbeEnabled}
                autoProbeIntervalMinutes={autoProbeIntervalMinutes}
                onAutoProbeIntervalChange={setSafeAutoProbeIntervalMinutes}
                probeBatchSize={probeBatchSize}
                onProbeBatchSizeChange={setSafeProbeBatchSize}
                probeBatchIntervalMs={probeBatchIntervalMs}
                onProbeBatchIntervalChange={setSafeProbeBatchIntervalMs}
                quotaDisableThresholdLabel={quotaDisableThresholdLabel}
                quotaDisableThresholdHint={quotaDisableThresholdHint}
                codexQuotaDisableRemainingPercent={codexQuotaDisableRemainingPercent}
                onQuotaDisableRemainingPercentChange={setSafeQuotaDisableRemainingPercent}
                autoProbeConfigHint={autoProbeConfigHint}
                backendAutomationHint={backendAutomationHint}
            />

            <CredentialSelectionBar
                t={t}
                selectedCount={selectedItems.size}
                isArchiveBusy={isArchiveBusy}
                isDeletingSelection={isDeletingSelection}
                onArchiveSelected={() => { void handleArchiveSelected(); }}
                onBatchDelete={() => { void handleBatchDelete(); }}
            />

            <CredentialTable
                t={t}
                i18nLanguage={i18n.language}
                cpaReady={cpaReady}
                isLoading={isLoading}
                isError={isError}
                error={error}
                filteredCredentials={filteredCredentials}
                pagedCredentials={pagedCredentials}
                selectedItems={selectedItems}
                onToggleSelectAll={handleSelectAll}
                onToggleItem={handleToggleItem}
                probeStatuses={mergedProbeStatuses}
                codexQuotaResumeMap={runtimeCodexQuotaResumeMap}
                runtimeOwnedNames={runtimeOwnedNames}
                operationErrors={currentOperationErrors}
                isLocked={isLocked}
                deletingNames={deletingNames}
                togglingNames={togglingNames}
                onProbeSingle={(cred) => { void handleProbeSingle(cred); }}
                onToggleStatus={(cred) => { void handleToggleStatus(cred); }}
                onDeleteSingle={(name) => { void handleDeleteSingle(name); }}
                onShowProbeDetail={(detail) => showAlert({ title: t('Probe Detail'), message: detail || t('No detail'), confirmText: t('Confirm', 'Confirm') })}
                onRetryLoad={() => { void refreshListWithLock(true); }}
                totalItems={totalItems}
                pageStart={pageStart}
                pageEnd={pageEnd}
                pageSize={pageSize}
                onPageSizeChange={setSafePageSize}
                currentPage={currentPage}
                totalPages={totalPages}
                onPageChange={setPage}
            />

        </div>
    );
}
















