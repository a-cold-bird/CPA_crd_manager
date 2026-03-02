import express from 'express';
import cors from 'cors';
import fs from 'fs';
import yaml from 'js-yaml';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');
const MAIN_PY_PATH = path.join(PROJECT_ROOT, 'main.py');
const ARCHIVE_STORE_PATH = path.join(PROJECT_ROOT, 'runtime', 'credential_archive.json');

const app = express();
const PORT = Number(process.env.PORT || 8333);
const CONFIG_PATH = path.join(process.cwd(), 'config.yaml');

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Helper to read config
function readConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    return { cpa_url: '', management_key: '' };
  }
  const file = fs.readFileSync(CONFIG_PATH, 'utf8');
  try {
    return yaml.load(file);
  } catch (e) {
    console.error('Failed to parse config.yaml', e);
    return { cpa_url: '', management_key: '' };
  }
}

// Helper to write config
function writeConfig(data) {
  const current = readConfig();
  const merged = { ...current, ...data };
  const str = yaml.dump(merged);
  fs.writeFileSync(CONFIG_PATH, str, 'utf-8');
}

function isAuthorized(password, config) {
  return typeof password === 'string' && password === String(config.management_key || '');
}

function parseIntSafe(value, defaultValue) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

function parseFloatSafe(value, defaultValue) {
  const parsed = Number.parseFloat(String(value ?? ''));
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

function parseIndexesValue(value) {
  if (Array.isArray(value)) {
    return value
      .map((item) => Number.parseInt(String(item), 10))
      .filter((item) => Number.isFinite(item))
      .join(',');
  }
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => Number.parseInt(item, 10))
      .filter((item) => Number.isFinite(item))
      .join(',');
  }
  return '';
}

function isSubPath(parentPath, childPath) {
  const relative = path.relative(parentPath, childPath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function resolveAccountFilePath(rawPath) {
  const input = String(rawPath || '').trim();
  if (!input) {
    throw new Error('account_file is required');
  }
  const resolved = path.resolve(PROJECT_ROOT, input);
  if (!isSubPath(PROJECT_ROOT, resolved)) {
    throw new Error('account_file must be inside project root');
  }
  return resolved;
}

function readArchiveStore() {
  if (!fs.existsSync(ARCHIVE_STORE_PATH)) {
    return { by_cpa_url: {} };
  }
  try {
    const raw = fs.readFileSync(ARCHIVE_STORE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      return { by_cpa_url: {} };
    }
    if (!parsed.by_cpa_url || typeof parsed.by_cpa_url !== 'object') {
      return { by_cpa_url: {} };
    }
    return parsed;
  } catch {
    return { by_cpa_url: {} };
  }
}

function writeArchiveStore(store) {
  fs.mkdirSync(path.dirname(ARCHIVE_STORE_PATH), { recursive: true });
  fs.writeFileSync(ARCHIVE_STORE_PATH, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
}

function normalizeArchiveNames(names) {
  if (!Array.isArray(names)) return [];
  const normalized = names
    .map((item) => String(item || '').trim())
    .filter(Boolean);
  return Array.from(new Set(normalized));
}

function normalizeCpaUrlForArchive(rawUrl, fallbackUrl = '') {
  const value = String(rawUrl || fallbackUrl || '').trim();
  return value || '__default__';
}

function getArchiveNames(store, cpaUrlKey) {
  const items = store?.by_cpa_url?.[cpaUrlKey];
  if (!Array.isArray(items)) return [];
  return normalizeArchiveNames(items);
}

function setArchiveNames(store, cpaUrlKey, names) {
  const next = normalizeArchiveNames(names);
  if (!store.by_cpa_url || typeof store.by_cpa_url !== 'object') {
    store.by_cpa_url = {};
  }
  store.by_cpa_url[cpaUrlKey] = next;
  return next;
}

function normalizeAccountLines(content) {
  return String(content || '')
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function extractEmailPasswordKey(line) {
  const raw = String(line || '').trim();
  if (!raw) return '';

  if (raw.startsWith('{') && raw.endsWith('}')) {
    try {
      const obj = JSON.parse(raw);
      const email = String(obj?.email || '').trim().toLowerCase();
      const password = String(obj?.password || '').trim();
      if (email && password) {
        return `${email}----${password}`;
      }
      return '';
    } catch {
      return '';
    }
  }

  const parts = raw.split('----');
  if (parts.length < 2) {
    return '';
  }
  const email = String(parts[0] || '').trim().toLowerCase();
  const password = String(parts[1] || '').trim();
  if (!email || !password) {
    return '';
  }
  return `${email}----${password}`;
}

function mergeAccountLinesByEmailPassword(existingLines, incomingLines) {
  const merged = [];
  const indexByKey = new Map();
  let overwritten = 0;
  let added = 0;
  let skippedInvalid = 0;

  for (const line of existingLines) {
    const key = extractEmailPasswordKey(line);
    if (!key) {
      merged.push(line);
      continue;
    }
    if (indexByKey.has(key)) {
      const idx = indexByKey.get(key);
      merged[idx] = line;
      continue;
    }
    indexByKey.set(key, merged.length);
    merged.push(line);
  }

  for (const line of incomingLines) {
    const key = extractEmailPasswordKey(line);
    if (!key) {
      skippedInvalid += 1;
      continue;
    }
    if (indexByKey.has(key)) {
      const idx = indexByKey.get(key);
      merged[idx] = line;
      overwritten += 1;
      continue;
    }
    indexByKey.set(key, merged.length);
    merged.push(line);
    added += 1;
  }

  return { merged, added, overwritten, skippedInvalid };
}

function extractLastJsonObject(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  try {
    const payload = JSON.parse(raw);
    if (payload && typeof payload === 'object') return payload;
  } catch {
    // fallback
  }
  for (let i = raw.length - 1; i >= 0; i -= 1) {
    if (raw[i] !== '{') continue;
    const candidate = raw.slice(i);
    try {
      const payload = JSON.parse(candidate);
      if (payload && typeof payload === 'object') return payload;
    } catch {
      // keep searching
    }
  }
  return null;
}

function buildCliCommonArgs(config, body) {
  const cpaUrl = String(body?.cpa_url || config.cpa_url || '').trim();
  const managementKey = String(config.management_key || '').trim();
  const timeout = Math.max(5, parseIntSafe(body?.timeout, 35));
  if (!cpaUrl) {
    throw new Error('config cpa_url is empty');
  }
  if (!managementKey) {
    throw new Error('config management_key is empty');
  }
  return [
    '--cpa-url',
    cpaUrl,
    '--management-key',
    managementKey,
    '--timeout',
    String(timeout),
  ];
}

function runPythonMain(args, timeoutMs = 10 * 60 * 1000, options = {}) {
  return new Promise((resolve) => {
    const child = spawn('python', [MAIN_PY_PATH, ...args], {
      cwd: PROJECT_ROOT,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let aborted = false;
    let settled = false;
    const abortSignal = options?.abortSignal;

    const cleanupAbortListener = () => {
      if (abortSignal && typeof abortSignal.removeEventListener === 'function') {
        abortSignal.removeEventListener('abort', onAbort);
      }
    };
    const finish = (payload) => {
      if (settled) return;
      settled = true;
      cleanupAbortListener();
      resolve(payload);
    };
    const onAbort = () => {
      aborted = true;
      if (!child.killed) {
        child.kill('SIGTERM');
      }
    };

    if (abortSignal && typeof abortSignal.addEventListener === 'function') {
      abortSignal.addEventListener('abort', onAbort);
      if (abortSignal.aborted) {
        onAbort();
      }
    }

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, Math.max(5000, timeoutMs));

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      finish({
        ok: false,
        exit_code: -1,
        timed_out: false,
        aborted,
        stdout,
        stderr: `${stderr}\n${String(error?.message || error)}`.trim(),
        payload: null,
      });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const exitCode = Number(code ?? -1);
      finish({
        ok: exitCode === 0 && !timedOut && !aborted,
        exit_code: exitCode,
        signal: signal || '',
        timed_out: timedOut,
        aborted,
        stdout,
        stderr,
        payload: extractLastJsonObject(stdout),
      });
    });
  });
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
  const { password } = req.body;
  const config = readConfig();
  if (isAuthorized(password, config)) {
    res.json({ ok: true, config });
  } else {
    res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
});

// 3. Update config (requires current password or new password)
app.post('/api/config/update', (req, res) => {
  const { old_password, new_config } = req.body;
  const config = readConfig();

  // To update config, they must provide the correct current password
  if (isAuthorized(old_password, config)) {
    try {
      writeConfig({
        cpa_url: new_config.cpa_url !== undefined ? new_config.cpa_url : config.cpa_url,
        management_key: new_config.management_key !== undefined ? new_config.management_key : config.management_key,
      });
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false, error: 'Failed to write config.yaml' });
    }
  } else {
    res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
});

app.post('/api/oauth/login', async (req, res) => {
  const body = req.body || {};
  const config = readConfig();
  if (!isAuthorized(body.password, config)) {
    res.status(401).json({ ok: false, error: 'Unauthorized' });
    return;
  }
  try {
    const requestAbortController = new AbortController();
    req.on('aborted', () => {
      requestAbortController.abort();
    });
    const provider = String(body.provider || 'codex').trim() || 'codex';
    const accountFile = String(body.account_file || '').trim();
    if (!accountFile) {
      res.status(400).json({ ok: false, error: 'account_file is required' });
      return;
    }
    const index = parseIntSafe(body.index, 0);
    const waitSeconds = Math.max(5, parseIntSafe(body.wait_seconds, 30));
    const maxWait = Math.max(30, parseIntSafe(body.max_wait, 180));
    const callbackUrl = String(body.callback_url || '').trim();
    const headless = parseBoolSafe(body.headless, false);
    const execTimeoutMs = Math.max(10000, parseIntSafe(body.exec_timeout_ms, 10 * 60 * 1000));
    const args = [
      ...buildCliCommonArgs(config, body),
      'oauth-login',
      '--provider',
      provider,
      '--account-file',
      accountFile,
      '--index',
      String(index),
      '--wait-seconds',
      String(waitSeconds),
      '--max-wait',
      String(maxWait),
    ];
    if (headless) args.push('--headless');
    if (callbackUrl) {
      args.push('--callback-url', callbackUrl);
    }
    const result = await runPythonMain(args, execTimeoutMs, { abortSignal: requestAbortController.signal });
    res.status(result.ok ? 200 : 400).json(result);
  } catch (error) {
    res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

app.post('/api/oauth/login-batch', async (req, res) => {
  const body = req.body || {};
  const config = readConfig();
  if (!isAuthorized(body.password, config)) {
    res.status(401).json({ ok: false, error: 'Unauthorized' });
    return;
  }
  try {
    const provider = String(body.provider || 'codex').trim() || 'codex';
    const accountFile = String(body.account_file || '').trim();
    if (!accountFile) {
      res.status(400).json({ ok: false, error: 'account_file is required' });
      return;
    }
    const start = Math.max(0, parseIntSafe(body.start, 0));
    const limit = parseIntSafe(body.limit, 0);
    const workers = Math.max(1, parseIntSafe(body.workers, 1));
    const indexes = parseIndexesValue(body.indexes);
    const retries = Math.max(0, parseIntSafe(body.retries, 0));
    const waitSeconds = Math.max(5, parseIntSafe(body.wait_seconds, 30));
    const maxWait = Math.max(30, parseIntSafe(body.max_wait, 180));
    const cooldown = Math.max(0, parseFloatSafe(body.cooldown, 0));
    const callbackFile = String(body.callback_file || '').trim();
    const resultFile = String(body.result_file || 'runtime/batch_login_callback_results.jsonl').trim();
    const successFile = String(body.success_file || 'runtime/batch_login_callback_success.txt').trim();
    const detailLogFile = String(body.detail_log_file || 'runtime/batch_login_callback_detail.log').trim();
    const headless = parseBoolSafe(body.headless, false);
    const skipSubmitted = parseBoolSafe(body.skip_submitted, false);
    const dryRun = parseBoolSafe(body.dry_run, false);
    const execTimeoutMs = Math.max(10000, parseIntSafe(body.exec_timeout_ms, 30 * 60 * 1000));
    const args = [
      ...buildCliCommonArgs(config, body),
      'oauth-login-batch',
      '--provider',
      provider,
      '--account-file',
      accountFile,
      '--start',
      String(start),
      '--limit',
      String(limit),
      '--indexes',
      String(indexes || ''),
      '--workers',
      String(workers),
      '--retries',
      String(retries),
      '--wait-seconds',
      String(waitSeconds),
      '--max-wait',
      String(maxWait),
      '--cooldown',
      String(cooldown),
      '--result-file',
      resultFile,
      '--success-file',
      successFile,
      '--detail-log-file',
      detailLogFile,
    ];
    if (headless) args.push('--headless');
    if (skipSubmitted) args.push('--skip-submitted');
    if (dryRun) args.push('--dry-run');
    if (callbackFile) {
      args.push('--callback-file', callbackFile);
    }
    const result = await runPythonMain(args, execTimeoutMs);
    res.status(result.ok ? 200 : 400).json(result);
  } catch (error) {
    res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

app.post('/api/oauth/accounts/preview', async (req, res) => {
  const body = req.body || {};
  const config = readConfig();
  if (!isAuthorized(body.password, config)) {
    res.status(401).json({ ok: false, error: 'Unauthorized' });
    return;
  }
  try {
    const provider = String(body.provider || 'codex').trim() || 'codex';
    const accountFile = String(body.account_file || '').trim();
    if (!accountFile) {
      res.status(400).json({ ok: false, error: 'account_file is required' });
      return;
    }
    const mode = String(body.mode || 'batch').trim().toLowerCase() === 'single' ? 'single' : 'batch';
    const index = parseIntSafe(body.index, 0);
    const start = Math.max(0, parseIntSafe(body.start, 0));
    const limit = parseIntSafe(body.limit, 0);
    const execTimeoutMs = Math.max(5000, parseIntSafe(body.exec_timeout_ms, 30 * 1000));
    const args = [
      'oauth-account-preview',
      '--provider',
      provider,
      '--account-file',
      accountFile,
      '--mode',
      mode,
    ];
    if (mode === 'single') {
      args.push('--index', String(index));
    } else {
      args.push('--start', String(start), '--limit', String(limit));
    }
    const result = await runPythonMain(args, execTimeoutMs);
    res.status(result.ok ? 200 : 400).json(result);
  } catch (error) {
    res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

app.post('/api/oauth/accounts/append', (req, res) => {
  const body = req.body || {};
  const config = readConfig();
  if (!isAuthorized(body.password, config)) {
    res.status(401).json({ ok: false, error: 'Unauthorized' });
    return;
  }
  try {
    const accountFile = String(body.account_file || '').trim();
    const content = String(body.content || '');
    const normalized = normalizeAccountLines(content);
    if (!accountFile) {
      res.status(400).json({ ok: false, error: 'account_file is required' });
      return;
    }
    if (normalized.length === 0) {
      res.status(400).json({ ok: false, error: 'content is empty' });
      return;
    }
    const resolvedPath = resolveAccountFilePath(accountFile);
    fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
    const existingLines = fs.existsSync(resolvedPath)
      ? normalizeAccountLines(fs.readFileSync(resolvedPath, 'utf8'))
      : [];
    const { merged, added, overwritten, skippedInvalid } = mergeAccountLinesByEmailPassword(existingLines, normalized);
    const output = merged.length > 0 ? `${merged.join('\n')}\n` : '';
    fs.writeFileSync(resolvedPath, output, 'utf8');
    res.json({
      ok: true,
      exit_code: 0,
      timed_out: false,
      signal: '',
      stdout: '',
      stderr: '',
      payload: {
        file: path.relative(PROJECT_ROOT, resolvedPath).replace(/\\/g, '/'),
        appended: added,
        added,
        overwritten,
        skipped_invalid: skippedInvalid,
        input_total: normalized.length,
        final_total: merged.length,
      },
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

app.post('/api/oauth/accounts/delete', async (req, res) => {
  const body = req.body || {};
  const config = readConfig();
  if (!isAuthorized(body.password, config)) {
    res.status(401).json({ ok: false, error: 'Unauthorized' });
    return;
  }
  try {
    const provider = String(body.provider || 'codex').trim() || 'codex';
    const accountFile = String(body.account_file || '').trim();
    const indexes = parseIndexesValue(body.indexes);
    if (!accountFile) {
      res.status(400).json({ ok: false, error: 'account_file is required' });
      return;
    }
    if (!indexes) {
      res.status(400).json({ ok: false, error: 'indexes is required' });
      return;
    }
    const execTimeoutMs = Math.max(5000, parseIntSafe(body.exec_timeout_ms, 30 * 1000));
    const args = [
      'oauth-account-delete',
      '--provider',
      provider,
      '--account-file',
      accountFile,
      '--indexes',
      indexes,
    ];
    const result = await runPythonMain(args, execTimeoutMs);
    res.status(result.ok ? 200 : 400).json(result);
  } catch (error) {
    res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

app.post('/api/archive/list', (req, res) => {
  const body = req.body || {};
  const config = readConfig();
  if (!isAuthorized(body.password, config)) {
    res.status(401).json({ ok: false, error: 'Unauthorized' });
    return;
  }
  try {
    const cpaUrlKey = normalizeCpaUrlForArchive(body.cpa_url, config.cpa_url);
    const store = readArchiveStore();
    const names = getArchiveNames(store, cpaUrlKey);
    res.json({
      ok: true,
      payload: {
        cpa_url: cpaUrlKey,
        names,
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
  if (!isAuthorized(body.password, config)) {
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
    const current = getArchiveNames(store, cpaUrlKey);
    const merged = Array.from(new Set([...current, ...incoming]));
    setArchiveNames(store, cpaUrlKey, merged);
    writeArchiveStore(store);
    res.json({
      ok: true,
      payload: {
        cpa_url: cpaUrlKey,
        names: merged,
        total: merged.length,
        added: merged.length - current.length,
      },
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

app.post('/api/archive/remove', (req, res) => {
  const body = req.body || {};
  const config = readConfig();
  if (!isAuthorized(body.password, config)) {
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
    const current = getArchiveNames(store, cpaUrlKey);
    const next = current.filter((name) => !removing.has(name));
    setArchiveNames(store, cpaUrlKey, next);
    writeArchiveStore(store);
    res.json({
      ok: true,
      payload: {
        cpa_url: cpaUrlKey,
        names: next,
        total: next.length,
        removed: current.length - next.length,
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

app.listen(PORT, () => {
  console.log(`Backend config server is running on http://localhost:${PORT}`);
});
