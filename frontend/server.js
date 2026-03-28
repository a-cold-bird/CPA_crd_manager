import express from 'express';
import cors from 'cors';
import fs from 'fs';
import yaml from 'js-yaml';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  classifyProviderProbe,
  shouldAutoArchive,
  shouldAutoDisable,
  toProbeErrorResponse,
} from './src/shared/providerRuntimeStrategies.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');
const ARCHIVE_STORE_PATH = path.join(PROJECT_ROOT, 'runtime', 'credential_archive.json');
const RUNTIME_STATE_PATH = path.join(PROJECT_ROOT, 'runtime', 'credential_runtime_state.json');
const REPLENISHMENT_STATUS_PATH = path.join(PROJECT_ROOT, 'runtime', 'replenishment_status.json');
const REPLENISHMENT_LOCK_PATH = path.join(PROJECT_ROOT, 'runtime', 'replenishment.lock');
const BACKEND_SERVER_LOCK_PATH = path.join(PROJECT_ROOT, 'runtime', 'frontend_server.lock');

const app = express();
const PORT = Number(process.env.CPA_BACKEND_PORT || process.env.API_PORT || 8333);
const DEFAULT_CONFIG_PATH = path.join(process.cwd(), 'config.yaml');
const CONFIG_PATH = path.resolve(process.env.CPA_CONFIG_FILE || DEFAULT_CONFIG_PATH);
const CONFIG_FALLBACK_PATH = path.join(process.cwd(), 'config.example.yaml');
const RUNTIME_WAKE_INTERVAL_MS = 30_000;
const CPA_REQUEST_TIMEOUT_MS = 20_000;
const MAIL_REQUEST_TIMEOUT_MS = 15_000;
const RATE_LIMIT_RETRY_MS = 30 * 60_000;
const RUNTIME_RECHECK_FLOOR_MS = 30_000;
const AUTO_REPLENISH_RESTART_GUARD_MS = 5 * 60_000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));

const runtimeScheduler = {
  started: false,
  startedAt: Date.now(),
  timer: null,
  cycleInProgress: false,
  replenishmentInProgress: false,
  replenishmentChild: null,
  replenishmentPid: null,
  replenishmentStopRequested: false,
};

let backendServerLockHeld = false;


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

function resolveReadableFilePath(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return '';
  }
  try {
    const stat = fs.statSync(filePath);
    if (stat.isFile()) {
      return filePath;
    }
    console.error(`Path exists but is not a file: ${filePath}`);
  } catch (error) {
    console.error(`Failed to stat path ${filePath}`, error);
  }
  return '';
}

function ensureWritableFilePath(filePath) {
  if (fs.existsSync(filePath)) {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) {
      throw new Error(`Path must be a file, but received: ${filePath}`);
    }
  }
}

// Helper to read config
function readConfig() {
  const defaults = {
    cpa_url: '',
    management_key: '',
    mail_api_base: '',
    mail_username: '',
    mail_password: '',
    mail_email_domain: '',
    mail_email_domains: '', // Added
    mail_randomize_from_list: true,
    codex_replenish_enabled: false, // Added
    codex_target_count: 5,
    codex_replenish_target_count: 5, // Added
    codex_replenish_threshold: 2, // Added
    codex_replenish_batch_size: 1,
    codex_replenish_worker_count: 1,
    codex_replenish_use_proxy: false, // Added
    codex_replenish_proxy_pool: '',
    auto_probe_enabled: false,
    auto_probe_interval_minutes: 60,
    codex_quota_disable_remaining_percent: 10,
  };
  const configPathToRead = resolveReadableConfigPath();
  if (!configPathToRead) {
    return defaults;
  }
  try {
    const file = fs.readFileSync(configPathToRead, 'utf8');
    const parsed = yaml.load(file);
    if (!parsed || typeof parsed !== 'object') {
      return defaults;
    }
    const normalizedTargetCount = resolveCodexReplenishTargetCount(parsed, 5);
    const normalizedMailEmailDomain = normalizeDomain(parsed.mail_email_domain || '');
    const normalizedMailEmailDomains = normalizeDomainListText(parsed.mail_email_domains, normalizedMailEmailDomain);
    return {
      ...defaults,
      ...parsed,
      mail_email_domain: normalizedMailEmailDomain,
      mail_email_domains: normalizedMailEmailDomains,
      mail_randomize_from_list: parseBoolSafe(parsed.mail_randomize_from_list, true),
      codex_replenish_enabled: parseBoolSafe(parsed.codex_replenish_enabled, false), // Added
      codex_replenish_target_count: normalizedTargetCount,
      codex_target_count: normalizedTargetCount,
      codex_replenish_threshold: normalizeCodexReplenishThreshold(parsed.codex_replenish_threshold, normalizedTargetCount, 2), // Added
      codex_replenish_batch_size: normalizeCodexReplenishBatchSize(parsed.codex_replenish_batch_size, 1),
      codex_replenish_worker_count: normalizeCodexReplenishWorkerCount(parsed.codex_replenish_worker_count, 1),
      codex_replenish_use_proxy: parseBoolSafe(parsed.codex_replenish_use_proxy, false), // Added
      codex_replenish_proxy_pool: String(parsed.codex_replenish_proxy_pool || ''),
    };
  } catch (e) {
    console.error('Failed to parse config.yaml', e);
    return defaults;
  }
}

// Helper to write config
function writeConfig(data) {
  if (fs.existsSync(CONFIG_PATH)) {
    const stat = fs.statSync(CONFIG_PATH);
    if (!stat.isFile()) {
      throw new Error(`CONFIG_PATH must be a file, but received: ${CONFIG_PATH}`);
    }
  }
  const current = readConfig();
  const merged = { ...current, ...data };
  const normalizedTargetCount = resolveCodexReplenishTargetCount(merged, 5);
  const normalizedThreshold = normalizeCodexReplenishThreshold(merged.codex_replenish_threshold, normalizedTargetCount, 2);
  const normalizedBatchSize = normalizeCodexReplenishBatchSize(merged.codex_replenish_batch_size, 1);
  const normalizedWorkerCount = normalizeCodexReplenishWorkerCount(merged.codex_replenish_worker_count, 1);
  const normalizedMailEmailDomain = normalizeDomain(merged.mail_email_domain || '');
  const normalizedMailEmailDomains = normalizeDomainListText(merged.mail_email_domains, normalizedMailEmailDomain);
  merged.codex_replenish_target_count = normalizedTargetCount;
  merged.codex_target_count = normalizedTargetCount;
  merged.codex_replenish_threshold = normalizedThreshold;
  merged.codex_replenish_batch_size = normalizedBatchSize;
  merged.codex_replenish_worker_count = normalizedWorkerCount;
  merged.mail_email_domain = normalizedMailEmailDomain;
  merged.mail_email_domains = normalizedMailEmailDomains;
  const str = yaml.dump(merged);
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, str, 'utf-8');
}

function isAuthorized(password, config) {
  return typeof password === 'string' && password === String(config.management_key || '');
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

function normalizeDomain(value) {
  return String(value || '').trim().toLowerCase().replace(/^@+/, '');
}

function normalizeDomainListText(value, fallbackDomain = '') {
  const items = typeof value === 'string'
    ? value.replace(/\r/g, '\n').split(/[\n,]+/)
    : Array.isArray(value)
      ? value
      : [];
  const domains = [];
  items.forEach((item) => {
    const normalized = normalizeDomain(item);
    if (normalized && !domains.includes(normalized)) {
      domains.push(normalized);
    }
  });
  const fallback = normalizeDomain(fallbackDomain);
  if (fallback && !domains.includes(fallback)) {
    domains.unshift(fallback);
  }
  return domains.join(', ');
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

function normalizeNonNegativeInteger(value, fallback = 0) {
  return Math.max(0, parseIntSafe(value, fallback));
}

function resolveCodexReplenishTargetCount(source, fallback = 5) {
  if (!source || typeof source !== 'object') {
    return fallback;
  }
  if (source.codex_replenish_target_count !== undefined) {
    return normalizeNonNegativeInteger(source.codex_replenish_target_count, fallback);
  }
  if (source.codex_target_count !== undefined) {
    return normalizeNonNegativeInteger(source.codex_target_count, fallback);
  }
  return normalizeNonNegativeInteger(fallback, 5);
}

function normalizeCodexReplenishThreshold(value, targetCount, fallback = 0) {
  return Math.min(normalizeNonNegativeInteger(value, fallback), Math.max(0, targetCount));
}

function normalizeCodexReplenishBatchSize(value, fallback = 1) {
  return Math.max(1, Math.min(200, normalizeNonNegativeInteger(value, fallback)));
}

function normalizeCodexReplenishWorkerCount(value, fallback = 1) {
  return Math.max(1, Math.min(200, normalizeNonNegativeInteger(value, fallback)));
}

function readArchiveStore() {
  const storePath = resolveReadableFilePath(ARCHIVE_STORE_PATH);
  if (!storePath) {
    return { by_cpa_url: {} };
  }
  try {
    const raw = fs.readFileSync(storePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      return { by_cpa_url: {} };
    }
    if (!parsed.by_cpa_url || typeof parsed.by_cpa_url !== 'object') {
      return { by_cpa_url: {} };
    }
    const normalizedStore = { by_cpa_url: {} };
    Object.entries(parsed.by_cpa_url).forEach(([rawKey, value]) => {
      const normalizedKey = normalizeCpaUrlForArchive(rawKey);
      const existing = Array.isArray(normalizedStore.by_cpa_url[normalizedKey]) ? normalizedStore.by_cpa_url[normalizedKey] : [];
      const incoming = Array.isArray(value) ? value : [];
      normalizedStore.by_cpa_url[normalizedKey] = normalizeArchiveEntries([...existing, ...incoming]);
    });
    return normalizedStore;
  } catch {
    return { by_cpa_url: {} };
  }
}

function writeArchiveStore(store) {
  ensureWritableFilePath(ARCHIVE_STORE_PATH);
  const normalizedStore = { by_cpa_url: {} };
  const source = store?.by_cpa_url && typeof store.by_cpa_url === 'object' ? store.by_cpa_url : {};
  Object.entries(source).forEach(([rawKey, value]) => {
    normalizedStore.by_cpa_url[normalizeCpaUrlForArchive(rawKey)] = normalizeArchiveEntries(value);
  });
  fs.mkdirSync(path.dirname(ARCHIVE_STORE_PATH), { recursive: true });
  fs.writeFileSync(ARCHIVE_STORE_PATH, `${JSON.stringify(normalizedStore, null, 2)}\n`, 'utf8');
}

function createEmptyRuntimeState() {
  return {
    by_cpa_url: {},
    worker: {
      cycle_in_progress: false,
      last_cycle_started_at: null,
      last_cycle_finished_at: null,
      last_error: '',
    },
  };
}

function normalizeStringOrEmpty(value) {
  return typeof value === 'string' ? value : '';
}

function normalizeNumberOrNull(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function normalizeBoolean(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  return fallback;
}

function normalizeBatchAccountStatus(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    idx: normalizeNumberOrNull(source.idx),
    total: normalizeNumberOrNull(source.total),
    email: normalizeStringOrEmpty(source.email),
    proxy: normalizeStringOrEmpty(source.proxy),
    status: normalizeStringOrEmpty(source.status),
    register_ok: normalizeBoolean(source.register_ok, false),
    codex_ok: normalizeBoolean(source.codex_ok, false),
    upload_ok: normalizeBoolean(source.upload_ok, false),
    error: normalizeStringOrEmpty(source.error),
    updated_at: normalizeNumberOrNull(source.updated_at),
  };
}

function normalizeBatchStatus(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    attempt: normalizeNumberOrNull(source.attempt),
    requested: normalizeNumberOrNull(source.requested),
    workers: normalizeNumberOrNull(source.workers),
    selected_domain: normalizeStringOrEmpty(source.selected_domain),
    email_selection_mode: normalizeStringOrEmpty(source.email_selection_mode),
    status: normalizeStringOrEmpty(source.status),
    register_succeeded: normalizeNumberOrNull(source.register_succeeded) ?? 0,
    register_failed: normalizeNumberOrNull(source.register_failed) ?? 0,
    codex_succeeded: normalizeNumberOrNull(source.codex_succeeded) ?? 0,
    codex_failed: normalizeNumberOrNull(source.codex_failed) ?? 0,
    upload_succeeded: normalizeNumberOrNull(source.upload_succeeded) ?? 0,
    upload_failed: normalizeNumberOrNull(source.upload_failed) ?? 0,
    current_proxy: normalizeStringOrEmpty(source.current_proxy),
    current_email: normalizeStringOrEmpty(source.current_email),
    last_error: normalizeStringOrEmpty(source.last_error),
    started_at: normalizeNumberOrNull(source.started_at),
    finished_at: normalizeNumberOrNull(source.finished_at),
    events: Array.isArray(source.events)
      ? source.events.map((item) => normalizeStringOrEmpty(item)).filter(Boolean).slice(-20)
      : [],
    accounts: Array.isArray(source.accounts)
      ? source.accounts.map((item) => normalizeBatchAccountStatus(item)).slice(-16)
      : [],
  };
}

function createEmptyReplenishmentStatus() {
  return {
    mode: '',
    in_progress: false,
    last_started_at: null,
    last_finished_at: null,
    last_error: '',
    last_limit: null,
    target_count: null,
    threshold: null,
    batch_size: null,
    worker_count: null,
    use_proxy: false,
    healthy_count: null,
    needed: null,
    new_token_files: null,
    last_scan_register_total: null,
    last_scan_cpa_total: null,
    last_scan_missing_count: null,
    last_uploaded: null,
    last_failed: null,
    failed_names: [],
    last_summary: '',
    proxy_pool_size: 0,
    log_file: '',
    recent_events: [],
    log_tail: [],
    email_selection_mode: '',
    last_selected_domain: '',
    current_batch: null,
    batch_history: [],
  };
}

function normalizeReplenishmentStatus(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    mode: normalizeStringOrEmpty(source.mode),
    in_progress: normalizeBoolean(source.in_progress, false),
    last_started_at: normalizeNumberOrNull(source.last_started_at),
    last_finished_at: normalizeNumberOrNull(source.last_finished_at),
    last_error: normalizeStringOrEmpty(source.last_error),
    last_limit: normalizeNumberOrNull(source.last_limit),
    target_count: normalizeNumberOrNull(source.target_count),
    threshold: normalizeNumberOrNull(source.threshold),
    batch_size: normalizeNumberOrNull(source.batch_size),
    worker_count: normalizeNumberOrNull(source.worker_count),
    use_proxy: normalizeBoolean(source.use_proxy, false),
    healthy_count: normalizeNumberOrNull(source.healthy_count),
    needed: normalizeNumberOrNull(source.needed),
    new_token_files: normalizeNumberOrNull(source.new_token_files),
    last_scan_register_total: normalizeNumberOrNull(source.last_scan_register_total),
    last_scan_cpa_total: normalizeNumberOrNull(source.last_scan_cpa_total),
    last_scan_missing_count: normalizeNumberOrNull(source.last_scan_missing_count),
    last_uploaded: normalizeNumberOrNull(source.last_uploaded),
    last_failed: normalizeNumberOrNull(source.last_failed),
    failed_names: Array.isArray(source.failed_names)
      ? source.failed_names.map((item) => normalizeStringOrEmpty(item)).filter(Boolean).slice(0, 20)
      : [],
    last_summary: normalizeStringOrEmpty(source.last_summary),
    proxy_pool_size: normalizeNumberOrNull(source.proxy_pool_size) ?? 0,
    log_file: normalizeStringOrEmpty(source.log_file),
    recent_events: Array.isArray(source.recent_events)
      ? source.recent_events.map((item) => normalizeStringOrEmpty(item)).filter(Boolean).slice(-80)
      : [],
    log_tail: Array.isArray(source.log_tail)
      ? source.log_tail.map((item) => normalizeStringOrEmpty(item)).filter(Boolean).slice(-120)
      : [],
    email_selection_mode: normalizeStringOrEmpty(source.email_selection_mode),
    last_selected_domain: normalizeStringOrEmpty(source.last_selected_domain),
    current_batch: source.current_batch && typeof source.current_batch === 'object'
      ? normalizeBatchStatus(source.current_batch)
      : null,
    batch_history: Array.isArray(source.batch_history)
      ? source.batch_history.map((item) => normalizeBatchStatus(item)).slice(-12)
      : [],
  };
}

function readReplenishmentStatus() {
  const statusPath = resolveReadableFilePath(REPLENISHMENT_STATUS_PATH);
  if (!statusPath) {
    return createEmptyReplenishmentStatus();
  }
  try {
    const raw = fs.readFileSync(statusPath, 'utf8');
    const parsed = JSON.parse(raw);
    return normalizeReplenishmentStatus(parsed);
  } catch {
    return createEmptyReplenishmentStatus();
  }
}

function writeReplenishmentStatus(status) {
  ensureWritableFilePath(REPLENISHMENT_STATUS_PATH);
  const normalized = normalizeReplenishmentStatus(status);
  fs.writeFileSync(REPLENISHMENT_STATUS_PATH, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
}

function updateReplenishmentStatus(partial) {
  const current = readReplenishmentStatus();
  writeReplenishmentStatus({
    ...current,
    ...(partial && typeof partial === 'object' ? partial : {}),
  });
}

function getTrackedReplenishmentProcess() {
  const trackedPid = normalizeNumberOrNull(runtimeScheduler.replenishmentPid);
  if (trackedPid && isPidRunning(trackedPid)) {
    runtimeScheduler.replenishmentInProgress = true;
    return {
      pid: trackedPid,
      source: runtimeScheduler.replenishmentChild ? 'scheduler-child' : 'scheduler-pid',
      mode: '',
    };
  }

  const lockPayload = readProcessLock(REPLENISHMENT_LOCK_PATH);
  const lockPid = normalizeNumberOrNull(lockPayload.pid);
  if (lockPid && isPidRunning(lockPid)) {
    runtimeScheduler.replenishmentInProgress = true;
    runtimeScheduler.replenishmentPid = lockPid;
    return {
      pid: lockPid,
      source: 'replenishment-lock',
      mode: normalizeStringOrEmpty(lockPayload.mode),
    };
  }

  runtimeScheduler.replenishmentInProgress = false;
  runtimeScheduler.replenishmentChild = null;
  runtimeScheduler.replenishmentPid = null;
  return null;
}

function clearStaleTrackedReplenishmentStatus() {
  if (getTrackedReplenishmentProcess()) {
    return;
  }
  const current = readReplenishmentStatus();
  if (!normalizeBoolean(current.in_progress, false)) {
    return;
  }
  updateReplenishmentStatus({
    in_progress: false,
    last_finished_at: normalizeNumberOrNull(current.last_finished_at) ?? Date.now(),
    last_error: normalizeStringOrEmpty(current.last_error),
    last_summary: normalizeStringOrEmpty(current.last_summary) || 'Cleared stale replenishment status with no tracked process.',
  });
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
    },
  };
}

function readRuntimeState() {
  const statePath = resolveReadableFilePath(RUNTIME_STATE_PATH);
  if (!statePath) {
    return createEmptyRuntimeState();
  }
  try {
    const raw = fs.readFileSync(statePath, 'utf8');
    const parsed = JSON.parse(raw);
    return normalizeRuntimeStateStore(parsed);
  } catch (error) {
    console.error('Failed to read credential runtime state, falling back to empty store', error);
    return createEmptyRuntimeState();
  }
}

function writeRuntimeState(store) {
  ensureWritableFilePath(RUNTIME_STATE_PATH);
  const normalized = normalizeRuntimeStateStore(store);
  fs.mkdirSync(path.dirname(RUNTIME_STATE_PATH), { recursive: true });
  fs.writeFileSync(RUNTIME_STATE_PATH, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
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
  return String(req.query?.password || '').trim();
}

function normalizeCpaBaseUrl(rawUrl) {
  return String(rawUrl || '').trim().replace(/\/+$/, '');
}

function normalizeMailDomain(rawDomain) {
  return String(rawDomain || '').trim().toLowerCase().replace(/^@+/, '');
}

function isValidMailDomain(domain) {
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i.test(domain);
}

function buildCookieHeaderFromResponse(response) {
  const headerValues = typeof response?.headers?.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [response?.headers?.get?.('set-cookie')].filter(Boolean);
  return headerValues
    .map((value) => String(value || '').split(';')[0].trim())
    .filter(Boolean)
    .join('; ');
}

function shouldDelayAutoReplenishment(status, nowMs = Date.now()) {
  const normalizedStatus = normalizeReplenishmentStatus(status);
  const lastStartedAt = normalizeNumberOrNull(normalizedStatus.last_started_at);
  const lastFinishedAt = normalizeNumberOrNull(normalizedStatus.last_finished_at);
  const latestActivityAt = Math.max(lastStartedAt || 0, lastFinishedAt || 0);
  if (!latestActivityAt) {
    return false;
  }
  return nowMs - latestActivityAt < AUTO_REPLENISH_RESTART_GUARD_MS;
}

function buildMailDomainTestMailbox(domain) {
  const randomPart = Math.random().toString(36).slice(2, 10);
  return `cpamc-domain-test-${Date.now()}-${randomPart}@${domain}`;
}

async function fetchMailService(config, {
  method = 'GET',
  pathname,
  query,
  body,
  headers = {},
  timeoutMs = MAIL_REQUEST_TIMEOUT_MS,
}) {
  const mailApiBase = normalizeCpaBaseUrl(config?.mail_api_base);
  if (!mailApiBase) {
    throw new Error('mail_api_base is required');
  }

  const endpointUrl = new URL(pathname, `${mailApiBase}/`);
  if (query && typeof query === 'object') {
    Object.entries(query).forEach(([key, value]) => {
      if (value === undefined || value === null || value === '') return;
      endpointUrl.searchParams.set(key, String(value));
    });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(endpointUrl.toString(), {
      method,
      headers: {
        Accept: 'application/json',
        ...headers,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const data = await readJsonLikeResponse(response);
    return {
      status: response.status,
      ok: response.ok,
      data,
      response,
    };
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw createRequestError(`Mail API ${method} ${pathname} timed out after ${timeoutMs}ms`, 0, null);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function runMailDomainSmokeTest(targetConfig) {
  const domain = normalizeMailDomain(targetConfig?.domain);
  const mailApiBase = normalizeCpaBaseUrl(targetConfig?.mail_api_base);
  const mailUsername = String(targetConfig?.mail_username || '').trim();
  const mailPassword = String(targetConfig?.mail_password || '').trim();

  if (!mailApiBase) {
    throw new Error('mail_api_base is required');
  }
  if (!mailUsername) {
    throw new Error('mail_username is required');
  }
  if (!mailPassword) {
    throw new Error('mail_password is required');
  }
  if (!domain) {
    throw new Error('domain is required');
  }
  if (!isValidMailDomain(domain)) {
    throw new Error(`invalid domain: ${domain}`);
  }

  const mailbox = buildMailDomainTestMailbox(domain);
  const payload = {
    domain,
    mailbox,
    ok: false,
    login_status: null,
    list_status: null,
    message: '',
    error: '',
  };

  const loginResult = await fetchMailService(
    { mail_api_base: mailApiBase },
    {
      method: 'POST',
      pathname: '/api/login',
      body: {
        username: mailUsername,
        password: mailPassword,
      },
    },
  );
  payload.login_status = loginResult.status;
  if (!loginResult.ok) {
    payload.error = String(loginResult.data?.error || loginResult.data?.message || `login failed (${loginResult.status})`);
    throw createRequestError(payload.error, loginResult.status, payload);
  }

  const cookieHeader = buildCookieHeaderFromResponse(loginResult.response);
  if (!cookieHeader) {
    payload.error = 'mail login succeeded but no session cookie was returned';
    throw createRequestError(payload.error, loginResult.status, payload);
  }

  const listResult = await fetchMailService(
    { mail_api_base: mailApiBase },
    {
      method: 'GET',
      pathname: '/api/emails',
      query: { mailbox },
      headers: {
        Cookie: cookieHeader,
      },
    },
  );
  payload.list_status = listResult.status;
  if (!listResult.ok) {
    payload.error = String(listResult.data?.error || listResult.data?.message || `mailbox list failed (${listResult.status})`);
    throw createRequestError(payload.error, listResult.status, payload);
  }

  payload.ok = true;
  payload.message = 'Mail login and mailbox listing succeeded.';
  return payload;
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
  if (!managementKey) {
    throw new Error('management_key is required');
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

async function uploadAuthFileToCpa(config, { name, content, timeoutMs = CPA_REQUEST_TIMEOUT_MS }) {
  const cpaUrl = normalizeCpaBaseUrl(config?.cpa_url);
  const managementKey = String(config?.management_key || '').trim();
  if (!cpaUrl) {
    throw new Error('cpa_url is required');
  }
  if (!managementKey) {
    throw new Error('management_key is required');
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

async function deleteAuthFileFromCpa(config, credentialName, timeoutMs = CPA_REQUEST_TIMEOUT_MS) {
  const query = new URLSearchParams({ name: credentialName }).toString();
  return cpaRequest(config, {
    method: 'DELETE',
    pathname: `/v0/management/auth-files?${query}`,
    timeoutMs,
  });
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

async function fetchAuthFilesFromCpa(config) {
  let result;
  try {
    result = await cpaRequest(config, {
      method: 'GET',
      pathname: '/v0/management/auth-files',
    });
  } catch (error) {
    const status = Number(error?.response?.status) || 0;
    const shouldRetry = status === 0 || status >= 500;
    if (!shouldRetry) {
      throw error;
    }

    console.warn(`[CPA] GET /v0/management/auth-files failed once (status=${status || 'timeout'}), retrying once...`);
    await sleep(1000);
    result = await cpaRequest(config, {
      method: 'GET',
      pathname: '/v0/management/auth-files',
    });
  }

  const files = Array.isArray(result.data?.files) ? result.data.files : [];
  return files
    .map((item) => normalizeCredentialRecord(item))
    .filter((item) => item.name && item.auth_index);
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

async function probeCredentialFromCpa(config, credential) {
  const result = await cpaRequest(config, {
    method: 'POST',
    pathname: '/v0/management/api-call',
    body: buildProbePayload(credential),
  });
  return result.data && typeof result.data === 'object'
    ? result.data
    : { status_code: result.status, body: result.data };
}

async function updateCredentialDisabledStatus(config, credentialName, disabled) {
  return cpaRequest(config, {
    method: 'PATCH',
    pathname: '/v0/management/auth-files/status',
    body: {
      name: credentialName,
      disabled,
    },
  });
}

function toEpochMsFromSeconds(value) {
  const seconds = normalizeNumberOrNull(value);
  if (seconds === null || seconds <= 0) return null;
  return Math.floor(seconds * 1000);
}

function resolveRuntimeNextProbeAtMs(status, quota, normalIntervalMs, nowMs) {
  const quotaResetAtMs = toEpochMsFromSeconds(quota?.resetAt ?? null);
  if (status === 'rate_limited') {
    return Math.max(nowMs + RATE_LIMIT_RETRY_MS, quotaResetAtMs || 0);
  }
  if (status === 'quota_exhausted' || status === 'quota_low_remaining') {
    if (quotaResetAtMs) {
      return Math.max(nowMs + RUNTIME_RECHECK_FLOOR_MS, quotaResetAtMs);
    }
    return nowMs + normalIntervalMs;
  }
  if (status === 'invalidated' || status === 'unauthorized' || status === 'expired_by_time' || status === 'unknown') {
    return nowMs + normalIntervalMs;
  }
  return nowMs + normalIntervalMs;
}

function resolveCredentialDueAtMs(credential, runtimeEntry, normalIntervalMs) {
  if (runtimeEntry?.next_probe_at_ms) {
    return runtimeEntry.next_probe_at_ms;
  }
  if (runtimeEntry?.last_probe_at) {
    return runtimeEntry.last_probe_at + normalIntervalMs;
  }
  return 0;
}

function upsertArchiveName(store, cpaUrlKey, credentialName) {
  return upsertArchiveEntry(store, cpaUrlKey, {
    name: credentialName,
    archived_at: Date.now(),
  });
}

function pruneRuntimeBucket(store, cpaUrlKey, activeCredentialNames) {
  const bucket = getRuntimeBucket(store, cpaUrlKey, { createIfMissing: false });
  if (!bucket) return false;
  const nextCredentials = {};
  let changed = false;
  Object.entries(bucket.credentials).forEach(([name, entry]) => {
    if (!activeCredentialNames.has(name)) {
      changed = true;
      return;
    }
    nextCredentials[name] = entry;
  });
  if (!changed) return false;
  replaceRuntimeBucket(store, cpaUrlKey, { credentials: nextCredentials });
  return true;
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
  clearStaleTrackedReplenishmentStatus();
  const runtimeState = readRuntimeState();
  const replenishmentStatus = readReplenishmentStatus();
  const trackedReplenishment = getTrackedReplenishmentProcess();
  const cpaUrlKey = normalizeCpaUrlForArchive(config?.cpa_url, config?.cpa_url);
  const bucket = getRuntimeBucket(runtimeState, cpaUrlKey, { createIfMissing: false }) || normalizeRuntimeBucket({});
  const credentialStates = {};

  Object.entries(bucket.credentials).forEach(([name, entry]) => {
    credentialStates[name] = {
      provider: normalizeStringOrEmpty(entry.provider),
      last_status: normalizeStringOrEmpty(entry.last_status),
      last_reason: normalizeStringOrEmpty(entry.last_reason),
      last_probe_at: normalizeNumberOrNull(entry.last_probe_at),
      last_probe_at_iso: formatRuntimeTime(entry.last_probe_at),
      last_probe_detail: normalizeStringOrEmpty(entry.last_probe_detail),
      last_reset_at: normalizeNumberOrNull(entry.last_reset_at),
      last_quota_source: normalizeStringOrEmpty(entry.last_quota_source),
      last_quota_used_percent: normalizeNumberOrNull(entry.last_quota_used_percent),
      last_quota_cards: Array.isArray(entry.last_quota_cards) ? entry.last_quota_cards : [],
      next_probe_at_ms: normalizeNumberOrNull(entry.next_probe_at_ms),
      archived_by_runtime: normalizeBoolean(entry.archived_by_runtime, false),
      disabled_by_runtime: normalizeBoolean(entry.disabled_by_runtime, false),
    };
  });

  const configEnabled = parseBoolSafe(config?.auto_probe_enabled, false);
  const hasRuntimeConfig = Boolean(normalizeCpaBaseUrl(config?.cpa_url) && String(config?.management_key || '').trim());
  const healthyCodexCount = countNormalCodexAccountsFromRuntime(runtimeState, cpaUrlKey);
  const replenishmentTracked = Boolean(trackedReplenishment) || normalizeBoolean(replenishmentStatus.in_progress, false);
  const statusHealthyCount = normalizeNumberOrNull(replenishmentStatus.healthy_count);
  const derivedHealthyCount = statusHealthyCount ?? healthyCodexCount;
  const statusTargetCount = normalizeNumberOrNull(replenishmentStatus.target_count);
  const configTargetCount = normalizeNonNegativeInteger(
    config?.codex_replenish_target_count,
    normalizeNonNegativeInteger(config?.codex_target_count, 0),
  );
  const effectiveTargetCount = statusTargetCount ?? configTargetCount;
  const statusNeeded = normalizeNumberOrNull(replenishmentStatus.needed);
  const derivedNeeded = statusNeeded ?? Math.max(0, effectiveTargetCount - derivedHealthyCount);

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
    },
      replenishment: {
        enabled: parseBoolSafe(config?.codex_replenish_enabled, false),
        in_progress: replenishmentTracked,
        stop_requested: runtimeScheduler.replenishmentStopRequested,
        process_pid: trackedReplenishment?.pid ?? normalizeNumberOrNull(runtimeScheduler.replenishmentPid),
        mode: normalizeStringOrEmpty(replenishmentStatus.mode),
      healthy_count: derivedHealthyCount,
      proxy_pool_size: normalizeNumberOrNull(replenishmentStatus.proxy_pool_size),
      target_count: effectiveTargetCount,
      threshold: normalizeNumberOrNull(replenishmentStatus.threshold),
      batch_size: normalizeNumberOrNull(replenishmentStatus.batch_size) ?? normalizeCodexReplenishBatchSize(config?.codex_replenish_batch_size, 1),
      worker_count: normalizeNumberOrNull(replenishmentStatus.worker_count) ?? normalizeCodexReplenishWorkerCount(config?.codex_replenish_worker_count, 1),
      use_proxy: normalizeBoolean(replenishmentStatus.use_proxy, false),
      needed: derivedNeeded,
      new_token_files: normalizeNumberOrNull(replenishmentStatus.new_token_files),
      last_limit: normalizeNumberOrNull(replenishmentStatus.last_limit),
      last_scan_register_total: normalizeNumberOrNull(replenishmentStatus.last_scan_register_total),
      last_scan_cpa_total: normalizeNumberOrNull(replenishmentStatus.last_scan_cpa_total),
      last_scan_missing_count: normalizeNumberOrNull(replenishmentStatus.last_scan_missing_count),
      last_uploaded: normalizeNumberOrNull(replenishmentStatus.last_uploaded),
      last_failed: normalizeNumberOrNull(replenishmentStatus.last_failed),
      failed_names: Array.isArray(replenishmentStatus.failed_names) ? replenishmentStatus.failed_names : [],
      log_file: normalizeStringOrEmpty(replenishmentStatus.log_file),
      recent_events: Array.isArray(replenishmentStatus.recent_events) ? replenishmentStatus.recent_events : [],
      log_tail: Array.isArray(replenishmentStatus.log_tail) ? replenishmentStatus.log_tail : [],
      last_started_at: normalizeNumberOrNull(replenishmentStatus.last_started_at),
      last_started_at_iso: formatRuntimeTime(replenishmentStatus.last_started_at),
      last_finished_at: normalizeNumberOrNull(replenishmentStatus.last_finished_at),
      last_finished_at_iso: formatRuntimeTime(replenishmentStatus.last_finished_at),
      last_error: normalizeStringOrEmpty(replenishmentStatus.last_error),
      last_summary: normalizeStringOrEmpty(replenishmentStatus.last_summary),
      email_selection_mode: normalizeStringOrEmpty(replenishmentStatus.email_selection_mode),
      last_selected_domain: normalizeStringOrEmpty(replenishmentStatus.last_selected_domain),
      current_batch: replenishmentStatus.current_batch && typeof replenishmentStatus.current_batch === 'object' ? replenishmentStatus.current_batch : null,
      batch_history: Array.isArray(replenishmentStatus.batch_history) ? replenishmentStatus.batch_history : [],
    },
    credentials: credentialStates,
  };
}

function looksLikeCodexRuntimeCredential(name, entry) {
  const provider = normalizeStringOrEmpty(entry?.provider).toLowerCase();
  const quotaCards = Array.isArray(entry?.last_quota_cards) ? entry.last_quota_cards : [];
  return (
    provider === 'codex'
    || String(name || '').startsWith('codex-')
    || quotaCards.length > 0
    || ![null, '', 'unknown'].includes(entry?.last_quota_source)
  );
}

function countNormalCodexAccountsFromRuntime(runtimeState, cpaUrlKey) {
  const bucket = getRuntimeBucket(runtimeState, cpaUrlKey, { createIfMissing: false }) || normalizeRuntimeBucket({});
  let count = 0;
  Object.entries(bucket.credentials || {}).forEach(([name, entry]) => {
    if (!looksLikeCodexRuntimeCredential(name, entry)) {
      return;
    }
    if (normalizeStringOrEmpty(entry?.last_status) !== 'active') {
      return;
    }
    if (normalizeBoolean(entry?.disabled_by_runtime, false)) {
      return;
    }
    count += 1;
  });
  return count;
}

function countUsableCodexAccounts(credentials, runtimeState, cpaUrlKey) {
  const files = Array.isArray(credentials) ? credentials : [];
  const bucket = getRuntimeBucket(runtimeState, cpaUrlKey, { createIfMissing: false }) || normalizeRuntimeBucket({});
  const bucketCredentials = bucket.credentials || {};
  let count = 0;

  files.forEach((credential) => {
    const provider = normalizeStringOrEmpty(credential?.provider).toLowerCase();
    if (provider !== 'codex') {
      return;
    }
    if (normalizeBoolean(credential?.disabled, false)) {
      return;
    }

    const name = normalizeCredentialName(credential?.name);
    const runtimeEntry = bucketCredentials[name] || {};
    const runtimeStatus = normalizeStringOrEmpty(runtimeEntry?.last_status).toLowerCase();
    const cpaStatus = normalizeStringOrEmpty(credential?.status).toLowerCase();
    const resolvedStatus = runtimeStatus || cpaStatus;
    if (resolvedStatus !== 'active') {
      return;
    }
    if (normalizeBoolean(runtimeEntry?.disabled_by_runtime, false)) {
      return;
    }
    if (normalizeBoolean(runtimeEntry?.archived_by_runtime, false)) {
      return;
    }

    count += 1;
  });

  return count;
}

async function runBackendAutomationCycle() {
  if (runtimeScheduler.cycleInProgress) {
    return;
  }

  runtimeScheduler.cycleInProgress = true;
  const cycleStartedAt = Date.now();
  let runtimeState = setRuntimeWorkerState(readRuntimeState(), {
    cycle_in_progress: true,
    last_cycle_started_at: cycleStartedAt,
    last_error: '',
  });
  writeRuntimeState(runtimeState);

  try {
    const config = readConfig();
    const autoProbeEnabled = parseBoolSafe(config.auto_probe_enabled, false);
    const cpaBaseUrl = normalizeCpaBaseUrl(config.cpa_url);
    const managementKey = String(config.management_key || '').trim();

    if (!autoProbeEnabled || !cpaBaseUrl || !managementKey) {
      runtimeState = setRuntimeWorkerState(runtimeState, {
        cycle_in_progress: false,
        last_cycle_finished_at: Date.now(),
        last_error: '',
      });
      writeRuntimeState(runtimeState);
      return;
    }

    const normalIntervalMs = Math.max(1, parseIntSafe(config.auto_probe_interval_minutes, 60)) * 60 * 1000;
    const cpaUrlKey = normalizeCpaUrlForArchive(cpaBaseUrl, cpaBaseUrl);
    const credentials = await fetchAuthFilesFromCpa(config);
    const activeCredentialNames = new Set(credentials.map((item) => item.name).filter(Boolean));
    pruneRuntimeBucket(runtimeState, cpaUrlKey, activeCredentialNames);

    const archiveStore = readArchiveStore();
    const archivedNameSet = new Set(getArchiveNames(archiveStore, cpaUrlKey));
    let archiveStoreChanged = false;
    const nowMs = Date.now();

    for (const credential of credentials) {
      if (!credential.name || archivedNameSet.has(credential.name)) {
        continue;
      }

      let runtimeEntry = getCredentialRuntimeState(runtimeState, cpaUrlKey, credential.name);
      if (runtimeEntry?.archived_by_runtime) {
        runtimeEntry = setCredentialRuntimeState(runtimeState, cpaUrlKey, credential.name, {
          archived_by_runtime: false,
        });
      }
      if (!credential.disabled && runtimeEntry?.disabled_by_runtime) {
        runtimeEntry = setCredentialRuntimeState(runtimeState, cpaUrlKey, credential.name, {
          disabled_by_runtime: false,
        });
      }

      const dueAtMs = resolveCredentialDueAtMs(credential, runtimeEntry, normalIntervalMs);
      if (dueAtMs > nowMs) {
        continue;
      }

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

      const nextBaseState = buildRuntimeProbeStatePatch(probeResult, probeResponse, {
        provider: credential.provider,
      });

      if (probeResult.status === 'active') {
        const shouldEnable = Boolean(credential.disabled && runtimeEntry?.disabled_by_runtime);
        if (shouldEnable) {
          await updateCredentialDisabledStatus(config, credential.name, false);
        }
        setCredentialRuntimeState(runtimeState, cpaUrlKey, credential.name, {
          ...nextBaseState,
          next_probe_at_ms: nowMs + normalIntervalMs,
          archived_by_runtime: false,
          disabled_by_runtime: false,
        });
        continue;
      }

      if (shouldAutoArchive(probeResult.status)) {
        if (!credential.disabled) {
          await updateCredentialDisabledStatus(config, credential.name, true);
        }
        if (upsertArchiveName(archiveStore, cpaUrlKey, credential.name)) {
          archiveStoreChanged = true;
          archivedNameSet.add(credential.name);
        }
        setCredentialRuntimeState(runtimeState, cpaUrlKey, credential.name, {
          ...nextBaseState,
          next_probe_at_ms: null,
          archived_by_runtime: true,
          disabled_by_runtime: true,
        });
        continue;
      }

      if (shouldAutoDisable(probeResult.status)) {
        if (!credential.disabled) {
          await updateCredentialDisabledStatus(config, credential.name, true);
        }
        setCredentialRuntimeState(runtimeState, cpaUrlKey, credential.name, {
          ...nextBaseState,
          next_probe_at_ms: resolveRuntimeNextProbeAtMs(probeResult.status, probeResult.quota, normalIntervalMs, nowMs),
          archived_by_runtime: false,
          disabled_by_runtime: true,
        });
        continue;
      }

      setCredentialRuntimeState(runtimeState, cpaUrlKey, credential.name, {
        ...nextBaseState,
        next_probe_at_ms: nowMs + normalIntervalMs,
        archived_by_runtime: false,
        disabled_by_runtime: Boolean(runtimeEntry?.disabled_by_runtime && credential.disabled),
      });
    }

    if (archiveStoreChanged) {
      writeArchiveStore(archiveStore);
    }

    runtimeState = setRuntimeWorkerState(runtimeState, {
      cycle_in_progress: false,
      last_cycle_finished_at: Date.now(),
      last_error: '',
    });
    writeRuntimeState(runtimeState);

    // Phase: Codex Replenishment Check
    if (parseBoolSafe(config.codex_replenish_enabled, false)) {
      const targetCount = normalizeNonNegativeInteger(config.codex_replenish_target_count, normalizeNonNegativeInteger(config.codex_target_count, 0));
      const threshold = normalizeCodexReplenishThreshold(config.codex_replenish_threshold, targetCount, 0);
      const normalCodexCount = countUsableCodexAccounts(credentials, runtimeState, cpaUrlKey);
      if (normalCodexCount >= threshold) {
        console.log(`[Replenish] Skip spawn because healthy Codex count ${normalCodexCount} is above threshold ${threshold} (target ${targetCount})`);
        return;
      }
      const replenishmentStatus = readReplenishmentStatus();
      if (shouldDelayAutoReplenishment(replenishmentStatus)) {
        console.log(`[Replenish] Skip auto spawn because the last replenishment activity is within the ${AUTO_REPLENISH_RESTART_GUARD_MS}ms restart guard window.`);
        return;
      }
      setImmediate(() => {
        spawnReplenishmentProcess().catch((err) => console.error('Codex replenishment trigger failed', err));
      });
    }
  } catch (error) {
    runtimeState = setRuntimeWorkerState(runtimeState, {
      cycle_in_progress: false,
      last_cycle_finished_at: Date.now(),
      last_error: String(error?.message || error),
    });
    writeRuntimeState(runtimeState);
    console.error('Backend automation cycle failed', error);
  } finally {
    runtimeScheduler.cycleInProgress = false;
  }
}

async function spawnReplenishmentProcess(options = {}) {
  const tracked = getTrackedReplenishmentProcess();
  if (tracked) {
    console.log(`[Replenish] Skip spawn because replenishment process ${tracked.pid} is already running (${tracked.source})`);
    return;
  }

  clearStaleTrackedReplenishmentStatus();

  const { spawn } = await import('child_process');
  const pythonPath = String(process.env.PYTHON_BIN || (process.platform === 'win32' ? 'python' : 'python3'));
  const scriptPath = path.join(PROJECT_ROOT, 'replenish_codex.py');
  const configPath = CONFIG_PATH;
  const statePath = RUNTIME_STATE_PATH;
  const args = ['-u', scriptPath, '--config', configPath, '--state', statePath];
  const needed = normalizeNumberOrNull(options?.needed);
  if (needed !== null && needed > 0) {
    args.push('--needed', String(needed));
  }

  console.log(`[Replenish] Spawning ${pythonPath} ${args.join(' ')}`);
  runtimeScheduler.replenishmentInProgress = true;
  runtimeScheduler.replenishmentStopRequested = false;

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback) => {
      if (runtimeScheduler.replenishmentChild === child) {
        runtimeScheduler.replenishmentInProgress = false;
        runtimeScheduler.replenishmentChild = null;
        runtimeScheduler.replenishmentPid = null;
        runtimeScheduler.replenishmentStopRequested = false;
      }
      if (!settled) {
        settled = true;
        callback();
      }
    };

    const child = spawn(pythonPath, args, {
      env: {
        ...process.env,
        PYTHONUNBUFFERED: '1',
        PYTHONIOENCODING: 'utf-8',
        PYTHONUTF8: '1',
      },
      windowsHide: process.platform === 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const streamLog = (prefix, chunk, writer = console.log) => {
      const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk ?? '');
      if (!text) return;
      text.split(/\r?\n/).forEach((line) => {
        const trimmed = line.trimEnd();
        if (trimmed) {
          writer(`${prefix}${trimmed}`);
        }
      });
    };

    child.stdout?.on('data', (chunk) => {
      streamLog('[Replenish] stdout: ', chunk, console.log);
    });

    child.stderr?.on('data', (chunk) => {
      streamLog('[Replenish] stderr: ', chunk, console.warn);
    });

    child.on('error', (error) => {
      finish(() => {
        console.error(`[Replenish] Process errored: ${error.message}`);
        reject(error);
      });
    });

    child.on('close', (code, signal) => {
      if (code && code !== 0) {
        finish(() => {
          const error = new Error(`replenish_codex.py exited with code ${code}${signal ? ` signal ${signal}` : ''}`);
          console.error(`[Replenish] Process errored: ${error.message}`);
          reject(error);
        });
        return;
      }
      finish(() => resolve());
    });

    runtimeScheduler.replenishmentChild = child;
    runtimeScheduler.replenishmentPid = child.pid || null;
  });
}

async function terminateTrackedProcess(pid) {
  if (process.platform === 'win32') {
    const { execFile } = await import('child_process');
    return new Promise((resolve, reject) => {
      execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, (error) => {
        if (error) {
          return reject(new Error(`Failed to stop replenishment process ${pid}.`));
        }
        resolve();
      });
    });
  }

  try {
    process.kill(pid, 'SIGTERM');
  } catch (error) {
    if (error?.code !== 'ESRCH') {
      throw new Error(`Failed to stop replenishment process ${pid}.`);
    }
  }

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (!isPidRunning(pid)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  try {
    process.kill(pid, 'SIGKILL');
  } catch (error) {
    if (error?.code !== 'ESRCH') {
      throw new Error(`Failed to force stop replenishment process ${pid}.`);
    }
  }
}

async function stopTrackedReplenishmentProcess() {
  const tracked = getTrackedReplenishmentProcess();
  const pid = Number(tracked?.pid || 0);
  if (!pid) {
    return {
      requested: false,
      stopped: false,
      pid: null,
      message: 'No tracked replenishment process is currently running.',
    };
  }

  runtimeScheduler.replenishmentStopRequested = true;

  await terminateTrackedProcess(pid);

  runtimeScheduler.replenishmentInProgress = false;
  runtimeScheduler.replenishmentChild = null;
  runtimeScheduler.replenishmentPid = null;
  runtimeScheduler.replenishmentStopRequested = false;
  const lockPayload = readProcessLock(REPLENISHMENT_LOCK_PATH);
  if (normalizeNumberOrNull(lockPayload.pid) === pid) {
    removeProcessLock(REPLENISHMENT_LOCK_PATH);
  }
  updateReplenishmentStatus({
    in_progress: false,
    last_finished_at: Date.now(),
    last_error: 'Stopped manually from dashboard.',
    last_summary: normalizeStringOrEmpty(readReplenishmentStatus().last_summary) || 'Stopped manually from dashboard.',
  });

  return {
    requested: true,
    stopped: true,
    pid,
    message: `Stopped replenishment process ${pid}.`,
  };
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
  const nextConfig = new_config && typeof new_config === 'object' ? new_config : {};

  // To update config, they must provide the correct current password
  if (isAuthorized(old_password, config)) {
    try {
      const nextAutoProbeEnabled = nextConfig.auto_probe_enabled !== undefined
        ? parseBoolSafe(nextConfig.auto_probe_enabled, parseBoolSafe(config.auto_probe_enabled, false))
        : parseBoolSafe(config.auto_probe_enabled, false);
      const nextAutoProbeIntervalMinutesRaw = nextConfig.auto_probe_interval_minutes !== undefined
        ? parseIntSafe(nextConfig.auto_probe_interval_minutes, parseIntSafe(config.auto_probe_interval_minutes, 60))
        : parseIntSafe(config.auto_probe_interval_minutes, 60);
      const nextAutoProbeIntervalMinutes = Math.max(1, Math.min(1440, nextAutoProbeIntervalMinutesRaw));
      
      const nextQuotaDisableRemainingPercentRaw = nextConfig.codex_quota_disable_remaining_percent !== undefined
        ? parseIntSafe(nextConfig.codex_quota_disable_remaining_percent, parseIntSafe(config.codex_quota_disable_remaining_percent, 10))
        : parseIntSafe(config.codex_quota_disable_remaining_percent, 10);
      const nextQuotaDisableRemainingPercent = Math.max(0, Math.min(100, nextQuotaDisableRemainingPercentRaw));

      const nextCodexReplenishEnabled = nextConfig.codex_replenish_enabled !== undefined
        ? parseBoolSafe(nextConfig.codex_replenish_enabled, config.codex_replenish_enabled)
        : config.codex_replenish_enabled;
      
      const nextCodexReplenishTargetCountRaw = nextConfig.codex_replenish_target_count !== undefined || nextConfig.codex_target_count !== undefined
        ? resolveCodexReplenishTargetCount(nextConfig, config.codex_replenish_target_count)
        : config.codex_replenish_target_count;
      const nextCodexReplenishTargetCount = normalizeNonNegativeInteger(
        nextCodexReplenishTargetCountRaw,
        normalizeNonNegativeInteger(config.codex_replenish_target_count, 5),
      );
      
      const nextCodexReplenishThresholdRaw = nextConfig.codex_replenish_threshold !== undefined
        ? parseIntSafe(nextConfig.codex_replenish_threshold, config.codex_replenish_threshold)
        : config.codex_replenish_threshold;
      const nextCodexReplenishThreshold = normalizeCodexReplenishThreshold(
        nextCodexReplenishThresholdRaw,
        nextCodexReplenishTargetCount,
        normalizeCodexReplenishThreshold(config.codex_replenish_threshold, nextCodexReplenishTargetCount, 2),
      );
      const nextCodexReplenishBatchSize = nextConfig.codex_replenish_batch_size !== undefined
        ? normalizeCodexReplenishBatchSize(nextConfig.codex_replenish_batch_size, config.codex_replenish_batch_size)
        : normalizeCodexReplenishBatchSize(config.codex_replenish_batch_size, 1);
      const nextCodexReplenishWorkerCount = nextConfig.codex_replenish_worker_count !== undefined
        ? normalizeCodexReplenishWorkerCount(nextConfig.codex_replenish_worker_count, config.codex_replenish_worker_count)
        : normalizeCodexReplenishWorkerCount(config.codex_replenish_worker_count, 1);

      const nextCodexReplenishUseProxy = nextConfig.codex_replenish_use_proxy !== undefined
        ? parseBoolSafe(nextConfig.codex_replenish_use_proxy, config.codex_replenish_use_proxy)
        : config.codex_replenish_use_proxy;
      const nextCodexReplenishProxyPool = nextConfig.codex_replenish_proxy_pool !== undefined
        ? String(nextConfig.codex_replenish_proxy_pool || '')
        : String(config.codex_replenish_proxy_pool || '');

      writeConfig({
        cpa_url: nextConfig.cpa_url !== undefined ? nextConfig.cpa_url : config.cpa_url,
        management_key: nextConfig.management_key !== undefined ? nextConfig.management_key : config.management_key,
        mail_api_base: nextConfig.mail_api_base !== undefined ? nextConfig.mail_api_base : config.mail_api_base,
        mail_username: nextConfig.mail_username !== undefined ? nextConfig.mail_username : config.mail_username,
        mail_password: nextConfig.mail_password !== undefined ? nextConfig.mail_password : config.mail_password,
        mail_email_domain: nextConfig.mail_email_domain !== undefined ? nextConfig.mail_email_domain : config.mail_email_domain,
        mail_email_domains: nextConfig.mail_email_domains !== undefined ? nextConfig.mail_email_domains : config.mail_email_domains,
        mail_randomize_from_list: nextConfig.mail_randomize_from_list !== undefined ? parseBoolSafe(nextConfig.mail_randomize_from_list, config.mail_randomize_from_list) : config.mail_randomize_from_list,
        codex_replenish_enabled: nextCodexReplenishEnabled,
        codex_target_count: nextCodexReplenishTargetCount,
        codex_replenish_target_count: nextCodexReplenishTargetCount,
        codex_replenish_threshold: nextCodexReplenishThreshold,
        codex_replenish_batch_size: nextCodexReplenishBatchSize,
        codex_replenish_worker_count: nextCodexReplenishWorkerCount,
        codex_replenish_use_proxy: nextCodexReplenishUseProxy,
        codex_replenish_proxy_pool: nextCodexReplenishProxyPool,
        auto_probe_enabled: nextAutoProbeEnabled,
        auto_probe_interval_minutes: nextAutoProbeIntervalMinutes,
        codex_quota_disable_remaining_percent: nextQuotaDisableRemainingPercent,
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
    res.status(502).json({
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
    const result = await updateCredentialDisabledStatus(config, name, disabled);
    res.json(result.data ?? { ok: true });
  } catch (error) {
    res.status(502).json({
      ok: false,
      error: String(error?.message || error),
      payload: error?.response?.data ?? null,
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
    const result = await deleteAuthFileFromCpa(config, name);
    res.json(result.data ?? { ok: true });
  } catch (error) {
    res.status(502).json({
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
    const result = await cpaRequest(config, {
      method: 'POST',
      pathname: '/v0/management/api-call',
      body,
    });
    res.status(result.status || 200).json(result.data ?? {});
  } catch (error) {
    res.status(502).json({
      ok: false,
      error: String(error?.message || error),
      payload: error?.response?.data ?? null,
    });
  }
});

app.post('/api/mail/domain-test', async (req, res) => {
  const config = readConfig();
  if (!isAuthorized(resolveRequestSecret(req), config)) {
    res.status(401).json({ ok: false, error: 'Unauthorized' });
    return;
  }

  try {
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    const payload = await runMailDomainSmokeTest({
      mail_api_base: body.mail_api_base !== undefined ? body.mail_api_base : config.mail_api_base,
      mail_username: body.mail_username !== undefined ? body.mail_username : config.mail_username,
      mail_password: body.mail_password !== undefined ? body.mail_password : config.mail_password,
      domain: body.domain !== undefined ? body.domain : config.mail_email_domain,
    });
    res.json({ ok: true, payload });
  } catch (error) {
    const fallbackDomain = normalizeMailDomain(req.body?.domain || config.mail_email_domain);
    const fallbackMailbox = fallbackDomain ? buildMailDomainTestMailbox(fallbackDomain) : '';
    res.status(502).json({
      ok: false,
      error: String(error?.message || error),
      payload: {
        domain: fallbackDomain,
        mailbox: fallbackMailbox,
        ok: false,
        login_status: Number(error?.response?.data?.login_status) || null,
        list_status: Number(error?.response?.data?.list_status) || null,
        message: '',
        error: String(error?.response?.data?.error || error?.message || error),
      },
    });
  }
});

app.post('/api/archive/list', (req, res) => {
  const body = req.body || {};
  const config = readConfig();
  if (!isAuthorized(resolveRequestSecret(req), config)) {
    res.status(401).json({ ok: false, error: 'Unauthorized' });
    return;
  }
  try {
    const cpaUrlKey = normalizeCpaUrlForArchive(body.cpa_url, config.cpa_url);
    const store = readArchiveStore();
    const entries = getArchiveEntries(store, cpaUrlKey);
    const names = entries.map((item) => item.name);
    res.json({
      ok: true,
      payload: {
        cpa_url: cpaUrlKey,
        names,
        entries: entries.map((item) => ({
          name: item.name,
          archived_at: normalizeArchiveTimestamp(item.archived_at),
          archived_at_iso: formatRuntimeTime(item.archived_at),
        })),
        total: names.length,
      },
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

app.post('/api/archive/add', (req, res) => {
  const body = req.body || {};
  const config = readConfig();
  if (!isAuthorized(resolveRequestSecret(req), config)) {
    res.status(401).json({ ok: false, error: 'Unauthorized' });
    return;
  }
  try {
    const cpaUrlKey = normalizeCpaUrlForArchive(body.cpa_url, config.cpa_url);
    const incoming = normalizeArchiveNames(body.names);
    if (!incoming.length) {
      res.status(400).json({ ok: false, error: 'names is required' });
      return;
    }
    const store = readArchiveStore();
    const currentEntries = getArchiveEntries(store, cpaUrlKey);
    const currentNameSet = new Set(currentEntries.map((item) => item.name));
    const addedEntries = incoming
      .filter((name) => !currentNameSet.has(name))
      .map((name) => ({ name, archived_at: Date.now() }));
    const mergedEntries = normalizeArchiveEntries([...currentEntries, ...addedEntries]);
    const merged = mergedEntries.map((item) => item.name);
    setArchiveEntries(store, cpaUrlKey, mergedEntries);
    writeArchiveStore(store);
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
        added: addedEntries.length,
      },
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

app.post('/api/archive/remove', (req, res) => {
  const body = req.body || {};
  const config = readConfig();
  if (!isAuthorized(resolveRequestSecret(req), config)) {
    res.status(401).json({ ok: false, error: 'Unauthorized' });
    return;
  }
  try {
    const cpaUrlKey = normalizeCpaUrlForArchive(body.cpa_url, config.cpa_url);
    const removing = new Set(normalizeArchiveNames(body.names));
    if (!removing.size) {
      res.status(400).json({ ok: false, error: 'names is required' });
      return;
    }
    const store = readArchiveStore();
    const currentEntries = getArchiveEntries(store, cpaUrlKey);
    const nextEntries = currentEntries.filter((item) => !removing.has(item.name));
    const next = nextEntries.map((item) => item.name);
    setArchiveEntries(store, cpaUrlKey, nextEntries);
    writeArchiveStore(store);
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
        removed: currentEntries.length - next.length,
      },
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: String(error?.message || error) });
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
    res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

app.post('/api/runtime/replenishment/stop', async (req, res) => {
  const config = readConfig();
  if (!isAuthorized(resolveRequestSecret(req), config)) {
    res.status(401).json({ ok: false, error: 'Unauthorized' });
    return;
  }

  try {
    const payload = await stopTrackedReplenishmentProcess();
    res.json({ ok: true, payload });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: String(error?.message || error),
      payload: {
        requested: true,
        stopped: false,
        pid: normalizeNumberOrNull(runtimeScheduler.replenishmentPid),
        message: String(error?.message || error),
      },
    });
  }
});

app.post('/api/runtime/replenishment/start', async (req, res) => {
  const config = readConfig();
  if (!isAuthorized(resolveRequestSecret(req), config)) {
    res.status(401).json({ ok: false, error: 'Unauthorized' });
    return;
  }

  try {
    clearStaleTrackedReplenishmentStatus();

    const targetCount = normalizeNonNegativeInteger(
      config.codex_replenish_target_count,
      normalizeNonNegativeInteger(config.codex_target_count, 0),
    );
    const threshold = normalizeCodexReplenishThreshold(config.codex_replenish_threshold, targetCount, 0);
    const runtimeState = readRuntimeState();
    const cpaUrlKey = normalizeCpaUrlForArchive(config?.cpa_url, config?.cpa_url);
    let healthyCount = countNormalCodexAccountsFromRuntime(runtimeState, cpaUrlKey);
    try {
      const credentials = await fetchAuthFilesFromCpa(config);
      healthyCount = countUsableCodexAccounts(credentials, runtimeState, cpaUrlKey);
    } catch (error) {
      console.warn(`[Replenish] Falling back to runtime-only healthy count for manual start: ${String(error?.message || error)}`);
    }
    const needed = Math.max(0, targetCount - healthyCount);

    const tracked = getTrackedReplenishmentProcess();
    if (tracked) {
      res.json({
        ok: true,
        payload: {
          started: false,
          already_running: true,
          pid: tracked.pid,
          needed,
          healthy_count: healthyCount,
          target_count: targetCount,
          threshold,
          message: `A replenishment process is already running (PID ${tracked.pid}).`,
        },
      });
      return;
    }

    if (targetCount <= 0) {
      res.json({
        ok: true,
        payload: {
          started: false,
          already_running: false,
          pid: null,
          needed: 0,
          healthy_count: healthyCount,
          target_count: targetCount,
          threshold,
          message: 'Target count is 0. Increase codex_replenish_target_count before starting replenishment.',
        },
      });
      return;
    }

    if (needed <= 0) {
      updateReplenishmentStatus({
        in_progress: false,
        target_count: targetCount,
        threshold,
        needed: 0,
        last_finished_at: Date.now(),
        last_error: '',
        last_summary: `Manual start skipped because healthy Codex count ${healthyCount} already meets target ${targetCount}.`,
      });
      res.json({
        ok: true,
        payload: {
          started: false,
          already_running: false,
          pid: null,
          needed: 0,
          healthy_count: healthyCount,
          target_count: targetCount,
          threshold,
          message: `Healthy Codex count ${healthyCount} already meets target ${targetCount}.`,
        },
      });
      return;
    }

    void spawnReplenishmentProcess({ needed }).catch((err) => {
      console.error('Manual Codex replenishment trigger failed', err);
    });

    res.json({
      ok: true,
      payload: {
        started: true,
        already_running: false,
        pid: null,
        needed,
        healthy_count: healthyCount,
        target_count: targetCount,
        threshold,
        message: `Started manual replenishment for ${needed} account(s).`,
      },
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: String(error?.message || error),
    });
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
    res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

app.post('/api/runtime/credential-state/upsert', (req, res) => {
  const config = readConfig();
  if (!isAuthorized(resolveRequestSecret(req), config)) {
    res.status(401).json({ ok: false, error: 'Unauthorized' });
    return;
  }

  try {
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    const cpaUrlKey = normalizeCpaUrlForArchive(body.cpa_url, config.cpa_url);
    const credentialName = normalizeCredentialName(body.name);
    if (!credentialName) {
      res.status(400).json({ ok: false, error: 'name is required' });
      return;
    }

    const runtimeState = readRuntimeState();
    const nextEntry = setCredentialRuntimeState(runtimeState, cpaUrlKey, credentialName, body.state);
    writeRuntimeState(runtimeState);

    res.json({
      ok: true,
      payload: {
        cpa_url: cpaUrlKey,
        name: credentialName,
        state: nextEntry,
      },
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: String(error?.message || error) });
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

app.listen(PORT, () => {
  startBackendAutomationScheduler();
  console.log(`Backend config server is running on http://localhost:${PORT}`);
  console.log(`Backend automation scheduler wake interval: ${RUNTIME_WAKE_INTERVAL_MS}ms`);
});

