import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { clearAuthFilesCache, cpaApi, configApi } from '../lib/api';
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
        // Ignore localStorage errors.
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

export default function Dashboard() {
    const navigate = useNavigate();
    const { t, i18n } = useTranslation();
    const [activeTab, setActiveTab] = useState<'credentials' | 'archive' | 'settings'>('credentials');
    const [theme, setTheme] = useState<'light' | 'dark'>(getInitialTheme);
    const [cpaUrl, setCpaUrl] = useState('');
    const [newPassword, setNewPassword] = useState('');
    const [autoProbeEnabled, setAutoProbeEnabled] = useState<boolean>(getInitialAutoProbeEnabled);
    const [autoProbeIntervalMinutes, setAutoProbeIntervalMinutes] = useState<number>(() => clampAutoProbeIntervalMinutes(localStorage.getItem('probe_auto_interval_minutes') || 60));
    const [codexQuotaDisableRemainingPercent, setCodexQuotaDisableRemainingPercent] = useState<number>(() => clampQuotaDisableRemainingPercent(localStorage.getItem('codex_quota_disable_remaining_percent') || 10));
    const [autoProbeConfigStatus, setAutoProbeConfigStatus] = useState<AutoProbeConfigStatus>('idle');
    const [savingSettings, setSavingSettings] = useState(false);
    const [settingsMessage, setSettingsMessage] = useState<SettingsMessage>({ type: '', text: '' });
    const autoProbeConfigLoadedRef = useRef(false);
    const autoProbeConfigSyncPrimedRef = useRef(false);

    useEffect(() => {
        const key = localStorage.getItem('management_key');
        if (!key) {
            navigate('/login');
            return;
        }

        const initConfig = async () => {
            try {
                const { data } = await configApi.post('/config', { password: key });
                if (!data.ok) return;

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
                clearAuthFilesCache();
                setCpaUrl(resolvedUrl);
                setAutoProbeEnabled(resolvedAutoProbeEnabled);
                setAutoProbeIntervalMinutes(resolvedAutoProbeInterval);
                setCodexQuotaDisableRemainingPercent(resolvedQuotaDisableRemainingPercent);
                setAutoProbeConfigStatus('loaded');
                autoProbeConfigLoadedRef.current = true;
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
            // Ignore localStorage errors.
        }
    }, [theme]);

    useEffect(() => {
        try {
            localStorage.setItem('probe_auto_enabled', autoProbeEnabled ? '1' : '0');
            localStorage.setItem('probe_auto_interval_minutes', String(autoProbeIntervalMinutes));
            localStorage.setItem('codex_quota_disable_remaining_percent', String(codexQuotaDisableRemainingPercent));
        } catch {
            // Ignore localStorage errors.
        }
    }, [autoProbeEnabled, autoProbeIntervalMinutes, codexQuotaDisableRemainingPercent]);

    useEffect(() => {
        if (!autoProbeConfigLoadedRef.current) return;
        if (savingSettings) return;
        if (!autoProbeConfigSyncPrimedRef.current) {
            autoProbeConfigSyncPrimedRef.current = true;
            return;
        }

        let cancelled = false;

        const timer = window.setTimeout(() => {
            const password = String(localStorage.getItem('management_key') || '').trim();
            if (!password) {
                setAutoProbeConfigStatus('error');
                return;
            }
            setAutoProbeConfigStatus('saving');
            void configApi.post('/config/update', {
                old_password: password,
                new_config: {
                    auto_probe_enabled: autoProbeEnabled,
                    auto_probe_interval_minutes: autoProbeIntervalMinutes,
                    codex_quota_disable_remaining_percent: codexQuotaDisableRemainingPercent,
                },
            }).then(() => {
                if (!cancelled) setAutoProbeConfigStatus('saved');
            }).catch(() => {
                if (!cancelled) setAutoProbeConfigStatus('error');
            });
        }, 300);

        return () => {
            cancelled = true;
            window.clearTimeout(timer);
        };
    }, [autoProbeEnabled, autoProbeIntervalMinutes, codexQuotaDisableRemainingPercent, savingSettings]);

    const toggleTheme = () => setTheme((previous) => previous === 'light' ? 'dark' : 'light');
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
                        <span className="truncate text-sm font-medium text-muted-foreground">{t('URL')}: {cpaUrl || t('Not Connected')}</span>
                    </div>
                    <div className="flex flex-row items-center gap-4">
                        <button onClick={toggleLanguage} className="p-2 rounded-md hover:bg-muted text-muted-foreground transition-colors" title={t('Toggle Language')}>
                            <Globe className="h-4 w-4" />
                        </button>
                        <button onClick={toggleTheme} className="p-2 rounded-md hover:bg-muted text-muted-foreground transition-colors" title={t('Toggle Theme')}>
                            {theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
                        </button>
                        <div className="hidden md:flex items-center gap-2 border-l border-border pl-4">
                            <div className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
                            <span className="text-sm text-emerald-600 dark:text-emerald-500 font-medium">{t('Connected')}</span>
                        </div>
                        <button
                            onClick={() => {
                                localStorage.removeItem('management_key');
                                navigate('/login');
                            }}
                            className="text-sm font-medium text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5 transition-colors pl-4 border-l border-border"
                        >
                            <LogOut className="h-4 w-4" /> {t('Sign out')}
                        </button>
                    </div>
                </header>

                <nav className="grid grid-cols-3 border-b border-border bg-card p-2 md:hidden">
                    <button
                        type="button"
                        onClick={() => setActiveTab('credentials')}
                        className={`flex items-center justify-center gap-1.5 rounded-md px-2 py-2 text-xs font-medium ${activeTab === 'credentials' ? 'bg-primary/10 text-primary' : 'text-muted-foreground'}`}
                    >
                        <ShieldCheck className="h-4 w-4" /> {t('Auth Files')}
                    </button>
                    <button
                        type="button"
                        onClick={() => setActiveTab('archive')}
                        className={`flex items-center justify-center gap-1.5 rounded-md px-2 py-2 text-xs font-medium ${activeTab === 'archive' ? 'bg-primary/10 text-primary' : 'text-muted-foreground'}`}
                    >
                        <Trash2 className="h-4 w-4" /> {t('Archive')}
                    </button>
                    <button
                        type="button"
                        onClick={() => setActiveTab('settings')}
                        className={`flex items-center justify-center gap-1.5 rounded-md px-2 py-2 text-xs font-medium ${activeTab === 'settings' ? 'bg-primary/10 text-primary' : 'text-muted-foreground'}`}
                    >
                        <Settings className="h-4 w-4" /> {t('Config')}
                    </button>
                </nav>

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
