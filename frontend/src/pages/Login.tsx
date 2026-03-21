import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { cpaApi, configApi } from '../lib/api';
import { KeyRound, LogIn } from 'lucide-react';

export default function Login() {
    const { t } = useTranslation();
    const [password, setPassword] = useState('');
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(false);
    const navigate = useNavigate();

    const handleLogin = async (e: React.FormEvent) => {
        e.preventDefault();
        const normalizedPassword = password.trim();
        if (!normalizedPassword) {
            setError(t('Management key is required.'));
            return;
        }

        setLoading(true);
        setError('');

        try {
            const { data } = await configApi.post('/auth/login', { password: normalizedPassword });

            if (data.ok && data.config) {
                localStorage.setItem('management_key', normalizedPassword);
                cpaApi.defaults.baseURL = data.config.cpa_url;
                navigate('/');
            } else {
                setError(t('Authentication failed'));
            }
        } catch (error: unknown) {
            const errObj = error as { response?: { status?: number; data?: { error?: string } } };
            if (errObj?.response?.status === 401) {
                setError(t('Management key is invalid for this local console.'));
            } else {
                setError(errObj?.response?.data?.error || t('Local console is unreachable.'));
            }
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="flex bg-background min-h-screen items-center justify-center p-4 selection:bg-primary/10">
            <div className="w-full max-w-sm rounded-2xl border border-border bg-card p-8 shadow-sm">
                <div className="mb-8 flex flex-col items-center gap-4">
                    <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10 text-primary">
                        <KeyRound className="h-6 w-6" />
                    </div>
                    <div className="text-center">
                        <h1 className="text-2xl font-semibold tracking-tight">CPA Manager</h1>
                        <p className="text-sm text-muted-foreground mt-1">{t('Enter management key to connect')}</p>
                    </div>
                </div>

                <form onSubmit={handleLogin} className="space-y-4">
                    <div className="space-y-2">
                        <input
                            type="password"
                            placeholder={t('Management Key')}
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            className="flex h-10 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm ring-offset-background disabled:cursor-not-allowed disabled:opacity-50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                            autoFocus
                        />
                    </div>

                    {error && <p className="text-sm text-destructive">{error}</p>}

                    <button
                        type="submit"
                        disabled={loading || !password.trim()}
                        className="inline-flex w-full items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 h-10"
                    >
                        {loading ? <span className="animate-pulse">{t('Connecting...')}</span> : (
                            <>
                                <LogIn className="mr-2 h-4 w-4" /> {t('Connect Console')}
                            </>
                        )}
                    </button>
                </form>
            </div>
        </div>
    );
}
