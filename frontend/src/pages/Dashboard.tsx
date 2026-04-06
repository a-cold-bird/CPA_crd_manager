import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { cpaApi, configApi } from '../lib/api';
import { Settings, LogOut, ShieldCheck, Layers, Moon, Sun, Globe, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import SettingsPanel from './dashboard/SettingsPanelV3';
import ArchivedCredentialsPanel from './dashboard/ArchivedCredentialsPanelV3';
import CredentialManager from './dashboard/CredentialManager';

interface SidebarButtonProps {
    active: boolean;
    onClick: () => void;
    icon: ReactNode;
    label: string;
}

interface SettingsMessage {
    type: '' | 'success' | 'error';
    text: string;
}

type AutoProbeConfigStatus = 'idle' | 'loaded' | 'saving' | 'saved' | 'error';

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

function getInitialAutoProbeEnabled(): boolean {
    try {
        const raw = String(localStorage.getItem('probe_auto_enabled') || '').trim().toLowerCase();
        return raw === '1' || raw === 'true' || raw === 'yes';
    } catch {
        return false;
    }
}

function clampAutoProbeIntervalMinutes(value: unknown, fallback = 60): number {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return fallback;
    return Math.max(1, Math.min(1440, Math.floor(numeric)));
}

function clampQuotaDisableRemainingPercent(value: unknown, fallback = 10): number {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return fallback;
    return Math.max(0, Math.min(100, Math.floor(numeric)));
}

function parseConfigBoolean(value: unknown, fallback = false): boolean {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
        const lower = value.trim().toLowerCase();
        if (lower === '1' || lower === 'true' || lower === 'yes') return true;
        if (lower === '0' || lower === 'false' || lower === 'no') return false;
    }
    return fallback;
}

function parseIntSafe(value: unknown, fallback: number): number {
    const numeric = Number.parseInt(String(value ?? ''), 10);
    return Number.isFinite(numeric) ? numeric : fallback;
}

export default function Dashboard() {
    const navigate = useNavigate();
    const { t, i18n } = useTranslation();
    const [activeTab, setActiveTab] = useState<'credentials' | 'archive' | 'settings'>('credentials');
    const [theme, setTheme] = useState<'light' | 'dark'>(getInitialTheme);

    const [cpaUrl, setCpaUrl] = useState('');
    const [newPassword, setNewPassword] = useState('');
    const [mailApiBase, setMailApiBase] = useState('');
    const [mailfreeApiBase, setMailfreeApiBase] = useState('');
    const [inbucketApiBase, setInbucketApiBase] = useState('');
    const [inbucketUsername, setInbucketUsername] = useState('');
    const [inbucketPassword, setInbucketPassword] = useState('');
    const [inbucketEmailDomain, setInbucketEmailDomain] = useState('');
    const [inbucketIceApiBase, setInbucketIceApiBase] = useState('');
    const [inbucketIceUsername, setInbucketIceUsername] = useState('');
    const [inbucketIcePassword, setInbucketIcePassword] = useState('');
    const [inbucketIceEmailDomain, setInbucketIceEmailDomain] = useState('');
    const [inbucketIceDomains, setInbucketIceDomains] = useState<string[]>([]);
    const [duckmailApiBase, setDuckmailApiBase] = useState('');
    const [duckmailApiKey, setDuckmailApiKey] = useState('');
    const [mailUsername, setMailUsername] = useState('');
    const [mailfreeUsername, setMailfreeUsername] = useState('');
    const [mailPassword, setMailPassword] = useState('');
    const [mailfreePassword, setMailfreePassword] = useState('');
    const [mailEmailProvider, setMailEmailProvider] = useState<'mailfree' | 'inbucket' | 'inbucket_ice' | 'duckmail'>('mailfree');
    const [mailEmailDomain, setMailEmailDomain] = useState('');
    const [mailfreeEmailDomain, setMailfreeEmailDomain] = useState('');
    const [mailEmailDomains, setMailEmailDomains] = useState('');
    const [mailfreeEmailDomains, setMailfreeEmailDomains] = useState('');
    const [inbucketDomains, setInbucketDomains] = useState<string[]>([]);
    const [inbucketDisabledDomains, setInbucketDisabledDomains] = useState<string[]>([]);
    const [duckmailDomains, setDuckmailDomains] = useState<string[]>([]);
    const [mailRandomizeFromList, setMailRandomizeFromList] = useState(true);
    const [codexReplenishEnabled, setCodexReplenishEnabled] = useState(false);
    const [codexReplenishTargetCount, setCodexReplenishTargetCount] = useState(5);
    const [codexReplenishThreshold, setCodexReplenishThreshold] = useState(2);
    const [codexReplenishBatchSize, setCodexReplenishBatchSize] = useState(1);
    const [codexReplenishWorkerCount, setCodexReplenishWorkerCount] = useState(1);
    const [codexReplenishUseProxy, setCodexReplenishUseProxy] = useState(true);
    const [codexReplenishProxyPool, setCodexReplenishProxyPool] = useState('');
    const [autoProbeEnabled, setAutoProbeEnabled] = useState<boolean>(getInitialAutoProbeEnabled);
    const [autoProbeIntervalMinutes, setAutoProbeIntervalMinutes] = useState<number>(() => clampAutoProbeIntervalMinutes(localStorage.getItem('probe_auto_interval_minutes') || 60));
    const [codexQuotaDisableRemainingPercent, setCodexQuotaDisableRemainingPercent] = useState<number>(() => clampQuotaDisableRemainingPercent(localStorage.getItem('codex_quota_disable_remaining_percent') || 10));
    const [autoProbeConfigStatus, setAutoProbeConfigStatus] = useState<AutoProbeConfigStatus>('idle');
    const [savingSettings, setSavingSettings] = useState(false);
    const [settingsMessage, setSettingsMessage] = useState<SettingsMessage>({ type: '', text: '' });
    const autoProbeConfigLoadedRef = useRef(false);
    const autoProbeConfigSyncPrimedRef = useRef(false);
    const previousMailProviderRef = useRef<'mailfree' | 'inbucket' | 'inbucket_ice' | 'duckmail'>('mailfree');

    useEffect(() => {
        const key = localStorage.getItem('management_key');
        if (!key) {
            navigate('/login');
            return;
        }

        const initConfig = async () => {
            try {
                const { data } = await configApi.post('/config', { password: key });
                if (data.ok) {
                    const resolvedUrl = String(data.config.cpa_url || '').trim();
                    const resolvedAutoProbeEnabled = parseConfigBoolean(data.config.auto_probe_enabled, getInitialAutoProbeEnabled());
                    const resolvedAutoProbeInterval = clampAutoProbeIntervalMinutes(
                        data.config.auto_probe_interval_minutes,
                        clampAutoProbeIntervalMinutes(localStorage.getItem('probe_auto_interval_minutes') || 60),
                    );
                    const resolvedQuotaDisableRemainingPercent = clampQuotaDisableRemainingPercent(
                        data.config.codex_quota_disable_remaining_percent,
                        clampQuotaDisableRemainingPercent(localStorage.getItem('codex_quota_disable_remaining_percent') || 10),
                    );
                    cpaApi.defaults.baseURL = '/api/cpa';
                    setCpaUrl(resolvedUrl);
                    {
                        const provider = String(data.config.mail_email_provider || 'mailfree').trim().toLowerCase();
                        setMailEmailProvider(provider === 'inbucket' || provider === 'inbucket_ice' || provider === 'duckmail' ? provider : 'mailfree');
                    }
                    setMailApiBase(String(data.config.mail_api_base || ''));
                    setMailfreeApiBase(String(data.config.mailfree_api_base || data.config.mail_api_base || ''));
                    setDuckmailApiBase(String(data.config.duckmail_api_base || data.mail_meta?.duckmail_api_base || ''));
                    setDuckmailApiKey(String(data.config.duckmail_api_key || ''));
                    setMailUsername(String(data.config.mail_username || ''));
                    setMailfreeUsername(String(data.config.mailfree_username || data.config.mail_username || ''));
                    setMailPassword(String(data.config.mail_password || ''));
                    setMailfreePassword(String(data.config.mailfree_password || data.config.mail_password || ''));
                    setMailEmailDomain(String(data.config.mail_email_domain || ''));
                    setMailfreeEmailDomain(String(data.config.mailfree_mail_domain || data.config.mail_email_domain || ''));
                    setMailEmailDomains(String(data.config.mail_email_domains || ''));
                    setMailfreeEmailDomains(String(data.config.mailfree_mail_domains || data.config.mail_email_domains || ''));
                    setInbucketApiBase(String(data.mail_meta?.inbucket_api_base || ''));
                    setInbucketUsername(String(data.config.inbucket_mail_username || ''));
                    setInbucketPassword(String(data.config.inbucket_mail_password || ''));
                    setInbucketEmailDomain(String(data.config.inbucket_mail_domain || ''));
                    setInbucketDomains(Array.isArray(data.mail_meta?.inbucket_domains) ? data.mail_meta.inbucket_domains.map((item: unknown) => String(item || '').trim()).filter(Boolean) : []);
                    setInbucketDisabledDomains(
                        String(data.config.inbucket_mail_disabled_domains || '')
                            .split(',')
                            .map((item: string) => item.trim().toLowerCase())
                            .filter(Boolean),
                    );
                    setInbucketIceApiBase(String(data.config.inbucket_ice_mail_api_base || data.config.inbucket_v1_mail_api_base || ''));
                    setInbucketIceUsername(String(data.config.inbucket_ice_mail_username || data.config.inbucket_v1_mail_username || ''));
                    setInbucketIcePassword(String(data.config.inbucket_ice_mail_password || data.config.inbucket_v1_mail_password || ''));
                    setInbucketIceEmailDomain(String(data.config.inbucket_ice_mail_domain || data.config.inbucket_v1_mail_domain || ''));
                    {
                        const parsed = String(data.config.inbucket_ice_mail_domains || data.config.inbucket_v1_mail_domains || '')
                            .split(',')
                            .map((item: string) => item.trim())
                            .filter(Boolean);
                        setInbucketIceDomains(parsed);
                    }
                    setDuckmailDomains(Array.isArray(data.mail_meta?.duckmail_domains) ? data.mail_meta.duckmail_domains.map((item: unknown) => String(item || '').trim()).filter(Boolean) : []);
                    setMailRandomizeFromList(parseConfigBoolean(data.config.mail_randomize_from_list, true));
                    setCodexReplenishEnabled(parseConfigBoolean(data.config.codex_replenish_enabled, false));
                    setCodexReplenishTargetCount(parseIntSafe(data.config.codex_replenish_target_count, 5));
                    setCodexReplenishThreshold(parseIntSafe(data.config.codex_replenish_threshold, 2));
                    setCodexReplenishBatchSize(parseIntSafe(data.config.codex_replenish_batch_size, 1));
                    setCodexReplenishWorkerCount(parseIntSafe(data.config.codex_replenish_worker_count, 1));
                    setCodexReplenishUseProxy(parseConfigBoolean(data.config.codex_replenish_use_proxy, true));
                    setCodexReplenishProxyPool(String(data.config.codex_replenish_proxy_pool || ''));
                    setAutoProbeEnabled(resolvedAutoProbeEnabled);
                    setAutoProbeIntervalMinutes(resolvedAutoProbeInterval);
                    setCodexQuotaDisableRemainingPercent(resolvedQuotaDisableRemainingPercent);
                    setAutoProbeConfigStatus('loaded');
                    autoProbeConfigLoadedRef.current = true;
                }
            } catch {
                localStorage.removeItem('management_key');
                navigate('/login');
            }
        };

        void initConfig();
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

    useEffect(() => {
        const previousProvider = previousMailProviderRef.current;
        if (previousProvider === mailEmailProvider) return;

        if (previousProvider === 'mailfree') {
            setMailfreeApiBase(mailApiBase);
            setMailfreeUsername(mailUsername);
            setMailfreePassword(mailPassword);
            setMailfreeEmailDomain(mailEmailDomain);
            setMailfreeEmailDomains(mailEmailDomains);
        } else if (previousProvider === 'inbucket' || previousProvider === 'inbucket_ice') {
            if (previousProvider === 'inbucket') {
                setInbucketApiBase(mailApiBase);
                setInbucketUsername(mailUsername);
                setInbucketPassword(mailPassword);
                setInbucketEmailDomain(mailEmailDomain);
                setInbucketDomains(
                    String(mailEmailDomains || '')
                        .split(',')
                        .map((item) => String(item || '').trim())
                        .filter(Boolean),
                );
            } else {
                setInbucketIceApiBase(mailApiBase);
                setInbucketIceUsername(mailUsername);
                setInbucketIcePassword(mailPassword);
                setInbucketIceEmailDomain(mailEmailDomain);
            }
        }

        if (mailEmailProvider === 'mailfree') {
            setMailApiBase(mailfreeApiBase);
            setMailUsername(mailfreeUsername);
            setMailPassword(mailfreePassword);
            setMailEmailDomain(mailfreeEmailDomain);
            setMailEmailDomains(mailfreeEmailDomains);
        } else if (mailEmailProvider === 'inbucket' || mailEmailProvider === 'inbucket_ice') {
            if (mailEmailProvider === 'inbucket') {
                setMailApiBase(inbucketApiBase);
                setMailUsername(inbucketUsername);
                setMailPassword(inbucketPassword);
                setMailEmailDomain(inbucketEmailDomain);
                setMailEmailDomains(inbucketDomains.join(', '));
            } else {
                setMailApiBase(inbucketIceApiBase);
                setMailUsername(inbucketIceUsername);
                setMailPassword(inbucketIcePassword);
                setMailEmailDomain(inbucketIceEmailDomain);
                setMailEmailDomains(inbucketIceDomains.join(', '));
            }
        } else {
            setMailApiBase(duckmailApiBase);
            setMailUsername('');
            setMailPassword('');
            if (duckmailDomains.length > 0) {
                setMailEmailDomains(duckmailDomains.join(', '));
                if (!duckmailDomains.includes(mailEmailDomain)) {
                    setMailEmailDomain(duckmailDomains[0]);
                }
            }
        }

        previousMailProviderRef.current = mailEmailProvider;
    }, [duckmailApiBase, duckmailDomains, inbucketApiBase, inbucketDomains, inbucketEmailDomain, inbucketPassword, inbucketUsername, inbucketIceApiBase, inbucketIceDomains, inbucketIceEmailDomain, inbucketIcePassword, inbucketIceUsername, mailApiBase, mailEmailDomain, mailEmailDomains, mailEmailProvider, mailPassword, mailUsername, mailfreeApiBase, mailfreeEmailDomain, mailfreeEmailDomains, mailfreePassword, mailfreeUsername]);

    useEffect(() => {
        if (mailEmailProvider !== 'mailfree') return;
        setMailfreeApiBase(mailApiBase);
        setMailfreeUsername(mailUsername);
        setMailfreePassword(mailPassword);
        setMailfreeEmailDomain(mailEmailDomain);
        setMailfreeEmailDomains(mailEmailDomains);
    }, [mailApiBase, mailEmailDomain, mailEmailDomains, mailEmailProvider, mailPassword, mailUsername]);

    useEffect(() => {
        if (mailEmailProvider === 'inbucket') {
            setInbucketApiBase(mailApiBase);
            setInbucketUsername(mailUsername);
            setInbucketPassword(mailPassword);
            setInbucketEmailDomain(mailEmailDomain);
            return;
        }
        if (mailEmailProvider === 'inbucket_ice') {
            setInbucketIceApiBase(mailApiBase);
            setInbucketIceUsername(mailUsername);
            setInbucketIcePassword(mailPassword);
            setInbucketIceEmailDomain(mailEmailDomain);
        }
    }, [mailApiBase, mailEmailDomain, mailEmailProvider, mailPassword, mailUsername]);

    useEffect(() => {
        try {
            localStorage.setItem('probe_auto_enabled', autoProbeEnabled ? '1' : '0');
            localStorage.setItem('probe_auto_interval_minutes', String(autoProbeIntervalMinutes));
            localStorage.setItem('codex_quota_disable_remaining_percent', String(codexQuotaDisableRemainingPercent));
        } catch {
            // ignore localStorage errors
        }
    }, [autoProbeEnabled, autoProbeIntervalMinutes, codexQuotaDisableRemainingPercent]);

    useEffect(() => {
        if (!autoProbeConfigLoadedRef.current) return;
        if (!autoProbeConfigSyncPrimedRef.current) {
            autoProbeConfigSyncPrimedRef.current = true;
            return;
        }

        let cancelled = false;
        const password = String(localStorage.getItem('management_key') || '').trim();
        if (!password) return;

        const timer = window.setTimeout(() => {
            setAutoProbeConfigStatus('saving');
            void configApi.post('/config/update', {
                old_password: password,
                new_config: {
                    mail_api_base: mailApiBase,
                    mail_username: mailUsername,
                    mail_password: mailPassword,
                    mail_email_provider: mailEmailProvider,
                    mail_email_domain: mailEmailDomain,
                    mail_email_domains: mailEmailDomains,
                    auto_probe_enabled: autoProbeEnabled,
                    auto_probe_interval_minutes: autoProbeIntervalMinutes,
                    codex_quota_disable_remaining_percent: codexQuotaDisableRemainingPercent,
                    mail_randomize_from_list: mailRandomizeFromList,
                    codex_replenish_enabled: codexReplenishEnabled,
                    codex_replenish_target_count: codexReplenishTargetCount,
                    codex_replenish_threshold: codexReplenishThreshold,
                    codex_replenish_batch_size: codexReplenishBatchSize,
                    codex_replenish_worker_count: codexReplenishWorkerCount,
                    codex_replenish_use_proxy: codexReplenishUseProxy,
                    codex_replenish_proxy_pool: codexReplenishProxyPool,
                },
            }).then(() => {
                if (!cancelled) {
                    setAutoProbeConfigStatus('saved');
                }
            }).catch(() => {
                if (!cancelled) {
                    setAutoProbeConfigStatus('error');
                }
            });
        }, 300);

        return () => {
            cancelled = true;
            window.clearTimeout(timer);
        };
    }, [
        mailApiBase,
        mailUsername,
        mailPassword,
        mailEmailProvider,
        mailEmailDomain,
        mailEmailDomains,
        autoProbeEnabled,
        autoProbeIntervalMinutes,
        codexQuotaDisableRemainingPercent,
        mailRandomizeFromList,
        codexReplenishEnabled,
        codexReplenishTargetCount,
        codexReplenishThreshold,
        codexReplenishBatchSize,
        codexReplenishWorkerCount,
        codexReplenishUseProxy,
        codexReplenishProxyPool,
    ]);

    const toggleTheme = () => setTheme((prev) => prev === 'light' ? 'dark' : 'light');
    const toggleLanguage = () => i18n.changeLanguage(i18n.language === 'zh' ? 'en' : 'zh');

    return (
        <div className="flex h-screen w-full bg-muted/20 text-foreground overflow-hidden">
            <aside className="hidden md:flex w-64 flex-col border-r border-border bg-card">
                <div className="flex h-14 items-center px-4 border-b border-border">
                    <Layers className="h-5 w-5 text-primary mr-2" />
                    <span className="font-semibold text-lg tracking-tight">CPAMC Console</span>
                </div>
                <nav className="flex-1 overflow-y-auto py-4 flex flex-col gap-1 px-3">
                    <p className="px-2 text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2 mt-4 first:mt-0">{t('Management')}</p>
                    <SidebarButton active={activeTab === 'credentials'} onClick={() => setActiveTab('credentials')} icon={<ShieldCheck className="h-4 w-4" />} label={t('Auth Files')} />
                    <SidebarButton active={activeTab === 'archive'} onClick={() => setActiveTab('archive')} icon={<Trash2 className="h-4 w-4" />} label={t('Archive')} />
                    <p className="px-2 text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2 mt-4">{t('System')}</p>
                    <SidebarButton active={activeTab === 'settings'} onClick={() => setActiveTab('settings')} icon={<Settings className="h-4 w-4" />} label={t('Config')} />
                </nav>
            </aside>

            <div className="flex flex-1 flex-col min-w-0">
                <header className="flex h-14 items-center gap-4 border-b border-border bg-card px-6 lg:px-8">
                    <div className="flex-1 flex items-center">
                        <span className="text-sm font-medium text-muted-foreground">{t('URL')}: {cpaUrl || t('Not Connected')}</span>
                    </div>
                    <div className="flex flex-row items-center gap-4">
                        <button onClick={toggleLanguage} className="p-2 rounded-md hover:bg-muted text-muted-foreground transition-colors" title={t('Toggle Language')}>
                            <Globe className="h-4 w-4" />
                        </button>
                        <button onClick={toggleTheme} className="p-2 rounded-md hover:bg-muted text-muted-foreground transition-colors" title={t('Toggle Theme')}>
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
                            <LogOut className="h-4 w-4" /> {t('Sign out')}
                        </button>
                    </div>
                </header>

                <main className="flex-1 p-4 lg:p-6 overflow-y-auto">
                    <div className="mx-auto w-full max-w-[1900px] space-y-6">
                        {activeTab === 'credentials' && (
                            <CredentialManager
                                cpaReady={Boolean(cpaUrl)}
                                cpaUrl={cpaUrl}
                                autoProbeEnabled={autoProbeEnabled}
                                setAutoProbeEnabled={setAutoProbeEnabled}
                                autoProbeIntervalMinutes={autoProbeIntervalMinutes}
                                setAutoProbeIntervalMinutes={setAutoProbeIntervalMinutes}
                                codexQuotaDisableRemainingPercent={codexQuotaDisableRemainingPercent}
                                setCodexQuotaDisableRemainingPercent={setCodexQuotaDisableRemainingPercent}
                                autoProbeConfigStatus={autoProbeConfigStatus}
                            />
                        )}
                        {activeTab === 'archive' && <ArchivedCredentialsPanel cpaReady={Boolean(cpaUrl)} cpaUrl={cpaUrl} />}
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
                                mailEmailProvider={mailEmailProvider}
                                setMailEmailProvider={setMailEmailProvider}
                                inbucketApiBase={inbucketApiBase}
                                duckmailApiBase={duckmailApiBase}
                                duckmailApiKey={duckmailApiKey}
                                setDuckmailApiKey={setDuckmailApiKey}
                                mailEmailDomain={mailEmailDomain}
                                setMailEmailDomain={setMailEmailDomain}
                                mailEmailDomains={mailEmailDomains}
                                setMailEmailDomains={setMailEmailDomains}
                                inbucketDomains={inbucketDomains}
                                inbucketIceDomains={inbucketIceDomains}
                                setInbucketDomains={setInbucketDomains}
                                inbucketDisabledDomains={inbucketDisabledDomains}
                                setInbucketDisabledDomains={setInbucketDisabledDomains}
                                duckmailDomains={duckmailDomains}
                                mailRandomizeFromList={mailRandomizeFromList}
                                setMailRandomizeFromList={setMailRandomizeFromList}
                                codexReplenishEnabled={codexReplenishEnabled}
                                setCodexReplenishEnabled={setCodexReplenishEnabled}
                                codexReplenishTargetCount={codexReplenishTargetCount}
                                setCodexReplenishTargetCount={setCodexReplenishTargetCount}
                            codexReplenishThreshold={codexReplenishThreshold}
                            setCodexReplenishThreshold={setCodexReplenishThreshold}
                            codexReplenishBatchSize={codexReplenishBatchSize}
                            setCodexReplenishBatchSize={setCodexReplenishBatchSize}
                            codexReplenishWorkerCount={codexReplenishWorkerCount}
                            setCodexReplenishWorkerCount={setCodexReplenishWorkerCount}
                            codexReplenishUseProxy={codexReplenishUseProxy}
                                setCodexReplenishUseProxy={setCodexReplenishUseProxy}
                                codexReplenishProxyPool={codexReplenishProxyPool}
                                setCodexReplenishProxyPool={setCodexReplenishProxyPool}
                                savingSettings={savingSettings}
                                setSavingSettings={setSavingSettings}
                                message={settingsMessage}
                                setMessage={setSettingsMessage}
                            />
                        )}
                    </div>
                </main>
            </div>
        </div>
    );
}

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
