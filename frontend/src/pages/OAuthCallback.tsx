import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { submitOAuthCallback, getOAuthStatus } from '../lib/api';
import { Loader2, CheckCircle, XCircle } from 'lucide-react';

export default function OAuthCallback() {
    const [searchParams] = useSearchParams();
    const [status, setStatus] = useState<'processing' | 'success' | 'error'>('processing');
    const [message, setMessage] = useState('Submitting OAuth callback...');

    useEffect(() => {
        const handleCallback = async () => {
            const code = searchParams.get('code');
            const urlState = searchParams.get('state');
            const storedState = sessionStorage.getItem('oauth_state');

            if (!code || !urlState) {
                setStatus('error');
                setMessage('Missing code or state in callback URL.');
                return;
            }

            if (storedState && storedState !== urlState) {
                setStatus('error');
                setMessage('Mismatching OAuth state parameter. Potential CSRF attack.');
                return;
            }

            try {
                const fullRedirectUrl = window.location.href;
                await submitOAuthCallback('codex', fullRedirectUrl, urlState);
                setMessage('Waiting for manager to process tokens...');

                // Polling logic
                let attempts = 0;
                const poll = setInterval(async () => {
                    attempts++;
                    try {
                        const statusRes = await getOAuthStatus(urlState);
                        if (statusRes.status === 'ok') {
                            setStatus('success');
                            setMessage('OAuth completed successfully. Auto-closing...');
                            clearInterval(poll);
                            setTimeout(() => window.close(), 3000);
                        } else if (statusRes.status === 'error') {
                            setStatus('error');
                            setMessage(`Manager error: ${statusRes.error}`);
                            clearInterval(poll);
                        } else if (attempts > 30) {
                            setStatus('error');
                            setMessage('Timeout waiting for completion.');
                            clearInterval(poll);
                        }
                    } catch {
                        // wait for next attempt
                    }
                }, 2000);

                return () => clearInterval(poll);
            } catch (error: unknown) {
                const errObj = error as { response?: { data?: { error?: string } } };
                setStatus('error');
                setMessage(errObj?.response?.data?.error || 'Failed to submit callback');
            }
        };

        handleCallback();
    }, [searchParams]);

    return (
        <div className="min-h-screen bg-background text-foreground flex items-center justify-center p-4">
            <div className="max-w-md w-full border border-border bg-card rounded-xl p-8 text-center shadow-sm">
                <div className="flex justify-center mb-6">
                    {status === 'processing' && <Loader2 className="w-12 h-12 text-primary animate-spin" />}
                    {status === 'success' && <CheckCircle className="w-12 h-12 text-emerald-500" />}
                    {status === 'error' && <XCircle className="w-12 h-12 text-destructive" />}
                </div>
                <h2 className="text-xl font-bold mb-2">
                    {status === 'processing' ? 'Processing OAuth...' : status === 'success' ? 'Success!' : 'OAuth Failed'}
                </h2>
                <p className="text-muted-foreground text-sm mb-6">{message}</p>
                {status !== 'processing' && (
                    <button
                        onClick={() => window.close()}
                        className="px-4 py-2 bg-secondary text-secondary-foreground rounded-md text-sm font-medium hover:bg-secondary/80"
                    >
                        Close Window
                    </button>
                )}
            </div>
        </div>
    );
}
