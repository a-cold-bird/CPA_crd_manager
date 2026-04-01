import axios from 'axios';

// 1. Create independent backend configuration API
export const configApi = axios.create({
  baseURL: '/api', // this goes to our local node server
});

configApi.interceptors.request.use((config) => {
  const key = localStorage.getItem('management_key');
  if (key) {
    config.headers['Authorization'] = `Bearer ${key}`;
  }
  return config;
});

// 2. Create the main CPA API client
export const cpaApi = axios.create({
  baseURL: '/api/cpa',
});

cpaApi.interceptors.request.use((config) => {
  const key = localStorage.getItem('management_key');
  if (key) {
    config.headers['Authorization'] = `Bearer ${key}`;
  }
  return config;
});

// Types based on phase 1 API doc
export type Provider = 'codex';

export interface IdTokenInfo {
  plan_type?: string;
  [key: string]: unknown;
}

export interface Credential {
  id: string;
  name: string;
  provider: Provider | string;
  auth_index: string;
  disabled: boolean;
  id_token?: IdTokenInfo;
  [key: string]: unknown;
}

export type CheckStatus = 'active' | 'invalidated' | 'deactivated' | 'unauthorized' | 'expired_by_time' | 'quota_exhausted' | 'quota_low_remaining' | 'rate_limited' | 'unknown' | 'error';

export interface OperationLog {
  at: string;
  action: string;
  target: string;
  ok: boolean;
  message: string;
}

export interface ProbeResponse {
  status_code: number;
  body?: unknown;
  error?: string;
  [key: string]: unknown;
}

export interface LocalCliResult<T = Record<string, unknown>> {
  ok: boolean;
  exit_code: number;
  signal?: string;
  timed_out?: boolean;
  stdout?: string;
  stderr?: string;
  payload?: T | null;
  error?: string;
}

export interface CredentialArchivePayload {
  cpa_url: string;
  names: string[];
  entries: Array<{
    name: string;
    archived_at: number | null;
    archived_at_iso: string;
  }>;
  total: number;
  added?: number;
  removed?: number;
}

export interface CredentialArchiveRequest {
  cpa_url?: string;
  names?: string[];
}

export interface RuntimeCredentialState {
  provider?: string;
  last_status: CheckStatus;
  last_reason: string;
  last_probe_at: number | null;
  last_probe_at_iso: string;
  last_probe_detail: string;
  last_reset_at: number | null;
  last_quota_source: string;
  last_quota_used_percent: number | null;
  last_quota_cards: Array<{
    key: string;
    label: string;
    usedPercent: number | null;
    resetAt: number | null;
    limitWindowSeconds: number | null;
    limitReached: boolean | null;
  }>;
  next_probe_at_ms: number | null;
  archived_by_runtime: boolean;
  disabled_by_runtime: boolean;
}

export interface ReplenishmentBatchStatus {
  accounts: Array<{
    idx: number | null;
    total: number | null;
    email: string;
    proxy: string;
    status: string;
    register_ok: boolean;
    codex_ok: boolean;
    upload_ok: boolean;
    error: string;
    updated_at: number | null;
  }>;
  attempt: number | null;
  requested: number | null;
  workers: number | null;
  selected_domain: string;
  email_selection_mode: string;
  status: string;
  register_succeeded: number;
  register_failed: number;
  codex_succeeded: number;
  codex_failed: number;
  upload_succeeded: number;
  upload_failed: number;
  current_proxy: string;
  current_email: string;
  last_error: string;
  started_at: number | null;
  finished_at: number | null;
  events: string[];
}

export interface RuntimeStatusPayload {
  cpa_url: string;
  runtime: {
    wake_interval_ms: number;
    auto_probe_enabled: boolean;
    has_runtime_config: boolean;
    backend_automation_active: boolean;
    cycle_in_progress: boolean;
    last_cycle_started_at: number | null;
    last_cycle_started_at_iso: string;
    last_cycle_finished_at: number | null;
    last_cycle_finished_at_iso: string;
    last_error: string;
  };
  replenishment: {
    domain_stats: Record<string, { total: number; success: number; fail: number }>;
    enabled: boolean;
    in_progress: boolean;
    stop_requested: boolean;
    process_pid: number | null;
    mode: string;
    healthy_count: number | null;
    proxy_pool_size: number | null;
    target_count: number | null;
    threshold: number | null;
    batch_size: number | null;
    worker_count: number | null;
    use_proxy: boolean;
    needed: number | null;
    new_token_files: number | null;
    last_limit: number | null;
    last_scan_register_total: number | null;
    last_scan_cpa_total: number | null;
    last_scan_missing_count: number | null;
    last_uploaded: number | null;
    last_failed: number | null;
    failed_names: string[];
    log_file: string;
    recent_events: string[];
    log_tail: string[];
    last_started_at: number | null;
    last_started_at_iso: string;
    last_finished_at: number | null;
    last_finished_at_iso: string;
    last_error: string;
    last_summary: string;
    email_selection_mode: string;
    last_selected_domain: string;
    current_batch: ReplenishmentBatchStatus | null;
    batch_history: ReplenishmentBatchStatus[];
  };
  credentials: Record<string, RuntimeCredentialState>;
}

export interface RemotePushTestPayload {
  target_cpa_url: string;
  read_ok: boolean;
  auth_files_total: number;
  push_test: {
    attempted: boolean;
    upload_ok: boolean;
    cleanup_ok: boolean;
    upload_status: number | null;
    cleanup_status: number | null;
    upload_mode: string;
    error: string;
  };
}

export interface MailDomainTestPayload {
  provider?: string;
  domain: string;
  mailbox: string;
  ok: boolean;
  login_status: number | null;
  list_status: number | null;
  message: string;
  error: string;
}

export interface StartReplenishmentPayload {
  started: boolean;
  already_running: boolean;
  pid: number | null;
  needed: number | null;
  healthy_count: number | null;
  target_count: number | null;
  threshold: number | null;
  message: string;
}

export interface StopReplenishmentPayload {
  requested: boolean;
  stopped: boolean;
  pid: number | null;
  message: string;
}

const AUTH_FILES_CACHE_TTL_MS = 3000;
const AUTH_FILES_MIN_GAP_MS = 250;

type AuthFilesCacheEntry = { data: Credential[]; at: number };

const authFilesCacheByBaseUrl = new Map<string, AuthFilesCacheEntry>();
const authFilesInFlightByBaseUrl = new Map<string, Promise<Credential[]>>();
const authFilesLastRequestAtByBaseUrl = new Map<string, number>();

const cloneCredentials = (files: Credential[]): Credential[] => files.map((item) => ({ ...item }));

const sleep = async (ms: number) => {
  if (ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
};

export const clearAuthFilesCache = () => {
  authFilesCacheByBaseUrl.clear();
  authFilesInFlightByBaseUrl.clear();
  authFilesLastRequestAtByBaseUrl.clear();
};

async function requestAuthFilesFromServer(): Promise<Credential[]> {
  const res = await cpaApi.get('/auth-files');
  return res.data.files as Credential[];
}

function getAuthFilesCacheKey(): string {
  return String(cpaApi.defaults.baseURL || '');
}

// APIs
export const fetchAuthFiles = async (options?: { force?: boolean }): Promise<Credential[]> => {
  const force = options?.force ?? false;
  const cacheKey = getAuthFilesCacheKey();
  const now = Date.now();
  const cacheEntry = authFilesCacheByBaseUrl.get(cacheKey) || null;
  const inFlight = authFilesInFlightByBaseUrl.get(cacheKey) || null;
  const lastRequestAt = authFilesLastRequestAtByBaseUrl.get(cacheKey) || 0;

  if (!force && cacheEntry && now - cacheEntry.at < AUTH_FILES_CACHE_TTL_MS) {
    return cloneCredentials(cacheEntry.data);
  }

  if (inFlight) {
    const data = await inFlight;
    return cloneCredentials(data);
  }

  const waitMs = force ? 0 : Math.max(0, AUTH_FILES_MIN_GAP_MS - (now - lastRequestAt));

  const nextInFlight = (async () => {
    await sleep(waitMs);
    const data = await requestAuthFilesFromServer();
    const fetchedAt = Date.now();
    authFilesLastRequestAtByBaseUrl.set(cacheKey, fetchedAt);
    authFilesCacheByBaseUrl.set(cacheKey, {
      data: cloneCredentials(data),
      at: fetchedAt,
    });
    return cloneCredentials(data);
  })().finally(() => {
    authFilesInFlightByBaseUrl.delete(cacheKey);
  });

  authFilesInFlightByBaseUrl.set(cacheKey, nextInFlight);
  const result = await nextInFlight;
  return cloneCredentials(result);
};

export const fetchAuthFilesForceRefresh = async (): Promise<Credential[]> => {
  clearAuthFilesCache();
  return fetchAuthFiles({ force: true });
};

export const probeCredential = async (auth_index: string, provider: string, signal?: AbortSignal): Promise<ProbeResponse> => {
  let method = 'GET';
  let url = 'https://chatgpt.com/backend-api/wham/usage';
  let header: Record<string, string> = {
    Authorization: 'Bearer $TOKEN$',
    'Content-Type': 'application/json',
    'User-Agent': 'codex_cli_rs/0.98.0',
  };
  let data: string | undefined;

  if (provider.toLowerCase() === 'antigravity') {
    method = 'POST';
    url = 'https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist';
    header = {
      Authorization: 'Bearer $TOKEN$',
      'Content-Type': 'application/json',
    };
    data = '{}';
  }

  const res = await cpaApi.post(
    '/api-call',
    {
      auth_index,
      method,
      url,
      header,
      ...(data !== undefined && { data }),
    },
    {
      signal,
    },
  );
  return res.data as ProbeResponse;
};

export const updateCredentialStatus = async (name: string, disabled: boolean) => {
  const res = await cpaApi.patch('/auth-files/status', {
    name,
    disabled,
  });
  clearAuthFilesCache();
  return res.data;
};

export const deleteCredential = async (name: string) => {
  const res = await cpaApi.delete('/auth-files', { params: { name } });
  clearAuthFilesCache();
  return res.data;
};

function getManagementKeyOrThrow(): string {
  const password = String(localStorage.getItem('management_key') || '').trim();
  if (!password) {
    throw new Error('management key not found');
  }
  return password;
}

export const runCredentialArchiveList = async (payload?: CredentialArchiveRequest): Promise<LocalCliResult<CredentialArchivePayload>> => {
  const password = getManagementKeyOrThrow();
  const res = await configApi.post('/archive/list', {
    password,
    ...payload,
  });
  return res.data as LocalCliResult<CredentialArchivePayload>;
};

export const runCredentialArchiveAdd = async (payload: CredentialArchiveRequest): Promise<LocalCliResult<CredentialArchivePayload>> => {
  const password = getManagementKeyOrThrow();
  const res = await configApi.post('/archive/add', {
    password,
    ...payload,
  });
  return res.data as LocalCliResult<CredentialArchivePayload>;
};

export const runCredentialArchiveRemove = async (payload: CredentialArchiveRequest): Promise<LocalCliResult<CredentialArchivePayload>> => {
  const password = getManagementKeyOrThrow();
  const res = await configApi.post('/archive/remove', {
    password,
    ...payload,
  });
  return res.data as LocalCliResult<CredentialArchivePayload>;
};

export const fetchRuntimeStatus = async (): Promise<LocalCliResult<RuntimeStatusPayload>> => {
  const res = await configApi.get('/runtime/status');
  return res.data as LocalCliResult<RuntimeStatusPayload>;
};

export const upsertRuntimeCredentialState = async (payload: {
  cpa_url?: string;
  name: string;
  state: Partial<RuntimeCredentialState>;
}): Promise<LocalCliResult<{ cpa_url: string; name: string; state: RuntimeCredentialState }>> => {
  const res = await configApi.post('/runtime/credential-state/upsert', payload);
  return res.data as LocalCliResult<{ cpa_url: string; name: string; state: RuntimeCredentialState }>;
};

export const runRemotePushTest = async (payload?: {
  target_cpa_url?: string;
  target_management_key?: string;
}): Promise<LocalCliResult<RemotePushTestPayload>> => {
  const password = getManagementKeyOrThrow();
  const res = await configApi.post('/remote/push-test', {
    password,
    ...payload,
  });
  return res.data as LocalCliResult<RemotePushTestPayload>;
};

export const runMailDomainTest = async (payload: {
  mail_email_provider?: 'mailfree' | 'inbucket';
  domain: string;
  mail_api_base?: string;
  mail_username?: string;
  mail_password?: string;
}): Promise<LocalCliResult<MailDomainTestPayload>> => {
  const password = getManagementKeyOrThrow();
  const res = await configApi.post('/mail/domain-test', {
    password,
    ...payload,
  });
  return res.data as LocalCliResult<MailDomainTestPayload>;
};

export const stopReplenishment = async (): Promise<LocalCliResult<StopReplenishmentPayload>> => {
  const password = getManagementKeyOrThrow();
  const res = await configApi.post('/runtime/replenishment/stop', {
    password,
  });
  return res.data as LocalCliResult<StopReplenishmentPayload>;
};

export const startReplenishment = async (): Promise<LocalCliResult<StartReplenishmentPayload>> => {
  const password = getManagementKeyOrThrow();
  const res = await configApi.post('/runtime/replenishment/start', {
    password,
  });
  return res.data as LocalCliResult<StartReplenishmentPayload>;
};
