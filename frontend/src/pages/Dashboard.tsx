import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { cpaApi, configApi, fetchAuthFiles, fetchAuthFilesForceRefresh, clearAuthFilesCache, probeCredential, updateCredentialStatus, deleteCredential, getCodexAuthUrl, runCredentialArchiveAdd, runCredentialArchiveList, runCredentialArchiveRemove, runOAuthAccountPreview, runOAuthAppendAccounts, runOAuthDeleteAccounts, runOAuthLogin } from '../lib/api';
import type { Credential, OAuthAccountPreviewPayload } from '../lib/api';
import { Settings, LogOut, CheckCircle2, XCircle, Clock, AlertTriangle, ShieldCheck, Play, RefreshCw, Layers, Moon, Sun, Globe, Trash2, ShieldAlert } from 'lucide-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { canProbeCredential, classifyProviderProbe, resolveTierAfterProbe, resolveTierFromCredential, shouldAutoDisable, toProbeErrorResponse, type ProbeTier, type ProbeUiStatus } from '../lib/providerStrategies';
import { useRunLock } from '../hooks/useRunLock';
import { useLockedInterval } from '../hooks/useLockedInterval';
import { useGlobalModal } from '../components/global-modal/useGlobalModal';

interface ProbeUiState {
    status: ProbeUiStatus;
    time: string;
    reason?: string;
    tier?: ProbeTier;
    detail?: string;
}

interface SidebarButtonProps {
    active: boolean;
    onClick: () => void;
    icon: React.ReactNode;
    label: string;
}

interface SettingsMessage {
    type: '' | 'success' | 'error';
    text: string;
}

interface SettingsPanelProps {
    cpaUrl: string;
    setCpaUrl: React.Dispatch<React.SetStateAction<string>>;
    newPassword: string;
    setNewPassword: React.Dispatch<React.SetStateAction<string>>;
    mailApiBase: string;
    setMailApiBase: React.Dispatch<React.SetStateAction<string>>;
    mailUsername: string;
    setMailUsername: React.Dispatch<React.SetStateAction<string>>;
    mailPassword: string;
    setMailPassword: React.Dispatch<React.SetStateAction<string>>;
    mailEmailDomain: string;
    setMailEmailDomain: React.Dispatch<React.SetStateAction<string>>;
    savingSettings: boolean;
    setSavingSettings: React.Dispatch<React.SetStateAction<boolean>>;
    message: SettingsMessage;
    setMessage: React.Dispatch<React.SetStateAction<SettingsMessage>>;
    t: (key: string, options?: { [key: string]: unknown }) => string;
}

interface CredentialManagerProps {
    cpaReady: boolean;
    cpaUrl: string;
}

interface OAuthLoginPanelProps {
    cpaReady: boolean;
}
interface ArchivePanelProps {
    cpaReady: boolean;
    cpaUrl: string;
}

function getInitialTheme(): 'light' | 'dark' {
    try {
        const cached = localStorage.getItem('theme');
        if (cached === 'dark' || cached === 'light') {
            return cached;
        }
    } catch {
        // ignore localStorage errors
    }
    return document.documentElement.classList.contains('dark') ? 'dark' : 'light';
}

export default function Dashboard() {
    const navigate = useNavigate();
    const { t, i18n } = useTranslation();
    const [activeTab, setActiveTab] = useState<'credentials' | 'archive' | 'oauthLogin' | 'settings'>('credentials');
    const [theme, setTheme] = useState<'light' | 'dark'>(getInitialTheme);

    // Settings Form State
    const [cpaUrl, setCpaUrl] = useState('');
    const [newPassword, setNewPassword] = useState('');
    const [mailApiBase, setMailApiBase] = useState('');
    const [mailUsername, setMailUsername] = useState('');
    const [mailPassword, setMailPassword] = useState('');
    const [mailEmailDomain, setMailEmailDomain] = useState('');
    const [savingSettings, setSavingSettings] = useState(false);
    const [settingsMessage, setSettingsMessage] = useState<SettingsMessage>({ type: '', text: '' });

    // Add an initialization effect that loads the URL securely
    useEffect(() => {
        const key = localStorage.getItem('management_key');
        if (!key) {
            navigate('/login');
            return;
        }

        // Try to restore config dynamically on page refresh
        const initConfig = async () => {
            try {
                const { data } = await configApi.post('/config', { password: key });
                if (data.ok) {
                    const resolvedUrl = String(data.config.cpa_url || '').trim();
                    cpaApi.defaults.baseURL = resolvedUrl;
                    setCpaUrl(resolvedUrl);
                    setMailApiBase(String(data.config.mail_api_base || ''));
                    setMailUsername(String(data.config.mail_username || ''));
                    setMailPassword(String(data.config.mail_password || ''));
                    setMailEmailDomain(String(data.config.mail_email_domain || ''));
                }
            } catch {
                localStorage.removeItem('management_key');
                navigate('/login');
            }
        };
        initConfig();
    }, [navigate]);

    useEffect(() => {
        const root = document.documentElement;
        if (theme === 'dark') {
            root.classList.add('dark');
        } else {
            root.classList.remove('dark');
        }
        root.style.colorScheme = theme;
        try {
            localStorage.setItem('theme', theme);
        } catch {
            // ignore localStorage errors
        }
    }, [theme]);

    const toggleTheme = () => setTheme(prev => prev === 'light' ? 'dark' : 'light');
    const toggleLanguage = () => i18n.changeLanguage(i18n.language === 'zh' ? 'en' : 'zh');

    return (
        <div className="flex h-screen w-full bg-muted/20 text-foreground overflow-hidden">
            {/* Sidebar */}
            <aside className="hidden md:flex w-64 flex-col border-r border-border bg-card">
                <div className="flex h-14 items-center px-4 border-b border-border">
                    <Layers className="h-5 w-5 text-primary mr-2" />
                    <span className="font-semibold text-lg tracking-tight">CPAMC Console</span>
                </div>
                <nav className="flex-1 overflow-y-auto py-4 flex flex-col gap-1 px-3">
                    <p className="px-2 text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2 mt-4 first:mt-0">Management</p>
                    <SidebarButton active={activeTab === 'credentials'} onClick={() => setActiveTab('credentials')} icon={<ShieldCheck className="h-4 w-4" />} label="Auth Files" />
                    <SidebarButton active={activeTab === 'archive'} onClick={() => setActiveTab('archive')} icon={<Trash2 className="h-4 w-4" />} label="Archive" />
                    <SidebarButton active={activeTab === 'oauthLogin'} onClick={() => setActiveTab('oauthLogin')} icon={<Play className="h-4 w-4" />} label="OAuth Login" />
                    <p className="px-2 text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2 mt-4">System</p>
                    <SidebarButton active={activeTab === 'settings'} onClick={() => setActiveTab('settings')} icon={<Settings className="h-4 w-4" />} label="Config" />
                </nav>
            </aside>

            {/* Main Content Area */}
            <div className="flex flex-1 flex-col min-w-0">
                {/* Header */}
                <header className="flex h-14 items-center gap-4 border-b border-border bg-card px-6 lg:px-8">
                    <div className="flex-1 flex items-center">
                        <span className="text-sm font-medium text-muted-foreground">URL: {cpaUrl || 'Not Connected'}</span>
                    </div>
                    <div className="flex flex-row items-center gap-4">
                        <button onClick={toggleLanguage} className="p-2 rounded-md hover:bg-muted text-muted-foreground transition-colors" title="Toggle Language">
                            <Globe className="h-4 w-4" />
                        </button>
                        <button onClick={toggleTheme} className="p-2 rounded-md hover:bg-muted text-muted-foreground transition-colors" title="Toggle Theme">
                            {theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
                        </button>
                        <div className="hidden md:flex items-center gap-2 border-l border-border pl-4">
                            <div className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse"></div>
                            <span className="text-sm text-emerald-600 dark:text-emerald-500 font-medium">{t('Connected')}</span>
                        </div>
                        <button
                            onClick={() => { localStorage.removeItem('management_key'); navigate('/login'); }}
                            className="text-sm font-medium text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5 transition-colors pl-4 border-l border-border"
                        >
                            <LogOut className="h-4 w-4" /> Sign out
                        </button>
                    </div>
                </header>

                {/* Main Scrollable Content */}
                <main className="flex-1 p-4 lg:p-6 overflow-y-auto">
                    <div className="mx-auto w-full max-w-[1900px] space-y-6">
                        {activeTab === 'credentials' && <CredentialManager cpaReady={Boolean(cpaUrl)} cpaUrl={cpaUrl} />}
                        {activeTab === 'archive' && <ArchivePanel cpaReady={Boolean(cpaUrl)} cpaUrl={cpaUrl} />}
                        {activeTab === 'oauthLogin' && <OAuthLoginPanel cpaReady={Boolean(cpaUrl)} />}
                        {activeTab === 'settings' && (
                            <SettingsPanel
                                cpaUrl={cpaUrl}
                                setCpaUrl={setCpaUrl}
                                newPassword={newPassword}
                                setNewPassword={setNewPassword}
                                mailApiBase={mailApiBase}
                                setMailApiBase={setMailApiBase}
                                mailUsername={mailUsername}
                                setMailUsername={setMailUsername}
                                mailPassword={mailPassword}
                                setMailPassword={setMailPassword}
                                mailEmailDomain={mailEmailDomain}
                                setMailEmailDomain={setMailEmailDomain}
                                savingSettings={savingSettings}
                                setSavingSettings={setSavingSettings}
                                message={settingsMessage}
                                setMessage={setSettingsMessage}
                                t={t}
                            />
                        )}
                    </div>
                </main>
            </div>
        </div>
    );
}

// ---------------- UI Components ----------------

const SidebarButton = ({ active, onClick, icon, label }: SidebarButtonProps) => (
    <button
        onClick={onClick}
        className={`flex items-center justify-start gap-3 rounded-md px-3 py-2.5 text-sm font-medium transition-all ${active
            ? 'bg-primary/10 text-primary'
            : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground'
            }`}
    >
        {icon}
        {label}
    </button>
);

// ---------------- Sub Sections ----------------

function SettingsPanel({
    cpaUrl,
    setCpaUrl,
    newPassword,
    setNewPassword,
    mailApiBase,
    setMailApiBase,
    mailUsername,
    setMailUsername,
    mailPassword,
    setMailPassword,
    mailEmailDomain,
    setMailEmailDomain,
    savingSettings,
    setSavingSettings,
    message,
    setMessage,
    t,
}: SettingsPanelProps) {
    const handleSave = async () => {
        setSavingSettings(true);
        setMessage({ type: '', text: '' });

        try {
            const oldPass = localStorage.getItem('management_key');
            const payload = {
                old_password: oldPass,
                new_config: {
                    cpa_url: cpaUrl || undefined,
                    management_key: newPassword || undefined,
                    mail_api_base: mailApiBase,
                    mail_username: mailUsername,
                    mail_password: mailPassword,
                    mail_email_domain: mailEmailDomain,
                }
            };

            const { data } = await configApi.post('/config/update', payload);
            if (data.ok) {
                setMessage({ type: 'success', text: 'Settings updated successfully!' });
                const resolvedUrl = (cpaUrl || '').trim();
                if (resolvedUrl) {
                    cpaApi.defaults.baseURL = resolvedUrl;
                    setCpaUrl(resolvedUrl);
                }
                if (newPassword) {
                    localStorage.setItem('management_key', newPassword);
                    setNewPassword('');
                }
            } else {
                setMessage({ type: 'error', text: 'Failed to update settings.' });
            }
        } catch (error: unknown) {
            const messageText = typeof error === 'object' && error !== null && 'message' in error
                ? String((error as { message?: string }).message || 'Update failed')
                : 'Update failed';
            setMessage({ type: 'error', text: messageText });
        } finally {
            setSavingSettings(false);
        }
    };

    return (
        <div className="rounded-xl border border-border bg-card p-6 shadow-sm">
            <h2 className="text-xl font-semibold mb-6 flex items-center gap-2"><Settings className="h-5 w-5" /> {t('Service Configuration')}</h2>

            <div className="space-y-4 max-w-md">
                <div className="grid gap-2">
                    <label className="text-sm font-medium leading-none">{t('CPA API URL')}</label>
                    <input
                        type="url"
                        value={cpaUrl}
                        onChange={(e) => setCpaUrl(e.target.value)}
                        className="flex h-10 w-full rounded-md border border-input bg-background/50 px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        placeholder="http://127.0.0.1:8080"
                    />
                </div>
                <div className="grid gap-2">
                    <label className="text-sm font-medium leading-none">{t('New Management Key')}</label>
                    <input
                        type="password"
                        value={newPassword}
                        onChange={(e) => setNewPassword(e.target.value)}
                        className="flex h-10 w-full rounded-md border border-input bg-background/50 px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        placeholder={t('Leave blank to keep current')}
                    />
                </div>
                <div className="grid gap-2">
                    <label className="text-sm font-medium leading-none">Mail API Base</label>
                    <input
                        type="url"
                        value={mailApiBase}
                        onChange={(e) => setMailApiBase(e.target.value)}
                        className="flex h-10 w-full rounded-md border border-input bg-background/50 px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        placeholder="https://mail-api.example.com"
                    />
                </div>
                <div className="grid gap-2">
                    <label className="text-sm font-medium leading-none">Mail Username</label>
                    <input
                        type="text"
                        value={mailUsername}
                        onChange={(e) => setMailUsername(e.target.value)}
                        className="flex h-10 w-full rounded-md border border-input bg-background/50 px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        placeholder="admin"
                    />
                </div>
                <div className="grid gap-2">
                    <label className="text-sm font-medium leading-none">Mail Password</label>
                    <input
                        type="password"
                        value={mailPassword}
                        onChange={(e) => setMailPassword(e.target.value)}
                        className="flex h-10 w-full rounded-md border border-input bg-background/50 px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        placeholder="mail service password"
                    />
                </div>
                <div className="grid gap-2">
                    <label className="text-sm font-medium leading-none">Mail Email Domain</label>
                    <input
                        type="text"
                        value={mailEmailDomain}
                        onChange={(e) => setMailEmailDomain(e.target.value)}
                        className="flex h-10 w-full rounded-md border border-input bg-background/50 px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        placeholder="example.com"
                    />
                </div>

                {message.text && (
                    <div className={`text-sm px-4 py-3 rounded-md border ${message.type === 'success' ? 'border-primary/50 bg-primary/10 text-primary' : 'border-destructive/50 bg-destructive/10 text-destructive'}`}>
                        {message.text}
                    </div>
                )}

                <button
                    onClick={handleSave}
                    disabled={savingSettings}
                    className="inline-flex h-10 items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors"
                >
                    {savingSettings ? t('Saving...') : t('Save Configuration')}
                </button>
            </div>
        </div>
    );
}


function OAuthLoginPanel({ cpaReady }: OAuthLoginPanelProps) {
    const { t } = useTranslation();
    const { showAlert, showConfirm } = useGlobalModal();
    const queryClient = useQueryClient();

    type OAuthRowStatus = 'pending' | 'running' | 'success' | 'failed' | 'skipped';
    type OAuthLogLevel = 'info' | 'success' | 'error' | 'warn';
    interface OAuthAccountRow {
        index: number;
        email: string;
        provider: string;
        channel: string;
        hasAccessToken: boolean;
        hasRecoveryEmail: boolean;
        hasTotpUrl: boolean;
        status: OAuthRowStatus;
        statusText: string;
        submitHttpStatus?: number;
        authStatus?: string;
    }
    interface OAuthLogEntry {
        at: string;
        level: OAuthLogLevel;
        message: string;
    }

    const STORAGE_KEY = 'oauth_login_panel_v3';
    const persisted = useMemo(() => {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) {
                return {};
            }
            const parsed = JSON.parse(raw);
            return (parsed && typeof parsed === 'object') ? parsed as Record<string, unknown> : {};
        } catch {
            return {};
        }
    }, []);

    const [isOauthing, setIsOauthing] = useState(false);
    const [isBatchRunning, setIsBatchRunning] = useState(false);
    const [batchCancelRequested, setBatchCancelRequested] = useState(false);
    const [isLoadingAccounts, setIsLoadingAccounts] = useState(false);
    const currentLoginAbortRef = useRef<AbortController | null>(null);
    const batchCancelRequestedRef = useRef(false);
    const [oauthProvider, setOauthProvider] = useState(String(persisted.oauthProvider || 'codex'));
    const [oauthAccountFile, setOauthAccountFile] = useState(String(persisted.oauthAccountFile || 'runtime/accounts.txt'));
    const [oauthRetries, setOauthRetries] = useState(Math.max(0, Number(persisted.oauthRetries || 0)));
    const [oauthWaitSeconds, setOauthWaitSeconds] = useState(Math.max(5, Number(persisted.oauthWaitSeconds || 30)));
    const [oauthMaxWait, setOauthMaxWait] = useState(Math.max(30, Number(persisted.oauthMaxWait || 180)));
    const [oauthCooldown, setOauthCooldown] = useState(Math.max(0, Number(persisted.oauthCooldown || 0)));
    const [oauthHeadless, setOauthHeadless] = useState(Boolean(persisted.oauthHeadless ?? true));
    const [oauthCallbackFile, setOauthCallbackFile] = useState(String(persisted.oauthCallbackFile || ''));
    const [oauthSkipSubmitted, setOauthSkipSubmitted] = useState(Boolean(persisted.oauthSkipSubmitted ?? true));
    const [oauthResultFile, setOauthResultFile] = useState(String(persisted.oauthResultFile || 'runtime/batch_login_callback_results.jsonl'));
    const [oauthSuccessFile, setOauthSuccessFile] = useState(String(persisted.oauthSuccessFile || 'runtime/batch_login_callback_success.txt'));
    const [oauthDetailLogFile, setOauthDetailLogFile] = useState(String(persisted.oauthDetailLogFile || 'runtime/batch_login_callback_detail.log'));
    const [oauthRunOutput, setOauthRunOutput] = useState(String(persisted.oauthRunOutput || ''));
    const [oauthAccountRows, setOauthAccountRows] = useState<OAuthAccountRow[]>(Array.isArray(persisted.oauthAccountRows) ? persisted.oauthAccountRows as OAuthAccountRow[] : []);
    const [selectedRowKeys, setSelectedRowKeys] = useState<string[]>(Array.isArray(persisted.selectedRowKeys) ? persisted.selectedRowKeys as string[] : []);
    const [oauthLogs, setOauthLogs] = useState<OAuthLogEntry[]>(Array.isArray(persisted.oauthLogs) ? persisted.oauthLogs as OAuthLogEntry[] : []);
    const [oauthPreviewMeta, setOauthPreviewMeta] = useState<{ total: number; selected: number }>(() => {
        const candidate = persisted.oauthPreviewMeta as { total?: number; selected?: number } | undefined;
        return {
            total: Number(candidate?.total || 0),
            selected: Number(candidate?.selected || 0),
        };
    });
    const [quickAppendText, setQuickAppendText] = useState(String(persisted.quickAppendText || ''));
    const [isAppendingAccounts, setIsAppendingAccounts] = useState(false);
    const [isDeletingAccounts, setIsDeletingAccounts] = useState(false);
    const APPEND_CHUNK_MAX_CHARS = 200_000;
    const OUTPUT_MAX_CHARS = 120_000;

    const rowKey = useCallback((item: { index: number; email: string }) => `${item.index}|${String(item.email || '').trim().toLowerCase()}`, []);

    const appendLog = useCallback((level: OAuthLogLevel, message: string) => {
        const at = new Date().toLocaleTimeString('zh-CN', { hour12: false });
        setOauthLogs((prev) => {
            const next = [...prev, { at, level, message }];
            return next.slice(-600);
        });
    }, []);

    const refreshCredentialList = async () => {
        clearAuthFilesCache();
        await queryClient.invalidateQueries({ queryKey: ['credentials'] });
    };

    const formatOAuthResultText = (result: unknown): string => {
        if (!result || typeof result !== 'object') {
            return String(result || '');
        }
        const response = result as {
            payload?: unknown;
            stderr?: string;
        };
        const payload = response.payload ?? response;
        const parts = [JSON.stringify(payload, null, 2)];
        const stderrText = String(response.stderr || '').trim();
        if (stderrText) {
            parts.push(`stderr:\n${stderrText}`);
        }
        return parts.join('\n\n');
    };

    const sleep = async (ms: number) => {
        if (ms <= 0) return;
        await new Promise((resolve) => setTimeout(resolve, ms));
    };

    const trimOutputText = (text: string) => {
        const value = String(text || '');
        if (value.length <= OUTPUT_MAX_CHARS) {
            return value;
        }
        return `...(trimmed ${value.length - OUTPUT_MAX_CHARS} chars)\n${value.slice(-OUTPUT_MAX_CHARS)}`;
    };

    const appendRunOutput = (title: string, result: unknown) => {
        const ts = new Date().toLocaleTimeString('zh-CN', { hour12: false });
        const text = formatOAuthResultText(result);
        setOauthRunOutput((prev) => {
            const lines = [`[${ts}] ${title}`, text];
            const merged = prev.trim()
                ? `${prev}\n\n${lines.join('\n')}`
                : lines.join('\n');
            return trimOutputText(merged);
        });
    };

    const splitAppendChunks = (content: string): string[] => {
        const lines = String(content || '')
            .replace(/\r/g, '')
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line.length > 0);
        if (!lines.length) {
            return [];
        }
        const chunks: string[] = [];
        let current = '';
        for (const line of lines) {
            const next = current ? `${current}\n${line}` : line;
            if (next.length > APPEND_CHUNK_MAX_CHARS) {
                if (current) {
                    chunks.push(current);
                    current = line;
                    continue;
                }
                chunks.push(line);
                current = '';
                continue;
            }
            current = next;
        }
        if (current) {
            chunks.push(current);
        }
        return chunks;
    };

    const extractCliError = (error: unknown): { message: string; data?: Record<string, unknown> } => {
        const fallback = error instanceof Error ? error.message : String(error);
        const err = error as {
            message?: string;
            response?: {
                status?: number;
                data?: Record<string, unknown>;
            };
        };
        const data = err?.response?.data;
        if (!data || typeof data !== 'object') {
            return { message: fallback };
        }
        const payload = (data.payload && typeof data.payload === 'object')
            ? data.payload as Record<string, unknown>
            : undefined;
        const payloadError = payload ? String(payload.error || '') : '';
        const topError = String(data.error || '');
        const stderr = String(data.stderr || '');
        const detailed = payloadError || topError || stderr || fallback;
        const status = Number(err?.response?.status || 0);
        const msg = status > 0 ? `${detailed} (http ${status})` : detailed;
        return { message: msg, data };
    };

    const markRows = useCallback((keys: string[], status: OAuthRowStatus, text: string) => {
        const set = new Set(keys);
        setOauthAccountRows((prev) =>
            prev.map((item) =>
                set.has(rowKey(item))
                    ? { ...item, status, statusText: text }
                    : item,
            ),
        );
    }, [rowKey]);

    const applyRowUpdates = useCallback((updates: Array<{
        index?: number;
        email?: string;
        status: OAuthRowStatus;
        statusText: string;
        submitHttpStatus?: number;
        authStatus?: string;
    }>) => {
        setOauthAccountRows((prev) => {
            const next = [...prev];
            const keyToPos = new Map<string, number>();
            next.forEach((item, idx) => keyToPos.set(rowKey(item), idx));
            for (const patch of updates) {
                const index = Number(patch.index);
                const email = String(patch.email || '').trim();
                if (!Number.isFinite(index) || !email) {
                    continue;
                }
                const key = `${index}|${email.toLowerCase()}`;
                const pos = keyToPos.get(key);
                if (pos === undefined) {
                    continue;
                }
                next[pos] = {
                    ...next[pos],
                    status: patch.status,
                    statusText: patch.statusText,
                    submitHttpStatus: patch.submitHttpStatus,
                    authStatus: patch.authStatus,
                };
            }
            return next;
        });
    }, [rowKey]);

    const handleLoadOauthAccounts = async () => {
        if (!oauthAccountFile.trim()) {
            showAlert({ title: t('Error'), message: 'account_file 不能为空', confirmText: t('Confirm', 'Confirm') });
            return;
        }
        setIsLoadingAccounts(true);
        appendLog('info', `开始加载账号: ${oauthAccountFile.trim()}`);
        try {
            const result = await runOAuthAccountPreview({
                provider: oauthProvider,
                account_file: oauthAccountFile.trim(),
                mode: 'batch',
                start: 0,
                limit: 0,
            });
            appendRunOutput('账号预览', result);
            if (!result.ok) {
                const msg = String((result.payload as { error?: string } | null)?.error || result.error || 'oauth-account-preview failed');
                appendLog('error', `加载账号失败: ${msg}`);
                showAlert({ title: t('Error'), message: msg, confirmText: t('Confirm', 'Confirm') });
                return;
            }
            const payload = (result.payload || {}) as OAuthAccountPreviewPayload;
            const previewAccounts = Array.isArray(payload.accounts) ? payload.accounts : [];
            const previousByKey = new Map<string, OAuthAccountRow>();
            for (const row of oauthAccountRows) {
                previousByKey.set(rowKey(row), row);
            }
            const mergedRows: OAuthAccountRow[] = previewAccounts.map((item) => {
                const nextRow: OAuthAccountRow = {
                    index: Number(item.index),
                    email: String(item.email || ''),
                    provider: String(item.provider || oauthProvider),
                    channel: String(item.channel || oauthProvider),
                    hasAccessToken: Boolean(item.has_access_token),
                    hasRecoveryEmail: Boolean(item.has_recovery_email),
                    hasTotpUrl: Boolean(item.has_totp_url),
                    status: 'pending',
                    statusText: '待登录',
                };
                const prev = previousByKey.get(rowKey(nextRow));
                if (!prev) {
                    return nextRow;
                }
                return {
                    ...nextRow,
                    status: prev.status,
                    statusText: prev.statusText,
                    submitHttpStatus: prev.submitHttpStatus,
                    authStatus: prev.authStatus,
                };
            });
            setOauthAccountRows(mergedRows);
            const validKeys = new Set(mergedRows.map((item) => rowKey(item)));
            setSelectedRowKeys((prev) => prev.filter((key) => validKeys.has(key)));
            setOauthPreviewMeta({
                total: Number(payload.total_accounts || previewAccounts.length),
                selected: Number(payload.selected || previewAccounts.length),
            });
            appendLog('success', `加载账号完成: total=${payload.total_accounts || previewAccounts.length}, selected=${payload.selected || previewAccounts.length}`);
        } catch (error) {
            const parsed = extractCliError(error);
            if (parsed.data) {
                appendRunOutput('账号预览(异常)', parsed.data);
            } else {
                setOauthRunOutput(parsed.message);
            }
            appendLog('error', `加载账号异常: ${parsed.message}`);
            showAlert({ title: t('Error'), message: parsed.message, confirmText: t('Confirm', 'Confirm') });
        } finally {
            setIsLoadingAccounts(false);
        }
    };
    const applySingleLoginResult = (result: { payload?: unknown }, row: OAuthAccountRow) => {
        const payload = (result.payload || {}) as { detail?: Record<string, unknown> };
        const detail = payload.detail || {};
        const success = Boolean(detail.success);
        const submitHttpStatus = Number(detail.submit_http_status || 0);
        const authStatus = String(detail.auth_status || '');
        const errorText = String(detail.error || detail.submit_error || detail.auth_error || '').trim();
        const statusText = success
            ? `成功 (${submitHttpStatus || '-'} / ${authStatus || 'ok'})`
            : `失败 (${errorText || `HTTP ${submitHttpStatus || 0}`})`;
        applyRowUpdates([
            {
                index: row.index,
                email: row.email,
                status: success ? 'success' : 'failed',
                statusText,
                submitHttpStatus: submitHttpStatus > 0 ? submitHttpStatus : undefined,
                authStatus,
            },
        ]);
        appendLog(success ? 'success' : 'error', `[${row.email}] ${statusText}`);
    };

    const runBatchLogin = async (rows: OAuthAccountRow[], title: string) => {
        if (rows.length === 0) {
            showAlert({ title: t('Error'), message: `${title}: 没有可执行账号`, confirmText: t('Confirm', 'Confirm') });
            return;
        }
        if (!oauthAccountFile.trim()) {
            showAlert({ title: t('Error'), message: 'account_file 不能为空', confirmText: t('Confirm', 'Confirm') });
            return;
        }
        const rowsToRun = oauthSkipSubmitted
            ? rows.filter((item) => item.status !== 'success')
            : rows;
        const skippedRows = oauthSkipSubmitted
            ? rows.filter((item) => item.status === 'success')
            : [];
        if (rowsToRun.length === 0) {
            appendLog('warn', `${title} 全部跳过（已成功且启用 skip submitted）`);
            return;
        }

        for (const row of skippedRows) {
            appendLog('warn', `[${row.email}] 跳过（已成功且启用 skip submitted）`);
        }

        const keys = rowsToRun.map((item) => rowKey(item));
        markRows(keys, 'pending', '待登录');
        appendLog('info', `${title} 开始，账号数=${rowsToRun.length}`);
        setIsOauthing(true);
        setIsBatchRunning(true);
        setBatchCancelRequested(false);
        batchCancelRequestedRef.current = false;
        try {
            for (const row of rowsToRun) {
                if (batchCancelRequestedRef.current) {
                    appendLog('warn', `${title} 已取消`);
                    break;
                }
                const key = rowKey(row);
                markRows([key], 'running', '登录中...');
                let finished = false;
                for (let attempt = 1; attempt <= Math.max(1, oauthRetries + 1); attempt += 1) {
                    if (batchCancelRequestedRef.current) {
                        break;
                    }
                    appendLog('info', `[${row.email}] 开始尝试 ${attempt}/${Math.max(1, oauthRetries + 1)}`);
                    const controller = new AbortController();
                    currentLoginAbortRef.current = controller;
                    try {
                        const result = await runOAuthLogin(
                            {
                                provider: oauthProvider,
                                account_file: oauthAccountFile.trim(),
                                index: row.index,
                                wait_seconds: oauthWaitSeconds,
                                max_wait: oauthMaxWait,
                                headless: oauthHeadless,
                            },
                            { signal: controller.signal },
                        );
                        appendRunOutput(`[${row.email}] 尝试 ${attempt}`, result);
                        applySingleLoginResult(result, row);
                        if (result.ok) {
                            finished = true;
                            break;
                        }
                    } catch (error) {
                        const parsed = extractCliError(error);
                        if (parsed.data) {
                            appendRunOutput(`[${row.email}] 尝试 ${attempt} 失败`, parsed.data);
                            const payload = parsed.data.payload as Record<string, unknown> | undefined;
                            const detail = payload?.detail as Record<string, unknown> | undefined;
                            if (detail) {
                                applySingleLoginResult({ payload: { detail } }, row);
                                if (detail.success) {
                                    finished = true;
                                    break;
                                }
                            }
                        }
                        if (batchCancelRequestedRef.current) {
                            appendLog('warn', `[${row.email}] 已取消当前登录`);
                            markRows([key], 'pending', '已取消');
                            finished = true;
                            break;
                        }
                        appendLog('error', `[${row.email}] 尝试 ${attempt} 异常: ${parsed.message}`);
                        if (attempt >= Math.max(1, oauthRetries + 1)) {
                            markRows([key], 'failed', `失败 (${parsed.message})`);
                        }
                    } finally {
                        currentLoginAbortRef.current = null;
                    }

                    if (attempt < Math.max(1, oauthRetries + 1) && !batchCancelRequestedRef.current) {
                        markRows([key], 'running', `重试中 ${attempt + 1}/${Math.max(1, oauthRetries + 1)}`);
                    }
                }

                if (!finished && !batchCancelRequestedRef.current) {
                    markRows([key], 'failed', '失败');
                }

                if (batchCancelRequestedRef.current) {
                    break;
                }

                if (oauthCooldown > 0) {
                    await sleep(Math.max(0, Number(oauthCooldown)) * 1000);
                }
            }
            if (!batchCancelRequestedRef.current) {
                appendLog('success', `${title} 完成`);
                await refreshCredentialList();
            }
        } catch (error) {
            const parsed = extractCliError(error);
            if (parsed.data) {
                appendRunOutput(`${title} 异常`, parsed.data);
            }
            appendLog('error', `${title} 异常: ${parsed.message}`);
            showAlert({ title: t('Error'), message: parsed.message, confirmText: t('Confirm', 'Confirm') });
            markRows(keys, 'failed', `失败 (${parsed.message})`);
        } finally {
            setIsOauthing(false);
            setIsBatchRunning(false);
            setBatchCancelRequested(false);
            batchCancelRequestedRef.current = false;
            currentLoginAbortRef.current = null;
        }
    };

    const handleSingleRowLogin = async (row: OAuthAccountRow) => {
        if (!oauthAccountFile.trim()) {
            showAlert({ title: t('Error'), message: 'account_file 不能为空', confirmText: t('Confirm', 'Confirm') });
            return;
        }
        const key = rowKey(row);
        markRows([key], 'running', '登录中...');
        appendLog('info', `单账号登录开始: ${row.email}`);
        setIsOauthing(true);
        try {
            const controller = new AbortController();
            currentLoginAbortRef.current = controller;
            const result = await runOAuthLogin({
                provider: oauthProvider,
                account_file: oauthAccountFile.trim(),
                index: row.index,
                wait_seconds: oauthWaitSeconds,
                max_wait: oauthMaxWait,
                headless: oauthHeadless,
            }, { signal: controller.signal });
            appendRunOutput(`[${row.email}] 单账号登录`, result);
            applySingleLoginResult(result, row);
            if (result.ok) {
                await refreshCredentialList();
            }
        } catch (error) {
            const parsed = extractCliError(error);
            if (parsed.data) {
                appendRunOutput(`[${row.email}] 单账号登录(失败)`, parsed.data);
                const payload = parsed.data.payload as Record<string, unknown> | undefined;
                const detail = payload?.detail as Record<string, unknown> | undefined;
                if (detail) {
                    applySingleLoginResult({ payload: { detail } }, row);
                }
            }
            if (batchCancelRequestedRef.current) {
                appendLog('warn', `[${row.email}] 登录已取消`);
                markRows([key], 'pending', '已取消');
            } else {
                appendLog('error', `[${row.email}] 登录异常: ${parsed.message}`);
                markRows([key], 'failed', `失败 (${parsed.message})`);
            }
        } finally {
            setIsOauthing(false);
            currentLoginAbortRef.current = null;
        }
    };

    const pendingRows = useMemo(() => oauthAccountRows.filter((item) => item.status === 'pending' || item.status === 'running'), [oauthAccountRows]);
    const successRows = useMemo(() => oauthAccountRows.filter((item) => item.status === 'success'), [oauthAccountRows]);
    const failedRows = useMemo(() => oauthAccountRows.filter((item) => item.status === 'failed' || item.status === 'skipped'), [oauthAccountRows]);

    const selectedRows = useMemo(() => {
        const keySet = new Set(selectedRowKeys);
        return oauthAccountRows.filter((item) => keySet.has(rowKey(item)));
    }, [oauthAccountRows, selectedRowKeys, rowKey]);

    const statusClass = (status: OAuthRowStatus) => {
        if (status === 'success') {
            return 'bg-emerald-100 text-emerald-700';
        }
        if (status === 'failed') {
            return 'bg-rose-100 text-rose-700';
        }
        if (status === 'skipped') {
            return 'bg-amber-100 text-amber-700';
        }
        if (status === 'running') {
            return 'bg-sky-100 text-sky-700';
        }
        return 'bg-slate-100 text-slate-700';
    };

    const outputLineClass = (line: string) => {
        const text = line.toLowerCase();
        if (text.includes('success') || text.includes('"ok"') || text.includes('"status": "ok"')) {
            return 'text-emerald-600';
        }
        if (text.includes('error') || text.includes('failed') || text.includes('exception') || text.includes('"status": "error"')) {
            return 'text-rose-600';
        }
        if (text.includes('skip') || text.includes('warn')) {
            return 'text-amber-600';
        }
        return 'text-muted-foreground';
    };

    useEffect(() => {
        setOauthAccountRows((prev) =>
            prev.map((item) =>
                item.status === 'running'
                    ? { ...item, status: 'pending', statusText: '待登录(上次中断)' }
                    : item,
            ),
        );
    }, []);

    useEffect(() => {
        const valid = new Set(oauthAccountRows.map((item) => rowKey(item)));
        setSelectedRowKeys((prev) => prev.filter((key) => valid.has(key)));
    }, [oauthAccountRows, rowKey]);

    useEffect(() => {
        const payload = {
            oauthProvider,
            oauthAccountFile,
            oauthRetries,
            oauthWaitSeconds,
            oauthMaxWait,
            oauthCooldown,
            oauthHeadless,
            oauthCallbackFile,
            oauthSkipSubmitted,
            oauthResultFile,
            oauthSuccessFile,
            oauthDetailLogFile,
            oauthRunOutput,
            oauthAccountRows,
            selectedRowKeys,
            oauthLogs,
            oauthPreviewMeta,
            quickAppendText,
        };
        const timer = window.setTimeout(() => {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
        }, 300);
        return () => window.clearTimeout(timer);
    }, [
        oauthProvider,
        oauthAccountFile,
        oauthRetries,
        oauthWaitSeconds,
        oauthMaxWait,
        oauthCooldown,
        oauthHeadless,
        oauthCallbackFile,
        oauthSkipSubmitted,
        oauthResultFile,
        oauthSuccessFile,
        oauthDetailLogFile,
        oauthRunOutput,
        oauthAccountRows,
        selectedRowKeys,
        oauthLogs,
        oauthPreviewMeta,
        quickAppendText,
    ]);

    const toggleSelectRow = (row: OAuthAccountRow) => {
        const key = rowKey(row);
        setSelectedRowKeys((prev) => (prev.includes(key) ? prev.filter((item) => item !== key) : [...prev, key]));
    };

    const selectAllPending = () => {
        setSelectedRowKeys(Array.from(new Set(pendingRows.map((item) => rowKey(item)))));
    };

    const selectAllFailedSkipped = () => {
        setSelectedRowKeys(Array.from(new Set(failedRows.map((item) => rowKey(item)))));
    };

    const cancelBatchLogin = () => {
        if (!isBatchRunning) {
            return;
        }
        setBatchCancelRequested(true);
        batchCancelRequestedRef.current = true;
        currentLoginAbortRef.current?.abort();
        appendLog('warn', '收到取消请求，将在当前账号结束后停止');
    };

    const handleQuickAppendAccounts = async () => {
        const content = quickAppendText.trim();
        if (!oauthAccountFile.trim()) {
            showAlert({ title: t('Error'), message: 'account_file 不能为空', confirmText: t('Confirm', 'Confirm') });
            return;
        }
        if (!content) {
            showAlert({ title: t('Error'), message: '请粘贴账号内容', confirmText: t('Confirm', 'Confirm') });
            return;
        }
        setIsAppendingAccounts(true);
        try {
            const chunks = splitAppendChunks(content);
            if (!chunks.length) {
                showAlert({ title: t('Error'), message: '请粘贴有效账号内容', confirmText: t('Confirm', 'Confirm') });
                return;
            }

            let totalAdded = 0;
            let totalOverwritten = 0;
            let totalSkipped = 0;
            let targetFile = oauthAccountFile;
            appendLog('info', `开始追加账号: chunk=${chunks.length}`);

            for (let i = 0; i < chunks.length; i += 1) {
                const result = await runOAuthAppendAccounts({
                    provider: oauthProvider,
                    account_file: oauthAccountFile.trim(),
                    content: chunks[i],
                });
                appendRunOutput(`快捷追加账号 chunk ${i + 1}/${chunks.length}`, result);
                if (!result.ok) {
                    const msg = String((result.payload as { error?: string } | null)?.error || result.error || 'append accounts failed');
                    appendLog('error', `追加账号失败(chunk ${i + 1}/${chunks.length}): ${msg}`);
                    showAlert({ title: t('Error'), message: msg, confirmText: t('Confirm', 'Confirm') });
                    return;
                }
                const payload = (result.payload || {}) as {
                    appended?: number;
                    added?: number;
                    overwritten?: number;
                    skipped_invalid?: number;
                    file?: string;
                };
                totalAdded += Number(payload.added ?? payload.appended ?? 0);
                totalOverwritten += Number(payload.overwritten ?? 0);
                totalSkipped += Number(payload.skipped_invalid ?? 0);
                targetFile = String(payload.file || targetFile);
            }

            appendLog(
                'success',
                `追加账号成功: 新增=${totalAdded} 覆盖=${totalOverwritten} 跳过无效=${totalSkipped} file=${targetFile}`,
            );
            setQuickAppendText('');
            await handleLoadOauthAccounts();
        } catch (error) {
            const parsed = extractCliError(error);
            if (parsed.data) {
                appendRunOutput('快捷追加账号(异常)', parsed.data);
            }
            appendLog('error', `追加账号异常: ${parsed.message}`);
            showAlert({ title: t('Error'), message: parsed.message, confirmText: t('Confirm', 'Confirm') });
        } finally {
            setIsAppendingAccounts(false);
        }
    };

    const handleDeleteRows = async (rows: OAuthAccountRow[], title: string) => {
        if (!rows.length) {
            appendLog('warn', `${title}: 没有可删除账号`);
            return;
        }
        if (!oauthAccountFile.trim()) {
            showAlert({ title: t('Error'), message: 'account_file 不能为空', confirmText: t('Confirm', 'Confirm') });
            return;
        }
        const confirmed = await showConfirm({
            title: '删除账号确认',
            message: `${title}，将从账号文件中删除 ${rows.length} 条记录（按预览索引）。是否继续？`,
            confirmText: t('Confirm', 'Confirm'),
            cancelText: t('Cancel', 'Cancel'),
        });
        if (!confirmed) {
            return;
        }

        const indexes = Array.from(new Set(rows.map((item) => Number(item.index))))
            .filter((item) => Number.isFinite(item) && item >= 0)
            .sort((a, b) => a - b);
        if (!indexes.length) {
            appendLog('warn', `${title}: 无有效索引`);
            return;
        }

        setIsDeletingAccounts(true);
        try {
            const result = await runOAuthDeleteAccounts({
                provider: oauthProvider,
                account_file: oauthAccountFile.trim(),
                indexes,
            });
            appendRunOutput(`${title}`, result);
            if (!result.ok) {
                const msg = String((result.payload as { error?: string } | null)?.error || result.error || 'delete accounts failed');
                appendLog('error', `${title}失败: ${msg}`);
                showAlert({ title: t('Error'), message: msg, confirmText: t('Confirm', 'Confirm') });
                return;
            }
            const detail = ((result.payload as { detail?: Record<string, unknown> } | null)?.detail || {}) as Record<string, unknown>;
            const deleted = Number(detail.deleted || 0);
            const missing = Number(detail.missing || 0);
            const requested = Number(detail.requested || indexes.length);
            appendLog('success', `${title}完成: requested=${requested} deleted=${deleted} missing=${missing}`);
            const deletedKeySet = new Set(rows.map((item) => rowKey(item)));
            setSelectedRowKeys((prev) => prev.filter((item) => !deletedKeySet.has(item)));
            await handleLoadOauthAccounts();
        } catch (error) {
            const parsed = extractCliError(error);
            if (parsed.data) {
                appendRunOutput(`${title}(异常)`, parsed.data);
            }
            appendLog('error', `${title}异常: ${parsed.message}`);
            showAlert({ title: t('Error'), message: parsed.message, confirmText: t('Confirm', 'Confirm') });
        } finally {
            setIsDeletingAccounts(false);
        }
    };

    const clearLogs = () => {
        setOauthLogs([]);
        setOauthRunOutput('');
    };

    const renderGroup = (title: string, rows: OAuthAccountRow[]) => (
        <div className="rounded-md border border-border bg-background">
            <div className="px-3 py-2 border-b border-border text-sm font-medium">{title} ({rows.length})</div>
            <div className="overflow-auto max-h-64">
                <table className="min-w-full text-xs">
                    <thead className="sticky top-0 bg-muted/40">
                        <tr className="text-left text-muted-foreground">
                            <th className="px-2 py-2 w-8"></th>
                            <th className="px-2 py-2 w-16">#</th>
                            <th className="px-2 py-2">Email</th>
                            <th className="px-2 py-2">状态</th>
                            <th className="px-2 py-2 w-40">操作</th>
                        </tr>
                    </thead>
                    <tbody>
                        {rows.length === 0 && (
                            <tr>
                                <td className="px-2 py-3 text-muted-foreground" colSpan={5}>
                                    暂无数据
                                </td>
                            </tr>
                        )}
                        {rows.map((item) => (
                            <tr key={rowKey(item)} className="border-t border-border">
                                <td className="px-2 py-2">
                                    <input
                                        type="checkbox"
                                        checked={selectedRowKeys.includes(rowKey(item))}
                                        onChange={() => toggleSelectRow(item)}
                                        className="rounded border-input text-primary focus:ring-primary h-4 w-4 bg-background/50"
                                    />
                                </td>
                                <td className="px-2 py-2 font-mono">{item.index}</td>
                                <td className="px-2 py-2">{item.email}</td>
                                <td className="px-2 py-2">
                                    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${statusClass(item.status)}`}>
                                        {item.statusText}
                                    </span>
                                </td>
                                <td className="px-2 py-2">
                                    <button
                                        onClick={() => handleSingleRowLogin(item)}
                                        disabled={isOauthing || isLoadingAccounts || isAppendingAccounts || isDeletingAccounts || !cpaReady}
                                        className="inline-flex h-7 items-center justify-center rounded-md border border-input bg-transparent px-2 text-xs font-medium hover:bg-accent hover:text-accent-foreground disabled:opacity-50"
                                    >
                                        登录
                                    </button>
                                    <button
                                        onClick={() => handleDeleteRows([item], `[${item.email}] 删除账号`)}
                                        disabled={isOauthing || isLoadingAccounts || isAppendingAccounts || isDeletingAccounts || !cpaReady}
                                        className="ml-2 inline-flex h-7 items-center justify-center rounded-md border border-rose-300 bg-rose-50 px-2 text-xs font-medium text-rose-700 hover:bg-rose-100 disabled:opacity-50"
                                    >
                                        删除
                                    </button>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    );

    return (
        <div className="rounded-xl border border-border bg-card p-5 shadow-sm space-y-4">
            <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-2">
                <div>
                    <h3 className="text-base font-semibold">OAuth 临时账号管理</h3>
                    <p className="text-xs text-muted-foreground">加载账号后可按分组管理，支持单账号登录和勾选批量登录。界面状态与日志会自动持久化。</p>
                </div>
                <div className="text-xs text-muted-foreground">
                    total={oauthPreviewMeta.total} loaded={oauthPreviewMeta.selected} pending={pendingRows.length} success={successRows.length} failed={failedRows.length} selected={selectedRows.length}
                </div>
            </div>

            <div className="grid grid-cols-1 xl:grid-cols-5 gap-4">
                <div className="xl:col-span-3 space-y-3">
                    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                        <div className="grid gap-1">
                            <label className="text-xs text-muted-foreground">Provider</label>
                            <select
                                value={oauthProvider}
                                onChange={(e) => setOauthProvider(e.target.value)}
                                className="h-9 rounded-md border border-input bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            >
                                <option value="codex">codex</option>
                            </select>
                        </div>
                        <div className="grid gap-1 md:col-span-2">
                            <label className="text-xs text-muted-foreground">Account File</label>
                            <input
                                value={oauthAccountFile}
                                onChange={(e) => setOauthAccountFile(e.target.value)}
                                className="h-9 rounded-md border border-input bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                placeholder="runtime/accounts.txt"
                            />
                        </div>
                        <div className="grid gap-1">
                            <label className="text-xs text-muted-foreground">执行模式</label>
                            <input
                                value="串行 (1)"
                                disabled
                                className="h-9 rounded-md border border-input bg-muted/30 px-2 text-sm text-muted-foreground focus-visible:outline-none"
                            />
                        </div>
                        <div className="grid gap-1">
                            <label className="text-xs text-muted-foreground">Retries</label>
                            <input
                                type="number"
                                min={0}
                                value={oauthRetries}
                                onChange={(e) => setOauthRetries(Math.max(0, Number(e.target.value || 0)))}
                                className="h-9 rounded-md border border-input bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            />
                        </div>
                        <div className="grid gap-1">
                            <label className="text-xs text-muted-foreground">Wait Seconds</label>
                            <input
                                type="number"
                                min={5}
                                value={oauthWaitSeconds}
                                onChange={(e) => setOauthWaitSeconds(Math.max(5, Number(e.target.value || 30)))}
                                className="h-9 rounded-md border border-input bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            />
                        </div>
                        <div className="grid gap-1">
                            <label className="text-xs text-muted-foreground">Max Wait</label>
                            <input
                                type="number"
                                min={30}
                                value={oauthMaxWait}
                                onChange={(e) => setOauthMaxWait(Math.max(30, Number(e.target.value || 180)))}
                                className="h-9 rounded-md border border-input bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            />
                        </div>
                        <div className="grid gap-1">
                            <label className="text-xs text-muted-foreground">Cooldown</label>
                            <input
                                type="number"
                                min={0}
                                step={0.1}
                                value={oauthCooldown}
                                onChange={(e) => setOauthCooldown(Math.max(0, Number(e.target.value || 0)))}
                                className="h-9 rounded-md border border-input bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            />
                        </div>
                        <label className="flex items-center gap-2 text-xs text-muted-foreground mt-6">
                            <input
                                type="checkbox"
                                checked={oauthHeadless}
                                onChange={(e) => setOauthHeadless(e.target.checked)}
                                className="rounded border-input text-primary focus:ring-primary h-4 w-4 bg-background/50"
                            />
                            Headless（默认开启）
                        </label>
                        <label className="flex items-center gap-2 text-xs text-muted-foreground mt-6">
                            <input
                                type="checkbox"
                                checked={oauthSkipSubmitted}
                                onChange={(e) => setOauthSkipSubmitted(e.target.checked)}
                                className="rounded border-input text-primary focus:ring-primary h-4 w-4 bg-background/50"
                            />
                            Skip Submitted（跳过已成功账号）
                        </label>
                    </div>

                    <details className="rounded-md border border-border bg-muted/20 p-3">
                        <summary className="cursor-pointer text-xs font-medium text-muted-foreground">高级参数（可选）</summary>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-3">
                            <div className="grid gap-1">
                                <label className="text-xs text-muted-foreground">Callback（默认留空，表示浏览器自动回调）</label>
                                <input
                                    value={oauthCallbackFile}
                                    onChange={(e) => setOauthCallbackFile(e.target.value)}
                                    className="h-9 rounded-md border border-input bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                    placeholder="(default empty)"
                                />
                            </div>
                            <div className="grid gap-1">
                                <label className="text-xs text-muted-foreground">Result File</label>
                                <input
                                    value={oauthResultFile}
                                    onChange={(e) => setOauthResultFile(e.target.value)}
                                    className="h-9 rounded-md border border-input bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                />
                            </div>
                            <div className="grid gap-1">
                                <label className="text-xs text-muted-foreground">Success File</label>
                                <input
                                    value={oauthSuccessFile}
                                    onChange={(e) => setOauthSuccessFile(e.target.value)}
                                    className="h-9 rounded-md border border-input bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                />
                            </div>
                            <div className="grid gap-1">
                                <label className="text-xs text-muted-foreground">Detail Log File（后端持久化）</label>
                                <input
                                    value={oauthDetailLogFile}
                                    onChange={(e) => setOauthDetailLogFile(e.target.value)}
                                    className="h-9 rounded-md border border-input bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                />
                            </div>
                        </div>
                    </details>

                    <div className="flex flex-wrap gap-2">
                        <button
                            onClick={handleLoadOauthAccounts}
                            disabled={isOauthing || isLoadingAccounts || isAppendingAccounts || isDeletingAccounts || !cpaReady}
                            className="inline-flex h-9 items-center justify-center rounded-md border border-input bg-transparent px-4 py-2 text-sm font-medium hover:bg-accent hover:text-accent-foreground disabled:opacity-50"
                        >
                            {isLoadingAccounts ? t('Loading...') : '加载账号'}
                        </button>
                        <button
                            onClick={() => runBatchLogin(pendingRows.filter((item) => item.status === 'pending'), '批量登录待登录账号')}
                            disabled={isOauthing || isLoadingAccounts || isAppendingAccounts || isDeletingAccounts || !cpaReady || pendingRows.filter((item) => item.status === 'pending').length === 0}
                            className="inline-flex h-9 items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                        >
                            {isBatchRunning ? '批量执行中...' : '批量登录待登录'}
                        </button>
                        <button
                            onClick={() => runBatchLogin(selectedRows, '批量登录勾选账号')}
                            disabled={isOauthing || isLoadingAccounts || isAppendingAccounts || isDeletingAccounts || !cpaReady || selectedRows.length === 0}
                            className="inline-flex h-9 items-center justify-center rounded-md border border-input bg-transparent px-4 py-2 text-sm font-medium hover:bg-accent hover:text-accent-foreground disabled:opacity-50"
                        >
                            {isBatchRunning ? '批量执行中...' : '批量登录勾选账号'}
                        </button>
                        <button
                            onClick={cancelBatchLogin}
                            disabled={!isBatchRunning}
                            className="inline-flex h-9 items-center justify-center rounded-md border border-rose-300 bg-rose-50 px-4 py-2 text-sm font-medium text-rose-700 hover:bg-rose-100 disabled:opacity-50"
                        >
                            {batchCancelRequested ? '取消中...' : '取消批量登录'}
                        </button>
                        <button
                            onClick={selectAllPending}
                            disabled={oauthAccountRows.length === 0}
                            className="inline-flex h-9 items-center justify-center rounded-md border border-input bg-transparent px-4 py-2 text-sm font-medium hover:bg-accent hover:text-accent-foreground disabled:opacity-50"
                        >
                            勾选全部待登录
                        </button>
                        <button
                            onClick={selectAllFailedSkipped}
                            disabled={oauthAccountRows.length === 0}
                            className="inline-flex h-9 items-center justify-center rounded-md border border-input bg-transparent px-4 py-2 text-sm font-medium hover:bg-accent hover:text-accent-foreground disabled:opacity-50"
                        >
                            勾选全部失败/跳过
                        </button>
                        <button
                            onClick={() => handleDeleteRows(selectedRows, '删除勾选账号')}
                            disabled={isOauthing || isLoadingAccounts || isAppendingAccounts || isDeletingAccounts || !cpaReady || selectedRows.length === 0}
                            className="inline-flex h-9 items-center justify-center rounded-md border border-rose-300 bg-rose-50 px-4 py-2 text-sm font-medium text-rose-700 hover:bg-rose-100 disabled:opacity-50"
                        >
                            {isDeletingAccounts ? '删除中...' : '删除勾选账号'}
                        </button>
                        <button
                            onClick={() => setSelectedRowKeys([])}
                            disabled={selectedRowKeys.length === 0}
                            className="inline-flex h-9 items-center justify-center rounded-md border border-input bg-transparent px-4 py-2 text-sm font-medium hover:bg-accent hover:text-accent-foreground disabled:opacity-50"
                        >
                            清空勾选
                        </button>
                    </div>
                </div>

                <div className="xl:col-span-2 rounded-md border border-border bg-muted/20 p-3 space-y-2">
                    <div className="text-sm font-medium">快捷添加账号</div>
                    <p className="text-xs text-muted-foreground">直接粘贴多行账号，按“邮箱+密码”覆盖更新；不校验 access token。</p>
                    <textarea
                        value={quickAppendText}
                        onChange={(e) => setQuickAppendText(e.target.value)}
                        className="w-full min-h-56 rounded-md border border-input bg-background px-2 py-2 text-xs font-mono focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        placeholder="email----password&#10;email----password----token"
                    />
                    <div className="flex gap-2">
                        <button
                            onClick={handleQuickAppendAccounts}
                            disabled={isOauthing || isLoadingAccounts || isAppendingAccounts || isDeletingAccounts || !cpaReady}
                            className="inline-flex h-8 items-center justify-center rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                        >
                            {isAppendingAccounts ? t('Loading...') : '追加到账号文件'}
                        </button>
                        <button
                            onClick={() => setQuickAppendText('')}
                            disabled={!quickAppendText.trim()}
                            className="inline-flex h-8 items-center justify-center rounded-md border border-input bg-transparent px-3 text-xs font-medium hover:bg-accent hover:text-accent-foreground disabled:opacity-50"
                        >
                            清空输入
                        </button>
                    </div>
                </div>
            </div>

            <div className="space-y-3">
                {renderGroup('待登录', pendingRows)}
                {renderGroup('成功', successRows)}
                {renderGroup('失败/跳过', failedRows)}
            </div>

            <div className="rounded-md border border-border bg-muted/20 p-3">
                <div className="flex items-center justify-between mb-2">
                    <div className="text-xs text-muted-foreground">运行日志（持久化）</div>
                    <button
                        onClick={clearLogs}
                        className="inline-flex h-7 items-center justify-center rounded-md border border-input bg-transparent px-2 text-xs font-medium hover:bg-accent hover:text-accent-foreground"
                    >
                        清空日志
                    </button>
                </div>
                <div className="max-h-56 overflow-auto rounded border border-border bg-background p-2 space-y-1">
                    {oauthLogs.length === 0 && <div className="text-xs text-muted-foreground">(empty)</div>}
                    {oauthLogs.map((item, idx) => (
                        <div
                            key={`${item.at}-${idx}`}
                            className={`text-xs font-mono ${
                                item.level === 'success'
                                    ? 'text-emerald-600'
                                    : item.level === 'error'
                                        ? 'text-rose-600'
                                        : item.level === 'warn'
                                            ? 'text-amber-600'
                                            : 'text-muted-foreground'
                            }`}
                        >
                            [{item.at}] {item.message}
                        </div>
                    ))}
                </div>
            </div>

            <div className="rounded-md border border-border bg-muted/20 p-3">
                <div className="text-xs text-muted-foreground mb-2">运行输出（彩色）</div>
                <div className="max-h-72 overflow-auto rounded border border-border bg-background p-2 font-mono text-xs space-y-0.5">
                    {(oauthRunOutput || '(empty)').split('\n').map((line, idx) => (
                        <div key={idx} className={outputLineClass(line)}>{line || ' '}</div>
                    ))}
                </div>
            </div>
        </div>
    );
}
function CredentialManager({ cpaReady, cpaUrl }: CredentialManagerProps) {
    const queryClient = useQueryClient();
    const { t } = useTranslation();
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

    // Status memory hook (store probing status in UI state since it's not natively returned in list)
    // In actual CPA, we fetch auth list, but it does not tell "active/dead" directly smoothly until probe
    const [probeStatuses, setProbeStatuses] = useState<Record<string, ProbeUiState>>({});
    const [isProbingAll, setIsProbingAll] = useState(false);
    const [probeCancelRequested, setProbeCancelRequested] = useState(false);
    const probeCancelRequestedRef = useRef(false);
    const probeAbortControllersRef = useRef<Map<string, AbortController>>(new Map());
    const [isAutoDisable, setIsAutoDisable] = useState(true);

    // Batch Selection Data
    const [selectedItems, setSelectedItems] = useState<Set<string>>(new Set());
    const [archivedNames, setArchivedNames] = useState<string[]>([]);
    const [isArchiveBusy, setIsArchiveBusy] = useState(false);
    const [filterProvider, setFilterProvider] = useState<string>('all');
    const [statusFilter, setStatusFilter] = useState<'all' | 'enabled' | 'disabled'>('all');
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

    const toggleStatusMutation = useMutation({
        mutationFn: ({ name, disabled }: { name: string, disabled: boolean }) => updateCredentialStatus(name, disabled),
    });

    const deleteMutation = useMutation({
        mutationFn: (name: string) => deleteCredential(name),
        onSuccess: () => {
            clearAuthFilesCache();
            queryClient.invalidateQueries({ queryKey: ['credentials'] });
        }
    });

    const forceRefreshCredentials = useCallback(async () => {
        const fresh = await fetchAuthFilesForceRefresh();
        queryClient.setQueryData(['credentials', cpaUrl], fresh);
        return fresh;
    }, [queryClient, cpaUrl]);

    const setCredentialDisabledInCache = (name: string, disabled: boolean) => {
        queryClient.setQueriesData<Credential[]>({ queryKey: ['credentials'] }, (old) => {
            if (!old) return old;
            return old.map((item) => {
                if (item.name === name || item.id === name) {
                    return { ...item, disabled };
                }
                return item;
            });
        });
    };

    const runStatusUpdate = async (name: string, disabled: boolean) => {
        setTogglingNames(prev => new Set(prev).add(name));
        try {
            await toggleStatusMutation.mutateAsync({ name, disabled });
            setCredentialDisabledInCache(name, disabled);
        } finally {
            setTogglingNames(prev => { const n = new Set(prev); n.delete(name); return n; });
        }
    };

    const handleToggleStatus = async (cred: Credential) => {
        await runStatusUpdate(cred.name, !cred.disabled);
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
            await deleteMutation.mutateAsync(name);
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

    const isAbortError = (error: unknown): boolean => {
        const err = error as { code?: string; message?: string; name?: string };
        const msg = String(err?.message || '').toLowerCase();
        return err?.code === 'ERR_CANCELED' || err?.name === 'CanceledError' || msg.includes('canceled') || msg.includes('aborted');
    };

    const handleProbeSingle = async (cred: Credential, options?: { signal?: AbortSignal; fromBatch?: boolean }) => {
        const lockKey = `probe-single:${cred.name}`;
        await runWithLock(lockKey, async () => {
            setProbeStatuses(prev => ({
                ...prev,
                [cred.name]: {
                    status: 'running',
                    time: new Date().toLocaleTimeString(),
                    reason: '',
                    tier: resolveTierFromCredential(cred),
                    detail: '',
                },
            }));

            try {
                const response = await probeCredential(cred.auth_index, cred.provider as string, options?.signal);
                const result = classifyProviderProbe(cred.provider, response);
                const tier = resolveTierAfterProbe(cred, response);
                const detail = formatProbeDetail(response);

                setProbeStatuses(prev => ({
                    ...prev,
                    [cred.name]: {
                        status: result.status,
                        time: new Date().toLocaleTimeString(),
                        reason: truncateText(result.reason),
                        tier,
                        detail,
                    },
                }));

                if (result.status === 'active' && cred.disabled) {
                    await runStatusUpdate(cred.name, false);
                } else if (isAutoDisable && shouldAutoDisable(result.status) && !cred.disabled) {
                    await runStatusUpdate(cred.name, true);
                }
            } catch (error: unknown) {
                if (isAbortError(error)) {
                    if (options?.fromBatch) {
                        setProbeStatuses(prev => ({
                            ...prev,
                            [cred.name]: {
                                status: 'unknown',
                                time: new Date().toLocaleTimeString(),
                                reason: t('Probe cancelled'),
                                tier: resolveTierFromCredential(cred),
                                detail: t('Probe cancelled'),
                            },
                        }));
                    }
                    return;
                }

                const fallbackResponse = toProbeErrorResponse(error);
                const result = classifyProviderProbe(cred.provider, fallbackResponse);
                const finalStatus: ProbeUiStatus = result.status === 'unknown' ? 'error' : result.status;
                const detail = formatProbeDetail(fallbackResponse);

                setProbeStatuses(prev => ({
                    ...prev,
                    [cred.name]: {
                        status: finalStatus,
                        time: new Date().toLocaleTimeString(),
                        reason: truncateText(result.reason || 'Network error during probing'),
                        tier: resolveTierFromCredential(cred),
                        detail,
                    },
                }));

                if (isAutoDisable && shouldAutoDisable(finalStatus) && !cred.disabled) {
                    await runStatusUpdate(cred.name, true);
                }
            }
        });
    };

    const handleProbeAll = async () => {
        if (!activeCredentials.length || isProbingAll) return;
        probeCancelRequestedRef.current = false;
        setProbeCancelRequested(false);
        probeAbortControllersRef.current.clear();
        await runWithLock('probe-all', async () => {
            setIsProbingAll(true);
            try {
                const probeTargets = filteredCredentials.filter((cred: Credential) => canProbeCredential(cred));
                for (let i = 0; i < probeTargets.length; i += probeBatchSize) {
                    if (probeCancelRequestedRef.current) {
                        break;
                    }
                    const chunk = probeTargets.slice(i, i + probeBatchSize);
                    const tasks = chunk.map(async (cred) => {
                        const controller = new AbortController();
                        probeAbortControllersRef.current.set(cred.name, controller);
                        try {
                            await handleProbeSingle(cred, { signal: controller.signal, fromBatch: true });
                        } finally {
                            probeAbortControllersRef.current.delete(cred.name);
                        }
                    });
                    await Promise.allSettled(tasks);
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

    const handleCancelProbeAll = () => {
        if (!isProbingAll) return;
        setProbeCancelRequested(true);
        probeCancelRequestedRef.current = true;
        for (const controller of probeAbortControllersRef.current.values()) {
            controller.abort();
        }
    };

    // OAuth states
    const [isOauthing, setIsOauthing] = useState(false);
    const showManualOAuthButton = false;

    const handleAddOAuth = async () => {
        setIsOauthing(true);
        try {
            const authInfo = await getCodexAuthUrl(true);
            window.sessionStorage.setItem('oauth_state', authInfo.state);
            // open in new window
            window.open(authInfo.url, '_blank');
        } catch {
            showAlert({ title: t('Error'), message: t('Failed to get OAuth URL from manager'), confirmText: t('Confirm', 'Confirm') });
        } finally {
            setIsOauthing(false);
        }
    };

    const archivedNameSet = useMemo(() => new Set(archivedNames), [archivedNames]);
    const activeCredentials = useMemo(
        () => credentials.filter((cred: Credential) => !archivedNameSet.has(cred.name)),
        [credentials, archivedNameSet],
    );

    const loadCredentialArchive = useCallback(async () => {
        if (!cpaReady || !cpaUrl) {
            setArchivedNames([]);
            return;
        }
        try {
            const result = await runCredentialArchiveList({ cpa_url: cpaUrl });
            const payload = result.payload as { names?: unknown } | undefined;
            const names = Array.isArray(payload?.names)
                ? payload.names.map((item) => String(item || '').trim()).filter(Boolean)
                : [];
            setArchivedNames(Array.from(new Set(names)));
        } catch {
            setArchivedNames([]);
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
        setPage(1);
        setSelectedItems(new Set());
    }, [filterProvider, statusFilter, searchKeyword, pageSize, cpaUrl]);

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

    const refreshListWithLock = useCallback(async (force: boolean = false) => {
        await runWithLock('refresh-list', async () => {
            if (force) {
                await forceRefreshCredentials();
            } else {
                await refetch();
            }
        });
    }, [runWithLock, forceRefreshCredentials, refetch]);

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

        setIsOauthing(true); // reuse loading mask to prevent double submit
        try {
            const promises = Array.from(selectedItems).map(name => deleteMutation.mutateAsync(name));
            await Promise.all(promises);
            setSelectedItems(new Set());
            await forceRefreshCredentials();
        } finally {
            setIsOauthing(false);
        }
    };

    const setArchivedNamesFromPayload = (payload: unknown) => {
        const record = payload as { names?: unknown } | null;
        const names = Array.isArray(record?.names)
            ? record.names.map((item) => String(item || '').trim()).filter(Boolean)
            : [];
        setArchivedNames(Array.from(new Set(names)));
    };

    const archiveCredentialNames = async (names: string[]) => {
        const targets = Array.from(new Set(names.map((item) => String(item || '').trim()).filter(Boolean)));
        if (!targets.length) return;
        setIsArchiveBusy(true);
        try {
            for (const name of targets) {
                const cred = activeCredentials.find((item) => item.name === name);
                if (!cred) continue;
                if (!cred.disabled) {
                    await runStatusUpdate(name, true);
                }
            }
            const result = await runCredentialArchiveAdd({ cpa_url: cpaUrl, names: targets });
            setArchivedNamesFromPayload(result.payload || null);
            setSelectedItems((prev) => {
                const next = new Set(prev);
                targets.forEach((name) => next.delete(name));
                return next;
            });
            await forceRefreshCredentials();
        } finally {
            setIsArchiveBusy(false);
        }
    };

    const handleArchiveDisabled = async () => {
        const disabledTargets = disabledFilteredItems.map((cred: Credential) => cred.name);
        if (!disabledTargets.length) {
            showAlert({ title: t('Error'), message: '当前筛选范围没有可归档的已禁用凭证', confirmText: t('Confirm', 'Confirm') });
            return;
        }
        const confirmed = await showConfirm({
            title: '归档已禁用凭证',
            message: `将归档 ${disabledTargets.length} 个已禁用凭证，归档后不再使用，是否继续？`,
            confirmText: t('Confirm', 'Confirm'),
            cancelText: t('Cancel', 'Cancel'),
        });
        if (!confirmed) return;
        await archiveCredentialNames(disabledTargets);
    };

    const handleDeleteDisabled = async () => {
        const targets = disabledFilteredItems.map((cred: Credential) => cred.name);
        if (!targets.length) {
            showAlert({ title: t('Error'), message: '当前筛选范围没有可删除的已禁用凭证', confirmText: t('Confirm', 'Confirm') });
            return;
        }
        const confirmed = await showConfirm({
            title: '批量删除已禁用凭证',
            message: `将永久删除 ${targets.length} 个已禁用凭证，是否继续？`,
            confirmText: t('Confirm', 'Confirm'),
            cancelText: t('Cancel', 'Cancel'),
        });
        if (!confirmed) return;

        setIsArchiveBusy(true);
        try {
            const settled = await Promise.allSettled(targets.map((name) => deleteMutation.mutateAsync(name).then(() => name)));
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
                    message: `以下凭证删除失败：${failed.join(', ')}`,
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
            title: '归档选中凭证',
            message: `将归档 ${targets.length} 个选中凭证，并自动禁用后不再使用，是否继续？`,
            confirmText: t('Confirm', 'Confirm'),
            cancelText: t('Cancel', 'Cancel'),
        });
        if (!confirmed) return;
        await archiveCredentialNames(targets);
    };

    return (
        <div className="space-y-6">
            <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 rounded-xl border border-border bg-card p-6 shadow-sm">
                <div>
                    <h2 className="text-xl font-semibold mb-1 flex items-center gap-2"><ShieldAlert className="w-5 h-5 text-primary" /> {t('Authentication Keys')}</h2>
                    <p className="text-sm text-muted-foreground">{t('Manage and auto-disable your API keys effectively.')}</p>
                    <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
                        <span className="inline-flex items-center rounded-full border border-border bg-muted/40 px-2.5 py-1 font-medium text-foreground/90">
                            总数 {totalCredentialCount}
                        </span>
                        <span className="inline-flex items-center rounded-full border border-border bg-rose-50 px-2.5 py-1 font-medium text-rose-700 dark:bg-rose-900/20 dark:text-rose-300">
                            禁用 {disabledCredentialCount}
                        </span>
                        <span className="inline-flex items-center rounded-full border border-border bg-amber-50 px-2.5 py-1 font-medium text-amber-700 dark:bg-amber-900/20 dark:text-amber-300">
                            归档 {archivedCredentialCount}
                        </span>
                    </div>
                    {availableProviders.length > 0 && (
                        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                            {availableProviders.map((provider) => {
                                const stats = providerStats[provider] || { total: 0, disabled: 0 };
                                return (
                                    <span key={`summary-${provider}`} className="inline-flex items-center rounded-full border border-border bg-background px-2.5 py-1 font-medium text-foreground/90">
                                        {provider} 总/禁 {stats.total}/{stats.disabled}
                                    </span>
                                );
                            })}
                        </div>
                    )}
                </div>
                <div className="flex flex-col gap-2 w-full md:flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                        <div className="flex items-center p-1 rounded-full border border-border bg-background/50 overflow-x-auto mr-1 space-x-1">
                            <button
                                onClick={() => setFilterProvider('all')}
                                className={`px-3 py-1 rounded-full text-xs font-bold transition-all flex items-center whitespace-nowrap ${filterProvider === 'all' ? 'bg-primary text-primary-foreground shadow-sm' : 'text-muted-foreground hover:bg-muted'}`}
                            >
                                {t('All')} <span className={`ml-1.5 text-[10px] px-1.5 rounded-full ${filterProvider === 'all' ? 'bg-background/20 text-white' : 'bg-foreground/10 text-foreground/70'}`}>{totalCredentialCount}</span>
                            </button>
                            {availableProviders.map(p => {
                                const count = providerStats[p]?.total || 0;
                                const isSelected = filterProvider === p;
                                let activeBg = 'bg-secondary text-secondary-foreground shadow-sm';
                                if (p.toLowerCase() === 'antigravity') activeBg = 'bg-teal-500 text-white shadow-[0_0_10px_rgba(20,184,166,0.3)] shadow-sm';
                                else if (p.toLowerCase() === 'codex') activeBg = 'bg-amber-500 text-white shadow-[0_0_10px_rgba(245,158,11,0.3)] shadow-sm';
                                else if (p.toLowerCase() === 'iflow') activeBg = 'bg-purple-600 text-white shadow-[0_0_10px_rgba(147,51,234,0.3)] shadow-sm';

                                return (
                                    <button
                                        key={p}
                                        onClick={() => setFilterProvider(p)}
                                        className={`px-3 py-1 rounded-full text-xs font-bold transition-all flex items-center whitespace-nowrap ${isSelected ? activeBg : 'text-muted-foreground hover:bg-muted'}`}
                                    >
                                        {p} <span className={`ml-1.5 text-[10px] px-1.5 rounded-full ${isSelected ? 'bg-black/20 text-white' : 'bg-foreground/10 text-foreground/70'}`}>{count}</span>
                                    </button>
                                );
                            })}
                        </div>

                        <div className="flex items-center gap-2 text-xs text-muted-foreground whitespace-nowrap">
                            <span>状态</span>
                            <select
                                value={statusFilter}
                                onChange={(e) => setStatusFilter(e.target.value as 'all' | 'enabled' | 'disabled')}
                                className="h-8 rounded-md border border-input bg-background px-2 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            >
                                <option value="all">全部</option>
                                <option value="enabled">仅正常</option>
                                <option value="disabled">仅禁用</option>
                            </select>
                        </div>
                        <div className="flex items-center gap-2 text-xs text-muted-foreground whitespace-nowrap">
                            <input
                                type="text"
                                value={searchKeyword}
                                onChange={(e) => setSearchKeyword(e.target.value)}
                                placeholder="检索账号/文件名/provider"
                                className="h-8 w-56 rounded-md border border-input bg-background px-2 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            />
                        </div>

                        <label className="flex items-center gap-2 text-sm text-muted-foreground mr-1 cursor-pointer whitespace-nowrap">
                            <input type="checkbox" checked={isAutoDisable} onChange={(e) => setIsAutoDisable(e.target.checked)} className="rounded border-input text-primary focus:ring-primary h-4 w-4 bg-background/50" />
                            {t('Auto-disable')}
                        </label>

                        <button
                            onClick={() => { void refreshListWithLock(true); }}
                            disabled={!cpaReady || isFetching}
                            className="inline-flex h-9 items-center justify-center rounded-md border border-input bg-transparent px-4 py-2 text-sm font-medium hover:bg-accent hover:text-accent-foreground disabled:opacity-50 shrink-0"
                        >
                            {isFetching ? <RefreshCw className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
                            {t('Refresh List')}
                        </button>
                        <button
                            onClick={handleProbeAll}
                            disabled={!cpaReady || isProbingAll || !filteredCredentials.length}
                            className="inline-flex h-9 items-center justify-center rounded-md border border-input bg-transparent px-4 py-2 text-sm font-medium hover:bg-accent hover:text-accent-foreground disabled:opacity-50 shrink-0"
                        >
                            {isProbingAll ? <RefreshCw className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
                            {t('Probe List')}
                        </button>
                        {isProbingAll && (
                            <button
                                onClick={handleCancelProbeAll}
                                className="inline-flex h-9 items-center justify-center rounded-md border border-destructive/40 bg-destructive/10 px-4 py-2 text-sm font-medium text-destructive hover:bg-destructive/20 shrink-0"
                            >
                                {probeCancelRequested ? t('Cancelling...') : t('Cancel Probe')}
                            </button>
                        )}
                        <button
                            onClick={handleArchiveDisabled}
                            disabled={isArchiveBusy || disabledFilteredCount === 0}
                            className="inline-flex h-9 items-center justify-center rounded-md border border-input bg-transparent px-4 py-2 text-sm font-medium hover:bg-accent hover:text-accent-foreground disabled:opacity-50 shrink-0"
                        >
                            归档已禁用
                        </button>
                        <button
                            onClick={handleDeleteDisabled}
                            disabled={isArchiveBusy || disabledFilteredCount === 0}
                            className="inline-flex h-9 items-center justify-center rounded-md border border-destructive/30 bg-destructive/10 px-4 py-2 text-sm font-medium text-destructive hover:bg-destructive/20 disabled:opacity-50 shrink-0"
                        >
                            删除已禁用
                        </button>
                        {showManualOAuthButton && (
                            <button onClick={handleAddOAuth} disabled={isOauthing} className="inline-flex h-9 items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 shrink-0">
                                {isOauthing ? t('Loading...') : `+ ${t('Refresh OAuth')}`}
                            </button>
                        )}
                    </div>

                    <div className="flex flex-wrap items-center gap-2 md:justify-end">
                        <div className="flex items-center gap-2 text-xs text-muted-foreground whitespace-nowrap">
                            <span>{t('Probe batch size')}</span>
                            <input
                                type="number"
                                min={1}
                                max={100}
                                value={probeBatchSize}
                                onChange={(e) => setSafeProbeBatchSize(Number(e.target.value || 1))}
                                className="h-8 w-16 rounded-md border border-input bg-background px-2 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            />
                        </div>
                        <div className="flex items-center gap-2 text-xs text-muted-foreground whitespace-nowrap">
                            <span>{t('Probe batch interval(ms)')}</span>
                            <input
                                type="number"
                                min={0}
                                max={10000}
                                value={probeBatchIntervalMs}
                                onChange={(e) => setSafeProbeBatchIntervalMs(Number(e.target.value || 0))}
                                className="h-8 w-20 rounded-md border border-input bg-background px-2 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            />
                        </div>
                    </div>
                </div>
            </div>

            {selectedItems.size > 0 && (
                <div className="flex items-center justify-between rounded-lg bg-primary/10 border border-primary/20 px-4 py-3 animate-in fade-in slide-in-from-top-4">
                    <div className="text-sm font-medium text-primary">
                        {selectedItems.size} {t('items selected')}
                    </div>
                    <button
                        onClick={handleArchiveSelected}
                        disabled={isArchiveBusy || selectedItems.size === 0}
                        className="inline-flex items-center justify-center rounded-md border border-input bg-transparent h-8 px-3 text-xs font-medium hover:bg-accent hover:text-accent-foreground disabled:opacity-50"
                    >
                        归档选中
                    </button>
                    <button
                        onClick={handleBatchDelete}
                        className="inline-flex items-center justify-center rounded-md border border-destructive bg-destructive text-destructive-foreground h-8 px-3 text-xs font-medium hover:bg-destructive/90"
                    >
                        <Trash2 className="w-3.5 h-3.5 mr-1.5" />
                        {t('Delete Selected')}
                    </button>
                </div>
            )}

            <div className="rounded-xl border border-border bg-card shadow-sm overflow-hidden">
                <div className="overflow-x-auto">
                    <table className="min-w-[1480px] w-full text-sm text-left whitespace-nowrap">
                        <thead className="bg-muted/50 text-muted-foreground border-b border-border text-xs uppercase font-medium">
                            <tr>
                                <th className="px-4 py-4 w-12">
                                    <input
                                        type="checkbox"
                                        className="rounded border-input text-primary focus:ring-primary h-4 w-4 bg-background/50"
                                        checked={pagedCredentials.length > 0 && pagedCredentials.every((item) => selectedItems.has(item.name))}
                                        onChange={(e) => handleSelectAll(e.target.checked)}
                                    />
                                </th>
                                <th className="px-6 py-4">{t('ID / Index')}</th>
                                <th className="px-6 py-4">{t('Provider')}</th>
                                <th className="px-6 py-4">{t('Status')}</th>
                                <th className="px-6 py-4">{t('Last Checked')}</th>
                                <th className="px-6 py-4 text-right">{t('Actions')}</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-border">
                            {!cpaReady ? (
                                <tr><td colSpan={6} className="px-6 py-8 text-center text-muted-foreground">{t('Initializing connection...')}</td></tr>
                            ) : isLoading ? (
                                <tr><td colSpan={6} className="px-6 py-8 text-center text-muted-foreground">{t('Loading credentials...')}</td></tr>
                            ) : isError ? (
                                <tr>
                                    <td colSpan={6} className="px-6 py-8 text-center text-muted-foreground">
                                        <div className="space-y-2">
                                            <div>{t('Failed to load credentials.')}</div>
                                            <div className="text-xs text-destructive">{String((error as { message?: string })?.message || '')}</div>
                                            <button
                                                onClick={() => { void refreshListWithLock(true); }}
                                                className="inline-flex h-8 items-center justify-center rounded-md border border-input bg-transparent px-3 text-xs font-medium hover:bg-accent hover:text-accent-foreground"
                                            >
                                                {t('Retry')}
                                            </button>
                                        </div>
                                    </td>
                                </tr>
                            ) : filteredCredentials.length === 0 ? (
                                <tr><td colSpan={6} className="px-6 py-8 text-center text-muted-foreground">{t('No credentials found.')}</td></tr>
                            ) : (
                                pagedCredentials.map((cred: Credential) => {
                                    const st = probeStatuses[cred.name];
                                    const probeLockKey = `probe-single:${cred.name}`;
                                    const isProbeRunning = st?.status === 'running' || isLocked(probeLockKey);
                                    const canProbe = canProbeCredential(cred);

                                    const getProviderBadge = (provider: string) => {
                                        switch (provider.toLowerCase()) {
                                            case 'antigravity':
                                                return <span className="inline-flex items-center rounded-full bg-teal-500/15 border border-teal-500/20 px-2.5 py-0.5 text-[11px] font-semibold text-teal-600 dark:text-teal-400">Antigravity</span>;
                                            case 'codex':
                                                return <span className="inline-flex items-center rounded-full bg-amber-500/15 border border-amber-500/20 px-2.5 py-0.5 text-[11px] font-semibold text-amber-600 dark:text-amber-500">Codex</span>;
                                            case 'iflow':
                                                return <span className="inline-flex items-center rounded-full bg-purple-500/15 border border-purple-500/20 px-2.5 py-0.5 text-[11px] font-semibold text-purple-600 dark:text-purple-400">iFlow</span>;
                                            default:
                                                return <span className="inline-flex items-center rounded-full bg-secondary px-2.5 py-0.5 text-[11px] font-semibold text-secondary-foreground">{provider}</span>;
                                        }
                                    };

                                    const getTierBadge = (cred: Credential) => {
                                        const tier = st?.tier || resolveTierFromCredential(cred);
                                        if (tier === 'PLUS') return <span className="inline-flex items-center rounded-sm bg-fuchsia-500/15 border border-fuchsia-500/20 px-1.5 py-0.5 text-[10px] font-bold text-fuchsia-700 dark:text-fuchsia-400">PLUS</span>;
                                        if (tier === 'TEAM') return <span className="inline-flex items-center rounded-sm bg-blue-500/15 border border-blue-500/20 px-1.5 py-0.5 text-[10px] font-bold text-blue-700 dark:text-blue-400">TEAM</span>;
                                        if (tier === 'PRO') return <span className="inline-flex items-center rounded-sm bg-indigo-500/15 border border-indigo-500/20 px-1.5 py-0.5 text-[10px] font-bold text-indigo-700 dark:text-indigo-400">PRO</span>;
                                        if (tier === 'FREE') return <span className="inline-flex items-center rounded-sm bg-zinc-500/15 border border-zinc-500/20 px-1.5 py-0.5 text-[10px] font-bold text-zinc-700 dark:text-zinc-400">FREE</span>;
                                        return null;
                                    };

                                    return (
                                        <tr key={cred.id} className={`hover:bg-muted/30 transition-all duration-300 ${selectedItems.has(cred.name) ? 'bg-primary/5' : ''} ${deletingNames.has(cred.name) ? 'opacity-0 scale-[0.98] pointer-events-none' : 'opacity-100 scale-100'} ${togglingNames.has(cred.name) ? 'opacity-50 pointer-events-none' : ''}`}>
                                            <td className="px-4 py-4">
                                                <input
                                                    type="checkbox"
                                                    className="rounded border-input text-primary focus:ring-primary h-4 w-4 bg-background/50"
                                                    checked={selectedItems.has(cred.name)}
                                                    onChange={() => handleToggleItem(cred.name)}
                                                />
                                            </td>
                                            <td className="px-6 py-4">
                                                <div className="font-medium text-foreground">{cred.id}</div>
                                                <div className="text-xs text-muted-foreground font-mono mt-0.5" title={cred.auth_index}>{cred.auth_index.substring(0, 16)}...</div>
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
                                                        <div className="inline-flex items-center rounded-md border border-destructive/20 bg-destructive/10 px-2 py-1 text-xs font-medium text-destructive/90" title={st?.reason}>
                                                            <XCircle className="w-3.5 h-3.5 mr-1" /> {t('Disabled')} <span className="text-destructive/50 ml-1.5 pl-1.5 border-l border-destructive/20 text-[10px]">{t('Auto-check: 1h')}</span>
                                                        </div>
                                                        {st?.reason && (
                                                            <div className="text-[11px] font-medium text-destructive/90 max-w-[280px] break-words whitespace-normal leading-tight" title={st.reason}>
                                                                {st.reason}
                                                            </div>
                                                        )}
                                                        {st?.detail && (
                                                            <button
                                                                onClick={() => showAlert({ title: t('Probe Detail'), message: st.detail || t('No detail'), confirmText: t('Confirm', 'Confirm') })}
                                                                className="text-[11px] text-primary hover:underline"
                                                            >
                                                                {t('View Body')}
                                                            </button>
                                                        )}
                                                    </div>
                                                ) : (
                                                    <div className="flex flex-col items-start gap-1">
                                                        <div className="flex items-center gap-2">
                                                            {st?.status === 'active' ? (
                                                                <span className="flex items-center text-emerald-500"><CheckCircle2 className="w-4 h-4 mr-1.5" /> {t('Active')}</span>
                                                            ) : st?.status === 'invalidated' || st?.status === 'unauthorized' || st?.status === 'deactivated' || st?.status === 'expired_by_time' || st?.status === 'error' ? (
                                                                <span className="flex items-center text-destructive" title={st.reason}><AlertTriangle className="w-4 h-4 mr-1.5" /> {t(st.status)}</span>
                                                            ) : st?.status === 'unknown' ? (
                                                                <span className="flex items-center text-amber-500"><AlertTriangle className="w-4 h-4 mr-1.5" /> {t('Unknown')}</span>
                                                            ) : (
                                                                <span className="flex items-center text-primary"><Clock className="w-4 h-4 mr-1.5" /> {t('Normal')}</span>
                                                            )}
                                                        </div>
                                                        {st?.reason && (
                                                            <div className="text-[11px] font-medium text-destructive/90 max-w-[280px] break-words whitespace-normal leading-tight" title={st.reason}>
                                                                {st.reason}
                                                            </div>
                                                        )}
                                                        {st?.detail && (
                                                            <button
                                                                onClick={() => showAlert({ title: t('Probe Detail'), message: st.detail || t('No detail'), confirmText: t('Confirm', 'Confirm') })}
                                                                className="text-[11px] text-primary hover:underline"
                                                            >
                                                                {t('View Body')}
                                                            </button>
                                                        )}
                                                    </div>
                                                )}
                                            </td>
                                            <td className="px-6 py-4 text-muted-foreground">
                                                {st?.time || 'Never'}
                                            </td>
                                            <td className="px-6 py-4 text-right space-x-2">
                                                <button
                                                    onClick={() => handleProbeSingle(cred)}
                                                    disabled={isProbeRunning || !canProbe}
                                                    className="inline-flex items-center justify-center rounded-md border border-input bg-transparent h-8 px-2.5 text-xs font-medium hover:bg-accent hover:text-accent-foreground disabled:opacity-50"
                                                    title={!canProbe ? t('noProbeNeeded') : ''}
                                                >
                                                    {isProbeRunning ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
                                                </button>
                                                <button
                                                    onClick={() => handleToggleStatus(cred)}
                                                    className={`inline-flex items-center justify-center rounded-md h-8 px-2.5 text-xs font-medium transition-colors ${cred.disabled ? 'bg-primary text-primary-foreground hover:bg-primary/90' : 'bg-secondary text-secondary-foreground hover:bg-secondary/80'} ${togglingNames.has(cred.name) ? 'animate-pulse' : ''}`}
                                                >
                                                    {togglingNames.has(cred.name) ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : (cred.disabled ? t('Enable') : t('Disable'))}
                                                </button>
                                                <button
                                                    onClick={() => handleDeleteSingle(cred.name)}
                                                    disabled={deletingNames.has(cred.name)}
                                                    className="inline-flex items-center justify-center rounded-md border border-destructive/30 bg-destructive/10 text-destructive h-8 px-2.5 text-xs font-medium hover:bg-destructive/20"
                                                >
                                                    {deletingNames.has(cred.name) ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : t('Delete')}
                                                </button>
                                            </td>
                                        </tr>
                                    )
                                })
                            )}
                        </tbody>
                    </table>
                </div>
                <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-3 border-t border-border px-4 py-3 bg-muted/20">
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
                            onChange={(e) => setSafePageSize(Number(e.target.value || 1))}
                            className="h-8 w-20 rounded-md border border-input bg-background px-2 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        />
                        <button onClick={() => setSafePageSize(20)} className="h-8 rounded-md border border-input px-2 text-xs hover:bg-accent">20</button>
                        <button onClick={() => setSafePageSize(50)} className="h-8 rounded-md border border-input px-2 text-xs hover:bg-accent">50</button>
                        <button onClick={() => setSafePageSize(100)} className="h-8 rounded-md border border-input px-2 text-xs hover:bg-accent">100</button>
                        <div className="mx-1 text-xs text-muted-foreground">{t('Page X of Y', { page: currentPage, totalPages })}</div>
                        <button
                            onClick={() => setPage(Math.max(1, currentPage - 1))}
                            disabled={currentPage <= 1}
                            className="h-8 rounded-md border border-input px-3 text-xs disabled:opacity-50 hover:bg-accent"
                        >
                            {t('Prev')}
                        </button>
                        <button
                            onClick={() => setPage(Math.min(totalPages, currentPage + 1))}
                            disabled={currentPage >= totalPages}
                            className="h-8 rounded-md border border-input px-3 text-xs disabled:opacity-50 hover:bg-accent"
                        >
                            {t('Next')}
                        </button>
                    </div>
                </div>
            </div>

        </div>
    );
}

function ArchivePanel({ cpaReady, cpaUrl }: ArchivePanelProps) {
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
        } else {
            setSelectedNames(new Set());
        }
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
                <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
                    <div>
                        <h2 className="text-xl font-semibold mb-1 flex items-center gap-2"><Trash2 className="h-5 w-5 text-primary" /> 归档回收站</h2>
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

            <div className="rounded-xl border border-border bg-card shadow-sm overflow-hidden">
                <div className="overflow-x-auto">
                    <table className="min-w-[980px] w-full text-sm text-left whitespace-nowrap">
                        <thead className="bg-muted/50 text-muted-foreground border-b border-border text-xs uppercase font-medium">
                            <tr>
                                <th className="px-4 py-3 w-10">
                                    <input
                                        type="checkbox"
                                        className="rounded border-input text-primary focus:ring-primary h-4 w-4 bg-background/50"
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
                                                    className="rounded border-input text-primary focus:ring-primary h-4 w-4 bg-background/50"
                                                    checked={selectedNames.has(cred.name)}
                                                    onChange={() => handleToggleSelect(cred.name)}
                                                />
                                            </td>
                                            <td className="px-4 py-3">
                                                <div className="font-medium text-foreground">{cred.name}</div>
                                                <div className="text-xs text-muted-foreground font-mono mt-0.5">{String(cred.auth_index || '').slice(0, 16)}...</div>
                                            </td>
                                            <td className="px-4 py-3 text-muted-foreground">{cred.provider}</td>
                                            <td className="px-4 py-3">
                                                <span className={`inline-flex items-center rounded-md px-2 py-0.5 text-[11px] font-medium ${cred.disabled ? 'border border-destructive/20 bg-destructive/10 text-destructive/90' : 'border border-amber-300/30 bg-amber-100/60 text-amber-700 dark:bg-amber-900/20 dark:text-amber-300'}`}>
                                                    {cred.disabled ? '已禁用(归档)' : '已归档(未禁用)'}
                                                </span>
                                            </td>
                                            <td className="px-4 py-3 text-right space-x-2">
                                                <button
                                                    onClick={() => { void handleEnableSingle(cred.name); }}
                                                    disabled={isBusy || enabling || deleting}
                                                    className="inline-flex items-center justify-center rounded-md border border-input bg-transparent h-8 px-2.5 text-xs font-medium hover:bg-accent hover:text-accent-foreground disabled:opacity-50"
                                                >
                                                    {enabling ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : '再启用'}
                                                </button>
                                                <button
                                                    onClick={() => { void handleDeleteSingle(cred.name); }}
                                                    disabled={isBusy || deleting || enabling}
                                                    className="inline-flex items-center justify-center rounded-md border border-destructive/30 bg-destructive/10 text-destructive h-8 px-2.5 text-xs font-medium hover:bg-destructive/20 disabled:opacity-50"
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


