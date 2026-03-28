import { Settings } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';
import {
  cpaApi,
  configApi,
  fetchRuntimeStatus,
  runMailDomainTest,
  runRemotePushTest,
  startReplenishment,
  stopReplenishment,
  type MailDomainTestPayload,
  type ReplenishmentBatchStatus,
  type RemotePushTestPayload,
  type RuntimeStatusPayload,
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
  mailRandomizeFromList: boolean;
  setMailRandomizeFromList: Dispatch<SetStateAction<boolean>>;
  codexReplenishEnabled: boolean;
  setCodexReplenishEnabled: Dispatch<SetStateAction<boolean>>;
  codexReplenishTargetCount: number;
  setCodexReplenishTargetCount: Dispatch<SetStateAction<number>>;
  codexReplenishThreshold: number;
  setCodexReplenishThreshold: Dispatch<SetStateAction<number>>;
  codexReplenishBatchSize: number;
  setCodexReplenishBatchSize: Dispatch<SetStateAction<number>>;
  codexReplenishWorkerCount: number;
  setCodexReplenishWorkerCount: Dispatch<SetStateAction<number>>;
  codexReplenishUseProxy: boolean;
  setCodexReplenishUseProxy: Dispatch<SetStateAction<boolean>>;
  codexReplenishProxyPool: string;
  setCodexReplenishProxyPool: Dispatch<SetStateAction<string>>;
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
      .replace(/\r/g, '\n')
      .split(/[\n,]+/)
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

function normalizeReplenishBatchSize(value: unknown, fallback = 1): number {
  return Math.max(1, Math.min(200, normalizeNonNegativeInteger(value, fallback)));
}

function normalizeReplenishWorkerCount(value: unknown, fallback = 1): number {
  return Math.max(1, Math.min(200, normalizeNonNegativeInteger(value, fallback)));
}

function getReplenishmentResultLabel(
  status: RuntimeStatusPayload['replenishment'] | null,
  text: (en: string, zh: string) => string,
): string {
  if (!status) return text('No status', '暂无状态');
  if (status.in_progress) return text('Registration running', '注册运行中');
  if (!status.enabled) return text('Disabled', '已禁用');

  const summary = String(status.last_summary || '').toLowerCase();
  if (summary.includes('disabled')) return text('Disabled', '已禁用');
  if (summary.includes('target count is 0')) return text('Target count is 0', '目标数量为 0');
  if (summary.includes('no replenishment needed')) return text('No replenishment needed', '当前无需补货');
  if (summary.includes('succeeded') || Number(status.last_uploaded || 0) > 0) {
    return text('Registration succeeded', '注册成功');
  }
  if (summary.includes('failed') || !!String(status.last_error || '').trim() || Number(status.last_failed || 0) > 0) {
    return text('Registration failed', '注册失败');
  }
  return text('Idle', '空闲');
}

function StatusCard({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-md border border-border/60 bg-card/60 px-3 py-2">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div>{value}</div>
    </div>
  );
}

function formatBatchTime(value: number | null, text: (en: string, zh: string) => string): string {
  if (!value) return text('Unknown', '未知');
  try {
    return new Intl.DateTimeFormat(undefined, {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(value));
  } catch {
    return text('Unknown', '未知');
  }
}

function getEmailSelectionModeLabel(mode: string, text: (en: string, zh: string) => string): string {
  switch (String(mode || '').trim().toLowerCase()) {
    case 'per_account_random_from_list':
      return text('Per-account random', '每账号随机');
    case 'random_from_list':
      return text('Random from list', '从列表随机');
    case 'default':
      return text('Default domain', '默认域名');
    case 'first_available':
      return text('First available', '首个可用域名');
    default:
      return text('Unknown', '未知');
  }
}

function getBatchBadgeClass(status: string): string {
  switch (String(status || '').trim().toLowerCase()) {
    case 'succeeded':
      return 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400';
    case 'partial':
      return 'bg-amber-500/15 text-amber-700 dark:text-amber-400';
    case 'failed':
      return 'bg-destructive/10 text-destructive';
    case 'uploading':
    case 'registering':
      return 'bg-sky-500/15 text-sky-700 dark:text-sky-400';
    default:
      return 'bg-muted text-muted-foreground';
  }
}

function getAccountStatusLabel(status: string, text: (en: string, zh: string) => string): string {
  switch (String(status || '').trim().toLowerCase()) {
    case 'registering':
      return text('Registering', '注册中');
    case 'retrying':
      return text('Retrying', '重试中');
    case 'registered':
      return text('Registered', '已注册');
    case 'codex_failed':
      return text('Codex failed', 'Codex 失败');
    case 'register_failed':
      return text('Register failed', '注册失败');
    case 'upload_failed':
      return text('Upload failed', '上传失败');
    case 'completed':
      return text('Completed', '已完成');
    default:
      return text('Unknown', '未知');
  }
}

function buildSimpleReplenishmentLogLines(
  status: RuntimeStatusPayload['replenishment'] | null,
  text: (en: string, zh: string) => string,
): string[] {
  if (!status) return [];

  const lines: string[] = [];
  const pushLine = (value: string) => {
    const normalized = String(value || '').trim();
    if (!normalized) return;
    if (lines[lines.length - 1] === normalized) return;
    lines.push(normalized);
  };

  if (status.in_progress) {
    pushLine(text('Registration running.', '注册运行中。'));
  }

  if (status.current_batch?.events?.length) {
    status.current_batch.events.forEach(pushLine);
  }
  if (status.recent_events?.length) {
    status.recent_events.forEach(pushLine);
  }

  if (!lines.length && status.log_tail?.length) {
    status.log_tail
      .filter((line) => {
        const normalized = String(line || '').trim();
        return normalized.startsWith('[OK]')
          || normalized.startsWith('[FAIL')
          || normalized.includes('Started replenish job')
          || normalized.includes('Using external proxy pool')
          || normalized.includes('Uploaded ')
          || normalized.includes('No token files')
          || normalized.includes('Batch ')
          || normalized.includes('[OTP]');
      })
      .forEach(pushLine);
  }

  if (status.last_summary) {
    pushLine(`${text('Summary', '摘要')}: ${status.last_summary}`);
  }
  if (status.last_error) {
    pushLine(`${text('Error', '错误')}: ${status.last_error}`);
  }

  return lines.slice(-18);
}

function SimpleReplenishmentLogCard({
  lines,
  text,
}: {
  lines: string[];
  text: (en: string, zh: string) => string;
}) {
  return (
    <div className="rounded-md border border-border/60 bg-card/60 px-3 py-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="text-xs font-medium text-muted-foreground">{text('Live Log', '实时日志')}</div>
        <div className="text-[11px] text-muted-foreground">{text(`${lines.length} lines`, `${lines.length} 行`)}</div>
      </div>
      {lines.length === 0 ? (
        <div className="text-xs text-muted-foreground">{text('No replenishment logs yet.', '暂无补货日志。')}</div>
      ) : (
        <div className="max-h-64 space-y-1 overflow-auto rounded-md border border-border/50 bg-background/50 px-3 py-2">
          {lines.map((line, index) => (
            <div key={`simple-log-${index}`} className="font-mono text-xs text-muted-foreground">
              {line}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ReplenishmentAccountsCard({
  accounts,
  text,
}: {
  accounts: ReplenishmentBatchStatus['accounts'];
  text: (en: string, zh: string) => string;
}) {
  return (
    <div className="rounded-lg border border-border/70 bg-card/70 p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="text-sm font-medium">{text('Account Details', '账号明细')}</div>
        <div className="text-[11px] text-muted-foreground">
          {text(`${accounts.length} items`, `${accounts.length} 条`)}
        </div>
      </div>
      <div className="space-y-2 rounded-md border border-border/60 bg-background/40 px-3 py-3">
        {accounts.length === 0 ? (
          <div className="text-xs text-muted-foreground">{text('No account details yet.', '暂无账号明细。')}</div>
        ) : (
          accounts
            .slice()
            .map((account, index) => (
              <div key={`account-${account.updated_at ?? index}-${account.idx ?? index}-${account.email || index}`} className="rounded-md border border-border/60 bg-card/60 px-3 py-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="font-mono text-xs">{account.email || text('Pending email', '待生成邮箱')}</div>
                  <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${getBatchBadgeClass(account.status)}`}>
                    {getAccountStatusLabel(account.status, text)}
                  </span>
                </div>
                <div className="mt-2 flex flex-wrap gap-3 text-[11px] text-muted-foreground">
                  <span>#{account.idx ?? '-'}/{account.total ?? '-'}</span>
                  {account.proxy && <span>Proxy: <code>{account.proxy}</code></span>}
                  <span>{text('Register', '注册')}: {account.register_ok ? text('OK', '成功') : text('Pending', '未完成')}</span>
                  <span>Codex: {account.codex_ok ? text('OK', '成功') : text('Pending/Fail', '未完成/失败')}</span>
                  <span>{text('Upload', '上传')}: {account.upload_ok ? text('OK', '成功') : text('Pending/Fail', '未完成/失败')}</span>
                </div>
                {account.error && <div className="mt-2 text-[11px] text-destructive">{account.error}</div>}
              </div>
            ))
        )}
      </div>
    </div>
  );
}

export default function SettingsPanelV3(props: SettingsPanelProps) {
  const {
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
    mailRandomizeFromList,
    setMailRandomizeFromList,
    codexReplenishEnabled,
    setCodexReplenishEnabled,
    codexReplenishTargetCount,
    setCodexReplenishTargetCount,
    codexReplenishThreshold,
    setCodexReplenishThreshold,
    codexReplenishBatchSize,
    setCodexReplenishBatchSize,
    codexReplenishWorkerCount,
    setCodexReplenishWorkerCount,
    codexReplenishUseProxy,
    setCodexReplenishUseProxy,
    codexReplenishProxyPool,
    savingSettings,
    setSavingSettings,
    message,
    setMessage,
  } = props;

  const { i18n } = useTranslation();
  const isZh = i18n.language.startsWith('zh');
  const text = (en: string, zh: string) => (isZh ? zh : en);

  const [testingRemote, setTestingRemote] = useState(false);
  const [remoteTestResult, setRemoteTestResult] = useState<RemotePushTestPayload | null>(null);
  const [remoteTestError, setRemoteTestError] = useState('');
  const [domainDraft, setDomainDraft] = useState('');
  const [domainEditorError, setDomainEditorError] = useState('');
  const [domainTestStates, setDomainTestStates] = useState<Record<string, DomainTestState>>({});
  const [runtimeStatus, setRuntimeStatus] = useState<RuntimeStatusPayload | null>(null);
  const [runtimeStatusLoading, setRuntimeStatusLoading] = useState(false);
  const [runtimeStatusError, setRuntimeStatusError] = useState('');
  const [startingReplenishment, setStartingReplenishment] = useState(false);
  const [stoppingReplenishment, setStoppingReplenishment] = useState(false);

  const emailDomainOptions = useMemo(() => {
    const parsed = parseDomainList(mailEmailDomains);
    const current = normalizeDomain(mailEmailDomain);
    if (current && !parsed.includes(current)) parsed.unshift(current);
    return parsed;
  }, [mailEmailDomain, mailEmailDomains]);

  const effectiveTargetCount = normalizeNonNegativeInteger(codexReplenishTargetCount, 0);
  const effectiveThreshold = normalizeReplenishThreshold(codexReplenishThreshold, effectiveTargetCount, 0);
  const effectiveBatchSize = normalizeReplenishBatchSize(codexReplenishBatchSize, 1);
  const effectiveWorkerCount = normalizeReplenishWorkerCount(codexReplenishWorkerCount, 1);
  const replenishmentStatus = runtimeStatus?.replenishment ?? null;
  const replenishmentResultLabel = getReplenishmentResultLabel(replenishmentStatus, text);
  const simpleReplenishmentLogs = useMemo(
    () => buildSimpleReplenishmentLogLines(replenishmentStatus, text),
    [replenishmentStatus, text],
  );
  const replenishmentAccounts = useMemo(() => {
    const batches = [
      replenishmentStatus?.current_batch ?? null,
      ...(replenishmentStatus?.batch_history ?? []).slice().reverse(),
    ].filter(Boolean) as ReplenishmentBatchStatus[];

    return batches
      .flatMap((batch) => batch.accounts || [])
      .slice()
      .sort((a, b) => Number(b.updated_at || 0) - Number(a.updated_at || 0))
      .slice(0, 20);
  }, [replenishmentStatus]);

  const loadRuntimeStatus = async (silent = false) => {
    if (!silent) setRuntimeStatusLoading(true);
    try {
      const data = await fetchRuntimeStatus();
      if (data.ok && data.payload) {
        setRuntimeStatus(data.payload);
        setRuntimeStatusError('');
      } else {
        setRuntimeStatusError(data.error || text('Failed to load runtime status.', '加载 runtime 状态失败。'));
      }
    } catch (error: unknown) {
      const messageText = typeof error === 'object' && error !== null && 'response' in error
        ? String(((error as { response?: { data?: { error?: string } } }).response?.data?.error) || text('Failed to load runtime status.', '加载 runtime 状态失败。'))
        : text('Failed to load runtime status.', '加载 runtime 状态失败。');
      setRuntimeStatusError(messageText);
    } finally {
      if (!silent) setRuntimeStatusLoading(false);
    }
  };

  useEffect(() => {
    void loadRuntimeStatus(false);
    const timer = window.setInterval(() => { void loadRuntimeStatus(true); }, replenishmentStatus?.in_progress ? 2500 : 15000);
    return () => window.clearInterval(timer);
  }, [replenishmentStatus?.in_progress]);
  const commitDomains = (domains: string[]) => {
    const nextDomains = parseDomainList(stringifyDomainList(domains));
    setMailEmailDomains(stringifyDomainList(nextDomains));
    if (mailEmailDomain && !nextDomains.includes(normalizeDomain(mailEmailDomain))) {
      setMailEmailDomain(nextDomains[0] || '');
    }
    setDomainTestStates((prev) => {
      const next: Record<string, DomainTestState> = {};
      nextDomains.forEach((domain) => {
        if (prev[domain]) next[domain] = prev[domain];
      });
      return next;
    });
  };

  const handleAddDomain = () => {
    const normalized = normalizeDomain(domainDraft);
    if (!normalized) {
      setDomainEditorError(text('Please enter a domain first.', '请先输入域名。'));
      return;
    }
    if (!DOMAIN_PATTERN.test(normalized)) {
      setDomainEditorError(text(`Invalid domain: ${normalized}`, `域名格式无效: ${normalized}`));
      return;
    }
    if (emailDomainOptions.includes(normalized)) {
      setDomainEditorError(text(`Domain already exists: ${normalized}`, `域名已存在: ${normalized}`));
      return;
    }
    commitDomains([...emailDomainOptions, normalized]);
    if (!mailEmailDomain.trim()) setMailEmailDomain(normalized);
    setDomainDraft('');
    setDomainEditorError('');
  };

  const handleRemoveDomain = (domain: string) => {
    commitDomains(emailDomainOptions.filter((item) => item !== domain));
    setDomainEditorError('');
  };

  const handleMailDomainTest = async (domain: string) => {
    const normalized = normalizeDomain(domain);
    if (!normalized) return;
    setDomainTestStates((prev) => ({ ...prev, [normalized]: { status: 'testing', message: text('Testing domain...', '正在测试域名...'), payload: null } }));
    try {
      const data = await runMailDomainTest({
        domain: normalized,
        mail_api_base: mailApiBase.trim() || undefined,
        mail_username: mailUsername.trim() || undefined,
        mail_password: mailPassword || undefined,
      });
      const payload = data.payload ?? null;
      if (data.ok && payload) {
        setDomainTestStates((prev) => ({ ...prev, [normalized]: { status: 'success', message: payload.message || text('Domain test passed.', '域名测试通过。'), payload } }));
        return;
      }
      setDomainTestStates((prev) => ({ ...prev, [normalized]: { status: 'error', message: data.error || payload?.error || text('Domain test failed.', '域名测试失败。'), payload } }));
    } catch (error: unknown) {
      const messageText = typeof error === 'object' && error !== null && 'response' in error
        ? String(((error as { response?: { data?: { error?: string } } }).response?.data?.error) || text('Domain test failed.', '域名测试失败。'))
        : text('Domain test failed.', '域名测试失败。');
      setDomainTestStates((prev) => ({ ...prev, [normalized]: { status: 'error', message: messageText, payload: null } }));
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

  const handleStopReplenishment = async () => {
    setStoppingReplenishment(true);
    setMessage({ type: '', text: '' });
    try {
      const data = await stopReplenishment();
      if (data.ok && data.payload) {
        setMessage({ type: data.payload.stopped ? 'success' : 'error', text: data.payload.message || text('Replenishment stop request completed.', '停止补货请求已完成。') });
      } else {
        setMessage({ type: 'error', text: data.error || text('Failed to stop replenishment.', '停止补货失败。') });
      }
    } catch (error: unknown) {
      const messageText = typeof error === 'object' && error !== null && 'response' in error
        ? String(((error as { response?: { data?: { error?: string } } }).response?.data?.error) || text('Failed to stop replenishment.', '停止补货失败。'))
        : text('Failed to stop replenishment.', '停止补货失败。');
      setMessage({ type: 'error', text: messageText });
    } finally {
      setStoppingReplenishment(false);
      void loadRuntimeStatus(false);
    }
  };

  const handleStartReplenishment = async () => {
    setStartingReplenishment(true);
    setMessage({ type: '', text: '' });
    try {
      const data = await startReplenishment();
      if (data.ok && data.payload) {
        setMessage({ type: 'success', text: data.payload.message || text('Manual replenishment request completed.', '手动补货请求已完成。') });
      } else {
        setMessage({ type: 'error', text: data.error || text('Failed to start replenishment.', '启动补货失败。') });
      }
    } catch (error: unknown) {
      const messageText = typeof error === 'object' && error !== null && 'response' in error
        ? String(((error as { response?: { data?: { error?: string } } }).response?.data?.error) || text('Failed to start replenishment.', '启动补货失败。'))
        : text('Failed to start replenishment.', '启动补货失败。');
      setMessage({ type: 'error', text: messageText });
    } finally {
      setStartingReplenishment(false);
      void loadRuntimeStatus(false);
    }
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
          mail_randomize_from_list: mailRandomizeFromList,
          codex_replenish_enabled: codexReplenishEnabled,
          codex_replenish_target_count: effectiveTargetCount,
          codex_replenish_threshold: effectiveThreshold,
          codex_replenish_batch_size: effectiveBatchSize,
          codex_replenish_worker_count: effectiveWorkerCount,
          codex_replenish_use_proxy: codexReplenishUseProxy,
          codex_replenish_proxy_pool: codexReplenishProxyPool,
        },
      };
      const { data } = await configApi.post('/config/update', payload);
      if (!data.ok) {
        setMessage({ type: 'error', text: text('Failed to update settings.', '设置更新失败。') });
        return;
      }
      setMessage({ type: 'success', text: text('Settings updated successfully.', '设置已更新。') });
      const resolvedUrl = cpaUrl.trim();
      if (resolvedUrl) {
        cpaApi.defaults.baseURL = resolvedUrl;
        setCpaUrl(resolvedUrl);
      }
      if (newPassword) {
        localStorage.setItem('management_key', newPassword);
        setNewPassword('');
      }
    } catch (error: unknown) {
      const messageText = typeof error === 'object' && error !== null && 'message' in error
        ? String((error as { message?: string }).message || text('Update failed.', '更新失败。'))
        : text('Update failed.', '更新失败。');
      setMessage({ type: 'error', text: messageText });
    } finally {
      setSavingSettings(false);
    }
  };
  return (
    <div className="rounded-2xl border border-border bg-card/95 p-6 shadow-sm">
      <h2 className="mb-6 flex items-center gap-2 text-xl font-semibold">
        <Settings className="h-5 w-5" />
        {text('Service Configuration', '服务配置')}
      </h2>

      <div className="max-w-4xl space-y-6">
        <div className="grid gap-6 md:grid-cols-2">
          <section className="space-y-4 rounded-xl border border-border/60 bg-background/40 p-4">
            <div className="space-y-1">
              <h3 className="text-base font-semibold">{text('CPA Console', 'CPA 控制台')}</h3>
              <p className="text-xs text-muted-foreground">{text('Local console authentication and remote CPA target.', '本地控制台认证和远程 CPA 目标配置。')}</p>
            </div>
            <div className="grid gap-2">
              <label className="text-sm font-medium">{text('CPA API URL', 'CPA API 地址')}</label>
              <input type="url" value={cpaUrl} onChange={(e) => setCpaUrl(e.target.value)} className="flex h-10 w-full rounded-md border border-input bg-background/50 px-3 py-2 text-sm" placeholder="http://127.0.0.1:8080" />
            </div>
            <div className="grid gap-2">
              <label className="text-sm font-medium">{text('New Management Key', '新的管理密钥')}</label>
              <input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} className="flex h-10 w-full rounded-md border border-input bg-background/50 px-3 py-2 text-sm" placeholder={text('Leave blank to keep current', '留空则保持当前')} />
            </div>
          </section>

          <section className="space-y-4 rounded-xl border border-border/60 bg-background/40 p-4">
            <div className="space-y-1">
              <h3 className="text-base font-semibold">{text('Mail Service', '邮箱服务')}</h3>
              <p className="text-xs text-muted-foreground">{text('Mailbox backend used during registration.', '注册流程使用的邮箱后端配置。')}</p>
            </div>
            <div className="grid gap-2">
              <label className="text-sm font-medium">{text('Mail API Base', '邮件 API 地址')}</label>
              <input type="url" value={mailApiBase} onChange={(e) => setMailApiBase(e.target.value)} className="flex h-10 w-full rounded-md border border-input bg-background/50 px-3 py-2 text-sm" placeholder="https://mail-api.example.com" />
            </div>
            <div className="grid gap-2">
              <label className="text-sm font-medium">{text('Mail Username', '邮箱用户名')}</label>
              <input type="text" value={mailUsername} onChange={(e) => setMailUsername(e.target.value)} className="flex h-10 w-full rounded-md border border-input bg-background/50 px-3 py-2 text-sm" placeholder="admin" />
            </div>
            <div className="grid gap-2">
              <label className="text-sm font-medium">{text('Mail Password', '邮箱密码')}</label>
              <input type="password" value={mailPassword} onChange={(e) => setMailPassword(e.target.value)} className="flex h-10 w-full rounded-md border border-input bg-background/50 px-3 py-2 text-sm" placeholder={text('Mail service password', '邮箱服务密码')} />
            </div>
          </section>
        </div>

        <section className="space-y-4 rounded-xl border border-border/60 bg-background/40 p-4">
          <div className="space-y-1">
            <h3 className="text-base font-semibold">{text('Mail Domains', '邮箱域名')}</h3>
            <p className="text-xs text-muted-foreground">{text('Maintain the allowed email domain list for registration.', '维护注册时可用的邮箱域名列表。')}</p>
          </div>
          <div className="flex flex-col gap-3 md:flex-row">
            <input type="text" value={domainDraft} onChange={(e) => setDomainDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleAddDomain(); } }} className="flex h-10 flex-1 rounded-md border border-input bg-background/50 px-3 py-2 text-sm" placeholder="example.com" />
            <button type="button" onClick={handleAddDomain} className="inline-flex h-10 items-center justify-center rounded-md border border-border bg-background px-4 py-2 text-sm font-medium hover:bg-muted">{text('Add Domain', '添加域名')}</button>
          </div>
          {domainEditorError && <div className="rounded-md border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">{domainEditorError}</div>}
          <div className="grid gap-3">
            {emailDomainOptions.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border/70 bg-muted/20 px-4 py-5 text-sm text-muted-foreground">{text('No configured domains yet.', '暂无已配置域名。')}</div>
            ) : emailDomainOptions.map((domain) => {
              const testState = domainTestStates[domain];
              const isTesting = testState?.status === 'testing';
              return (
                <div key={domain} className="rounded-lg border border-border/70 bg-card/60 px-4 py-3">
                  <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                    <div className="space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{domain}</span>
                        {domain === normalizeDomain(mailEmailDomain) && <span className="rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">{text('Default', '默认')}</span>}
                      </div>
                      {testState?.message && <p className={`text-xs ${testState.status === 'error' ? 'text-destructive' : 'text-muted-foreground'}`}>{testState.message}</p>}
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <button type="button" onClick={() => setMailEmailDomain(domain)} className="inline-flex h-9 items-center justify-center rounded-md border border-border bg-background px-3 text-sm font-medium hover:bg-muted">{text('Use as Default', '设为默认')}</button>
                      <button type="button" onClick={() => { void handleMailDomainTest(domain); }} disabled={isTesting} className="inline-flex h-9 items-center justify-center rounded-md border border-border bg-background px-3 text-sm font-medium hover:bg-muted disabled:opacity-50">{isTesting ? text('Testing...', '测试中...') : text('Test Domain', '测试域名')}</button>
                      <button type="button" onClick={() => handleRemoveDomain(domain)} className="inline-flex h-9 items-center justify-center rounded-md border border-destructive/40 bg-destructive/5 px-3 text-sm font-medium text-destructive hover:bg-destructive/10">{text('Remove', '移除')}</button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
          <div className="grid gap-2">
            <label className="text-sm font-medium">{text('Default Mail Domain', '默认邮箱域名')}</label>
            <select value={mailEmailDomain} onChange={(e) => setMailEmailDomain(e.target.value)} className="flex h-10 w-full rounded-md border border-input bg-background/50 px-3 py-2 text-sm" disabled={emailDomainOptions.length === 0}>
              <option value="">{text('Select configured domain', '选择已配置域名')}</option>
              {emailDomainOptions.map((domain) => <option key={domain} value={domain}>{domain}</option>)}
            </select>
          </div>
          <label className="flex items-center gap-2 text-sm font-medium">
            <input type="checkbox" checked={mailRandomizeFromList} onChange={(e) => setMailRandomizeFromList(e.target.checked)} className="h-4 w-4 rounded border-input bg-background/50 accent-primary" />
            {text('Randomly pick from the domain list for replenishment', '补货时从域名列表随机选择')}
          </label>
          <p className="text-xs text-muted-foreground">
            {mailRandomizeFromList
              ? text('When enabled, each replenishment batch randomly selects one configured domain.', '启用后，每个补货批次会从已配置域名中随机选择一个。')
              : text('When disabled, replenishment uses the default mail domain above.', '关闭后，补货固定使用上面的默认邮箱域名。')}
          </p>
        </section>

        <section className="space-y-4 rounded-xl border border-border/60 bg-background/40 p-4">
          <div className="flex items-center justify-between">
            <div className="space-y-1">
              <h3 className="text-base font-semibold">{text('Codex Account Replenishment', 'Codex 自动补货')}</h3>
              <p className="text-xs text-muted-foreground">{text('These values are saved into config and used by the backend runtime.', '这些值会写入配置文件，并由后端 runtime 使用。')}</p>
            </div>
            <label className="flex items-center gap-2 text-sm font-medium">
              <input type="checkbox" checked={codexReplenishEnabled} onChange={(e) => setCodexReplenishEnabled(e.target.checked)} className="h-4 w-4 rounded border-input bg-background/50 accent-primary" />
              {text('Enabled', '启用')}
            </label>
          </div>

          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <div className="grid gap-2">
              <label className="text-sm font-medium">{text('Target Account Count', '目标账号总数')}</label>
              <input type="number" min="0" step="1" value={effectiveTargetCount} onChange={(e) => { const nextTarget = normalizeNonNegativeInteger(e.target.value, 0); setCodexReplenishTargetCount(nextTarget); setCodexReplenishThreshold((prev) => normalizeReplenishThreshold(prev, nextTarget, 0)); }} className="flex h-10 w-full rounded-md border border-input bg-background/50 px-3 py-2 text-sm" />
              <p className="text-xs text-muted-foreground"><code>codex_replenish_target_count</code></p>
            </div>
            <div className="grid gap-2">
              <label className="text-sm font-medium">{text('Replenish Threshold', '补货触发阈值')}</label>
              <input type="number" min="0" max={String(effectiveTargetCount)} step="1" value={effectiveThreshold} onChange={(e) => setCodexReplenishThreshold(normalizeReplenishThreshold(e.target.value, effectiveTargetCount, 0))} className="flex h-10 w-full rounded-md border border-input bg-background/50 px-3 py-2 text-sm" />
              <p className="text-xs text-muted-foreground"><code>codex_replenish_threshold</code></p>
            </div>
            <div className="grid gap-2">
              <label className="text-sm font-medium">{text('Batch Size', '批量大小')}</label>
              <input type="number" min="1" max="200" step="1" value={effectiveBatchSize} onChange={(e) => setCodexReplenishBatchSize(normalizeReplenishBatchSize(e.target.value, 1))} className="flex h-10 w-full rounded-md border border-input bg-background/50 px-3 py-2 text-sm" />
              <p className="text-xs text-muted-foreground"><code>codex_replenish_batch_size</code></p>
            </div>
            <div className="grid gap-2">
              <label className="text-sm font-medium">{text('Worker Count', '并发 Worker 数')}</label>
              <input type="number" min="1" max="200" step="1" value={effectiveWorkerCount} onChange={(e) => setCodexReplenishWorkerCount(normalizeReplenishWorkerCount(e.target.value, 1))} className="flex h-10 w-full rounded-md border border-input bg-background/50 px-3 py-2 text-sm" />
              <p className="text-xs text-muted-foreground"><code>codex_replenish_worker_count</code></p>
            </div>
          </div>

          <div className="rounded-lg border border-border/60 bg-background/40 p-4 text-sm text-muted-foreground">
            {effectiveTargetCount > 0 ? text(`Trigger replenishment when healthy Codex accounts < ${effectiveThreshold}, then refill back to ${effectiveTargetCount}. Each batch creates up to ${effectiveBatchSize} accounts with up to ${effectiveWorkerCount} concurrent workers.`, `当健康 Codex 账号数低于 ${effectiveThreshold} 时触发补货，并补回到 ${effectiveTargetCount} 个。每批最多注册 ${effectiveBatchSize} 个账号，并发 worker 最多 ${effectiveWorkerCount} 个。`) : text('Target count is 0, so replenishment will not create new accounts until you increase the target.', '当前目标数量为 0，在你把目标调高之前，自动补货不会新增账号。')}
          </div>

          <label className="flex items-center gap-2 text-sm font-medium">
            <input type="checkbox" checked={codexReplenishUseProxy} onChange={(e) => setCodexReplenishUseProxy(e.target.checked)} className="h-4 w-4 rounded border-input bg-background/50 accent-primary" />
            {text('Use Proxy for Registration', '注册时使用代理')}
          </label>

          <p className="text-xs text-muted-foreground">{text('External proxy pool remains in config. The settings page only shows the proxy switch now.', '外部代理池仍保留在配置文件中，设置界面现在只显示代理开关。')}</p>
          <div className="rounded-lg border border-border/60 bg-background/40 p-4">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
              <div className="space-y-1">
                <h4 className="text-sm font-semibold">{text('Runtime Status', 'Runtime 状态')}</h4>
                <p className="text-xs text-muted-foreground">{text('Simple live summary of the backend replenishment worker.', '后端补货 worker 的简化实时摘要。')}</p>
              </div>
              <div className="flex flex-wrap gap-2">
                <button type="button" onClick={() => { void handleStartReplenishment(); }} disabled={startingReplenishment || Boolean(replenishmentStatus?.in_progress)} className="inline-flex h-9 items-center justify-center rounded-md border border-primary/30 bg-primary/10 px-3 text-sm font-medium text-primary hover:bg-primary/15 disabled:opacity-50">{startingReplenishment ? text('Starting...', '启动中...') : text('Start Replenishment', '开始补货')}</button>
                <button type="button" onClick={() => { void handleStopReplenishment(); }} disabled={stoppingReplenishment || !replenishmentStatus?.in_progress} className="inline-flex h-9 items-center justify-center rounded-md border border-destructive/40 bg-destructive/5 px-3 text-sm font-medium text-destructive hover:bg-destructive/10 disabled:opacity-50">{stoppingReplenishment ? text('Stopping...', '停止中...') : text('Stop Replenishment', '停止补货')}</button>
                <button type="button" onClick={() => { void loadRuntimeStatus(false); }} disabled={runtimeStatusLoading} className="inline-flex h-9 items-center justify-center rounded-md border border-border bg-background px-3 text-sm font-medium hover:bg-muted disabled:opacity-50">{runtimeStatusLoading ? text('Refreshing...', '刷新中...') : text('Refresh Status', '刷新状态')}</button>
              </div>
            </div>

            {runtimeStatusError && <div className="mb-3 rounded-md border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">{runtimeStatusError}</div>}

            {!replenishmentStatus ? (
              <div className="rounded-md border border-dashed border-border/70 bg-muted/20 px-4 py-5 text-sm text-muted-foreground">{text('No runtime status available yet.', '暂无 runtime 状态。')}</div>
            ) : (
              <div className="space-y-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{text('Status', '状态')}:</span>
                  <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${replenishmentStatus.in_progress ? 'bg-amber-500/15 text-amber-700 dark:text-amber-400' : replenishmentStatus.enabled ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400' : 'bg-muted text-muted-foreground'}`}>
                    {replenishmentStatus.in_progress ? text('Running', '运行中') : replenishmentStatus.enabled ? text('Idle', '空闲') : text('Disabled', '已禁用')}
                  </span>
                  {replenishmentStatus.mode && <span className="text-muted-foreground">{text('Mode', '模式')}: {replenishmentStatus.mode}</span>}
                  {replenishmentStatus.process_pid && <span className="text-muted-foreground">PID: {replenishmentStatus.process_pid}</span>}
                </div>

                <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                  <StatusCard label={text('Last Result', '最近结果')} value={replenishmentResultLabel} />
                  <StatusCard label={text('Healthy', '已有数量')} value={replenishmentStatus.healthy_count ?? 0} />
                  <StatusCard label={text('Target', '目标数量')} value={replenishmentStatus.target_count ?? effectiveTargetCount} />
                  <StatusCard label={text('Missing', '缺失数量')} value={replenishmentStatus.needed ?? 0} />
                  <StatusCard label={text('Batch Size', '批量大小')} value={replenishmentStatus.batch_size ?? effectiveBatchSize} />
                  <StatusCard label={text('Worker Count', '并发数')} value={replenishmentStatus.worker_count ?? effectiveWorkerCount} />
                  <StatusCard label={text('Mail Mode', '邮箱模式')} value={getEmailSelectionModeLabel(replenishmentStatus.email_selection_mode, text)} />
                  <StatusCard label={text('Last Domain', '最近域名')} value={replenishmentStatus.last_selected_domain || text('Unknown', '未知')} />
                  <StatusCard label={text('Last Started', '上次开始')} value={formatBatchTime(replenishmentStatus.last_started_at, text)} />
                  <StatusCard label={text('Last Finished', '上次结束')} value={formatBatchTime(replenishmentStatus.last_finished_at, text)} />
                </div>

                <SimpleReplenishmentLogCard lines={simpleReplenishmentLogs} text={text} />

                <ReplenishmentAccountsCard accounts={replenishmentAccounts} text={text} />

                <div className="rounded-md border border-border/60 bg-card/60 px-3 py-2">
                  <div className="text-xs text-muted-foreground">{text('Backend Detail', '后端详情')}</div>
                  <div>{text('The UI now focuses on account-level progress. Full raw logs are still written to the backend log file.', '前端现在聚焦账号级进度，完整原始日志仍写入后端日志文件。')}</div>
                  {replenishmentStatus.log_file && <div className="mt-1 text-xs text-muted-foreground"><code>{replenishmentStatus.log_file}</code></div>}
                </div>
              </div>
            )}
          </div>
        </section>

        <section className="space-y-4 rounded-xl border border-border/60 bg-background/40 p-4">
          <div className="space-y-1">
            <h3 className="text-base font-semibold">{text('Remote Push Test', '远程推送测试')}</h3>
            <p className="text-xs text-muted-foreground">{text('Smoke test the current remote CPA target by reading, uploading, and deleting a temporary auth file.', '通过读取、上传、删除临时 auth file 的方式，对当前远程 CPA 目标执行 smoke test。')}</p>
          </div>
          <button onClick={() => { void handleRemotePushTest(); }} disabled={testingRemote || !cpaUrl.trim()} className="inline-flex h-10 items-center justify-center rounded-md border border-border bg-background px-4 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50">{testingRemote ? text('Testing Remote Push...', '正在测试远程推送...') : text('Test Remote Read + Push', '测试远程读取与推送')}</button>
          {remoteTestError && <div className="rounded-md border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">{remoteTestError}</div>}
          {remoteTestResult && <div className="space-y-2 rounded-md border border-border bg-background/70 px-4 py-3 text-sm"><p><span className="font-medium">{text('Remote target', '远程目标')}:</span> {remoteTestResult.target_cpa_url}</p><p><span className="font-medium">{text('Read auth-files', '读取 auth-files')}:</span> {remoteTestResult.read_ok ? text('OK', '成功') : text('Failed', '失败')}</p><p><span className="font-medium">{text('Upload', '上传')}:</span> {remoteTestResult.push_test.upload_ok ? `${text('OK via', '成功，方式')} ${remoteTestResult.push_test.upload_mode}` : text('Failed', '失败')}</p><p><span className="font-medium">{text('Cleanup delete', '清理删除')}:</span> {remoteTestResult.push_test.cleanup_ok ? text('OK', '成功') : text('Not completed', '未完成')}</p></div>}
        </section>

        {message.text && <div className={`rounded-md border px-4 py-3 text-sm ${message.type === 'success' ? 'border-primary/50 bg-primary/10 text-primary' : 'border-destructive/50 bg-destructive/10 text-destructive'}`}>{message.text}</div>}

        <button onClick={() => { void handleSave(); }} disabled={savingSettings} className="inline-flex h-10 items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50">{savingSettings ? text('Saving...', '保存中...') : text('Save Configuration', '保存配置')}</button>
      </div>
    </div>
  );
}
