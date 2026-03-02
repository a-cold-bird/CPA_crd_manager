import axios from 'axios';

// 1. Create independent backend configuration API
export const configApi = axios.create({
  baseURL: '/api', // this goes to our local node server
});

// 2. Create the main CPA API client
export const cpaApi = axios.create(); // baseURL will be set dynamically once config is loaded

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

export type CheckStatus = 'active' | 'invalidated' | 'deactivated' | 'unauthorized' | 'expired_by_time' | 'unknown' | 'error';

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

export interface OAuthLoginRequest {
  provider: string;
  account_file: string;
  index?: number;
  wait_seconds?: number;
  max_wait?: number;
  headless?: boolean;
  callback_url?: string;
  timeout?: number;
}

export interface OAuthAppendAccountsRequest {
  provider: string;
  account_file: string;
  content: string;
}

export interface OAuthDeleteAccountsRequest {
  provider: string;
  account_file: string;
  indexes: number[];
  exec_timeout_ms?: number;
}

export interface OAuthAppendAccountsPayload {
  file: string;
  appended: number;
  added?: number;
  overwritten?: number;
  skipped_invalid?: number;
  input_total?: number;
  final_total?: number;
}

export interface OAuthDeleteAccountsPayload {
  detail?: {
    file?: string;
    provider?: string;
    requested?: number;
    deleted?: number;
    missing?: number;
    missing_indexes?: number[];
    total_before?: number;
    total_after?: number;
  };
}

export interface CredentialArchivePayload {
  cpa_url: string;
  names: string[];
  total: number;
  added?: number;
  removed?: number;
}

export interface CredentialArchiveRequest {
  cpa_url?: string;
  names?: string[];
}

export interface OAuthLoginBatchRequest {
  provider: string;
  account_file: string;
  start?: number;
  limit?: number;
  indexes?: number[];
  workers?: number;
  retries?: number;
  wait_seconds?: number;
  max_wait?: number;
  headless?: boolean;
  callback_file?: string;
  skip_submitted?: boolean;
  cooldown?: number;
  result_file?: string;
  success_file?: string;
  detail_log_file?: string;
  dry_run?: boolean;
  timeout?: number;
}

export type OAuthPreviewMode = 'single' | 'batch';

export interface OAuthAccountPreviewRequest {
  provider: string;
  account_file: string;
  mode?: OAuthPreviewMode;
  index?: number;
  start?: number;
  limit?: number;
  exec_timeout_ms?: number;
}

export interface OAuthAccountPreviewAccount {
  index: number;
  email: string;
  provider: string;
  channel: string;
  has_access_token: boolean;
  has_recovery_email: boolean;
  has_totp_url: boolean;
}

export interface OAuthAccountPreviewPayload {
  mode: OAuthPreviewMode;
  total_accounts: number;
  selected: number;
  indexes: number[];
  accounts: OAuthAccountPreviewAccount[];
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
  const res = await cpaApi.get('/v0/management/auth-files');
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
  let method = 'POST';
  let url = 'https://chatgpt.com/backend-api/codex/responses';
  let header: Record<string, string> = {
    Authorization: 'Bearer $TOKEN$',
    'Content-Type': 'application/json',
    'Openai-Beta': 'responses=experimental',
    Version: '0.98.0',
    Originator: 'codex_cli_rs',
    'User-Agent': 'codex_cli_rs/0.98.0',
  };
  let data: string | undefined = '{"model":"gpt-4.1-mini","input":"ping","stream":false}';

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
    '/v0/management/api-call',
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
  const res = await cpaApi.patch('/v0/management/auth-files/status', {
    name,
    disabled,
  });
  clearAuthFilesCache();
  return res.data;
};

export const deleteCredential = async (name: string) => {
  const res = await cpaApi.delete('/v0/management/auth-files', { params: { name } });
  clearAuthFilesCache();
  return res.data;
};

export const getCodexAuthUrl = async (is_webui: boolean = true) => {
  const res = await cpaApi.get(`/v0/management/codex-auth-url?is_webui=${is_webui}`);
  return res.data;
};

export const submitOAuthCallback = async (provider: string, redirectUrl: string, state?: string) => {
  const res = await cpaApi.post('/v0/management/oauth-callback', {
    provider,
    redirect_url: redirectUrl,
    state,
  });
  clearAuthFilesCache();
  return res.data;
};

export const getOAuthStatus = async (state: string) => {
  const res = await cpaApi.get(`/v0/management/get-auth-status?state=${state}`);
  return res.data;
};

function getManagementKeyOrThrow(): string {
  const password = String(localStorage.getItem('management_key') || '').trim();
  if (!password) {
    throw new Error('management key not found');
  }
  return password;
}

export const runOAuthLogin = async (
  payload: OAuthLoginRequest,
  options?: { signal?: AbortSignal },
): Promise<LocalCliResult> => {
  const password = getManagementKeyOrThrow();
  const res = await configApi.post('/oauth/login', {
    password,
    ...payload,
  }, {
    signal: options?.signal,
  });
  return res.data as LocalCliResult;
};

export const runOAuthLoginBatch = async (payload: OAuthLoginBatchRequest): Promise<LocalCliResult> => {
  const password = getManagementKeyOrThrow();
  const res = await configApi.post('/oauth/login-batch', {
    password,
    ...payload,
  });
  return res.data as LocalCliResult;
};

export const runOAuthAccountPreview = async (payload: OAuthAccountPreviewRequest): Promise<LocalCliResult<OAuthAccountPreviewPayload>> => {
  const password = getManagementKeyOrThrow();
  const res = await configApi.post('/oauth/accounts/preview', {
    password,
    ...payload,
  });
  return res.data as LocalCliResult<OAuthAccountPreviewPayload>;
};

export const runOAuthAppendAccounts = async (payload: OAuthAppendAccountsRequest): Promise<LocalCliResult<OAuthAppendAccountsPayload>> => {
  const password = getManagementKeyOrThrow();
  const res = await configApi.post('/oauth/accounts/append', {
    password,
    ...payload,
  });
  return res.data as LocalCliResult<OAuthAppendAccountsPayload>;
};

export const runOAuthDeleteAccounts = async (payload: OAuthDeleteAccountsRequest): Promise<LocalCliResult<OAuthDeleteAccountsPayload>> => {
  const password = getManagementKeyOrThrow();
  const res = await configApi.post('/oauth/accounts/delete', {
    password,
    ...payload,
  });
  return res.data as LocalCliResult<OAuthDeleteAccountsPayload>;
};

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
