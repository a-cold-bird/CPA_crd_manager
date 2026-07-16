import { Settings } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';
import {
  clearAuthFilesCache,
  cpaApi,
  configApi,
  runRemotePushTest,
  type RemotePushTestPayload,
} from '../../lib/api';

interface SettingsMessage {
  type: '' | 'success' | 'error';
  text: string;
}

interface SettingsPanelProps {
  cpaUrl: string;
  setCpaUrl: Dispatch<SetStateAction<string>>;
  newPassword: string;
  setNewPassword: Dispatch<SetStateAction<string>>;
  savingSettings: boolean;
  setSavingSettings: Dispatch<SetStateAction<boolean>>;
  message: SettingsMessage;
  setMessage: Dispatch<SetStateAction<SettingsMessage>>;
}

export default function SettingsPanelV3({
  cpaUrl,
  setCpaUrl,
  newPassword,
  setNewPassword,
  savingSettings,
  setSavingSettings,
  message,
  setMessage,
}: SettingsPanelProps) {
  const { i18n } = useTranslation();
  const isZh = i18n.language.startsWith('zh');
  const text = useCallback((en: string, zh: string) => (isZh ? zh : en), [isZh]);
  const [cpaUrlDraft, setCpaUrlDraft] = useState(cpaUrl);
  const [testingRemote, setTestingRemote] = useState(false);
  const [remoteTestResult, setRemoteTestResult] = useState<RemotePushTestPayload | null>(null);
  const [remoteTestError, setRemoteTestError] = useState('');

  useEffect(() => {
    setCpaUrlDraft(cpaUrl);
  }, [cpaUrl]);

  const handleRemotePushTest = async () => {
    setTestingRemote(true);
    setRemoteTestError('');
    setRemoteTestResult(null);
    try {
      const data = await runRemotePushTest({
        target_cpa_url: cpaUrlDraft.trim() || undefined,
        target_management_key: newPassword.trim() || undefined,
      });
      if (data.ok && data.payload) {
        setRemoteTestResult(data.payload);
        return;
      }
      setRemoteTestError(data.error || text('Remote push test failed.', '远程推送测试失败。'));
    } catch (error: unknown) {
      const messageText = typeof error === 'object' && error !== null && 'response' in error
        ? String(((error as { response?: { data?: { error?: string } } }).response?.data?.error) || text('Remote push test failed.', '远程推送测试失败。'))
        : text('Remote push test failed.', '远程推送测试失败。');
      setRemoteTestError(messageText);
    } finally {
      setTestingRemote(false);
    }
  };

  const handleSave = async () => {
    setSavingSettings(true);
    setMessage({ type: '', text: '' });
    try {
      const currentKey = String(localStorage.getItem('management_key') || '').trim();
      const nextKey = newPassword.trim();
      const { data } = await configApi.post('/config/update', {
        old_password: currentKey,
        new_config: {
          cpa_url: cpaUrlDraft.trim(),
          ...(nextKey ? { management_key: nextKey } : {}),
        },
      });
      if (!data.ok) {
        setMessage({ type: 'error', text: text('Failed to update settings.', '设置更新失败。') });
        return;
      }

      const resolvedUrl = cpaUrlDraft.trim();
      cpaApi.defaults.baseURL = '/api/cpa';
      clearAuthFilesCache();
      setCpaUrl(resolvedUrl);
      if (nextKey) {
        localStorage.setItem('management_key', nextKey);
        setNewPassword('');
      }
      setMessage({ type: 'success', text: text('Settings updated successfully.', '设置已更新。') });
    } catch (error: unknown) {
      const messageText = typeof error === 'object' && error !== null && 'response' in error
        ? String(((error as { response?: { data?: { error?: string } } }).response?.data?.error) || text('Update failed.', '更新失败。'))
        : text('Update failed.', '更新失败。');
      setMessage({ type: 'error', text: messageText });
    } finally {
      setSavingSettings(false);
    }
  };

  return (
    <div className="w-full max-w-5xl rounded-2xl border border-border bg-card/95 p-6 shadow-sm">
      <h2 className="mb-6 flex items-center gap-2 text-xl font-semibold">
        <Settings className="h-5 w-5" />
        {text('Remote CPA Configuration', '远程 CPA 配置')}
      </h2>

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="space-y-4 rounded-xl border border-border/60 bg-background/40 p-4">
          <div className="space-y-1">
            <h3 className="text-base font-semibold">{text('CPA Console', 'CPA 控制台')}</h3>
            <p className="text-xs text-muted-foreground">{text('Configure the remote CPA endpoint and optionally rotate the management key.', '配置远程 CPA 地址，并可按需更新管理密钥。')}</p>
          </div>
          <div className="grid gap-2">
            <label className="text-sm font-medium">{text('CPA API URL', 'CPA API 地址')}</label>
            <input
              type="url"
              value={cpaUrlDraft}
              onChange={(event) => setCpaUrlDraft(event.target.value)}
              className="flex h-10 w-full rounded-md border border-input bg-background/50 px-3 py-2 text-sm"
              placeholder="http://host.docker.internal:8317"
            />
          </div>
          <div className="grid gap-2">
            <label className="text-sm font-medium">{text('New Management Key', '新的管理密钥')}</label>
            <input
              type="password"
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
              className="flex h-10 w-full rounded-md border border-input bg-background/50 px-3 py-2 text-sm"
              placeholder={text('Leave blank to keep current', '留空则保持当前')}
            />
          </div>
        </section>

        <section className="space-y-4 rounded-xl border border-border/60 bg-background/40 p-4">
          <div className="space-y-1">
            <h3 className="text-base font-semibold">{text('Remote Push Test', '远程推送测试')}</h3>
            <p className="text-xs text-muted-foreground">{text('Test remote auth-file read, temporary upload, and cleanup delete.', '测试远程 auth file 读取、临时上传和清理删除。')}</p>
          </div>
          <button
            type="button"
            onClick={() => { void handleRemotePushTest(); }}
            disabled={testingRemote || !cpaUrlDraft.trim()}
            className="inline-flex h-10 items-center justify-center rounded-md border border-border bg-background px-4 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50"
          >
            {testingRemote ? text('Testing Remote Push...', '正在测试远程推送...') : text('Test Remote Read + Push', '测试远程读取与推送')}
          </button>
          {remoteTestError && (
            <div className="rounded-md border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">{remoteTestError}</div>
          )}
          {remoteTestResult && (
            <div className="space-y-2 rounded-md border border-border bg-background/70 px-4 py-3 text-sm">
              <p><span className="font-medium">{text('Remote target', '远程目标')}:</span> {remoteTestResult.target_cpa_url}</p>
              <p><span className="font-medium">{text('Auth files', 'Auth files')}:</span> {remoteTestResult.auth_files_total}</p>
              <p><span className="font-medium">{text('Read', '读取')}:</span> {remoteTestResult.read_ok ? text('OK', '成功') : text('Failed', '失败')}</p>
              <p><span className="font-medium">{text('Upload', '上传')}:</span> {remoteTestResult.push_test.upload_ok ? `${text('OK via', '成功，方式')} ${remoteTestResult.push_test.upload_mode}` : text('Failed', '失败')}</p>
              <p><span className="font-medium">{text('Cleanup delete', '清理删除')}:</span> {remoteTestResult.push_test.cleanup_ok ? text('OK', '成功') : text('Not completed', '未完成')}</p>
              {remoteTestResult.push_test.error && <p className="text-destructive">{remoteTestResult.push_test.error}</p>}
            </div>
          )}
        </section>
      </div>

      {message.text && (
        <div className={`mt-6 rounded-md border px-4 py-3 text-sm ${message.type === 'success' ? 'border-primary/50 bg-primary/10 text-primary' : 'border-destructive/50 bg-destructive/10 text-destructive'}`}>
          {message.text}
        </div>
      )}

      <button
        type="button"
        onClick={() => { void handleSave(); }}
        disabled={savingSettings}
        className="mt-6 inline-flex h-10 items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
      >
        {savingSettings ? text('Saving...', '保存中...') : text('Save Configuration', '保存配置')}
      </button>
    </div>
  );
}
