import { Settings } from 'lucide-react';
import { useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';
import {
  cpaApi,
  configApi,
  runMailDomainTest,
  runRemotePushTest,
  type MailDomainTestPayload,
  type RemotePushTestPayload,
} from '../../lib/api';

interface SettingsMessage {
  type: '' | 'success' | 'error';
  text: string;
}

interface DomainTestState {
  status: 'idle' | 'testing' | 'success' | 'error';
  message: string;
  payload: MailDomainTestPayload | null;
}

interface SettingsPanelProps {
  cpaUrl: string;
  setCpaUrl: Dispatch<SetStateAction<string>>;
  newPassword: string;
  setNewPassword: Dispatch<SetStateAction<string>>;
  mailApiBase: string;
  setMailApiBase: Dispatch<SetStateAction<string>>;
  mailUsername: string;
  setMailUsername: Dispatch<SetStateAction<string>>;
  mailPassword: string;
  setMailPassword: Dispatch<SetStateAction<string>>;
  mailEmailDomain: string;
  setMailEmailDomain: Dispatch<SetStateAction<string>>;
  mailEmailDomains: string;
  setMailEmailDomains: Dispatch<SetStateAction<string>>;
  codexReplenishEnabled: boolean;
  setCodexReplenishEnabled: Dispatch<SetStateAction<boolean>>;
  codexReplenishTargetCount: number;
  setCodexReplenishTargetCount: Dispatch<SetStateAction<number>>;
  codexReplenishThreshold: number;
  setCodexReplenishThreshold: Dispatch<SetStateAction<number>>;
  codexReplenishUseProxy: boolean;
  setCodexReplenishUseProxy: Dispatch<SetStateAction<boolean>>;
  savingSettings: boolean;
  setSavingSettings: Dispatch<SetStateAction<boolean>>;
  message: SettingsMessage;
  setMessage: Dispatch<SetStateAction<SettingsMessage>>;
}

const DOMAIN_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;

function normalizeDomain(input: string): string {
  return input.trim().toLowerCase().replace(/^@+/, '');
}

function parseDomainList(input: string): string[] {
  return Array.from(new Set(
    input
      .split(',')
      .map((item) => normalizeDomain(item))
      .filter(Boolean),
  ));
}

function stringifyDomainList(domains: string[]): string {
  return domains.join(', ');
}

function normalizeNonNegativeInteger(value: unknown, fallback = 0): number {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, parsed);
}

function normalizeReplenishThreshold(value: unknown, targetCount: number, fallback = 0): number {
  return Math.min(normalizeNonNegativeInteger(value, fallback), Math.max(0, targetCount));
}

export default function SettingsPanelV2({
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
  mailEmailDomains,
  setMailEmailDomains,
  codexReplenishEnabled,
  setCodexReplenishEnabled,
  codexReplenishTargetCount,
  setCodexReplenishTargetCount,
  codexReplenishThreshold,
  setCodexReplenishThreshold,
  codexReplenishUseProxy,
  setCodexReplenishUseProxy,
  savingSettings,
  setSavingSettings,
  message,
  setMessage,
}: SettingsPanelProps) {
  const { i18n } = useTranslation();
  const [testingRemote, setTestingRemote] = useState(false);
  const [remoteTestResult, setRemoteTestResult] = useState<RemotePushTestPayload | null>(null);
  const [remoteTestError, setRemoteTestError] = useState('');
  const [domainDraft, setDomainDraft] = useState('');
  const [domainEditorError, setDomainEditorError] = useState('');
  const [domainTestStates, setDomainTestStates] = useState<Record<string, DomainTestState>>({});
  const normalizedCurrentMailDomain = normalizeDomain(mailEmailDomain);
  const emailDomainOptions = parseDomainList(mailEmailDomains);
  const biLabel = (en: string, zh: string) => (i18n.language.startsWith('zh') ? `${zh} / ${en}` : `${en} / ${zh}`);
  const effectiveReplenishTargetCount = normalizeNonNegativeInteger(codexReplenishTargetCount, 0);
  const effectiveReplenishThreshold = normalizeReplenishThreshold(codexReplenishThreshold, effectiveReplenishTargetCount, 0);

  if (normalizedCurrentMailDomain && !emailDomainOptions.includes(normalizedCurrentMailDomain)) {
    emailDomainOptions.unshift(normalizedCurrentMailDomain);
  }

  const commitDomains = (domains: string[]) => {
    const nextDomains = parseDomainList(stringifyDomainList(domains));
    setMailEmailDomains(stringifyDomainList(nextDomains));
    if (mailEmailDomain && !nextDomains.includes(normalizeDomain(mailEmailDomain))) {
      setMailEmailDomain(nextDomains[0] || '');
    }
    setDomainTestStates((prev) => {
      const next: Record<string, DomainTestState> = {};
      nextDomains.forEach((domain) => {
        if (prev[domain]) {
          next[domain] = prev[domain];
        }
      });
      return next;
    });
  };

  const handleAddDomain = () => {
    const normalized = normalizeDomain(domainDraft);
    if (!normalized) {
      setDomainEditorError(biLabel('Please enter a domain first.', '请先输入域名'));
      return;
    }
    if (!DOMAIN_PATTERN.test(normalized)) {
      setDomainEditorError(biLabel(`Invalid domain: ${normalized}`, `域名格式无效: ${normalized}`));
      return;
    }
    if (emailDomainOptions.includes(normalized)) {
      setDomainEditorError(biLabel(`Domain already exists: ${normalized}`, `域名已存在: ${normalized}`));
      return;
    }
    commitDomains([...emailDomainOptions, normalized]);
    if (!mailEmailDomain.trim()) {
      setMailEmailDomain(normalized);
    }
    setDomainDraft('');
    setDomainEditorError('');
  };

  const handleRemoveDomain = (domain: string) => {
    commitDomains(emailDomainOptions.filter((item) => item !== domain));
    setDomainEditorError('');
  };

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
          mail_email_domains: mailEmailDomains,
          codex_replenish_enabled: codexReplenishEnabled,
          codex_replenish_target_count: effectiveReplenishTargetCount,
          codex_replenish_threshold: effectiveReplenishThreshold,
          codex_replenish_use_proxy: codexReplenishUseProxy,
        },
      };

      const { data } = await configApi.post('/config/update', payload);
      if (data.ok) {
        setMessage({ type: 'success', text: biLabel('Settings updated successfully!', '设置已更新') });
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
        setMessage({ type: 'error', text: biLabel('Failed to update settings.', '设置更新失败') });
      }
    } catch (error: unknown) {
      const messageText = typeof error === 'object' && error !== null && 'message' in error
        ? String((error as { message?: string }).message || biLabel('Update failed', '更新失败'))
        : biLabel('Update failed', '更新失败');
      setMessage({ type: 'error', text: messageText });
    } finally {
      setSavingSettings(false);
    }
  };

  const handleRemotePushTest = async () => {
    setTestingRemote(true);
    setRemoteTestError('');
    setRemoteTestResult(null);

    try {
      const data = await runRemotePushTest({
        target_cpa_url: cpaUrl.trim() || undefined,
        target_management_key: newPassword.trim() || undefined,
      });
      if (data.ok && data.payload) {
        setRemoteTestResult(data.payload);
        return;
      }
      setRemoteTestError(data.error || biLabel('Remote push test failed.', '远程推送测试失败'));
    } catch (error: unknown) {
      const messageText = typeof error === 'object' && error !== null && 'response' in error
        ? String((((error as { response?: { data?: { error?: string } } }).response?.data?.error) || biLabel('Remote push test failed.', '远程推送测试失败')))
        : biLabel('Remote push test failed.', '远程推送测试失败');
      setRemoteTestError(messageText);
    } finally {
      setTestingRemote(false);
    }
  };

  const handleMailDomainTest = async (domain: string) => {
    const normalized = normalizeDomain(domain);
    if (!normalized) return;

    setDomainTestStates((prev) => ({
      ...prev,
      [normalized]: {
        status: 'testing',
        message: biLabel('Testing domain...', '正在测试域名...'),
        payload: null,
      },
    }));

    try {
      const data = await runMailDomainTest({
        domain: normalized,
        mail_api_base: mailApiBase.trim() || undefined,
        mail_username: mailUsername.trim() || undefined,
        mail_password: mailPassword || undefined,
      });

      const payload = data.payload ?? null;
      if (data.ok && payload) {
        setDomainTestStates((prev) => ({
          ...prev,
          [normalized]: {
            status: 'success',
            message: payload.message || biLabel('Domain test passed.', '域名测试通过'),
            payload,
          },
        }));
        return;
      }

      setDomainTestStates((prev) => ({
        ...prev,
        [normalized]: {
          status: 'error',
          message: data.error || payload?.error || biLabel('Domain test failed.', '域名测试失败'),
          payload,
        },
      }));
    } catch (error: unknown) {
      const messageText = typeof error === 'object' && error !== null && 'response' in error
        ? String((((error as { response?: { data?: { error?: string } } }).response?.data?.error) || biLabel('Domain test failed.', '域名测试失败')))
        : biLabel('Domain test failed.', '域名测试失败');
      setDomainTestStates((prev) => ({
        ...prev,
        [normalized]: {
          status: 'error',
          message: messageText,
          payload: null,
        },
      }));
    }
  };

  return (
    <div className="rounded-2xl border border-border bg-card/95 p-6 shadow-sm">
      <h2 className="mb-6 flex items-center gap-2 text-xl font-semibold"><Settings className="h-5 w-5" /> {biLabel('Service Configuration', '系统配置')}</h2>

      <div className="max-w-3xl space-y-6">
        <div className="grid gap-6 md:grid-cols-2">
          <div className="space-y-4 rounded-xl border border-border/60 bg-background/40 p-4">
            <div className="space-y-1">
              <h3 className="text-base font-semibold">{biLabel('CPA Console', 'CPA 控制台')}</h3>
              <p className="text-xs text-muted-foreground">{biLabel('Local console auth and remote CPA target.', '本地控制台认证与远程 CPA 目标配置。')}</p>
            </div>
            <div className="grid gap-2">
              <label className="text-sm font-medium leading-none">{biLabel('CPA API URL', 'CPA 接口地址')}</label>
              <input
                type="url"
                value={cpaUrl}
                onChange={(e) => setCpaUrl(e.target.value)}
                className="flex h-10 w-full rounded-md border border-input bg-background/50 px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                placeholder="http://127.0.0.1:8080"
              />
            </div>
            <div className="grid gap-2">
              <label className="text-sm font-medium leading-none">{biLabel('New Management Key', '新的管理密钥')}</label>
              <input
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                className="flex h-10 w-full rounded-md border border-input bg-background/50 px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                placeholder={biLabel('Leave blank to keep current', '留空则保持当前值')}
              />
            </div>
          </div>

          <div className="space-y-4 rounded-xl border border-border/60 bg-background/40 p-4">
            <div className="space-y-1">
              <h3 className="text-base font-semibold">{biLabel('Mail Service', '邮件服务')}</h3>
              <p className="text-xs text-muted-foreground">{biLabel('Registration mailbox backend and selected default domain.', '注册邮箱后端与默认域名配置。')}</p>
            </div>
            <div className="grid gap-2">
              <label className="text-sm font-medium leading-none">{biLabel('Mail API Base', '邮件 API 地址')}</label>
              <input
                type="url"
                value={mailApiBase}
                onChange={(e) => setMailApiBase(e.target.value)}
                className="flex h-10 w-full rounded-md border border-input bg-background/50 px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                placeholder="https://mail-api.example.com"
              />
            </div>
            <div className="grid gap-2">
              <label className="text-sm font-medium leading-none">{biLabel('Mail Username', '邮件用户名')}</label>
              <input
                type="text"
                value={mailUsername}
                onChange={(e) => setMailUsername(e.target.value)}
                className="flex h-10 w-full rounded-md border border-input bg-background/50 px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                placeholder="admin"
              />
            </div>
            <div className="grid gap-2">
              <label className="text-sm font-medium leading-none">{biLabel('Mail Password', '邮件密码')}</label>
              <input
                type="password"
                value={mailPassword}
                onChange={(e) => setMailPassword(e.target.value)}
                className="flex h-10 w-full rounded-md border border-input bg-background/50 px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                placeholder="mail service password"
              />
            </div>
          </div>
        </div>

        <div className="space-y-4 rounded-xl border border-border/60 bg-background/40 p-4">
          <div className="space-y-1">
            <h3 className="text-base font-semibold">{biLabel('Mail Domains', '邮件域名')}</h3>
            <p className="text-xs text-muted-foreground">{biLabel('Add domains here, test them against the current mail service, then choose the default domain used for registration.', '在这里添加域名，使用当前邮件服务进行测试，然后选择注册使用的默认域名。')}</p>
          </div>
          <div className="flex flex-col gap-3 md:flex-row md:items-start">
            <div className="grid flex-1 gap-2">
              <label className="text-sm font-medium leading-none">{biLabel('Add Email Domain', '添加邮箱域名')}</label>
              <input
                type="text"
                value={domainDraft}
                onChange={(e) => setDomainDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    handleAddDomain();
                  }
                }}
                className="flex h-10 w-full rounded-md border border-input bg-background/50 px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                placeholder="example.com"
              />
              <p className="text-[11px] italic text-muted-foreground">{biLabel('Domains are saved back into ', '域名会保存回 ')}<code>mail_email_domains</code>{biLabel(' in config.yaml.', ' 配置项。')}</p>
            </div>
            <button
              type="button"
              onClick={handleAddDomain}
              className="inline-flex h-10 min-w-28 items-center justify-center rounded-md border border-border bg-background px-4 py-2 text-sm font-medium transition-colors hover:bg-muted"
            >
              {biLabel('Add Domain', '添加域名')}
            </button>
          </div>
          {domainEditorError && (
            <div className="rounded-md border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
              {domainEditorError}
            </div>
          )}
          <div className="grid gap-3">
            <label className="text-sm font-medium leading-none">{biLabel('Configured Domains', '已配置域名')}</label>
            {emailDomainOptions.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border/70 bg-muted/20 px-4 py-5 text-sm text-muted-foreground">
                {biLabel('No configured domains yet. Add one above, then run a domain test before saving.', '当前还没有配置域名。请先添加，再在保存前执行一次域名测试。')}
              </div>
            ) : (
              <div className="space-y-3">
                {emailDomainOptions.map((domain) => {
                  const testState = domainTestStates[domain];
                  const isTesting = testState?.status === 'testing';
                  return (
                    <div key={domain} className="rounded-lg border border-border/70 bg-card/60 px-4 py-3">
                      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                        <div className="space-y-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-medium">{domain}</span>
                            {domain === normalizeDomain(mailEmailDomain) && (
                              <span className="rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">
                                {biLabel('Default', '默认')}
                              </span>
                            )}
                          </div>
                          {testState?.message && (
                            <p className={`text-xs ${testState.status === 'error' ? 'text-destructive' : 'text-muted-foreground'}`}>
                              {testState.message}
                            </p>
                          )}
                          {testState?.payload?.mailbox && (
                            <p className="break-all text-[11px] text-muted-foreground">
                              {biLabel('mailbox', '测试邮箱')}: {testState.payload.mailbox}
                            </p>
                          )}
                        </div>
                        <div className="flex flex-wrap gap-2">
                          <button
                            type="button"
                            onClick={() => setMailEmailDomain(domain)}
                            className="inline-flex h-9 items-center justify-center rounded-md border border-border bg-background px-3 text-sm font-medium transition-colors hover:bg-muted"
                          >
                            {biLabel('Use as Default', '设为默认')}
                          </button>
                          <button
                            type="button"
                            onClick={() => handleMailDomainTest(domain)}
                            disabled={isTesting}
                            className="inline-flex h-9 items-center justify-center rounded-md border border-border bg-background px-3 text-sm font-medium transition-colors hover:bg-muted disabled:opacity-50"
                          >
                            {isTesting ? biLabel('Testing...', '测试中...') : biLabel('Test Domain', '测试域名')}
                          </button>
                          <button
                            type="button"
                            onClick={() => handleRemoveDomain(domain)}
                            className="inline-flex h-9 items-center justify-center rounded-md border border-destructive/40 bg-destructive/5 px-3 text-sm font-medium text-destructive transition-colors hover:bg-destructive/10"
                          >
                            {biLabel('Remove', '移除')}
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          <div className="grid gap-2">
            <label className="text-sm font-medium leading-none">{biLabel('Mail Email Domain', '默认邮箱域名')}</label>
            <select
              value={mailEmailDomain}
              onChange={(e) => setMailEmailDomain(e.target.value)}
              className="flex h-10 w-full rounded-md border border-input bg-background/50 px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
              disabled={emailDomainOptions.length === 0}
            >
              <option value="">
                {emailDomainOptions.length > 0 ? biLabel('Select configured domain', '选择已配置域名') : biLabel('No configured domains', '暂无已配置域名')}
              </option>
              {emailDomainOptions.map((domain) => (
                <option key={domain} value={domain}>
                  {domain}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="mt-6 space-y-4 border-t border-border pt-6">
          <div className="flex items-center justify-between">
            <h3 className="text-lg font-medium">{biLabel('Codex Account Replenishment', 'Codex 自动补货')}</h3>
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="codexReplenishEnabled"
                checked={codexReplenishEnabled}
                onChange={(e) => setCodexReplenishEnabled(e.target.checked)}
                className="h-4 w-4 rounded border-input bg-background/50 accent-primary"
              />
              <label htmlFor="codexReplenishEnabled" className="text-sm font-medium">{biLabel('Enabled', '启用')}</label>
            </div>
          </div>

          <div className="mb-4 space-y-2 rounded-lg border border-border/50 bg-muted/30 p-3 text-xs text-muted-foreground">
            <p className="font-medium text-foreground/80">{biLabel('Description:', '说明:')}</p>
            <p>{biLabel('When the number of active and healthy Codex accounts falls below the threshold, the system will automatically register new accounts until the count reaches the target.', '当健康且可用的 Codex 账号数量低于阈值时，系统会自动注册新账号，直到数量回到目标值。')}</p>
            <p>{biLabel('Healthy accounts are defined as those that are active, not banned, and not rate-limited (429).', '健康账号指处于启用状态、未被封禁、且未命中 429 限流的账号。')}</p>
          </div>

          {codexReplenishEnabled && (
            <div className="animate-in slide-in-from-top-2 space-y-4 duration-300 fade-in">
              <div className="grid gap-2">
                <label className="text-sm font-medium leading-none">{biLabel('Target Account Count', '目标账号总数')}</label>
                <input
                  type="number"
                  value={effectiveReplenishTargetCount}
                  onChange={(e) => {
                    const nextTargetCount = normalizeNonNegativeInteger(e.target.value, 0);
                    setCodexReplenishTargetCount(nextTargetCount);
                    setCodexReplenishThreshold((prev) => normalizeReplenishThreshold(prev, nextTargetCount, 0));
                  }}
                  className="flex h-10 w-full rounded-md border border-input bg-background/50 px-3 py-2 text-sm"
                  min="0"
                  step="1"
                />
                <p className="text-xs text-muted-foreground">
                  {biLabel('The runtime refills healthy Codex accounts back up to this count.', '触发补货后，runtime 会把健康 Codex 账号数量补回到这个目标值。')}
                </p>
              </div>
              <div className="grid gap-2">
                <label className="text-sm font-medium leading-none">{biLabel('Replenish Threshold', '补货触发阈值')}</label>
                <input
                  type="number"
                  value={effectiveReplenishThreshold}
                  onChange={(e) => setCodexReplenishThreshold(normalizeReplenishThreshold(e.target.value, effectiveReplenishTargetCount, 0))}
                  className="flex h-10 w-full rounded-md border border-input bg-background/50 px-3 py-2 text-sm"
                  min="0"
                  max={String(effectiveReplenishTargetCount)}
                  step="1"
                />
                <p className="text-xs text-muted-foreground">
                  {biLabel('Replenishment starts when healthy Codex accounts drop below this value.', '当健康 Codex 账号数量低于这个值时，自动补货会启动。')}
                </p>
              </div>
              <div className="rounded-lg border border-border/60 bg-background/40 p-4 text-sm">
                <p className="font-medium">{biLabel('Current effective rule', '当前生效规则')}</p>
                <p className="mt-1 text-muted-foreground">
                  {effectiveReplenishTargetCount > 0
                    ? biLabel(
                        `Trigger when healthy Codex accounts < ${effectiveReplenishThreshold}, then refill back to ${effectiveReplenishTargetCount}.`,
                        `当健康 Codex 账号数 < ${effectiveReplenishThreshold} 时触发补货，并补回到 ${effectiveReplenishTargetCount} 个。`,
                      )
                    : biLabel(
                        'Target count is 0, so replenishment will not add new accounts until you raise the target.',
                        '当前目标数量为 0，在你把目标调高之前，自动补货不会新增账号。',
                      )}
                </p>
              </div>
              <div className="flex items-center gap-3 py-1">
                <input
                  type="checkbox"
                  id="codexReplenishUseProxy"
                  checked={codexReplenishUseProxy}
                  onChange={(e) => setCodexReplenishUseProxy(e.target.checked)}
                  className="h-4 w-4 rounded border-input bg-background/50 accent-primary"
                />
                <label htmlFor="codexReplenishUseProxy" className="text-sm font-medium">{biLabel('Use Proxy for Registration', '注册时使用代理')}</label>
              </div>
              <div className="rounded-lg border border-border/60 bg-muted/20 p-3 text-xs text-muted-foreground">
                {biLabel('Replenishment will randomly choose from the configured domain list above.', '补货注册会从上面配置的域名列表中随机选择。')}
              </div>
            </div>
          )}
        </div>

        <div className="mt-6 space-y-4 border-t border-border pt-6">
          <div className="space-y-2">
            <h3 className="text-lg font-medium">{biLabel('Remote Push Test', '远程推送测试')}</h3>
            <p className="text-xs text-muted-foreground">
              {biLabel('Test current remote CPA target with a real smoke flow: read auth-files, upload a temporary file, then delete it immediately.', '使用真实 smoke 流程测试当前远程 CPA 目标：读取 auth-files，上传临时文件，然后立即删除。')}
            </p>
          </div>
          <div className="space-y-2 rounded-lg border border-border/60 bg-muted/20 p-4 text-sm">
            <p><span className="font-medium">{biLabel('Target', '目标')}:</span> {cpaUrl.trim() || biLabel('Not set', '未设置')}</p>
            <p><span className="font-medium">{biLabel('Key source', '密钥来源')}:</span> {newPassword.trim() ? biLabel('unsaved new management key', '未保存的新管理密钥') : biLabel('current local console key', '当前本地控制台密钥')}</p>
          </div>
          <button
            onClick={handleRemotePushTest}
            disabled={testingRemote || !cpaUrl.trim()}
            className="inline-flex h-10 items-center justify-center rounded-md border border-border bg-background px-4 py-2 text-sm font-medium transition-colors hover:bg-muted disabled:opacity-50"
          >
            {testingRemote ? biLabel('Testing Remote Push...', '正在测试远程推送...') : biLabel('Test Remote Read + Push', '测试远程读取与推送')}
          </button>
          {remoteTestError && (
            <div className="rounded-md border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
              {remoteTestError}
            </div>
          )}
          {remoteTestResult && (
            <div className="space-y-2 rounded-md border border-border bg-background/70 px-4 py-3 text-sm">
              <p><span className="font-medium">{biLabel('Remote target', '远程目标')}:</span> {remoteTestResult.target_cpa_url}</p>
              <p><span className="font-medium">{biLabel('Read auth-files', '读取 auth-files')}:</span> {remoteTestResult.read_ok ? `${biLabel('OK', '成功')} (${remoteTestResult.auth_files_total} ${biLabel('files', '个文件')})` : biLabel('Failed', '失败')}</p>
              <p><span className="font-medium">{biLabel('Upload', '上传')}:</span> {remoteTestResult.push_test.upload_ok ? `${biLabel('OK via', '成功，方式')} ${remoteTestResult.push_test.upload_mode}` : biLabel('Failed', '失败')}</p>
              <p><span className="font-medium">{biLabel('Cleanup delete', '清理删除')}:</span> {remoteTestResult.push_test.cleanup_ok ? biLabel('OK', '成功') : biLabel('Not completed', '未完成')}</p>
              {(remoteTestResult.push_test.upload_status !== null || remoteTestResult.push_test.cleanup_status !== null) && (
                <p className="text-xs text-muted-foreground">
                  upload_status={String(remoteTestResult.push_test.upload_status)} cleanup_status={String(remoteTestResult.push_test.cleanup_status)}
                </p>
              )}
              {remoteTestResult.push_test.error && (
                <pre className="whitespace-pre-wrap break-words rounded-md border border-border/60 bg-muted/30 p-3 text-xs text-muted-foreground">
                  {remoteTestResult.push_test.error}
                </pre>
              )}
            </div>
          )}
        </div>

        {message.text && (
          <div className={`rounded-md border px-4 py-3 text-sm ${message.type === 'success' ? 'border-primary/50 bg-primary/10 text-primary' : 'border-destructive/50 bg-destructive/10 text-destructive'}`}>
            {message.text}
          </div>
        )}

        <button
          onClick={handleSave}
          disabled={savingSettings}
          className="inline-flex h-10 items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
        >
          {savingSettings ? biLabel('Saving...', '保存中...') : biLabel('Save Configuration', '保存配置')}
        </button>
      </div>
    </div>
  );
}
