import express from 'express';
import cors from 'cors';
import fs from 'fs';
import yaml from 'js-yaml';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  classifyProviderProbe,
  resolveRuntimeNextProbeAtMs,
  shouldAutoArchive,
  shouldAutoDisable,
  toProbeErrorResponse,
} from './src/shared/providerRuntimeStrategies.js';
import {
  canProbeCredentialInRuntime,
  hasRuntimeOwnershipForCredential,
  selectCredentialsForProbe,
} from './runtimeProbePlanner.js';
import { createSerializedJsonStore } from './serializedJsonStore.js';
import { createKeyedInFlightDeduper, createKeyedOperationQueue } from './keyedOperationQueue.js';
import { createKeyedAsyncRequestCache } from './asyncRequestCache.js';
import { mapWithConcurrency } from './asyncConcurrency.js';
import { isAuthorizedManagementKey } from './managementAuth.js';
import {
  canCommitRuntimeArchive,
  evaluateCredentialStatusTransitionPrecondition,
  executeCredentialStatusTransaction,
  isSameCredentialIdentity,
} from './credentialStatusTransaction.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');
const ARCHIVE_STORE_PATH = path.join(PROJECT_ROOT, 'runtime', 'credential_archive.json');
const RUNTIME_STATE_PATH = path.join(PROJECT_ROOT, 'runtime', 'credential_runtime_state.json');
const BACKEND_SERVER_LOCK_PATH = path.join(PROJECT_ROOT, 'runtime', 'frontend_server.lock');

const app = express();
const PORT = Number(process.env.CPA_BACKEND_PORT || process.env.API_PORT || process.env.PORT || 8333);
const DEFAULT_CONFIG_PATH = path.join(process.cwd(), 'config.yaml');
const CONFIG_PATH = path.resolve(process.env.CPA_CONFIG_FILE || DEFAULT_CONFIG_PATH);
const CONFIG_FALLBACK_PATH = path.join(process.cwd(), 'config.example.yaml');
const RUNTIME_WAKE_INTERVAL_MS = 30_000;
const AUTOMATION_RETRY_DELAY_MS = 30_000;
const CPA_REQUEST_TIMEOUT_MS = 20_000;
const CPA_AUTH_FILES_REQUEST_TIMEOUT_MS = 8_000;
const CPA_AUTH_FILES_RETRY_DELAY_MS = 500;
const CPA_AUTH_FILES_CACHE_TTL_MS = 1_000;
const AUTO_PROBE_MAX_CONCURRENCY = 5;
const AUTO_PROBE_BATCH_SIZE_DEFAULT = 5;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

const runtimeScheduler = {
  started: false,
  timer: null,
  cycleInProgress: false,
};

let backendServerLockHeld = false;
const cpaAuthFilesCache = createKeyedAsyncRequestCache({
  ttlMs: CPA_AUTH_FILES_CACHE_TTL_MS,
  clone: (files) => files.map((item) => ({ ...item })),
});
const runKeyedCredentialProbe = createKeyedInFlightDeduper();


function resolveReadableConfigPath() {
  const candidates = [CONFIG_PATH, CONFIG_FALLBACK_PATH];
  for (const candidate of candidates) {
    if (!candidate || !fs.existsSync(candidate)) {
      continue;
    }
    try {
      const stat = fs.statSync(candidate);
      if (stat.isFile()) {
        return candidate;
      }
      console.error(`Config path exists but is not a file: ${candidate}`);
    } catch (error) {
      console.error(`Failed to stat config path ${candidate}`, error);
    }
  }
  return '';
}

const CONFIG_DEFAULTS = {
  cpa_url: '',
  management_key: '',
  auto_probe_enabled: false,
  auto_probe_interval_minutes: 60,
  auto_probe_batch_size: AUTO_PROBE_BATCH_SIZE_DEFAULT,
  codex_quota_disable_remaining_percent: 10,
};

function normalizeConfig(source = {}) {
  return {
    cpa_url: normalizeCpaBaseUrl(source.cpa_url),
    management_key: String(source.management_key || '').trim(),
    auto_probe_enabled: parseBoolSafe(source.auto_probe_enabled, CONFIG_DEFAULTS.auto_probe_enabled),
    auto_probe_interval_minutes: Math.max(1, Math.min(1440, parseIntSafe(
      source.auto_probe_interval_minutes,
      CONFIG_DEFAULTS.auto_probe_interval_minutes,
    ))),
    auto_probe_batch_size: Math.max(1, Math.min(100, parseIntSafe(
      source.auto_probe_batch_size,
      CONFIG_DEFAULTS.auto_probe_batch_size,
    ))),
    codex_quota_disable_remaining_percent: Math.max(0, Math.min(100, parseIntSafe(
      source.codex_quota_disable_remaining_percent,
      CONFIG_DEFAULTS.codex_quota_disable_remaining_percent,
    ))),
  };
}

function readConfig() {
  const configPathToRead = resolveReadableConfigPath();
  if (!configPathToRead) {
    return { ...CONFIG_DEFAULTS };
  }
  try {
    const file = fs.readFileSync(configPathToRead, 'utf8');
    const parsed = yaml.load(file);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ...CONFIG_DEFAULTS };
    }
    return normalizeConfig({ ...CONFIG_DEFAULTS, ...parsed });
  } catch (error) {
    console.error('Failed to parse config.yaml', error);
    return { ...CONFIG_DEFAULTS };
  }
}

function writeConfig(data) {
  if (fs.existsSync(CONFIG_PATH)) {
    const stat = fs.statSync(CONFIG_PATH);
    if (!stat.isFile()) {
      throw new Error(`CONFIG_PATH must be a file, but received: ${CONFIG_PATH}`);
    }
  }
  const normalized = normalizeConfig({ ...readConfig(), ...data });
  const str = yaml.dump(normalized);
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  const temporaryPath = `${CONFIG_PATH}.${process.pid}.${Date.now()}.tmp`;
  let descriptor = null;
  try {
    descriptor = fs.openSync(temporaryPath, 'w', 0o600);
    fs.writeFileSync(descriptor, str, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    fs.renameSync(temporaryPath, CONFIG_PATH);
    try {
      fs.chmodSync(CONFIG_PATH, 0o600);
    } catch {
      // Some mounted filesystems do not support POSIX permissions.
    }
  } catch (error) {
    if (descriptor !== null) {
      try {
        fs.closeSync(descriptor);
      } catch {
        // Preserve the original write error.
      }
    }
    try {
      fs.rmSync(temporaryPath, { force: true });
    } catch {
      // Preserve the original write error.
    }
    throw error;
  }
}

function initializeConfigFile() {
  if (fs.existsSync(CONFIG_PATH)) {
    return;
  }
  const configPathToRead = resolveReadableConfigPath();
  if (!configPathToRead || path.resolve(configPathToRead) !== path.resolve(CONFIG_FALLBACK_PATH)) {
    return;
  }
  writeConfig(readConfig());
  console.log(`Initialized default config at ${CONFIG_PATH}`);
}

function isAuthorized(password, config) {
  return isAuthorizedManagementKey(password, config?.management_key);
}

function parseIntSafe(value, defaultValue) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

function parseBoolSafe(value, defaultValue = false) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const lower = value.trim().toLowerCase();
    if (lower === 'true' || lower === '1' || lower === 'yes') return true;
    if (lower === 'false' || lower === '0' || lower === 'no') return false;
  }
  return defaultValue;
}

function ensureRuntimeDir() {
  fs.mkdirSync(path.join(PROJECT_ROOT, 'runtime'), { recursive: true });
}

function isPidRunning(pid) {
  const normalizedPid = normalizeNumberOrNull(pid);
  if (!normalizedPid || normalizedPid <= 0) {
    return false;
  }
  try {
    process.kill(normalizedPid, 0);
    return true;
  } catch {
    return false;
  }
}

function readProcessLock(lockPath) {
  if (!fs.existsSync(lockPath)) {
    return {};
  }
  try {
    const raw = fs.readFileSync(lockPath, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function removeProcessLock(lockPath) {
  try {
    fs.unlinkSync(lockPath);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return true;
    }
    return false;
  }
}

function acquireProcessLock(lockPath, metadata = {}) {
  ensureRuntimeDir();
  const payload = {
    pid: process.pid,
    started_at_ms: Date.now(),
    ...metadata,
  };

  while (true) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      fs.writeFileSync(fd, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
      fs.closeSync(fd);
      return { ok: true, payload };
    } catch (error) {
      if (error?.code !== 'EEXIST') {
        throw error;
      }

      const existing = readProcessLock(lockPath);
      const existingPid = normalizeNumberOrNull(existing.pid);
      if (existingPid && existingPid !== process.pid && isPidRunning(existingPid)) {
        return { ok: false, existing };
      }
      if (!removeProcessLock(lockPath)) {
        return { ok: false, existing };
      }
    }
  }
}

function releaseBackendServerLock() {
  if (!backendServerLockHeld) {
    return;
  }
  const existing = readProcessLock(BACKEND_SERVER_LOCK_PATH);
  const existingPid = normalizeNumberOrNull(existing.pid);
  if (existingPid && existingPid !== process.pid && isPidRunning(existingPid)) {
    backendServerLockHeld = false;
    return;
  }
  removeProcessLock(BACKEND_SERVER_LOCK_PATH);
  backendServerLockHeld = false;
}

function installBackendServerExitHandlers() {
  const exitSignals = ['SIGINT', 'SIGTERM', 'SIGBREAK'];
  process.once('exit', () => {
    releaseBackendServerLock();
  });
  exitSignals.forEach((signal) => {
    process.once(signal, () => {
      releaseBackendServerLock();
      process.exit(0);
    });
  });
}

function normalizeArchiveStore(store) {
  const normalizedStore = { by_cpa_url: {} };
  const source = store?.by_cpa_url && typeof store.by_cpa_url === 'object' ? store.by_cpa_url : {};
  Object.entries(source).forEach(([rawKey, value]) => {
    const normalizedKey = normalizeCpaUrlForArchive(rawKey);
    const existing = Array.isArray(normalizedStore.by_cpa_url[normalizedKey]) ? normalizedStore.by_cpa_url[normalizedKey] : [];
    const incoming = Array.isArray(value) ? value : [];
    normalizedStore.by_cpa_url[normalizedKey] = normalizeArchiveEntries([...existing, ...incoming]);
  });
  return normalizedStore;
}

const archiveStore = createSerializedJsonStore({
  filePath: ARCHIVE_STORE_PATH,
  createDefault: () => ({ by_cpa_url: {} }),
  normalize: normalizeArchiveStore,
});

function readArchiveStore() {
  return archiveStore.read();
}

function mutateArchiveStore(mutator) {
  return archiveStore.mutate(mutator);
}

function createEmptyRuntimeState() {
  return {
    by_cpa_url: {},
    worker: {
      cycle_in_progress: false,
      last_cycle_started_at: null,
      last_cycle_finished_at: null,
      last_error: '',
      probe_cursor_name: '',
      last_probe_count: 0,
    },
  };
}

function normalizeStringOrEmpty(value) {
  return typeof value === 'string' ? value : '';
}

function normalizeNumberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function normalizeBoolean(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  return fallback;
}

function normalizeCredentialRuntimeEntry(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const quotaCards = Array.isArray(source.last_quota_cards)
    ? source.last_quota_cards
      .map((item, index) => {
        const card = item && typeof item === 'object' && !Array.isArray(item) ? item : {};
        return {
          key: normalizeStringOrEmpty(card.key) || `runtime-card-${index}`,
          label: normalizeStringOrEmpty(card.label),
          usedPercent: normalizeNumberOrNull(card.usedPercent),
          resetAt: normalizeNumberOrNull(card.resetAt),
          limitWindowSeconds: normalizeNumberOrNull(card.limitWindowSeconds),
          limitReached: normalizeBoolean(card.limitReached, false),
        };
      })
      .filter((item) => item.label || item.usedPercent !== null || item.resetAt !== null)
    : [];
  return {
    provider: normalizeStringOrEmpty(source.provider),
    auth_index: normalizeStringOrEmpty(source.auth_index),
    last_status: normalizeStringOrEmpty(source.last_status),
    last_reason: normalizeStringOrEmpty(source.last_reason),
    last_probe_at: normalizeNumberOrNull(source.last_probe_at),
    last_probe_detail: normalizeStringOrEmpty(source.last_probe_detail),
    last_reset_at: normalizeNumberOrNull(source.last_reset_at),
    last_quota_source: normalizeStringOrEmpty(source.last_quota_source),
    last_quota_used_percent: normalizeNumberOrNull(source.last_quota_used_percent),
    last_quota_cards: quotaCards,
    next_probe_at_ms: normalizeNumberOrNull(source.next_probe_at_ms),
    archived_by_runtime: normalizeBoolean(source.archived_by_runtime, false),
    disabled_by_runtime: normalizeBoolean(source.disabled_by_runtime, false),
  };
}

function normalizeRuntimeBucket(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const credentials = source.credentials && typeof source.credentials === 'object' && !Array.isArray(source.credentials)
    ? source.credentials
    : {};
  const normalizedCredentials = {};
  Object.entries(credentials).forEach(([name, entry]) => {
    const normalizedName = String(name || '').trim();
    if (!normalizedName) return;
    normalizedCredentials[normalizedName] = normalizeCredentialRuntimeEntry(entry);
  });
  return {
    credentials: normalizedCredentials,
  };
}

function normalizeRuntimeStateStore(value) {
  const base = createEmptyRuntimeState();
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const byCpaUrl = source.by_cpa_url && typeof source.by_cpa_url === 'object' && !Array.isArray(source.by_cpa_url)
    ? source.by_cpa_url
    : {};
  const normalizedByCpaUrl = {};
  Object.entries(byCpaUrl).forEach(([cpaUrlKey, bucket]) => {
    const normalizedKey = normalizeCpaUrlForArchive(cpaUrlKey);
    normalizedByCpaUrl[normalizedKey] = normalizeRuntimeBucket(bucket);
  });
  const worker = source.worker && typeof source.worker === 'object' && !Array.isArray(source.worker)
    ? source.worker
    : {};

  return {
    by_cpa_url: normalizedByCpaUrl,
    worker: {
      cycle_in_progress: normalizeBoolean(worker.cycle_in_progress, false),
      last_cycle_started_at: normalizeNumberOrNull(worker.last_cycle_started_at),
      last_cycle_finished_at: normalizeNumberOrNull(worker.last_cycle_finished_at),
      last_error: normalizeStringOrEmpty(worker.last_error),
      probe_cursor_name: normalizeStringOrEmpty(worker.probe_cursor_name),
      last_probe_count: normalizeNumberOrNull(worker.last_probe_count) ?? 0,
    },
  };
}

const runtimeStateStore = createSerializedJsonStore({
  filePath: RUNTIME_STATE_PATH,
  createDefault: createEmptyRuntimeState,
  normalize: normalizeRuntimeStateStore,
});

function readRuntimeState() {
  return runtimeStateStore.read();
}

function mutateRuntimeState(mutator) {
  return runtimeStateStore.mutate(mutator);
}

function patchRuntimeWorkerState(patch) {
  return mutateRuntimeState((state) => {
    const next = setRuntimeWorkerState(state, patch);
    state.by_cpa_url = next.by_cpa_url;
    state.worker = next.worker;
    return next.worker;
  });
}

function patchCredentialRuntimeStateUnlocked(cpaUrlKey, credentialName, patch, { rejectOlderProbe = false } = {}) {
  return mutateRuntimeState((state) => {
    const current = getCredentialRuntimeState(state, cpaUrlKey, credentialName);
    const currentProbeAt = normalizeNumberOrNull(current?.last_probe_at);
    const incomingProbeAt = normalizeNumberOrNull(patch?.last_probe_at);
    if (rejectOlderProbe && currentProbeAt !== null && incomingProbeAt !== null && incomingProbeAt < currentProbeAt) {
      return current;
    }
    return setCredentialRuntimeState(state, cpaUrlKey, credentialName, patch);
  });
}

function patchCredentialRuntimeStateForCredential(config, cpaUrlKey, credential, patch, options) {
  return runCredentialStatusOperation(cpaUrlKey, credential?.name, async () => {
    const currentCredential = await fetchCredentialFromCpaByName(config, credential?.name, { fresh: true });
    if (!isSameCredentialIdentity(currentCredential?.auth_index, credential?.auth_index)) {
      return getCredentialRuntimeState(readRuntimeState(), cpaUrlKey, credential?.name);
    }
    return patchCredentialRuntimeStateUnlocked(cpaUrlKey, credential?.name, patch, options);
  });
}

function removeCredentialRuntimeStateUnlocked(cpaUrlKey, credentialName) {
  return mutateRuntimeState((state) => removeCredentialRuntimeState(state, cpaUrlKey, credentialName));
}

function setRuntimeWorkerState(store, nextPartialState) {
  const normalizedStore = normalizeRuntimeStateStore(store);
  normalizedStore.worker = {
    ...normalizedStore.worker,
    cycle_in_progress: normalizeBoolean(nextPartialState?.cycle_in_progress, normalizedStore.worker.cycle_in_progress),
    last_cycle_started_at: nextPartialState?.last_cycle_started_at !== undefined
      ? normalizeNumberOrNull(nextPartialState.last_cycle_started_at)
      : normalizedStore.worker.last_cycle_started_at,
    last_cycle_finished_at: nextPartialState?.last_cycle_finished_at !== undefined
      ? normalizeNumberOrNull(nextPartialState.last_cycle_finished_at)
      : normalizedStore.worker.last_cycle_finished_at,
    last_error: nextPartialState?.last_error !== undefined
      ? normalizeStringOrEmpty(nextPartialState.last_error)
      : normalizedStore.worker.last_error,
    probe_cursor_name: nextPartialState?.probe_cursor_name !== undefined
      ? normalizeStringOrEmpty(nextPartialState.probe_cursor_name)
      : normalizedStore.worker.probe_cursor_name,
    last_probe_count: nextPartialState?.last_probe_count !== undefined
      ? normalizeNumberOrNull(nextPartialState.last_probe_count) ?? 0
      : normalizedStore.worker.last_probe_count,
  };
  return normalizedStore;
}

function resolveRequestSecret(req) {
  const authHeader = String(req.headers?.authorization || '').trim();
  if (authHeader.toLowerCase().startsWith('bearer ')) {
    return authHeader.slice(7).trim();
  }
  if (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) {
    return String(req.body.password || '').trim();
  }
  return '';
}

function normalizeCpaBaseUrl(rawUrl) {
  return String(rawUrl || '').trim().replace(/\/+$/, '');
}

function buildCpaEndpointUrl(baseUrl, pathname) {
  const normalizedBase = normalizeCpaBaseUrl(baseUrl);
  if (!normalizedBase) {
    throw new Error('cpa_url is required');
  }
  return new URL(pathname, `${normalizedBase}/`).toString();
}

function createRequestError(message, status, data) {
  const error = new Error(message);
  if (status || data !== undefined) {
    error.response = {
      status: status || 0,
      data,
    };
  }
  return error;
}

async function readJsonLikeResponse(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function cpaRequest(config, { method = 'GET', pathname, body, timeoutMs = CPA_REQUEST_TIMEOUT_MS }) {
  const cpaUrl = normalizeCpaBaseUrl(config?.cpa_url);
  const managementKey = String(config?.management_key || '').trim();
  if (!cpaUrl) {
    throw new Error('cpa_url is required');
  }
  if (!isAuthorizedManagementKey(managementKey, managementKey)) {
    throw new Error('management_key is required and must not be a placeholder');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(buildCpaEndpointUrl(cpaUrl, pathname), {
      method,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${managementKey}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const data = await readJsonLikeResponse(response);
    if (!response.ok) {
      throw createRequestError(`CPA ${method} ${pathname} failed (${response.status})`, response.status, data);
    }
    return {
      status: response.status,
      data,
    };
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw createRequestError(`CPA ${method} ${pathname} timed out after ${timeoutMs}ms`, 0, null);
    }
    const causeCode = error?.cause?.code || error?.code || '';
    if (causeCode === 'UND_ERR_CONNECT_TIMEOUT') {
      throw createRequestError(`CPA ${method} ${pathname} connect timed out after ${timeoutMs}ms`, 0, null);
    }
    if (String(error?.message || '').toLowerCase() === 'fetch failed') {
      throw createRequestError(`CPA ${method} ${pathname} network error: fetch failed`, 0, null);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function sanitizePushTestName(rawName) {
  return String(rawName || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '') || `push-test-${Date.now()}.json`;
}

async function uploadAuthFileToCpaUnlocked(config, { name, content, timeoutMs = CPA_REQUEST_TIMEOUT_MS }) {
  const cpaUrl = normalizeCpaBaseUrl(config?.cpa_url);
  const managementKey = String(config?.management_key || '').trim();
  if (!cpaUrl) {
    throw new Error('cpa_url is required');
  }
  if (!isAuthorizedManagementKey(managementKey, managementKey)) {
    throw new Error('management_key is required and must not be a placeholder');
  }

  const filename = sanitizePushTestName(name);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const form = new FormData();
    form.append('file', new Blob([String(content || '')], { type: 'application/json' }), filename);
    const response = await fetch(buildCpaEndpointUrl(cpaUrl, '/v0/management/auth-files'), {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${managementKey}`,
      },
      body: form,
      signal: controller.signal,
    });
    const data = await readJsonLikeResponse(response);
    if (!response.ok) {
      throw createRequestError(`CPA POST /v0/management/auth-files failed (${response.status})`, response.status, data);
    }
    invalidateCpaAuthFilesCache(config);
    return {
      status: response.status,
      data,
      filename,
    };
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw createRequestError(`CPA POST /v0/management/auth-files timed out after ${timeoutMs}ms`, 0, null);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function uploadAuthFileToCpa(config, options) {
  const filename = sanitizePushTestName(options?.name);
  const cpaUrlKey = normalizeCpaUrlForArchive(config?.cpa_url, config?.cpa_url);
  return runCredentialStatusOperation(cpaUrlKey, filename, async () => {
    const result = await uploadAuthFileToCpaUnlocked(config, { ...options, name: filename });
    await removeCredentialRuntimeStateUnlocked(cpaUrlKey, filename);
    await removeArchiveNamesSerialized(cpaUrlKey, [filename]);
    return result;
  });
}

async function deleteAuthFileFromCpa(config, credentialName, timeoutMs = CPA_REQUEST_TIMEOUT_MS) {
  const query = new URLSearchParams({ name: credentialName }).toString();
  const result = await cpaRequest(config, {
    method: 'DELETE',
    pathname: `/v0/management/auth-files?${query}`,
    timeoutMs,
  });
  invalidateCpaAuthFilesCache(config);
  return result;
}

async function runRemotePushSmokeTest(targetConfig) {
  const normalizedTargetUrl = normalizeCpaBaseUrl(targetConfig?.cpa_url);
  const files = await fetchAuthFilesFromCpa(targetConfig);
  const testName = sanitizePushTestName(`push-test-${Date.now()}.json`);
  const testContent = JSON.stringify({
    source: 'cpamc-console',
    kind: 'remote_push_smoke_test',
    created_at: new Date().toISOString(),
  }, null, 2);

  const payload = {
    target_cpa_url: normalizedTargetUrl,
    read_ok: true,
    auth_files_total: files.length,
    push_test: {
      attempted: true,
      upload_ok: false,
      cleanup_ok: false,
      upload_status: null,
      cleanup_status: null,
      upload_mode: 'multipart:file',
      error: '',
    },
  };

  try {
    const uploadResult = await uploadAuthFileToCpa(targetConfig, {
      name: testName,
      content: testContent,
    });
    payload.push_test.upload_ok = true;
    payload.push_test.upload_status = uploadResult.status;

    try {
      const cleanupResult = await deleteAuthFileFromCpa(targetConfig, uploadResult.filename);
      payload.push_test.cleanup_ok = true;
      payload.push_test.cleanup_status = cleanupResult.status;
    } catch (cleanupError) {
      payload.push_test.error = String(cleanupError?.message || cleanupError);
      payload.push_test.cleanup_status = Number(cleanupError?.response?.status) || null;
    }
  } catch (uploadError) {
    payload.push_test.error = String(uploadError?.message || uploadError);
    payload.push_test.upload_status = Number(uploadError?.response?.status) || null;
  }

  return payload;
}

function normalizeCredentialRecord(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    ...source,
    id: String(source.id || ''),
    name: normalizeCredentialName(source.name),
    provider: String(source.provider || ''),
    auth_index: String(source.auth_index || source.authIndex || ''),
    disabled: Boolean(source.disabled),
  };
}

function getCpaAuthFilesCacheKey(config) {
  return `${normalizeCpaBaseUrl(config?.cpa_url)}\n${String(config?.management_key || '').trim()}`;
}

function invalidateCpaAuthFilesCache(config) {
  cpaAuthFilesCache.invalidate(getCpaAuthFilesCacheKey(config));
}

async function requestAuthFilesFromCpa(config) {
  let result;
  try {
    result = await cpaRequest(config, {
      method: 'GET',
      pathname: '/v0/management/auth-files',
      timeoutMs: CPA_AUTH_FILES_REQUEST_TIMEOUT_MS,
    });
  } catch (error) {
    const status = Number(error?.response?.status) || 0;
    const shouldRetry = status === 0 || status >= 500;
    if (!shouldRetry) {
      throw error;
    }

    console.warn(`[CPA] GET /v0/management/auth-files failed once (status=${status || 'timeout'}), retrying once...`);
    await sleep(CPA_AUTH_FILES_RETRY_DELAY_MS);
    result = await cpaRequest(config, {
      method: 'GET',
      pathname: '/v0/management/auth-files',
      timeoutMs: CPA_AUTH_FILES_REQUEST_TIMEOUT_MS,
    });
  }

  const files = Array.isArray(result.data?.files) ? result.data.files : [];
  return files
    .map((item) => normalizeCredentialRecord(item))
    .filter((item) => item.name && item.auth_index);
}

function fetchAuthFilesFromCpa(config, { maxAgeMs = CPA_AUTH_FILES_CACHE_TTL_MS } = {}) {
  const cacheKey = getCpaAuthFilesCacheKey(config);
  return cpaAuthFilesCache.get(cacheKey, () => requestAuthFilesFromCpa(config), { maxAgeMs });
}

function buildProbePayload(credential) {
  const provider = String(credential?.provider || '').toLowerCase();
  let method = 'GET';
  let url = 'https://chatgpt.com/backend-api/wham/usage';
  let header = {
    Authorization: 'Bearer $TOKEN$',
    'Content-Type': 'application/json',
    'User-Agent': 'codex_cli_rs/0.98.0',
  };
  let data;

  if (provider === 'antigravity') {
    method = 'POST';
    url = 'https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist';
    header = {
      Authorization: 'Bearer $TOKEN$',
      'Content-Type': 'application/json',
    };
    data = '{}';
  }

  return {
    auth_index: credential.auth_index,
    method,
    url,
    header,
    ...(data !== undefined ? { data } : {}),
  };
}

function probeApiCallFromCpa(config, payload) {
  const authIndex = normalizeStringOrEmpty(payload?.auth_index);
  const execute = async () => {
    const result = await cpaRequest(config, {
      method: 'POST',
      pathname: '/v0/management/api-call',
      body: payload,
    });
    return result.data && typeof result.data === 'object'
      ? result.data
      : { status_code: result.status, body: result.data };
  };
  if (!authIndex) {
    return execute();
  }
  const probeKey = `${normalizeCpaBaseUrl(config?.cpa_url)}\n${String(config?.management_key || '').trim()}\n${JSON.stringify(payload)}`;
  return runKeyedCredentialProbe(probeKey, execute);
}

function probeCredentialFromCpa(config, credential) {
  return probeApiCallFromCpa(config, buildProbePayload(credential));
}

async function updateCredentialDisabledStatus(config, credentialName, disabled) {
  const result = await cpaRequest(config, {
    method: 'PATCH',
    pathname: '/v0/management/auth-files/status',
    body: {
      name: credentialName,
      disabled,
    },
  });
  invalidateCpaAuthFilesCache(config);
  return result;
}

const runKeyedCredentialOperation = createKeyedOperationQueue();

function runCredentialStatusOperation(cpaUrlKey, credentialName, operation) {
  const key = `${normalizeCpaUrlForArchive(cpaUrlKey)}\n${normalizeCredentialName(credentialName)}`;
  return runKeyedCredentialOperation(key, operation);
}

function runCredentialStatusOperations(cpaUrlKey, credentialNames, operation) {
  const names = Array.from(new Set(
    credentialNames.map((name) => normalizeCredentialName(name)).filter(Boolean),
  )).sort((left, right) => left.localeCompare(right));
  const acquire = (index) => {
    if (index >= names.length) {
      return operation();
    }
    return runCredentialStatusOperation(cpaUrlKey, names[index], () => acquire(index + 1));
  };
  return acquire(0);
}

async function fetchCredentialFromCpaByName(config, credentialName, { fresh = false } = {}) {
  const credentials = await fetchAuthFilesFromCpa(config, {
    maxAgeMs: fresh ? -1 : CPA_AUTH_FILES_CACHE_TTL_MS,
  });
  const normalizedName = normalizeCredentialName(credentialName);
  const credential = credentials.find((item) => item.name === normalizedName) || null;
  if (!credential) {
    throw createRequestError(`CPA credential not found: ${normalizedName}`, 404, null);
  }
  return credential;
}

function restoreCredentialRuntimeEntry(cpaUrlKey, credentialName, previousEntry) {
  return mutateRuntimeState((state) => {
    if (!previousEntry) {
      removeCredentialRuntimeState(state, cpaUrlKey, credentialName);
      return null;
    }
    return setCredentialRuntimeState(state, cpaUrlKey, credentialName, previousEntry);
  });
}

async function updateCredentialStatusWithRuntimeState(config, {
  cpaUrlKey,
  credentialName,
  disabled,
  runtimeStatePatch,
  knownPreviousDisabled,
  requireRuntimeOwnership = false,
  claimRuntimeOwnership = false,
  expectedProbeAtMs = null,
  expectedAuthIndex = '',
  requireExactProbeVersion = false,
  retryOnFailureAtMs = null,
}) {
  return runCredentialStatusOperation(cpaUrlKey, credentialName, async () => {
    const currentRuntimeState = readRuntimeState();
    const previousEntry = getCredentialRuntimeState(currentRuntimeState, cpaUrlKey, credentialName);
    const currentCredential = knownPreviousDisabled === undefined
      ? await fetchCredentialFromCpaByName(config, credentialName, { fresh: true })
      : null;
    const previousDisabled = knownPreviousDisabled === undefined
      ? Boolean(currentCredential?.disabled)
      : Boolean(knownPreviousDisabled);
    const currentAuthIndex = normalizeStringOrEmpty(
      currentCredential?.auth_index || expectedAuthIndex || runtimeStatePatch?.auth_index,
    );
    if (
      expectedAuthIndex
      && !isSameCredentialIdentity(currentCredential?.auth_index, expectedAuthIndex)
    ) {
      return {
        cpa_url: normalizeCpaUrlForArchive(cpaUrlKey),
        name: normalizeCredentialName(credentialName),
        disabled: previousDisabled,
        state: serializeRuntimeCredentialState(previousEntry),
        skipped: true,
        skip_reason: 'credential_identity_changed',
      };
    }
    const previousEntryForIdentity = isSameCredentialIdentity(previousEntry?.auth_index, currentAuthIndex)
      ? previousEntry
      : null;
    const resolvedRuntimeStatePatch = runtimeStatePatch
      ? {
        ...runtimeStatePatch,
        auth_index: currentAuthIndex,
      }
      : runtimeStatePatch;
    const patchProbeAtMs = normalizeNumberOrNull(resolvedRuntimeStatePatch?.last_probe_at);
    if (expectedProbeAtMs !== null && patchProbeAtMs !== null && patchProbeAtMs !== expectedProbeAtMs) {
      throw createRequestError('runtime probe timestamp does not match expected_probe_at_ms', 400, null);
    }
    const precondition = evaluateCredentialStatusTransitionPrecondition({
      previousDisabled,
      previousRuntimeState: previousEntryForIdentity,
      expectedProbeAtMs,
      requireRuntimeOwnership,
      claimRuntimeOwnership,
      requireExactProbeVersion,
    });
    if (precondition.skipped) {
      return {
        cpa_url: normalizeCpaUrlForArchive(cpaUrlKey),
        name: normalizeCredentialName(credentialName),
        disabled: previousDisabled,
        state: serializeRuntimeCredentialState(previousEntryForIdentity),
        skipped: true,
        skip_reason: precondition.reason,
      };
    }
    const effectiveRuntimeStatus = normalizeStringOrEmpty(
      resolvedRuntimeStatePatch?.last_status || previousEntryForIdentity?.last_status,
    );
    if (resolvedRuntimeStatePatch?.archived_by_runtime && !shouldAutoArchive(effectiveRuntimeStatus)) {
      throw createRequestError('runtime archive ownership can only be claimed from an automatic archive probe result', 409, null);
    }
    if (claimRuntimeOwnership && !shouldAutoDisable(effectiveRuntimeStatus)) {
      throw createRequestError('runtime ownership can only be claimed from an automatic disable probe result', 409, null);
    }
    let transition;
    try {
      transition = await executeCredentialStatusTransaction({
        previousDisabled,
        targetDisabled: Boolean(disabled),
        previousRuntimeState: previousEntryForIdentity,
        runtimeStatePatch: resolvedRuntimeStatePatch,
        applyCredentialStatus: (nextDisabled) => updateCredentialDisabledStatus(config, credentialName, nextDisabled),
        applyRuntimeState: (patch) => patchCredentialRuntimeStateUnlocked(cpaUrlKey, credentialName, patch),
        restoreRuntimeState: (entry) => restoreCredentialRuntimeEntry(cpaUrlKey, credentialName, entry),
        readCredentialDisabled: async () => {
          invalidateCpaAuthFilesCache(config);
          return Boolean((await fetchCredentialFromCpaByName(config, credentialName, { fresh: true })).disabled);
        },
      });
    } catch (error) {
      const retryAtMs = normalizeNumberOrNull(retryOnFailureAtMs);
      if (retryAtMs !== null && retryAtMs > 0) {
        await patchCredentialRuntimeStateUnlocked(cpaUrlKey, credentialName, {
          auth_index: currentAuthIndex,
          next_probe_at_ms: retryAtMs,
        });
      }
      throw error;
    }
    if (resolvedRuntimeStatePatch?.archived_by_runtime === false) {
      try {
        await removeArchiveNamesSerialized(cpaUrlKey, [credentialName]);
      } catch (error) {
        const retryAtMs = normalizeNumberOrNull(retryOnFailureAtMs);
        if (retryAtMs !== null && retryAtMs > 0) {
          await patchCredentialRuntimeStateUnlocked(cpaUrlKey, credentialName, {
            auth_index: currentAuthIndex,
            next_probe_at_ms: retryAtMs,
          });
        }
        const archiveError = new Error(`Credential status changed but archive cleanup failed: ${String(error?.message || error)}`);
        archiveError.transition = {
          rolled_back: false,
          inconsistent: true,
          rollback_error: String(error?.message || error),
        };
        throw archiveError;
      }
    }
    return {
      cpa_url: normalizeCpaUrlForArchive(cpaUrlKey),
      name: normalizeCredentialName(credentialName),
      disabled: transition.disabled,
      state: serializeRuntimeCredentialState(transition.state),
    };
  });
}

function resolveCredentialDueAtMs(credential, runtimeEntry, normalIntervalMs) {
  if (!isSameCredentialIdentity(runtimeEntry?.auth_index, credential?.auth_index)) {
    return 0;
  }
  if (runtimeEntry?.next_probe_at_ms) {
    return runtimeEntry.next_probe_at_ms;
  }
  if (runtimeEntry?.last_probe_at) {
    return runtimeEntry.last_probe_at + normalIntervalMs;
  }
  return 0;
}

function resolveRuntimeProbeStart(cpaUrlKey, credential, normalIntervalMs) {
  return runCredentialStatusOperation(cpaUrlKey, credential?.name, () => {
    const latestEntry = getCredentialRuntimeState(readRuntimeState(), cpaUrlKey, credential?.name);
    return {
      shouldStart: canProbeCredentialInRuntime(credential, latestEntry || {})
        && resolveCredentialDueAtMs(credential, latestEntry, normalIntervalMs) <= Date.now(),
      requireRuntimeOwnership: hasRuntimeOwnershipForCredential(credential, latestEntry),
    };
  });
}

function upsertArchiveName(store, cpaUrlKey, credentialName) {
  return upsertArchiveEntry(store, cpaUrlKey, {
    name: credentialName,
    archived_at: Date.now(),
  });
}

function removeArchiveNames(store, cpaUrlKey, credentialNames) {
  const removing = new Set(normalizeArchiveNames(credentialNames));
  const currentEntries = getArchiveEntries(store, cpaUrlKey);
  const nextEntries = currentEntries.filter((item) => !removing.has(item.name));
  setArchiveEntries(store, cpaUrlKey, nextEntries);
  return {
    entries: nextEntries,
    removed: currentEntries.length - nextEntries.length,
  };
}

function removeArchiveNamesSerialized(cpaUrlKey, credentialNames) {
  return mutateArchiveStore((store) => removeArchiveNames(store, cpaUrlKey, credentialNames));
}

function addRuntimeOwnedArchiveName(config, cpaUrlKey, credentialName, expectedProbeAtMs, expectedAuthIndex) {
  return runCredentialStatusOperation(cpaUrlKey, credentialName, async () => {
    let currentCredential;
    try {
      currentCredential = await fetchCredentialFromCpaByName(config, credentialName, { fresh: true });
    } catch (error) {
      if (Number(error?.response?.status) === 404) {
        return { committed: false, added: false };
      }
      throw error;
    }
    if (!isSameCredentialIdentity(currentCredential?.auth_index, expectedAuthIndex)) {
      return { committed: false, added: false };
    }
    const runtimeEntry = getCredentialRuntimeState(readRuntimeState(), cpaUrlKey, credentialName);
    if (!canCommitRuntimeArchive(runtimeEntry, expectedProbeAtMs)) {
      return { committed: false, added: false };
    }
    const added = await mutateArchiveStore((store) => upsertArchiveName(store, cpaUrlKey, credentialName));
    return { committed: true, added };
  });
}

function formatRuntimeTime(ms) {
  const value = normalizeNumberOrNull(ms);
  if (value === null || value <= 0) return '';
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : '';
}

function formatProbeDetail(response) {
  const toPrettyText = (value) => {
    if (typeof value === 'string') return value;
    if (value === null || value === undefined) return '';
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  };

  const parts = [
    `status_code: ${Number(response?.status_code) || 0}`,
    `body:\n${toPrettyText(response?.body) || '(empty)'}`,
  ];
  const errText = toPrettyText(response?.error);
  if (errText) {
    parts.push(`error:\n${errText}`);
  }
  return parts.join('\n\n');
}

function buildRuntimeProbeStatePatch(probeResult, probeResponse, overrides = {}) {
  return {
    provider: normalizeStringOrEmpty(overrides.provider),
    auth_index: normalizeStringOrEmpty(overrides.auth_index),
    last_status: normalizeStringOrEmpty(probeResult?.status),
    last_reason: normalizeStringOrEmpty(probeResult?.reason),
    last_probe_at: normalizeNumberOrNull(overrides.last_probe_at ?? Date.now()),
    last_probe_detail: normalizeStringOrEmpty(overrides.last_probe_detail ?? formatProbeDetail(probeResponse)),
    last_reset_at: normalizeNumberOrNull(probeResult?.quota?.resetAt ?? null),
    last_quota_source: normalizeStringOrEmpty(probeResult?.quota?.source ?? ''),
    last_quota_used_percent: normalizeNumberOrNull(probeResult?.quota?.usedPercent ?? null),
    last_quota_cards: Array.isArray(probeResult?.quota?.cards) ? probeResult.quota.cards : [],
  };
}

function normalizeArchiveNames(names) {
  return normalizeArchiveEntries(names).map((item) => item.name);
}

function normalizeArchiveTimestamp(value) {
  const numeric = normalizeNumberOrNull(value);
  if (numeric === null || numeric <= 0) return null;
  return numeric;
}

function normalizeArchiveEntry(value) {
  if (typeof value === 'string') {
    const name = normalizeCredentialName(value);
    return name ? { name, archived_at: null } : null;
  }
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  if (!source) return null;
  const name = normalizeCredentialName(source.name);
  if (!name) return null;
  return {
    name,
    archived_at: normalizeArchiveTimestamp(source.archived_at),
  };
}

function normalizeArchiveEntries(entries) {
  if (!Array.isArray(entries)) return [];
  const mergedByName = new Map();
  entries.forEach((item) => {
    const normalized = normalizeArchiveEntry(item);
    if (!normalized) return;
    const existing = mergedByName.get(normalized.name) || null;
    if (!existing) {
      mergedByName.set(normalized.name, normalized);
      return;
    }
    const existingAt = normalizeArchiveTimestamp(existing.archived_at);
    const nextAt = normalizeArchiveTimestamp(normalized.archived_at);
    mergedByName.set(normalized.name, {
      name: normalized.name,
      archived_at: nextAt ?? existingAt ?? null,
    });
  });
  return Array.from(mergedByName.values()).sort((left, right) => {
    const leftAt = normalizeArchiveTimestamp(left.archived_at) || 0;
    const rightAt = normalizeArchiveTimestamp(right.archived_at) || 0;
    if (leftAt !== rightAt) {
      return rightAt - leftAt;
    }
    return left.name.localeCompare(right.name);
  });
}

function normalizeCredentialName(rawName) {
  return String(rawName || '').trim();
}

function normalizeCpaUrlForArchive(rawUrl, fallbackUrl = '') {
  const value = String(rawUrl || fallbackUrl || '').trim().replace(/\/+$/, '');
  return value || '__default__';
}

function resolveConfiguredCpaUrlKey(config, requestedUrl = '') {
  const configuredKey = normalizeCpaUrlForArchive(normalizeCpaBaseUrl(config?.cpa_url));
  const requestedValue = normalizeCpaBaseUrl(requestedUrl);
  if (requestedValue && normalizeCpaUrlForArchive(requestedValue) !== configuredKey) {
    throw createRequestError('cpa_url does not match the configured CPA endpoint', 400, null);
  }
  return configuredKey;
}

function getArchiveNames(store, cpaUrlKey) {
  const items = store?.by_cpa_url?.[cpaUrlKey];
  return getArchiveEntries(store, cpaUrlKey).map((item) => item.name);
}

function getArchiveEntries(store, cpaUrlKey) {
  const items = store?.by_cpa_url?.[cpaUrlKey];
  if (!Array.isArray(items)) return [];
  return normalizeArchiveEntries(items);
}

function setArchiveNames(store, cpaUrlKey, names) {
  const next = normalizeArchiveEntries(
    normalizeArchiveNames(names).map((name) => ({ name, archived_at: null })),
  );
  if (!store.by_cpa_url || typeof store.by_cpa_url !== 'object') {
    store.by_cpa_url = {};
  }
  store.by_cpa_url[cpaUrlKey] = next;
  return next;
}

function setArchiveEntries(store, cpaUrlKey, entries) {
  const next = normalizeArchiveEntries(entries);
  if (!store.by_cpa_url || typeof store.by_cpa_url !== 'object') {
    store.by_cpa_url = {};
  }
  store.by_cpa_url[cpaUrlKey] = next;
  return next;
}

function upsertArchiveEntry(store, cpaUrlKey, entry) {
  const normalizedEntry = normalizeArchiveEntry(entry);
  if (!normalizedEntry) return false;
  const currentEntries = getArchiveEntries(store, cpaUrlKey);
  const exists = currentEntries.some((item) => item.name === normalizedEntry.name);
  if (exists) {
    return false;
  }
  setArchiveEntries(store, cpaUrlKey, [...currentEntries, normalizedEntry]);
  return true;
}

function getRuntimeBucket(store, cpaUrlKey, { createIfMissing = false } = {}) {
  const normalizedKey = normalizeCpaUrlForArchive(cpaUrlKey);
  if (!store.by_cpa_url || typeof store.by_cpa_url !== 'object') {
    store.by_cpa_url = {};
  }
  let bucket = store.by_cpa_url[normalizedKey];
  if (!bucket && createIfMissing) {
    bucket = normalizeRuntimeBucket({});
    store.by_cpa_url[normalizedKey] = bucket;
  }
  if (!bucket) return null;
  return normalizeRuntimeBucket(bucket);
}

function replaceRuntimeBucket(store, cpaUrlKey, bucket) {
  const normalizedKey = normalizeCpaUrlForArchive(cpaUrlKey);
  if (!store.by_cpa_url || typeof store.by_cpa_url !== 'object') {
    store.by_cpa_url = {};
  }
  const normalizedBucket = normalizeRuntimeBucket(bucket);
  store.by_cpa_url[normalizedKey] = normalizedBucket;
  return normalizedBucket;
}

function getCredentialRuntimeState(store, cpaUrlKey, credentialName) {
  const bucket = getRuntimeBucket(store, cpaUrlKey, { createIfMissing: false });
  if (!bucket) return null;
  const normalizedName = normalizeCredentialName(credentialName);
  if (!normalizedName) return null;
  const entry = bucket.credentials[normalizedName];
  return entry ? normalizeCredentialRuntimeEntry(entry) : null;
}

function setCredentialRuntimeState(store, cpaUrlKey, credentialName, nextPartialState) {
  const normalizedName = normalizeCredentialName(credentialName);
  if (!normalizedName) {
    throw new Error('credential name is required');
  }
  const bucket = getRuntimeBucket(store, cpaUrlKey, { createIfMissing: true }) || normalizeRuntimeBucket({});
  const current = bucket.credentials[normalizedName] || normalizeCredentialRuntimeEntry({});
  const next = normalizeCredentialRuntimeEntry({
    ...current,
    ...(nextPartialState && typeof nextPartialState === 'object' ? nextPartialState : {}),
  });
  bucket.credentials[normalizedName] = next;
  replaceRuntimeBucket(store, cpaUrlKey, bucket);
  return next;
}

function removeCredentialRuntimeState(store, cpaUrlKey, credentialName) {
  const normalizedName = normalizeCredentialName(credentialName);
  if (!normalizedName) return false;
  const bucket = getRuntimeBucket(store, cpaUrlKey, { createIfMissing: false });
  if (!bucket || !bucket.credentials[normalizedName]) return false;
  delete bucket.credentials[normalizedName];
  replaceRuntimeBucket(store, cpaUrlKey, bucket);
  return true;
}

function buildRuntimeStatusPayload(config) {
  const runtimeState = readRuntimeState();
  const cpaUrlKey = normalizeCpaUrlForArchive(config?.cpa_url, config?.cpa_url);
  const bucket = getRuntimeBucket(runtimeState, cpaUrlKey, { createIfMissing: false }) || normalizeRuntimeBucket({});
  const credentialStates = {};

  Object.entries(bucket.credentials).forEach(([name, entry]) => {
    credentialStates[name] = serializeRuntimeCredentialState(entry);
  });

  const configEnabled = parseBoolSafe(config?.auto_probe_enabled, false);
  const managementKey = String(config?.management_key || '').trim();
  const hasRuntimeConfig = Boolean(
    normalizeCpaBaseUrl(config?.cpa_url)
    && isAuthorizedManagementKey(managementKey, managementKey),
  );

  return {
    cpa_url: cpaUrlKey,
    runtime: {
      wake_interval_ms: RUNTIME_WAKE_INTERVAL_MS,
      auto_probe_enabled: configEnabled,
      has_runtime_config: hasRuntimeConfig,
      backend_automation_active: configEnabled && hasRuntimeConfig,
      cycle_in_progress: normalizeBoolean(runtimeState.worker?.cycle_in_progress, false),
      last_cycle_started_at: normalizeNumberOrNull(runtimeState.worker?.last_cycle_started_at),
      last_cycle_started_at_iso: formatRuntimeTime(runtimeState.worker?.last_cycle_started_at),
      last_cycle_finished_at: normalizeNumberOrNull(runtimeState.worker?.last_cycle_finished_at),
      last_cycle_finished_at_iso: formatRuntimeTime(runtimeState.worker?.last_cycle_finished_at),
      last_error: normalizeStringOrEmpty(runtimeState.worker?.last_error),
      probe_cursor_name: normalizeStringOrEmpty(runtimeState.worker?.probe_cursor_name),
      last_probe_count: normalizeNumberOrNull(runtimeState.worker?.last_probe_count) ?? 0,
    },
    credentials: credentialStates,
  };
}

function serializeRuntimeCredentialState(entry) {
  const normalized = normalizeCredentialRuntimeEntry(entry || {});
  return {
    ...normalized,
    last_probe_at_iso: formatRuntimeTime(normalized.last_probe_at),
  };
}

async function runBackendAutomationCycle() {
  if (runtimeScheduler.cycleInProgress) {
    return;
  }

  runtimeScheduler.cycleInProgress = true;
  const cycleStartedAt = Date.now();

  try {
    await patchRuntimeWorkerState({
      cycle_in_progress: true,
      last_cycle_started_at: cycleStartedAt,
      last_error: '',
    });
    const config = readConfig();
    const autoProbeEnabled = parseBoolSafe(config.auto_probe_enabled, false);
    const cpaBaseUrl = normalizeCpaBaseUrl(config.cpa_url);
    const managementKey = String(config.management_key || '').trim();

    if (!autoProbeEnabled || !cpaBaseUrl || !isAuthorizedManagementKey(managementKey, managementKey)) {
      await patchRuntimeWorkerState({
        cycle_in_progress: false,
        last_cycle_finished_at: Date.now(),
        last_error: '',
      });
      return;
    }

    const normalIntervalMs = Math.max(1, parseIntSafe(config.auto_probe_interval_minutes, 60)) * 60 * 1000;
    const autoProbeBatchSize = Math.max(1, parseIntSafe(config.auto_probe_batch_size, AUTO_PROBE_BATCH_SIZE_DEFAULT));
    const cpaUrlKey = normalizeCpaUrlForArchive(cpaBaseUrl, cpaBaseUrl);
    const credentials = await fetchAuthFilesFromCpa(config);
    const planningState = readRuntimeState();
    const bucket = getRuntimeBucket(planningState, cpaUrlKey, { createIfMissing: false }) || normalizeRuntimeBucket({});
    const archivedNameSet = new Set(getArchiveNames(readArchiveStore(), cpaUrlKey));
    const nowMs = Date.now();
    const bucketCredentials = bucket.credentials || {};
    const probeCandidates = credentials.filter((credential) => canProbeCredentialInRuntime(
      credential,
      bucketCredentials[credential.name] || {},
    ));
    const probePlan = selectCredentialsForProbe(probeCandidates, {
      archivedNameSet,
      bucketCredentials,
      nowMs,
      normalIntervalMs,
      cursorName: planningState.worker?.probe_cursor_name,
      maxPerCycle: autoProbeBatchSize,
      resolveDueAtMs: resolveCredentialDueAtMs,
    });
    const credentialsToProbe = probePlan.selected;

    const processCredential = async (credential) => {
      if (!credential.name || archivedNameSet.has(credential.name)) {
        return;
      }
      if (getArchiveNames(readArchiveStore(), cpaUrlKey).includes(credential.name)) {
        return;
      }
      const probeStart = await resolveRuntimeProbeStart(cpaUrlKey, credential, normalIntervalMs);
      if (!probeStart.shouldStart) {
        return;
      }
      const requireExistingRuntimeOwnership = probeStart.requireRuntimeOwnership;

      let probeResponse;
      let probeResult;
      try {
        probeResponse = await probeCredentialFromCpa(config, credential);
      } catch (error) {
        probeResponse = toProbeErrorResponse(error);
      }
      probeResult = classifyProviderProbe(credential.provider, probeResponse, {
        codexQuotaDisableRemainingPercent: parseIntSafe(config.codex_quota_disable_remaining_percent, 10),
      });

      const probeAt = Date.now();
      const nextBaseState = buildRuntimeProbeStatePatch(probeResult, probeResponse, {
        provider: credential.provider,
        auth_index: credential.auth_index,
        last_probe_at: probeAt,
      });

      if (probeResult.status === 'active') {
        if (requireExistingRuntimeOwnership) {
          const transition = await updateCredentialStatusWithRuntimeState(config, {
            cpaUrlKey,
            credentialName: credential.name,
            disabled: false,
            runtimeStatePatch: {
              ...nextBaseState,
              next_probe_at_ms: probeAt + normalIntervalMs,
              archived_by_runtime: false,
              disabled_by_runtime: false,
            },
            requireRuntimeOwnership: true,
            expectedProbeAtMs: probeAt,
            expectedAuthIndex: credential.auth_index,
            retryOnFailureAtMs: Date.now() + AUTOMATION_RETRY_DELAY_MS,
          });
          if (transition.skipped) {
            const clearRuntimeOwnership = transition.skip_reason === 'credential_manually_disabled'
              || transition.skip_reason === 'runtime_ownership_missing';
            await patchCredentialRuntimeStateForCredential(config, cpaUrlKey, credential, {
              ...nextBaseState,
              next_probe_at_ms: probeAt + normalIntervalMs,
              archived_by_runtime: false,
              ...(clearRuntimeOwnership ? { disabled_by_runtime: false } : {}),
            }, { rejectOlderProbe: true });
          }
        } else {
          await patchCredentialRuntimeStateForCredential(config, cpaUrlKey, credential, {
            ...nextBaseState,
            next_probe_at_ms: probeAt + normalIntervalMs,
            archived_by_runtime: false,
            disabled_by_runtime: false,
          }, { rejectOlderProbe: true });
        }
        return;
      }

      if (shouldAutoArchive(probeResult.status)) {
        const transition = await updateCredentialStatusWithRuntimeState(config, {
          cpaUrlKey,
          credentialName: credential.name,
          disabled: true,
          runtimeStatePatch: {
            ...nextBaseState,
            next_probe_at_ms: null,
            archived_by_runtime: true,
            disabled_by_runtime: true,
          },
          claimRuntimeOwnership: !requireExistingRuntimeOwnership,
          requireRuntimeOwnership: requireExistingRuntimeOwnership,
          expectedProbeAtMs: probeAt,
          expectedAuthIndex: credential.auth_index,
          retryOnFailureAtMs: Date.now() + AUTOMATION_RETRY_DELAY_MS,
        });
        if (transition.skipped) {
          const clearRuntimeOwnership = transition.skip_reason === 'credential_manually_disabled'
            || transition.skip_reason === 'runtime_ownership_missing';
          await patchCredentialRuntimeStateForCredential(config, cpaUrlKey, credential, {
            ...nextBaseState,
            next_probe_at_ms: probeAt + normalIntervalMs,
            archived_by_runtime: false,
            ...(clearRuntimeOwnership ? { disabled_by_runtime: false } : {}),
          }, { rejectOlderProbe: true });
          return;
        }
        try {
          const archiveCommit = await addRuntimeOwnedArchiveName(
            config,
            cpaUrlKey,
            credential.name,
            probeAt,
            credential.auth_index,
          );
          if (archiveCommit.committed) {
            archivedNameSet.add(credential.name);
          }
        } catch (error) {
          await updateCredentialStatusWithRuntimeState(config, {
            cpaUrlKey,
            credentialName: credential.name,
            disabled: true,
            runtimeStatePatch: {
              archived_by_runtime: false,
              disabled_by_runtime: true,
              next_probe_at_ms: Date.now() + AUTOMATION_RETRY_DELAY_MS,
            },
            requireRuntimeOwnership: true,
            expectedProbeAtMs: probeAt,
            expectedAuthIndex: credential.auth_index,
            retryOnFailureAtMs: Date.now() + AUTOMATION_RETRY_DELAY_MS,
          });
          throw error;
        }
        return;
      }

      if (shouldAutoDisable(probeResult.status)) {
        const nextProbeAtMs = resolveRuntimeNextProbeAtMs(probeResult.status, probeResult.quota, normalIntervalMs, probeAt);
        const transition = await updateCredentialStatusWithRuntimeState(config, {
          cpaUrlKey,
          credentialName: credential.name,
          disabled: true,
          runtimeStatePatch: {
            ...nextBaseState,
            next_probe_at_ms: nextProbeAtMs,
            archived_by_runtime: false,
            disabled_by_runtime: true,
          },
          claimRuntimeOwnership: !requireExistingRuntimeOwnership,
          requireRuntimeOwnership: requireExistingRuntimeOwnership,
          expectedProbeAtMs: probeAt,
          expectedAuthIndex: credential.auth_index,
          retryOnFailureAtMs: Date.now() + AUTOMATION_RETRY_DELAY_MS,
        });
        if (transition.skipped) {
          const clearRuntimeOwnership = transition.skip_reason === 'credential_manually_disabled'
            || transition.skip_reason === 'runtime_ownership_missing';
          await patchCredentialRuntimeStateForCredential(config, cpaUrlKey, credential, {
            ...nextBaseState,
            next_probe_at_ms: nextProbeAtMs,
            archived_by_runtime: false,
            ...(clearRuntimeOwnership ? { disabled_by_runtime: false } : {}),
          }, { rejectOlderProbe: true });
        }
        return;
      }

      await patchCredentialRuntimeStateForCredential(config, cpaUrlKey, credential, {
        ...nextBaseState,
        next_probe_at_ms: probeAt + normalIntervalMs,
        archived_by_runtime: false,
        disabled_by_runtime: requireExistingRuntimeOwnership,
      }, { rejectOlderProbe: true });
    };
    const probeSettled = await mapWithConcurrency(
      credentialsToProbe,
      Math.min(AUTO_PROBE_MAX_CONCURRENCY, autoProbeBatchSize),
      processCredential,
    );
    const failedProbe = probeSettled.find((item) => item.status === 'rejected');
    if (failedProbe) {
      throw failedProbe.reason;
    }

    await patchRuntimeWorkerState({
      cycle_in_progress: false,
      last_cycle_finished_at: Date.now(),
      last_error: '',
      probe_cursor_name: probePlan.nextCursorName,
      last_probe_count: credentialsToProbe.length,
    });
  } catch (error) {
    try {
      await patchRuntimeWorkerState({
        cycle_in_progress: false,
        last_cycle_finished_at: Date.now(),
        last_error: String(error?.message || error),
      });
    } catch (stateError) {
      console.error('Failed to persist backend automation error state', stateError);
    }
    console.error('Backend automation cycle failed', error);
  } finally {
    runtimeScheduler.cycleInProgress = false;
  }
}

function startBackendAutomationScheduler() {
  if (runtimeScheduler.started) {
    return;
  }
  runtimeScheduler.started = true;
  runtimeScheduler.timer = setInterval(() => {
    void runBackendAutomationCycle();
  }, RUNTIME_WAKE_INTERVAL_MS);
  void runBackendAutomationCycle();
}

// 1. Verify password & login (returns config if matched)
app.post('/api/auth/login', (req, res) => {
  const { password } = req.body;
  const config = readConfig();
  if (isAuthorized(password, config)) {
    res.json({ ok: true, config });
  } else {
    res.status(401).json({ ok: false, error: 'Unauthorized: Invalid management key' });
  }
});

// 2. Get current config (requires password authentication)
// In a real production app we'd use JWT, but since password in localStorage is fine here
app.post('/api/config', (req, res) => {
  const config = readConfig();
  if (isAuthorized(resolveRequestSecret(req), config)) {
    res.json({ ok: true, config });
  } else {
    res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
});

// 3. Update config (requires current password or new password)
app.post('/api/config/update', (req, res) => {
  const { old_password, new_config } = req.body;
  const config = readConfig();
  const nextConfig = new_config && typeof new_config === 'object' && !Array.isArray(new_config) ? new_config : {};

  // To update config, they must provide the correct current password
  if (isAuthorized(old_password, config)) {
    try {
      writeConfig({
        cpa_url: nextConfig.cpa_url !== undefined ? nextConfig.cpa_url : config.cpa_url,
        management_key: nextConfig.management_key !== undefined ? nextConfig.management_key : config.management_key,
        auto_probe_enabled: nextConfig.auto_probe_enabled !== undefined ? nextConfig.auto_probe_enabled : config.auto_probe_enabled,
        auto_probe_interval_minutes: nextConfig.auto_probe_interval_minutes !== undefined
          ? nextConfig.auto_probe_interval_minutes
          : config.auto_probe_interval_minutes,
        auto_probe_batch_size: nextConfig.auto_probe_batch_size !== undefined
          ? nextConfig.auto_probe_batch_size
          : config.auto_probe_batch_size,
        codex_quota_disable_remaining_percent: nextConfig.codex_quota_disable_remaining_percent !== undefined
          ? nextConfig.codex_quota_disable_remaining_percent
          : config.codex_quota_disable_remaining_percent,
      });
      res.json({ ok: true });
    } catch (e) {
      console.error('Update config failed', e);
      res.status(500).json({ ok: false, error: 'Failed to write config.yaml' });
    }
  } else {
    res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
});

app.post('/api/remote/push-test', async (req, res) => {
  const config = readConfig();
  if (!isAuthorized(resolveRequestSecret(req), config)) {
    res.status(401).json({ ok: false, error: 'Unauthorized' });
    return;
  }

  try {
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    const targetConfig = {
      cpa_url: body.target_cpa_url !== undefined ? body.target_cpa_url : config.cpa_url,
      management_key: body.target_management_key !== undefined ? body.target_management_key : config.management_key,
    };
    const payload = await runRemotePushSmokeTest(targetConfig);
    res.json({ ok: true, payload });
  } catch (error) {
    const responseStatus = Number(error?.response?.status) || 0;
    res.status(responseStatus >= 400 && responseStatus < 500 ? responseStatus : 502).json({
      ok: false,
      error: String(error?.message || error),
      payload: {
        target_cpa_url: normalizeCpaBaseUrl(req.body?.target_cpa_url || config.cpa_url),
        read_ok: false,
        auth_files_total: 0,
        push_test: {
          attempted: false,
          upload_ok: false,
          cleanup_ok: false,
          upload_status: null,
          cleanup_status: null,
          upload_mode: 'multipart:file',
          error: String(error?.message || error),
        },
      },
    });
  }
});

app.get('/api/cpa/auth-files', async (req, res) => {
  const config = readConfig();
  if (!isAuthorized(resolveRequestSecret(req), config)) {
    res.status(401).json({ ok: false, error: 'Unauthorized' });
    return;
  }

  try {
    const files = await fetchAuthFilesFromCpa(config);
    res.json({ files });
  } catch (error) {
    res.status(502).json({
      ok: false,
      error: String(error?.message || error),
      payload: error?.response?.data ?? null,
    });
  }
});

app.patch('/api/cpa/auth-files/status', async (req, res) => {
  const config = readConfig();
  if (!isAuthorized(resolveRequestSecret(req), config)) {
    res.status(401).json({ ok: false, error: 'Unauthorized' });
    return;
  }

  try {
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    const name = normalizeCredentialName(body.name);
    if (!name) {
      res.status(400).json({ ok: false, error: 'name is required' });
      return;
    }
    const disabled = Boolean(body.disabled);
    const cpaUrlKey = resolveConfiguredCpaUrlKey(config, body.cpa_url);
    const requestedRuntimeState = body.runtime_state && typeof body.runtime_state === 'object' && !Array.isArray(body.runtime_state)
      ? body.runtime_state
      : {};
    const allowedRuntimeStateFields = new Set(['disabled_by_runtime', 'archived_by_runtime', 'next_probe_at_ms']);
    const unsupportedRuntimeStateFields = Object.keys(requestedRuntimeState)
      .filter((field) => !allowedRuntimeStateFields.has(field));
    if (unsupportedRuntimeStateFields.length > 0) {
      res.status(400).json({
        ok: false,
        error: `runtime_state contains unsupported status-transition fields: ${unsupportedRuntimeStateFields.join(', ')}`,
      });
      return;
    }
    const runtimeStatePatch = {
      ...requestedRuntimeState,
      disabled_by_runtime: normalizeBoolean(requestedRuntimeState.disabled_by_runtime, false),
      archived_by_runtime: normalizeBoolean(requestedRuntimeState.archived_by_runtime, false),
      next_probe_at_ms: Object.hasOwn(requestedRuntimeState, 'next_probe_at_ms')
        ? normalizeNumberOrNull(requestedRuntimeState.next_probe_at_ms)
        : null,
    };
    const requireRuntimeOwnership = Boolean(body.require_runtime_ownership);
    const claimRuntimeOwnership = runtimeStatePatch.disabled_by_runtime && !requireRuntimeOwnership;
    const expectedProbeAtMs = normalizeNumberOrNull(body.expected_probe_at_ms);
    const expectedAuthIndex = normalizeStringOrEmpty(body.expected_auth_index);
    if (!expectedAuthIndex) {
      res.status(400).json({ ok: false, error: 'expected_auth_index is required for credential status transitions' });
      return;
    }
    if ((claimRuntimeOwnership || requireRuntimeOwnership) && (expectedProbeAtMs === null || expectedProbeAtMs <= 0)) {
      res.status(400).json({ ok: false, error: 'expected_probe_at_ms is required for automatic status transitions' });
      return;
    }
    if (runtimeStatePatch.disabled_by_runtime && !disabled) {
      res.status(400).json({ ok: false, error: 'runtime ownership can only be claimed while disabling a credential' });
      return;
    }
    if (runtimeStatePatch.archived_by_runtime && (!disabled || !runtimeStatePatch.disabled_by_runtime)) {
      res.status(400).json({ ok: false, error: 'runtime archive ownership requires a runtime-owned disabled credential' });
      return;
    }
    const payload = await updateCredentialStatusWithRuntimeState(config, {
      cpaUrlKey,
      credentialName: name,
      disabled,
      runtimeStatePatch,
      claimRuntimeOwnership,
      requireRuntimeOwnership,
      expectedProbeAtMs,
      expectedAuthIndex,
      requireExactProbeVersion: claimRuntimeOwnership || requireRuntimeOwnership,
    });
    if (payload.skipped && payload.skip_reason === 'credential_identity_changed') {
      res.status(409).json({ ok: false, error: 'credential identity changed before status transition', payload });
      return;
    }
    res.json({ ok: true, payload });
  } catch (error) {
    const responseStatus = Number(error?.response?.status) || 0;
    res.status(responseStatus >= 400 && responseStatus < 500 ? responseStatus : 502).json({
      ok: false,
      error: String(error?.message || error),
      payload: error?.response?.data ?? null,
      transition: error?.transition ?? null,
    });
  }
});

app.delete('/api/cpa/auth-files', async (req, res) => {
  const config = readConfig();
  if (!isAuthorized(resolveRequestSecret(req), config)) {
    res.status(401).json({ ok: false, error: 'Unauthorized' });
    return;
  }

  try {
    const name = normalizeCredentialName(req.query?.name);
    if (!name) {
      res.status(400).json({ ok: false, error: 'name is required' });
      return;
    }
    const expectedAuthIndex = normalizeStringOrEmpty(req.query?.expected_auth_index);
    if (!expectedAuthIndex) {
      res.status(400).json({ ok: false, error: 'expected_auth_index is required' });
      return;
    }
    const cpaUrlKey = resolveConfiguredCpaUrlKey(config);
    const deletion = await runCredentialStatusOperation(cpaUrlKey, name, async () => {
      let result = null;
      let notFound = false;
      try {
        const currentCredential = await fetchCredentialFromCpaByName(config, name, { fresh: true });
        if (!isSameCredentialIdentity(currentCredential?.auth_index, expectedAuthIndex)) {
          const runtimeEntry = getCredentialRuntimeState(readRuntimeState(), cpaUrlKey, name);
          if (!runtimeEntry?.auth_index || isSameCredentialIdentity(runtimeEntry.auth_index, expectedAuthIndex)) {
            await removeCredentialRuntimeStateUnlocked(cpaUrlKey, name);
          }
          throw createRequestError('credential identity changed before deletion', 409, null);
        }
        result = await deleteAuthFileFromCpa(config, name);
      } catch (error) {
        if (Number(error?.response?.status) !== 404) {
          throw error;
        }
        notFound = true;
        invalidateCpaAuthFilesCache(config);
      }
      await removeCredentialRuntimeStateUnlocked(cpaUrlKey, name);
      await removeArchiveNamesSerialized(cpaUrlKey, [name]);
      return { result, notFound };
    });
    res.json(deletion.notFound
      ? { ok: true, deleted: false, reason: 'not found on CPA' }
      : (deletion.result?.data ?? { ok: true }));
  } catch (error) {
    const responseStatus = Number(error?.response?.status) || 0;
    res.status(responseStatus >= 400 && responseStatus < 500 ? responseStatus : 502).json({
      ok: false,
      error: String(error?.message || error),
      payload: error?.response?.data ?? null,
    });
  }
});

app.post('/api/cpa/api-call', async (req, res) => {
  const config = readConfig();
  if (!isAuthorized(resolveRequestSecret(req), config)) {
    res.status(401).json({ ok: false, error: 'Unauthorized' });
    return;
  }

  try {
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    const probeResponse = await probeApiCallFromCpa(config, body);
    res.json(probeResponse);
  } catch (error) {
    res.status(502).json({
      ok: false,
      error: String(error?.message || error),
      payload: error?.response?.data ?? null,
    });
  }
});

app.post('/api/archive/list', async (req, res) => {
  const body = req.body || {};
  const config = readConfig();
  if (!isAuthorized(resolveRequestSecret(req), config)) {
    res.status(401).json({ ok: false, error: 'Unauthorized' });
    return;
  }
  try {
    const cpaUrlKey = resolveConfiguredCpaUrlKey(config, body.cpa_url);
    let cpaNames = null;
    try {
      const cpaFiles = await fetchAuthFilesFromCpa(config);
      cpaNames = new Set(cpaFiles.map((f) => normalizeCredentialName(f.name)));
    } catch {
      // CPA unreachable, return all archive entries as-is
    }
    const currentEntries = getArchiveEntries(readArchiveStore(), cpaUrlKey);
    const validEntries = cpaNames === null
      ? currentEntries
      : currentEntries.filter((item) => cpaNames.has(item.name));

    const names = validEntries.map((item) => item.name);
    res.json({
      ok: true,
      payload: {
        cpa_url: cpaUrlKey,
        names,
        entries: validEntries.map((item) => ({
          name: item.name,
          archived_at: normalizeArchiveTimestamp(item.archived_at),
          archived_at_iso: formatRuntimeTime(item.archived_at),
        })),
        total: names.length,
      },
    });
  } catch (error) {
    const responseStatus = Number(error?.response?.status) || 0;
    res.status(responseStatus >= 400 && responseStatus < 500 ? responseStatus : 500).json({ ok: false, error: String(error?.message || error) });
  }
});

app.post('/api/archive/add', async (req, res) => {
  const body = req.body || {};
  const config = readConfig();
  if (!isAuthorized(resolveRequestSecret(req), config)) {
    res.status(401).json({ ok: false, error: 'Unauthorized' });
    return;
  }
  try {
    const cpaUrlKey = resolveConfiguredCpaUrlKey(config, body.cpa_url);
    const incoming = normalizeArchiveNames(body.names);
    if (!incoming.length) {
      res.status(400).json({ ok: false, error: 'names is required' });
      return;
    }
    const requireRuntimeOwnership = Boolean(body.require_runtime_ownership);
    const expectedProbeAtMs = normalizeNumberOrNull(body.expected_probe_at_ms);
    const expectedAuthIndex = normalizeStringOrEmpty(body.expected_auth_index);
    if (requireRuntimeOwnership && (expectedProbeAtMs === null || expectedProbeAtMs <= 0)) {
      res.status(400).json({ ok: false, error: 'expected_probe_at_ms is required for automatic archive transitions' });
      return;
    }
    if (requireRuntimeOwnership && !expectedAuthIndex) {
      res.status(400).json({ ok: false, error: 'expected_auth_index is required for automatic archive transitions' });
      return;
    }
    let added = 0;
    let skipped = [];
    if (requireRuntimeOwnership) {
      const results = await Promise.all(incoming.map(async (name) => ({
        name,
        result: await addRuntimeOwnedArchiveName(config, cpaUrlKey, name, expectedProbeAtMs, expectedAuthIndex),
      })));
      added = results.filter((item) => item.result.added).length;
      skipped = results.filter((item) => !item.result.committed).map((item) => item.name);
    } else {
      const rawAuthIndices = body.auth_indices && typeof body.auth_indices === 'object' && !Array.isArray(body.auth_indices)
        ? body.auth_indices
        : {};
      const expectedAuthIndices = Object.fromEntries(incoming.map((name) => [
        name,
        normalizeStringOrEmpty(rawAuthIndices[name]),
      ]));
      const missingIdentities = incoming.filter((name) => !expectedAuthIndices[name]);
      if (missingIdentities.length > 0) {
        res.status(400).json({ ok: false, error: `auth_indices are required for: ${missingIdentities.join(', ')}` });
        return;
      }
      const manualCommit = await runCredentialStatusOperations(cpaUrlKey, incoming, async () => {
        const credentials = await fetchAuthFilesFromCpa(config, { maxAgeMs: -1 });
        const credentialsByName = new Map(credentials.map((credential) => [credential.name, credential]));
        const eligibleNames = incoming.filter((name) => {
          const credential = credentialsByName.get(name);
          return Boolean(credential?.disabled)
            && isSameCredentialIdentity(credential?.auth_index, expectedAuthIndices[name]);
        });
        const addedCount = await mutateArchiveStore((store) => eligibleNames.reduce(
          (count, name) => count + (upsertArchiveName(store, cpaUrlKey, name) ? 1 : 0),
          0,
        ));
        return {
          added: addedCount,
          skipped: incoming.filter((name) => !eligibleNames.includes(name)),
        };
      });
      added = manualCommit.added;
      skipped = manualCommit.skipped;
    }
    const mergedEntries = getArchiveEntries(readArchiveStore(), cpaUrlKey);
    const merged = mergedEntries.map((item) => item.name);
    res.json({
      ok: true,
      payload: {
        cpa_url: cpaUrlKey,
        names: merged,
        entries: mergedEntries.map((item) => ({
          name: item.name,
          archived_at: normalizeArchiveTimestamp(item.archived_at),
          archived_at_iso: formatRuntimeTime(item.archived_at),
        })),
        total: merged.length,
        added,
        skipped,
      },
    });
  } catch (error) {
    const responseStatus = Number(error?.response?.status) || 0;
    res.status(responseStatus >= 400 && responseStatus < 500 ? responseStatus : 500).json({ ok: false, error: String(error?.message || error) });
  }
});

app.post('/api/archive/remove', async (req, res) => {
  const body = req.body || {};
  const config = readConfig();
  if (!isAuthorized(resolveRequestSecret(req), config)) {
    res.status(401).json({ ok: false, error: 'Unauthorized' });
    return;
  }
  try {
    const cpaUrlKey = resolveConfiguredCpaUrlKey(config, body.cpa_url);
    const removing = normalizeArchiveNames(body.names);
    if (!removing.length) {
      res.status(400).json({ ok: false, error: 'names is required' });
      return;
    }
    const archiveMutation = await removeArchiveNamesSerialized(cpaUrlKey, removing);
    const nextEntries = archiveMutation.entries;
    const next = nextEntries.map((item) => item.name);
    res.json({
      ok: true,
      payload: {
        cpa_url: cpaUrlKey,
        names: next,
        entries: nextEntries.map((item) => ({
          name: item.name,
          archived_at: normalizeArchiveTimestamp(item.archived_at),
          archived_at_iso: formatRuntimeTime(item.archived_at),
        })),
        total: next.length,
        removed: archiveMutation.removed,
      },
    });
  } catch (error) {
    const responseStatus = Number(error?.response?.status) || 0;
    res.status(responseStatus >= 400 && responseStatus < 500 ? responseStatus : 500).json({ ok: false, error: String(error?.message || error) });
  }
});

app.get('/api/runtime/status', (req, res) => {
  const config = readConfig();
  if (!isAuthorized(resolveRequestSecret(req), config)) {
    res.status(401).json({ ok: false, error: 'Unauthorized' });
    return;
  }
  try {
    res.json({
      ok: true,
      payload: buildRuntimeStatusPayload(config),
    });
  } catch (error) {
    const responseStatus = Number(error?.response?.status) || 0;
    res.status(responseStatus >= 400 && responseStatus < 500 ? responseStatus : 500).json({ ok: false, error: String(error?.message || error) });
  }
});

app.get('/api/runtime/credential-state', (req, res) => {
  const config = readConfig();
  if (!isAuthorized(resolveRequestSecret(req), config)) {
    res.status(401).json({ ok: false, error: 'Unauthorized' });
    return;
  }
  try {
    const payload = buildRuntimeStatusPayload(config);
    res.json({
      ok: true,
      payload: {
        cpa_url: payload.cpa_url,
        credentials: payload.credentials,
      },
    });
  } catch (error) {
    const responseStatus = Number(error?.response?.status) || 0;
    res.status(responseStatus >= 400 && responseStatus < 500 ? responseStatus : 500).json({ ok: false, error: String(error?.message || error) });
  }
});

app.post('/api/runtime/credential-state/upsert', async (req, res) => {
  const config = readConfig();
  if (!isAuthorized(resolveRequestSecret(req), config)) {
    res.status(401).json({ ok: false, error: 'Unauthorized' });
    return;
  }

  try {
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    const cpaUrlKey = resolveConfiguredCpaUrlKey(config, body.cpa_url);
    const credentialName = normalizeCredentialName(body.name);
    if (!credentialName) {
      res.status(400).json({ ok: false, error: 'name is required' });
      return;
    }
    const expectedAuthIndex = normalizeStringOrEmpty(body.auth_index);
    if (!expectedAuthIndex) {
      res.status(400).json({ ok: false, error: 'auth_index is required' });
      return;
    }

    const statePatch = body.state && typeof body.state === 'object' && !Array.isArray(body.state) ? body.state : {};
    if (
      Object.hasOwn(statePatch, 'disabled_by_runtime')
      || Object.hasOwn(statePatch, 'archived_by_runtime')
      || Object.hasOwn(statePatch, 'auth_index')
    ) {
      res.status(400).json({ ok: false, error: 'runtime ownership and credential identity fields are server-managed' });
      return;
    }
    const nextEntry = await runCredentialStatusOperation(cpaUrlKey, credentialName, async () => {
      const currentCredential = await fetchCredentialFromCpaByName(config, credentialName, { fresh: true });
      if (!isSameCredentialIdentity(currentCredential?.auth_index, expectedAuthIndex)) {
        throw createRequestError('credential identity changed before runtime state persistence', 409, null);
      }
      return patchCredentialRuntimeStateUnlocked(cpaUrlKey, credentialName, {
        ...statePatch,
        auth_index: expectedAuthIndex,
      }, { rejectOlderProbe: true });
    });

    res.json({
      ok: true,
      payload: {
        cpa_url: cpaUrlKey,
        name: credentialName,
        state: serializeRuntimeCredentialState(nextEntry),
      },
    });
  } catch (error) {
    const responseStatus = Number(error?.response?.status) || 0;
    res.status(responseStatus >= 400 && responseStatus < 500 ? responseStatus : 500).json({ ok: false, error: String(error?.message || error) });
  }
});

app.use((err, req, res, next) => {
  if (!err) {
    next();
    return;
  }
  if (err.type === 'entity.too.large') {
    res.status(413).json({
      ok: false,
      error: 'request body too large; please split account content into smaller chunks',
    });
    return;
  }
  res.status(400).json({ ok: false, error: String(err?.message || 'bad request') });
});

// Serve frontend static files
app.use(express.static(path.join(__dirname, 'dist')));

// Fallback all other routes to React router
app.get(/^(?!\/api).+/, (req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

const backendLock = acquireProcessLock(BACKEND_SERVER_LOCK_PATH, {
  role: 'frontend-backend-server',
  port: PORT,
});

if (!backendLock.ok) {
  const existingPid = normalizeNumberOrNull(backendLock.existing?.pid);
  console.error(`[Backend] Refusing to start because another backend server instance is already running${existingPid ? ` (PID ${existingPid})` : ''}.`);
  process.exit(1);
}

backendServerLockHeld = true;
installBackendServerExitHandlers();
initializeConfigFile();

app.listen(PORT, () => {
  startBackendAutomationScheduler();
  console.log(`Backend config server is running on http://localhost:${PORT}`);
  console.log(`Backend automation scheduler wake interval: ${RUNTIME_WAKE_INTERVAL_MS}ms`);
});

