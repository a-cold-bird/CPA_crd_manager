import os
import sys
import json
import yaml
import argparse
import importlib
import requests
import logging
import time
import errno
import ctypes
import contextlib
import threading
import random
from typing import Callable, Dict, Any, List, Optional, Set, Tuple

# Setup logging
logging.basicConfig(
    level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s"
)
logger = logging.getLogger(__name__)
PROJECT_ROOT = os.path.dirname(os.path.abspath(__file__))
RUNTIME_DIR = os.path.join(PROJECT_ROOT, "runtime")
REPLENISHMENT_STATUS_PATH = os.path.join(RUNTIME_DIR, "replenishment_status.json")
REPLENISHMENT_LOCK_PATH = os.path.join(RUNTIME_DIR, "replenishment.lock")
INTERNAL_REGISTER_PACKAGE = "internal_register.register"
INTERNAL_REGISTER_ROOT = os.path.join(PROJECT_ROOT, "internal_register")
PRIMARY_UPLOAD_RETRIES = 3
DEFAULT_REGISTRATION_BATCH_SIZE = 1
CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage"
CODEX_USER_AGENT = "codex_cli_rs/0.98.0"
REPLENISHMENT_EVENT_LIMIT = 80
REPLENISHMENT_LOG_TAIL_LIMIT = 120
REPLENISHMENT_BATCH_HISTORY_LIMIT = 12
REPLENISHMENT_BATCH_EVENT_LIMIT = 20
REPLENISHMENT_BATCH_ACCOUNT_LIMIT = 16
REPLENISHMENT_STATUS_LOCK = threading.RLock()
REGISTER_TOKEN_WATCH_POLL_SECONDS = 0.75
REGISTER_TOKEN_READY_AGE_NS = 1_000_000_000


def normalize_domain_list(value: Any) -> List[str]:
    if isinstance(value, list):
        raw_items = value
    else:
        raw_items = str(value or "").replace("\r", "\n").replace(",", "\n").split("\n")

    domains: List[str] = []
    seen: Set[str] = set()
    for raw in raw_items:
        domain = str(raw or "").strip().lower()
        if not domain or domain in seen:
            continue
        seen.add(domain)
        domains.append(domain)
    return domains


def load_provider_domain_list(config: Dict[str, Any]) -> List[str]:
    provider = (
        str(config.get("mail_email_provider", "mailfree") or "mailfree").strip().lower()
    )
    domain_source = config.get(
        "inbucket_mail_domains" if provider == "inbucket" else "mail_email_domains",
        "",
    )
    if provider == "inbucket" and not normalize_domain_list(domain_source):
        domain_source = config.get("mail_email_domains", "")
    configured_domains = normalize_domain_list(domain_source)
    default_domain = str(config.get("mail_email_domain", "") or "").strip().lower()

    if default_domain:
        configured_domains = [
            item for item in configured_domains if item != default_domain
        ]
        configured_domains.insert(0, default_domain)
    return configured_domains


def extract_email_domain(email: str) -> str:
    normalized = str(email or "").strip().lower()
    at_index = normalized.rfind("@")
    if at_index <= 0 or at_index >= len(normalized) - 1:
        return ""
    return normalized[at_index + 1 :]


def match_configured_domain(actual_domain: str, configured_domains: List[str]) -> str:
    normalized_actual = str(actual_domain or "").strip().lower()
    if not normalized_actual:
        return ""

    for configured_domain in configured_domains or []:
        normalized_configured = str(configured_domain or "").strip().lower()
        if not normalized_configured:
            continue
        if not normalized_configured.startswith("*."):
            if normalized_configured == normalized_actual:
                return normalized_configured
            continue
        suffix = normalized_configured[2:]
        if normalized_actual == suffix:
            continue
        if normalized_actual.endswith(f".{suffix}"):
            return normalized_configured

    return normalized_actual


def record_domain_stat_result(
    config: Dict[str, Any], *, email: str, register_ok: bool, codex_ok: bool
) -> None:
    actual_domain = extract_email_domain(email)
    if not actual_domain:
        return
    configured_domains = load_provider_domain_list(config)
    grouped_domain = match_configured_domain(actual_domain, configured_domains)
    if not grouped_domain:
        return

    def _mutate(current: Dict[str, Any]) -> None:
        domain_stats = current.get("domain_stats")
        if not isinstance(domain_stats, dict):
            domain_stats = {}
        current_stat = domain_stats.get(grouped_domain)
        if not isinstance(current_stat, dict):
            current_stat = {"total": 0, "success": 0, "fail": 0}
        current_stat["total"] = int(current_stat.get("total") or 0) + 1
        if bool(register_ok) and bool(codex_ok):
            current_stat["success"] = int(current_stat.get("success") or 0) + 1
        else:
            current_stat["fail"] = int(current_stat.get("fail") or 0) + 1
        domain_stats[grouped_domain] = {
            "total": int(current_stat.get("total") or 0),
            "success": int(current_stat.get("success") or 0),
            "fail": int(current_stat.get("fail") or 0),
        }
        current["domain_stats"] = domain_stats

    mutate_replenishment_status(_mutate)


def build_replenishment_summary(state: str) -> str:
    mapping = {
        "started": "Registration started.",
        "running": "Registration running.",
        "success": "Registration succeeded.",
        "failed": "Registration failed.",
        "idle": "No replenishment needed.",
        "disabled": "Codex replenishment is disabled.",
        "target_zero": "Target count is 0.",
        "backfill_started": "Backfill started.",
        "backfill_finished": "Backfill finished.",
        "backfill_failed": "Backfill failed.",
    }
    return mapping.get(str(state or "").strip().lower(), str(state or "").strip())


def _now_ms() -> int:
    return int(time.time() * 1000)


def create_empty_batch_status() -> Dict[str, Any]:
    return {
        "attempt": None,
        "requested": None,
        "workers": None,
        "selected_domain": "",
        "email_selection_mode": "",
        "status": "",
        "register_succeeded": 0,
        "register_failed": 0,
        "codex_succeeded": 0,
        "codex_failed": 0,
        "upload_succeeded": 0,
        "upload_failed": 0,
        "current_proxy": "",
        "current_email": "",
        "last_error": "",
        "started_at": None,
        "finished_at": None,
        "events": [],
        "accounts": [],
    }


def create_empty_batch_account() -> Dict[str, Any]:
    return {
        "idx": None,
        "total": None,
        "email": "",
        "proxy": "",
        "status": "",
        "register_ok": False,
        "codex_ok": False,
        "upload_ok": False,
        "error": "",
        "updated_at": None,
    }


def normalize_batch_account(account: Any) -> Optional[Dict[str, Any]]:
    if not isinstance(account, dict):
        return None
    normalized = {**create_empty_batch_account(), **account}
    normalized["email"] = str(normalized.get("email") or "")
    normalized["proxy"] = str(normalized.get("proxy") or "")
    normalized["status"] = str(normalized.get("status") or "")
    normalized["error"] = str(normalized.get("error") or "")
    normalized["register_ok"] = bool(normalized.get("register_ok"))
    normalized["codex_ok"] = bool(normalized.get("codex_ok"))
    normalized["upload_ok"] = bool(normalized.get("upload_ok"))
    for key in ("idx", "total", "updated_at"):
        value = normalized.get(key)
        normalized[key] = int(value) if isinstance(value, (int, float)) else None
    return normalized


def upsert_batch_account(
    batch: Dict[str, Any], *, idx: Optional[int] = None, email: str = "", **partial: Any
) -> None:
    accounts = [
        item
        for item in (
            normalize_batch_account(entry)
            for entry in list(batch.get("accounts") or [])
        )
        if item
    ]
    normalized_email = str(email or "").strip().lower()
    target_index = None
    for i, account in enumerate(accounts):
        if (
            normalized_email
            and str(account.get("email") or "").strip().lower() == normalized_email
        ):
            target_index = i
            break
        if idx is not None and account.get("idx") == idx:
            target_index = i
            break
    account = (
        accounts[target_index]
        if target_index is not None
        else create_empty_batch_account()
    )
    if idx is not None:
        account["idx"] = int(idx)
    if normalized_email:
        account["email"] = normalized_email
    account.update(partial)
    account["updated_at"] = _now_ms()
    normalized_account = (
        normalize_batch_account(account) or create_empty_batch_account()
    )
    if target_index is None:
        accounts.append(normalized_account)
    else:
        accounts[target_index] = normalized_account
    accounts.sort(
        key=lambda item: (int(item.get("updated_at") or 0), int(item.get("idx") or 0))
    )
    batch["accounts"] = accounts[-REPLENISHMENT_BATCH_ACCOUNT_LIMIT:]


def normalize_batch_status(batch: Any) -> Optional[Dict[str, Any]]:
    if not isinstance(batch, dict):
        return None

    normalized = {**create_empty_batch_status(), **batch}
    normalized["selected_domain"] = str(normalized.get("selected_domain") or "")
    normalized["email_selection_mode"] = str(
        normalized.get("email_selection_mode") or ""
    )
    normalized["status"] = str(normalized.get("status") or "")
    normalized["current_proxy"] = str(normalized.get("current_proxy") or "")
    normalized["current_email"] = str(normalized.get("current_email") or "")
    normalized["last_error"] = str(normalized.get("last_error") or "")
    normalized["events"] = [
        str(item)
        for item in list(normalized.get("events") or [])[
            -REPLENISHMENT_BATCH_EVENT_LIMIT:
        ]
    ]
    normalized["accounts"] = [
        item
        for item in (
            normalize_batch_account(entry)
            for entry in list(normalized.get("accounts") or [])
        )
        if item
    ][-REPLENISHMENT_BATCH_ACCOUNT_LIMIT:]

    for key in (
        "attempt",
        "requested",
        "workers",
        "register_succeeded",
        "register_failed",
        "codex_succeeded",
        "codex_failed",
        "upload_succeeded",
        "upload_failed",
        "started_at",
        "finished_at",
    ):
        value = normalized.get(key)
        normalized[key] = (
            int(value)
            if isinstance(value, (int, float))
            else (
                None
                if key
                in {"attempt", "requested", "workers", "started_at", "finished_at"}
                else 0
            )
        )

    return normalized


def sanitize_replenishment_status(status: Dict[str, Any]) -> Dict[str, Any]:
    current = {**create_empty_replenishment_status(), **(status or {})}
    if isinstance(current.get("failed_names"), list):
        current["failed_names"] = [str(item) for item in current["failed_names"][:20]]
    if isinstance(current.get("recent_events"), list):
        current["recent_events"] = [
            str(item) for item in current["recent_events"][-REPLENISHMENT_EVENT_LIMIT:]
        ]
    if isinstance(current.get("log_tail"), list):
        current["log_tail"] = [
            str(item) for item in current["log_tail"][-REPLENISHMENT_LOG_TAIL_LIMIT:]
        ]
    current["email_selection_mode"] = str(current.get("email_selection_mode") or "")
    current["last_selected_domain"] = str(current.get("last_selected_domain") or "")
    raw_domain_stats = current.get("domain_stats")
    if isinstance(raw_domain_stats, dict):
        normalized_domain_stats: Dict[str, Dict[str, int]] = {}
        for key, value in raw_domain_stats.items():
            domain = str(key or "").strip().lower()
            if not domain or not isinstance(value, dict):
                continue
            normalized_domain_stats[domain] = {
                "total": int(value.get("total") or 0),
                "success": int(value.get("success") or 0),
                "fail": int(value.get("fail") or 0),
            }
        current["domain_stats"] = normalized_domain_stats
    else:
        current["domain_stats"] = {}
    current["current_batch"] = normalize_batch_status(current.get("current_batch"))
    current["batch_history"] = [
        item
        for item in (
            normalize_batch_status(entry)
            for entry in list(current.get("batch_history") or [])
        )
        if item
    ][-REPLENISHMENT_BATCH_HISTORY_LIMIT:]
    return current


def snapshot_register_token_files(
    register_token_dir: str,
) -> Dict[str, Tuple[int, int]]:
    snapshot: Dict[str, Tuple[int, int]] = {}
    if not os.path.isdir(register_token_dir):
        return snapshot

    for entry in os.scandir(register_token_dir):
        if not entry.is_file() or not entry.name.endswith(".json"):
            continue
        try:
            stat = entry.stat()
        except OSError:
            continue
        snapshot[entry.name] = (
            int(stat.st_size),
            int(getattr(stat, "st_mtime_ns", int(stat.st_mtime * 1_000_000_000))),
        )
    return snapshot


def detect_changed_register_tokens(
    before_snapshot: Dict[str, Tuple[int, int]],
    after_snapshot: Dict[str, Tuple[int, int]],
) -> List[str]:
    changed_files = [
        file_name
        for file_name, metadata in after_snapshot.items()
        if before_snapshot.get(file_name) != metadata
    ]
    changed_files.sort(key=lambda file_name: after_snapshot[file_name][1])
    return changed_files


def detect_ready_changed_register_tokens(
    before_snapshot: Dict[str, Tuple[int, int]],
    after_snapshot: Dict[str, Tuple[int, int]],
    *,
    emitted: Optional[Set[str]] = None,
    allow_unstable: bool = False,
) -> List[str]:
    emitted_names = emitted or set()
    now_ns = time.time_ns()
    ready_files: List[str] = []
    for file_name in detect_changed_register_tokens(before_snapshot, after_snapshot):
        if file_name in emitted_names:
            continue
        _size, mtime_ns = after_snapshot[file_name]
        if allow_unstable or now_ns - int(mtime_ns) >= REGISTER_TOKEN_READY_AGE_NS:
            ready_files.append(file_name)
    return ready_files


def load_config(config_path: str) -> Dict[str, Any]:
    if not os.path.exists(config_path):
        return {}
    with open(config_path, "r", encoding="utf-8") as f:
        return yaml.safe_load(f) or {}


def load_runtime_state(state_path: str) -> Dict[str, Any]:
    if not os.path.exists(state_path):
        return {}
    with open(state_path, "r", encoding="utf-8") as f:
        return json.load(f) or {}


def normalize_cpa_url(cpa_url: str) -> str:
    return str(cpa_url or "").strip().rstrip("/")


def build_cpa_url(cpa_url: str, path: str) -> str:
    base = normalize_cpa_url(cpa_url)
    if not base:
        raise ValueError("cpa_url is required")
    return f"{base}{path}"


def create_cpa_session(management_key: str) -> requests.Session:
    session = requests.Session()
    session.trust_env = False
    session.headers.update(
        {
            "Authorization": f"Bearer {management_key}",
            "Accept": "application/json",
        }
    )
    return session


def ensure_runtime_dir() -> str:
    os.makedirs(RUNTIME_DIR, exist_ok=True)
    return RUNTIME_DIR


def is_pid_running(pid: int) -> bool:
    if pid <= 0:
        return False
    if os.name == "nt":
        PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
        kernel32 = ctypes.windll.kernel32
        handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
        if not handle:
            return False
        try:
            exit_code = ctypes.c_ulong()
            if not kernel32.GetExitCodeProcess(handle, ctypes.byref(exit_code)):
                return False
            return exit_code.value == 259
        finally:
            kernel32.CloseHandle(handle)

    try:
        os.kill(pid, 0)
    except OSError:
        return False
    return True


def read_lock_payload(lock_path: str) -> Dict[str, Any]:
    if not os.path.exists(lock_path):
        return {}
    try:
        with open(lock_path, "r", encoding="utf-8") as f:
            data = json.load(f) or {}
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def remove_stale_replenishment_lock(lock_path: str) -> bool:
    payload = read_lock_payload(lock_path)
    pid = int(payload.get("pid") or 0)
    if pid > 0 and is_pid_running(pid):
        return False

    try:
        os.remove(lock_path)
        logger.warning(
            "Removed stale replenishment lock: %s payload=%s", lock_path, payload
        )
        return True
    except FileNotFoundError:
        return True
    except OSError as exc:
        logger.warning(
            "Failed to remove stale replenishment lock: %s error=%s", lock_path, exc
        )
        return False


class ReplenishmentLock:
    def __init__(self, mode: str):
        self.mode = mode
        self.lock_path = REPLENISHMENT_LOCK_PATH
        self.fd: Optional[int] = None
        self.acquired = False

    def acquire(self) -> bool:
        ensure_runtime_dir()
        payload = {
            "pid": os.getpid(),
            "mode": self.mode,
            "started_at_ms": int(time.time() * 1000),
        }

        while True:
            try:
                self.fd = os.open(self.lock_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
                with os.fdopen(self.fd, "w", encoding="utf-8") as f:
                    json.dump(payload, f, indent=2, ensure_ascii=False)
                    f.write("\n")
                self.fd = None
                self.acquired = True
                logger.info(
                    "Acquired replenishment lock: %s payload=%s",
                    self.lock_path,
                    payload,
                )
                return True
            except OSError as exc:
                if exc.errno != errno.EEXIST:
                    raise
                if not remove_stale_replenishment_lock(self.lock_path):
                    existing = read_lock_payload(self.lock_path)
                    logger.info(
                        "Skip start because replenishment lock is already held: %s",
                        existing,
                    )
                    return False

    def release(self) -> None:
        if not self.acquired:
            return
        try:
            os.remove(self.lock_path)
            logger.info("Released replenishment lock: %s", self.lock_path)
        except FileNotFoundError:
            pass
        finally:
            self.acquired = False


def create_empty_replenishment_status() -> Dict[str, Any]:
    return {
        "mode": "",
        "in_progress": False,
        "last_started_at": None,
        "last_finished_at": None,
        "last_error": "",
        "last_limit": None,
        "target_count": None,
        "threshold": None,
        "batch_size": None,
        "worker_count": None,
        "use_proxy": None,
        "healthy_count": None,
        "needed": None,
        "new_token_files": None,
        "last_scan_register_total": None,
        "last_scan_cpa_total": None,
        "last_scan_missing_count": None,
        "last_uploaded": None,
        "last_failed": None,
        "failed_names": [],
        "last_summary": "",
        "proxy_pool_size": 0,
        "log_file": "",
        "recent_events": [],
        "log_tail": [],
        "email_selection_mode": "",
        "last_selected_domain": "",
        "domain_stats": {},
        "current_batch": None,
        "batch_history": [],
    }


def read_replenishment_status() -> Dict[str, Any]:
    with REPLENISHMENT_STATUS_LOCK:
        if not os.path.exists(REPLENISHMENT_STATUS_PATH):
            return create_empty_replenishment_status()
        try:
            with open(REPLENISHMENT_STATUS_PATH, "r", encoding="utf-8") as f:
                data = json.load(f) or {}
            if not isinstance(data, dict):
                return create_empty_replenishment_status()
            return sanitize_replenishment_status(data)
        except Exception:
            return create_empty_replenishment_status()


def write_replenishment_status(status: Dict[str, Any]) -> None:
    with REPLENISHMENT_STATUS_LOCK:
        ensure_runtime_dir()
        merged = sanitize_replenishment_status(status)
        with open(REPLENISHMENT_STATUS_PATH, "w", encoding="utf-8") as f:
            json.dump(merged, f, indent=2, ensure_ascii=False)
            f.write("\n")


def mutate_replenishment_status(mutator) -> Dict[str, Any]:
    with REPLENISHMENT_STATUS_LOCK:
        current = read_replenishment_status()
        mutator(current)
        merged = sanitize_replenishment_status(current)
        with open(REPLENISHMENT_STATUS_PATH, "w", encoding="utf-8") as f:
            json.dump(merged, f, indent=2, ensure_ascii=False)
            f.write("\n")
        return merged


def update_replenishment_status(**partial: Any) -> None:
    mutate_replenishment_status(lambda current: current.update(partial))


def append_replenishment_event(message: str) -> None:
    stamped = f"{time.strftime('%H:%M:%S')} {str(message or '').strip()}"
    if not stamped.strip():
        return

    def _mutate(current: Dict[str, Any]) -> None:
        events = list(current.get("recent_events") or [])
        events.append(stamped)
        current["recent_events"] = events[-REPLENISHMENT_EVENT_LIMIT:]
        current["last_summary"] = str(message or current.get("last_summary") or "")

    mutate_replenishment_status(_mutate)


def append_replenishment_log_line(line: str) -> None:
    text = str(line or "").rstrip()
    if not text:
        return

    def _mutate(current: Dict[str, Any]) -> None:
        log_tail = list(current.get("log_tail") or [])
        log_tail.append(text)
        current["log_tail"] = log_tail[-REPLENISHMENT_LOG_TAIL_LIMIT:]

    mutate_replenishment_status(_mutate)


def append_batch_event(batch: Dict[str, Any], message: str) -> None:
    text = str(message or "").strip()
    if not text:
        return
    events = list(batch.get("events") or [])
    events.append(f"{time.strftime('%H:%M:%S')} {text}")
    batch["events"] = events[-REPLENISHMENT_BATCH_EVENT_LIMIT:]


def start_current_batch_status(
    *,
    attempt: int,
    requested: int,
    workers: int,
    selected_domain: str,
    email_selection_mode: str,
) -> None:
    batch = create_empty_batch_status()
    batch.update(
        {
            "attempt": attempt,
            "requested": requested,
            "workers": workers,
            "selected_domain": selected_domain,
            "email_selection_mode": email_selection_mode,
            "status": "registering",
            "started_at": _now_ms(),
        }
    )
    append_batch_event(batch, f"Batch {attempt} started with domain {selected_domain}.")
    update_replenishment_status(
        current_batch=batch,
        last_selected_domain=selected_domain,
        email_selection_mode=email_selection_mode,
    )


def update_current_batch_status(
    *, event_message: Optional[str] = None, **partial: Any
) -> None:
    def _mutate(current: Dict[str, Any]) -> None:
        batch = (
            normalize_batch_status(current.get("current_batch"))
            or create_empty_batch_status()
        )
        batch.update(partial)
        if event_message:
            append_batch_event(batch, event_message)
        current["current_batch"] = batch

    mutate_replenishment_status(_mutate)


def bump_current_batch_status(
    *,
    event_message: Optional[str] = None,
    last_error: Optional[str] = None,
    **partial: Any,
) -> None:
    def _mutate(current: Dict[str, Any]) -> None:
        batch = (
            normalize_batch_status(current.get("current_batch"))
            or create_empty_batch_status()
        )
        counter_keys = {
            "register_succeeded",
            "register_failed",
            "codex_succeeded",
            "codex_failed",
            "upload_succeeded",
            "upload_failed",
        }
        for key, value in partial.items():
            if key in counter_keys:
                batch[key] = int(batch.get(key) or 0) + int(value or 0)
            else:
                batch[key] = value
        if last_error is not None:
            batch["last_error"] = str(last_error or "")
        if event_message:
            append_batch_event(batch, event_message)
        current["current_batch"] = batch

    mutate_replenishment_status(_mutate)


def finish_current_batch_status(*, status: str, error: str = "") -> None:
    def _mutate(current: Dict[str, Any]) -> None:
        batch = normalize_batch_status(current.get("current_batch"))
        if not batch:
            return
        batch["status"] = status
        batch["finished_at"] = _now_ms()
        if error:
            batch["last_error"] = str(error)
            append_batch_event(batch, f"Batch finished with error: {error}")
        else:
            append_batch_event(batch, f"Batch finished with status {status}.")
        history = list(current.get("batch_history") or [])
        history.append(batch)
        current["current_batch"] = batch
        current["batch_history"] = history[-REPLENISHMENT_BATCH_HISTORY_LIMIT:]

    mutate_replenishment_status(_mutate)


class TeeLineWriter:
    def __init__(self, downstream, log_handle):
        self.downstream = downstream
        self.log_handle = log_handle
        self.buffer = ""

    def write(self, data):
        text = str(data or "")
        if not text:
            return 0
        self.downstream.write(text)
        self.downstream.flush()
        self.log_handle.write(text)
        self.log_handle.flush()
        self.buffer += text
        while "\n" in self.buffer:
            line, self.buffer = self.buffer.split("\n", 1)
            append_replenishment_log_line(line)
        return len(text)

    def flush(self):
        self.downstream.flush()
        self.log_handle.flush()
        if self.buffer.strip():
            append_replenishment_log_line(self.buffer)
        self.buffer = ""


def get_register_token_dir() -> str:
    return os.path.join(PROJECT_ROOT, "codex_tokens")


def get_local_backup_dir() -> str:
    return os.path.join(ensure_runtime_dir(), "replenished_tokens")


def configure_internal_register_environment(config: Dict[str, Any]) -> None:
    configured_domains = load_provider_domain_list(config)
    default_domain = str(config.get("mail_email_domain", "") or "").strip().lower()
    mail_provider = (
        str(config.get("mail_email_provider", "mailfree") or "mailfree").strip().lower()
    )
    if default_domain and default_domain not in configured_domains:
        configured_domains.insert(0, default_domain)

    provider_api_base = str(
        config.get(
            "inbucket_mail_api_base"
            if mail_provider == "inbucket"
            else "mail_api_base",
            "",
        )
        or config.get("mail_api_base", "")
        or ""
    ).strip()

    env_updates = {
        "MAIL_EMAIL_PROVIDER": mail_provider,
        "MAIL_API_BASE": provider_api_base,
        "DUCKMAIL_API_BASE": provider_api_base,
        "MAIL_USERNAME": str(config.get("mail_username", "") or "").strip(),
        "MAIL_PASSWORD": str(config.get("mail_password", "") or ""),
        "MAIL_EMAIL_DOMAIN": default_domain,
        "EMAIL_DOMAINS": ",".join(configured_domains),
        "TOKEN_JSON_DIR": get_register_token_dir(),
        "AK_FILE": os.path.join(PROJECT_ROOT, "ak.txt"),
        "RK_FILE": os.path.join(PROJECT_ROOT, "rk.txt"),
        "STABLE_PROXY_FILE": os.path.join(PROJECT_ROOT, "stable_proxy.txt"),
    }

    for key, value in env_updates.items():
        if value:
            os.environ[key] = value
        else:
            os.environ.pop(key, None)


def load_internal_register_module(config: Dict[str, Any]):
    configure_internal_register_environment(config)
    if PROJECT_ROOT not in sys.path:
        sys.path.insert(0, PROJECT_ROOT)
    if not os.path.isdir(INTERNAL_REGISTER_ROOT):
        raise ImportError(
            f"Internal register module directory not found: {INTERNAL_REGISTER_ROOT}"
        )

    for module_name in (
        "internal_register.email_utils",
        "internal_register.proxy_utils",
        "internal_register.utf8_utils",
        INTERNAL_REGISTER_PACKAGE,
    ):
        sys.modules.pop(module_name, None)

    return importlib.import_module(INTERNAL_REGISTER_PACKAGE)


def list_register_token_files(register_token_dir: str) -> List[str]:
    if not os.path.isdir(register_token_dir):
        return []
    return sorted(
        [name for name in os.listdir(register_token_dir) if name.endswith(".json")]
    )


def fetch_cpa_auth_file_names(cpa_url: str, management_key: str) -> Set[str]:
    if not normalize_cpa_url(cpa_url):
        raise ValueError("cpa_url is required")
    if not str(management_key or "").strip():
        raise ValueError("management_key is required")

    session = create_cpa_session(management_key)
    try:
        response = session.get(
            build_cpa_url(cpa_url, "/v0/management/auth-files"), timeout=30
        )
        response.raise_for_status()
        data = response.json()
        files = data.get("files", []) if isinstance(data, dict) else []
        return {
            str(item.get("name")).strip()
            for item in files
            if isinstance(item, dict) and str(item.get("name") or "").strip()
        }
    finally:
        session.close()


def fetch_cpa_auth_files(cpa_url: str, management_key: str) -> List[Dict[str, Any]]:
    if not normalize_cpa_url(cpa_url):
        raise ValueError("cpa_url is required")
    if not str(management_key or "").strip():
        raise ValueError("management_key is required")

    session = create_cpa_session(management_key)
    try:
        response = session.get(
            build_cpa_url(cpa_url, "/v0/management/auth-files"), timeout=30
        )
        response.raise_for_status()
        data = response.json()
        files = data.get("files", []) if isinstance(data, dict) else []
        return [item for item in files if isinstance(item, dict)]
    finally:
        session.close()


def remove_file_if_exists(file_path: str) -> bool:
    if not os.path.exists(file_path):
        return False
    os.remove(file_path)
    return True


def cleanup_uploaded_token_artifacts(token_path: str) -> List[str]:
    cleaned_paths: List[str] = []
    candidates = [
        token_path,
        os.path.join(get_local_backup_dir(), os.path.basename(token_path)),
    ]

    for candidate in candidates:
        try:
            if remove_file_if_exists(candidate):
                cleaned_paths.append(candidate)
        except OSError as exc:
            logger.warning(
                "Failed to clean uploaded token artifact: %s error=%s", candidate, exc
            )

    return cleaned_paths


def read_token_file(token_path: str) -> Tuple[str, str]:
    with open(token_path, "r", encoding="utf-8") as f:
        content = f.read()
    return os.path.basename(token_path), content


def read_token_json(token_path: str) -> Dict[str, Any]:
    with open(token_path, "r", encoding="utf-8") as f:
        data = json.load(f) or {}
    return data if isinstance(data, dict) else {}


def create_direct_session() -> requests.Session:
    session = requests.Session()
    session.trust_env = False
    session.headers.update(
        {
            "Accept": "application/json",
            "Content-Type": "application/json",
            "User-Agent": CODEX_USER_AGENT,
        }
    )
    return session


def response_text_preview(response: requests.Response) -> str:
    try:
        text = response.text or ""
    except Exception:
        text = ""
    return text[:500]


def parse_json_like_response(response: requests.Response) -> Any:
    try:
        return response.json()
    except Exception:
        return response_text_preview(response)


def normalize_probe_text(value: Any) -> str:
    if isinstance(value, str):
        return value
    try:
        return json.dumps(value, ensure_ascii=False)
    except Exception:
        return str(value)


def is_invalidated_text(lower: str) -> bool:
    return (
        "token_invalidated" in lower
        or "token invalidated" in lower
        or "authentication token has been invalidated" in lower
        or "invalidated oauth token" in lower
        or "token_revoked" in lower
        or "invalidated" in lower
    )


def extract_codex_used_percent(body: Any) -> Optional[float]:
    if not isinstance(body, dict):
        return None
    rate_limit = body.get("rate_limit")
    if not isinstance(rate_limit, dict):
        return None
    if rate_limit.get("limit_reached") is True or rate_limit.get("allowed") is False:
        return 100.0
    max_used: Optional[float] = None
    for key in ("primary_window", "secondary_window"):
        window = rate_limit.get(key)
        if not isinstance(window, dict):
            continue
        used = window.get("used_percent")
        if isinstance(used, (int, float)):
            max_used = float(used) if max_used is None else max(max_used, float(used))
    return max_used


def probe_local_codex_token(token_path: str) -> Dict[str, Any]:
    token_data = read_token_json(token_path)
    access_token = str(token_data.get("access_token") or "").strip()
    if not access_token:
        return {
            "status": "unknown",
            "reason": "missing access_token",
            "status_code": 0,
            "body": None,
        }

    session = create_direct_session()
    try:
        response = session.get(
            CODEX_USAGE_URL,
            headers={"Authorization": f"Bearer {access_token}"},
            timeout=20,
        )
        body = parse_json_like_response(response)
        text = normalize_probe_text(body).lower()
        status_code = int(response.status_code)

        if status_code == 401 and is_invalidated_text(text):
            return {
                "status": "invalidated",
                "reason": text,
                "status_code": status_code,
                "body": body,
            }
        if status_code == 401 and "deactivated" in text:
            return {
                "status": "deactivated",
                "reason": text,
                "status_code": status_code,
                "body": body,
            }
        if status_code == 401:
            return {
                "status": "unauthorized",
                "reason": text,
                "status_code": status_code,
                "body": body,
            }
        if status_code == 429:
            return {
                "status": "rate_limited",
                "reason": text,
                "status_code": status_code,
                "body": body,
            }
        if status_code in (200, 201):
            used_percent = extract_codex_used_percent(body)
            if used_percent is not None and used_percent >= 100:
                return {
                    "status": "quota_exhausted",
                    "reason": text,
                    "status_code": status_code,
                    "body": body,
                }
            return {
                "status": "active",
                "reason": "",
                "status_code": status_code,
                "body": body,
            }
        return {
            "status": "unknown",
            "reason": text or f"unexpected response ({status_code})",
            "status_code": status_code,
            "body": body,
        }
    except requests.RequestException as exc:
        return {
            "status": "unknown",
            "reason": str(exc),
            "status_code": 0,
            "body": None,
        }
    finally:
        session.close()


def should_skip_upload_for_probe_status(status: str) -> bool:
    return status in {"invalidated", "deactivated", "unauthorized"}


def should_count_probe_status_as_healthy(status: str) -> bool:
    return status == "active"


def log_upload_failure(mode: str, response: requests.Response) -> None:
    body_preview = response.text[:500] if response.text else ""
    logger.warning(
        "CPA upload attempt failed: mode=%s status=%s body=%s",
        mode,
        response.status_code,
        body_preview,
    )


def try_upload_request(
    session: requests.Session,
    cpa_url: str,
    mode: str,
    *,
    json_payload: Optional[Dict[str, Any]] = None,
    multipart_field: Optional[str] = None,
    filename: Optional[str] = None,
    file_content: Optional[str] = None,
) -> bool:
    endpoint = build_cpa_url(cpa_url, "/v0/management/auth-files")
    timeout = 30

    if multipart_field and filename is not None and file_content is not None:
        response = session.post(
            endpoint,
            files={
                multipart_field: (filename, file_content, "application/json"),
            },
            timeout=timeout,
        )
    else:
        response = session.post(
            endpoint,
            json=json_payload,
            timeout=timeout,
        )

    if response.ok:
        logger.info(
            "CPA upload succeeded via mode=%s file=%s",
            mode,
            filename or json_payload.get("name", ""),
        )
        return True

    log_upload_failure(mode, response)
    return False


def upload_to_cpa(cpa_url: str, management_key: str, token_path: str) -> bool:
    if not normalize_cpa_url(cpa_url):
        logger.error("Cannot upload token: cpa_url is empty")
        return False
    if not str(management_key or "").strip():
        logger.error("Cannot upload token: management_key is empty")
        return False
    if not os.path.exists(token_path):
        logger.error("Cannot upload token: file does not exist: %s", token_path)
        return False

    filename, file_content = read_token_file(token_path)
    session = create_cpa_session(management_key)

    multipart_candidates = ["file", "files", "auth_file"]
    payload_candidates: List[Tuple[str, Dict[str, Any]]] = [
        ("json:name+content", {"name": filename, "content": file_content}),
        ("json:filename+content", {"filename": filename, "content": file_content}),
        (
            "json:name+account_content",
            {"name": filename, "account_content": file_content},
        ),
        (
            "json:filename+account_content",
            {"filename": filename, "account_content": file_content},
        ),
        ("json:file_object", {"file": {"name": filename, "content": file_content}}),
        ("json:files_array", {"files": [{"name": filename, "content": file_content}]}),
    ]

    try:
        for attempt in range(1, PRIMARY_UPLOAD_RETRIES + 1):
            mode = "multipart:file"
            try:
                if try_upload_request(
                    session,
                    cpa_url,
                    f"{mode}:attempt-{attempt}",
                    multipart_field="file",
                    filename=filename,
                    file_content=file_content,
                ):
                    return True
            except requests.RequestException as exc:
                logger.warning(
                    "CPA upload request exception: mode=%s attempt=%s/%s error=%s",
                    mode,
                    attempt,
                    PRIMARY_UPLOAD_RETRIES,
                    exc,
                )
                if attempt < PRIMARY_UPLOAD_RETRIES:
                    time.sleep(1)

        for field_name in multipart_candidates[1:]:
            mode = f"multipart:{field_name}"
            try:
                if try_upload_request(
                    session,
                    cpa_url,
                    mode,
                    multipart_field=field_name,
                    filename=filename,
                    file_content=file_content,
                ):
                    return True
            except requests.RequestException as exc:
                logger.warning(
                    "CPA upload request exception: mode=%s error=%s", mode, exc
                )

        for mode, payload in payload_candidates:
            try:
                if try_upload_request(
                    session, cpa_url, mode, json_payload=payload, filename=filename
                ):
                    return True
            except requests.RequestException as exc:
                logger.warning(
                    "CPA upload request exception: mode=%s error=%s", mode, exc
                )
    finally:
        session.close()

    logger.error(
        "Failed to upload token to CPA after trying all known request shapes: %s",
        filename,
    )
    return False


def process_token_for_cpa(
    cpa_url: str,
    management_key: str,
    token_path: str,
    *,
    validate_before_upload: bool = False,
    cleanup_on_success: bool = True,
) -> Dict[str, Any]:
    probe_status = "unknown"
    probe_reason = ""
    probe_status_code = 0

    if validate_before_upload:
        probe_result = probe_local_codex_token(token_path)
        probe_status = str(probe_result.get("status") or "unknown")
        probe_reason = str(probe_result.get("reason") or "")
        probe_status_code = int(probe_result.get("status_code") or 0)

        if should_skip_upload_for_probe_status(probe_status):
            logger.warning(
                "Skipping upload for local token due to probe status=%s status_code=%s file=%s reason=%s",
                probe_status,
                probe_status_code,
                os.path.basename(token_path),
                probe_reason[:300],
            )
            return {
                "uploaded": False,
                "healthy": False,
                "probe_status": probe_status,
                "probe_reason": probe_reason,
                "probe_status_code": probe_status_code,
                "failure_reason": f"skipped due to probe status {probe_status}",
                "cleaned_paths": [],
            }

    if not upload_to_cpa(cpa_url, management_key, token_path):
        return {
            "uploaded": False,
            "healthy": False,
            "probe_status": probe_status,
            "probe_reason": probe_reason,
            "probe_status_code": probe_status_code,
            "failure_reason": "upload failed",
            "cleaned_paths": [],
        }

    cleaned_paths = (
        cleanup_uploaded_token_artifacts(token_path) if cleanup_on_success else []
    )
    if cleaned_paths:
        logger.info(
            "Cleaned uploaded token artifacts for %s: %s",
            os.path.basename(token_path),
            cleaned_paths,
        )

    return {
        "uploaded": True,
        "healthy": should_count_probe_status_as_healthy(probe_status)
        if validate_before_upload
        else True,
        "probe_status": probe_status,
        "probe_reason": probe_reason,
        "probe_status_code": probe_status_code,
        "failure_reason": "",
        "cleaned_paths": cleaned_paths,
    }


def start_replenishment_status(
    mode: str,
    config: Dict[str, Any],
    *,
    limit: Optional[int] = None,
    needed: Optional[int] = None,
    healthy_count: Optional[int] = None,
) -> None:
    now_ms = _now_ms()
    target_count = config.get(
        "codex_replenish_target_count", config.get("codex_target_count")
    )
    threshold = config.get("codex_replenish_threshold")
    batch_size = config.get("codex_replenish_batch_size")
    worker_count = config.get("codex_replenish_worker_count")
    log_file = os.path.join(ensure_runtime_dir(), f"replenishment_{mode}_{now_ms}.log")
    update_replenishment_status(
        mode=mode,
        in_progress=True,
        last_started_at=now_ms,
        last_error="",
        last_limit=limit,
        target_count=int(target_count) if target_count is not None else None,
        threshold=int(threshold) if threshold is not None else None,
        batch_size=int(batch_size) if batch_size is not None else None,
        worker_count=int(worker_count) if worker_count is not None else None,
        use_proxy=bool(config.get("codex_replenish_use_proxy", False)),
        healthy_count=max(0, int(healthy_count)) if healthy_count is not None else None,
        needed=needed,
        new_token_files=None,
        last_scan_register_total=None,
        last_scan_cpa_total=None,
        last_scan_missing_count=None,
        last_uploaded=0,
        last_failed=0,
        failed_names=[],
        last_summary=build_replenishment_summary(
            "backfill_started" if mode == "backfill_missing" else "started"
        ),
        proxy_pool_size=0,
        log_file=log_file,
        recent_events=[],
        log_tail=[],
        current_batch=None,
        batch_history=[],
        last_selected_domain="",
        email_selection_mode="",
    )
    append_replenishment_event(f"Started {mode} job.")


def finish_replenishment_status(
    *,
    error: str = "",
    uploaded: int = 0,
    failed: int = 0,
    failed_names: Optional[List[str]] = None,
    summary: str = "",
    register_total: Optional[int] = None,
    cpa_total: Optional[int] = None,
    missing_count: Optional[int] = None,
    new_token_files: Optional[int] = None,
    healthy_count: Optional[int] = None,
) -> None:
    update_replenishment_status(
        in_progress=False,
        last_finished_at=_now_ms(),
        last_error=str(error or ""),
        last_uploaded=uploaded,
        last_failed=failed,
        failed_names=list(failed_names or []),
        last_summary=str(summary or ""),
        last_scan_register_total=register_total,
        last_scan_cpa_total=cpa_total,
        last_scan_missing_count=missing_count,
        new_token_files=new_token_files,
        healthy_count=max(0, int(healthy_count)) if healthy_count is not None else None,
    )


def update_running_replenishment_status(
    *,
    healthy_count: Optional[int] = None,
    needed: Optional[int] = None,
    uploaded: Optional[int] = None,
    failed: Optional[int] = None,
    failed_names: Optional[List[str]] = None,
    summary: Optional[str] = None,
    register_total: Optional[int] = None,
    cpa_total: Optional[int] = None,
    missing_count: Optional[int] = None,
    new_token_files: Optional[int] = None,
    proxy_pool_size: Optional[int] = None,
) -> None:
    partial: Dict[str, Any] = {
        "in_progress": True,
    }
    if healthy_count is not None:
        partial["healthy_count"] = max(0, int(healthy_count))
    if needed is not None:
        partial["needed"] = max(0, int(needed))
    if uploaded is not None:
        partial["last_uploaded"] = int(uploaded)
    if failed is not None:
        partial["last_failed"] = int(failed)
    if failed_names is not None:
        partial["failed_names"] = list(failed_names)
    if summary is not None:
        partial["last_summary"] = str(summary)
    if register_total is not None:
        partial["last_scan_register_total"] = int(register_total)
    if cpa_total is not None:
        partial["last_scan_cpa_total"] = int(cpa_total)
    if missing_count is not None:
        partial["last_scan_missing_count"] = int(missing_count)
    if new_token_files is not None:
        partial["new_token_files"] = int(new_token_files)
    if proxy_pool_size is not None:
        partial["proxy_pool_size"] = int(proxy_pool_size)
    update_replenishment_status(**partial)


def write_replenishment_idle_status(
    config: Dict[str, Any],
    *,
    healthy_count: Optional[int] = None,
    needed: int,
    summary: str,
    error: str = "",
) -> None:
    target_count = config.get(
        "codex_replenish_target_count", config.get("codex_target_count")
    )
    threshold = config.get("codex_replenish_threshold")
    batch_size = config.get("codex_replenish_batch_size")
    worker_count = config.get("codex_replenish_worker_count")
    update_replenishment_status(
        mode="replenish",
        in_progress=False,
        last_finished_at=_now_ms(),
        last_error=str(error or ""),
        target_count=int(target_count) if target_count is not None else None,
        threshold=int(threshold) if threshold is not None else None,
        batch_size=int(batch_size) if batch_size is not None else None,
        worker_count=int(worker_count) if worker_count is not None else None,
        use_proxy=bool(config.get("codex_replenish_use_proxy", False)),
        healthy_count=max(0, int(healthy_count)) if healthy_count is not None else None,
        needed=max(0, int(needed)),
        new_token_files=0,
        last_summary=str(summary or ""),
        proxy_pool_size=0,
        current_batch=None,
    )


def count_normal_accounts(
    cpa_url: str, management_key: str, runtime_state: Dict[str, Any]
) -> int:
    """
    Counts enabled and usable codex accounts for the current CPA target.
    """
    normalized_cpa_url = normalize_cpa_url(cpa_url)
    runtime_bucket = {}
    if normalized_cpa_url:
        runtime_bucket = (
            (runtime_state.get("by_cpa_url", {}) or {}).get(normalized_cpa_url) or {}
        ).get("credentials", {}) or {}

    try:
        auth_files = fetch_cpa_auth_files(cpa_url, management_key)
    except Exception as exc:
        logger.warning(
            "Falling back to runtime-only healthy count due to CPA auth-files fetch failure: %s",
            exc,
        )
        auth_files = []

    if auth_files:
        count = 0
        for item in auth_files:
            provider = str(item.get("provider") or "").strip().lower()
            disabled = bool(item.get("disabled"))
            if provider != "codex" or disabled:
                continue

            name = str(item.get("name") or "").strip()
            runtime_entry = (
                runtime_bucket.get(name) if isinstance(runtime_bucket, dict) else {}
            )
            runtime_status = (
                str((runtime_entry or {}).get("last_status") or "").strip().lower()
            )
            cpa_status = str(item.get("status") or "").strip().lower()
            resolved_status = runtime_status or cpa_status
            disabled_by_runtime = bool(
                (runtime_entry or {}).get("disabled_by_runtime", False)
            )
            archived_by_runtime = bool(
                (runtime_entry or {}).get("archived_by_runtime", False)
            )
            if (
                resolved_status == "active"
                and not disabled_by_runtime
                and not archived_by_runtime
            ):
                count += 1
        return count

    count = 0
    for name, state in (runtime_bucket or {}).items():
        provider = str(state.get("provider") or "").strip().lower()
        quota_cards = (
            state.get("last_quota_cards")
            if isinstance(state.get("last_quota_cards"), list)
            else []
        )
        looks_like_codex = (
            provider == "codex"
            or name.startswith("codex-")
            or len(quota_cards) > 0
            or state.get("last_quota_source") not in (None, "", "unknown")
        )
        if not looks_like_codex:
            continue

        status = str(state.get("last_status") or "").strip().lower()
        disabled_by_runtime = bool(state.get("disabled_by_runtime", False))
        archived_by_runtime = bool(state.get("archived_by_runtime", False))
        if status == "active" and not disabled_by_runtime and not archived_by_runtime:
            count += 1
    return count


def sync_register_mail_config(config: Dict[str, Any]) -> None:
    configure_internal_register_environment(config)


def disable_process_proxy_env() -> None:
    for key in (
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "http_proxy",
        "https_proxy",
        "all_proxy",
        "NO_PROXY",
        "no_proxy",
    ):
        os.environ.pop(key, None)


def normalize_proxy_value(proxy: str) -> str:
    value = str(proxy or "").strip()
    if not value:
        return ""
    parts = value.split(None, 1)
    if len(parts) == 2 and parts[0].rstrip(":").isdigit():
        value = parts[1].strip()
    if "://" not in value:
        value = f"http://{value}"
    return value


def parse_proxy_pool_text(proxy_pool_text: Any) -> List[str]:
    if isinstance(proxy_pool_text, list):
        raw_items = [str(item) for item in proxy_pool_text]
    else:
        raw_items = str(proxy_pool_text or "").replace("\r", "\n").split("\n")

    proxies: List[str] = []
    seen: Set[str] = set()
    for raw in raw_items:
        normalized = normalize_proxy_value(raw)
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        proxies.append(normalized)
    return proxies


class DirectOnlyProxyPool:
    def refresh(self, force: bool = False) -> None:
        return

    def info(self) -> Dict[str, Any]:
        return {
            "mode": "direct",
            "list_url": "",
            "count": 0,
            "fetched_count": 0,
            "validated_count": 0,
            "validate_enabled": False,
            "validate_test_url": "",
            "validate_timeout_seconds": 0,
            "validate_workers": 0,
            "bad_count": 0,
            "fallback_proxy": "",
            "stable_proxy": "",
            "prefer_stable_proxy": False,
            "max_retries_per_request": 1,
            "bad_ttl_seconds": 0,
            "last_error": "",
        }

    def next_proxy(self):
        return None

    def report_bad(
        self, proxy: Optional[str], error: Optional[Exception] = None
    ) -> None:
        return

    def report_success(self, proxy: Optional[str]) -> None:
        return


class ExternalProxyPool:
    def __init__(self, proxies: List[str], *, bad_ttl_seconds: int = 180):
        self.proxies = list(proxies)
        self.bad_ttl_seconds = max(10, int(bad_ttl_seconds))
        self.index = 0
        self.bad_until: Dict[str, float] = {}
        self.stable_proxy: Optional[str] = None

    def refresh(self, force: bool = False) -> None:
        return

    def info(self) -> Dict[str, Any]:
        now = time.time()
        bad_count = sum(1 for until in self.bad_until.values() if until > now)
        return {
            "mode": "external",
            "list_url": "",
            "count": len(self.proxies),
            "fetched_count": len(self.proxies),
            "validated_count": len(self.proxies),
            "validate_enabled": False,
            "validate_test_url": "",
            "validate_timeout_seconds": 0,
            "validate_workers": 0,
            "bad_count": bad_count,
            "fallback_proxy": "",
            "stable_proxy": self.stable_proxy or "",
            "prefer_stable_proxy": bool(self.stable_proxy),
            "max_retries_per_request": max(1, len(self.proxies)),
            "bad_ttl_seconds": self.bad_ttl_seconds,
            "last_error": "",
        }

    def next_proxy(self):
        if not self.proxies:
            return None
        now = time.time()
        if self.stable_proxy:
            until = self.bad_until.get(self.stable_proxy, 0)
            if until <= now:
                return self.stable_proxy
            self.stable_proxy = None

        total = len(self.proxies)
        for _ in range(total):
            proxy = self.proxies[self.index]
            self.index = (self.index + 1) % total
            until = self.bad_until.get(proxy, 0)
            if until <= now:
                return proxy
        return None

    def report_bad(
        self, proxy: Optional[str], error: Optional[Exception] = None
    ) -> None:
        normalized = normalize_proxy_value(proxy or "")
        if not normalized:
            return
        self.bad_until[normalized] = time.time() + self.bad_ttl_seconds
        if self.stable_proxy == normalized:
            self.stable_proxy = None

    def report_success(self, proxy: Optional[str]) -> None:
        normalized = normalize_proxy_value(proxy or "")
        if not normalized:
            return
        self.stable_proxy = normalized
        self.bad_until.pop(normalized, None)


def configure_register_proxy_mode(
    register_module: Any, use_proxy: bool, proxy_pool_text: Any
) -> Dict[str, Any]:
    disable_process_proxy_env()
    register_module.DEFAULT_PROXY = ""
    register_module.STABLE_PROXY = None
    register_module.PREFER_STABLE_PROXY = False
    register_module._stable_proxy_loaded = True
    register_module._save_stable_proxy_to_file = lambda proxy: None
    register_module._save_stable_proxy_to_config = lambda proxy: None

    external_proxies = parse_proxy_pool_text(proxy_pool_text) if use_proxy else []
    if use_proxy and external_proxies:
        pool = ExternalProxyPool(external_proxies)
        logger.info(
            "Registration proxy mode forced to external pool; proxy_count=%s",
            len(external_proxies),
        )
        append_replenishment_event(
            f"Using external proxy pool with {len(external_proxies)} proxies."
        )
    else:
        pool = DirectOnlyProxyPool()
        if use_proxy:
            logger.warning(
                "Proxy enabled but external proxy pool is empty. Falling back to direct mode."
            )
            append_replenishment_event(
                "Proxy enabled but external proxy pool is empty; falling back to direct mode."
            )
        else:
            logger.info(
                "Registration proxy mode forced to direct-only; register default proxy pool disabled."
            )
            append_replenishment_event(
                "Using direct mode; external proxy pool disabled."
            )

    register_module.load_proxy_candidates = lambda base_dir=None: []
    register_module._proxy_pool = pool
    register_module._get_proxy_pool = lambda fallback_proxy=None: pool
    return {
        "enabled": bool(use_proxy and external_proxies),
        "proxy_count": len(external_proxies),
    }


def resolve_replenishment_email_domain(config: Dict[str, Any]) -> Tuple[str, str]:
    email_domains = load_provider_domain_list(config)
    default_domain = str(config.get("mail_email_domain", "") or "").strip().lower()
    randomize_from_list = bool(config.get("mail_randomize_from_list", True))
    if default_domain and default_domain not in email_domains:
        email_domains.insert(0, default_domain)

    if email_domains:
        if randomize_from_list and len(email_domains) > 1:
            logger.info(
                "Using per-account random email domain selection from %s", email_domains
            )
            return "__mixed__", "per_account_random_from_list"
        if default_domain:
            logger.info(f"Using default email domain: {default_domain}")
            return default_domain, "default"
        selected_domain = email_domains[0]
        logger.info(f"Using first configured email domain: {selected_domain}")
        return selected_domain, "first_available"

    selected_domain = default_domain
    logger.info(f"Using default email domain: {selected_domain}")
    return selected_domain, "default"


def configure_register_email_domain_strategy(
    register_module, config: Dict[str, Any]
) -> Dict[str, Any]:
    email_provider = (
        str(config.get("mail_email_provider", "mailfree") or "mailfree").strip().lower()
        or "mailfree"
    )
    email_domains = load_provider_domain_list(config)
    default_domain = str(config.get("mail_email_domain", "") or "").strip().lower()
    randomize_from_list = bool(config.get("mail_randomize_from_list", True))
    if default_domain and default_domain not in email_domains:
        email_domains.insert(0, default_domain)

    if not email_domains:
        email_domains = [default_domain] if default_domain else []

    original_register_one = getattr(register_module, "_register_one", None)
    if not callable(original_register_one):
        raise AttributeError("internal register module does not expose _register_one")

    def resolve_account_domain(explicit_domain: Optional[str]) -> Optional[str]:
        normalized_explicit = str(explicit_domain or "").strip().lower()
        if normalized_explicit and normalized_explicit != "__mixed__":
            return normalized_explicit
        if email_domains:
            if randomize_from_list and len(email_domains) > 1:
                return random.choice(email_domains)
            if default_domain:
                return default_domain
            return email_domains[0]
        return normalized_explicit or default_domain or None

    def wrapped_register_one(
        idx,
        total,
        proxy,
        output_file,
        email_provider=email_provider,
        email_domain=None,
        extract_codex=True,
        progress_hook=None,
        use_proxy=True,
        debug=False,
    ):
        account_domain = resolve_account_domain(email_domain)
        return original_register_one(
            idx,
            total,
            proxy,
            output_file,
            email_provider=email_provider,
            email_domain=account_domain,
            extract_codex=extract_codex,
            progress_hook=progress_hook,
            use_proxy=use_proxy,
            debug=debug,
        )

    register_module._register_one = wrapped_register_one
    return {
        "email_provider": email_provider,
        "domains": list(email_domains),
        "default_domain": default_domain,
        "randomize_from_list": randomize_from_list,
        "runtime_email_domain": "__mixed__"
        if randomize_from_list and len(email_domains) > 1
        else (default_domain or (email_domains[0] if email_domains else "")),
        "selection_mode": "per_account_random_from_list"
        if randomize_from_list and len(email_domains) > 1
        else ("default" if default_domain else "first_available"),
        "batch_domain_label": "multiple"
        if randomize_from_list and len(email_domains) > 1
        else (default_domain or (email_domains[0] if email_domains else "")),
    }


def build_register_progress_hook(batch_attempt: int, config: Dict[str, Any]):
    def _progress_hook(event_type: str, **payload: Any) -> None:
        if event_type == "batch_started":
            workers = int(payload.get("workers") or 0)
            update_current_batch_status(
                workers=workers,
                status="registering",
                event_message=f"Register workers ready: {workers}.",
            )
            return

        if event_type == "account_started":
            proxy = str(payload.get("proxy") or "")
            idx = int(payload.get("idx") or 0)
            total = int(payload.get("total") or 0)

            def _mutate(current: Dict[str, Any]) -> None:
                batch = (
                    normalize_batch_status(current.get("current_batch"))
                    or create_empty_batch_status()
                )
                batch["current_proxy"] = proxy
                upsert_batch_account(
                    batch,
                    idx=idx,
                    proxy=proxy,
                    total=total,
                    status="registering",
                    error="",
                )
                append_batch_event(
                    batch, f"Account {idx}/{total} started via {proxy or 'direct'}."
                )
                current["current_batch"] = batch

            mutate_replenishment_status(_mutate)
            return

        if event_type == "account_succeeded":
            oauth_ok = bool(payload.get("oauth_ok"))
            email = str(payload.get("email") or "")
            proxy = str(payload.get("proxy") or "")
            idx = int(payload.get("idx") or 0)
            total = int(payload.get("total") or 0)

            def _mutate(current: Dict[str, Any]) -> None:
                batch = (
                    normalize_batch_status(current.get("current_batch"))
                    or create_empty_batch_status()
                )
                batch["register_succeeded"] = (
                    int(batch.get("register_succeeded") or 0) + 1
                )
                batch["codex_succeeded"] = int(batch.get("codex_succeeded") or 0) + (
                    1 if oauth_ok else 0
                )
                batch["codex_failed"] = int(batch.get("codex_failed") or 0) + (
                    0 if oauth_ok else 1
                )
                batch["current_email"] = email
                batch["current_proxy"] = proxy
                upsert_batch_account(
                    batch,
                    idx=idx,
                    total=total,
                    email=email,
                    proxy=proxy,
                    status="registered" if oauth_ok else "codex_failed",
                    register_ok=True,
                    codex_ok=oauth_ok,
                    error="" if oauth_ok else "Codex extraction failed",
                )
                append_batch_event(
                    batch,
                    f"Account {idx}/{total} registered: {email or 'unknown'} | Codex {'ok' if oauth_ok else 'fail'}.",
                )
                current["current_batch"] = batch

            mutate_replenishment_status(_mutate)
            record_domain_stat_result(
                config,
                email=email,
                register_ok=True,
                codex_ok=oauth_ok,
            )
            return

        if event_type == "account_attempt_failed":
            idx = int(payload.get("idx") or 0)
            total = int(payload.get("total") or 0)
            attempt = int(payload.get("attempt") or 0)
            email = str(payload.get("email") or "")
            proxy = str(payload.get("proxy") or "")
            error = str(payload.get("error") or "unknown error")
            if bool(payload.get("final")):

                def _mutate(current: Dict[str, Any]) -> None:
                    batch = (
                        normalize_batch_status(current.get("current_batch"))
                        or create_empty_batch_status()
                    )
                    upsert_batch_account(
                        batch,
                        idx=idx,
                        total=total,
                        email=email,
                        proxy=proxy,
                        status="register_failed",
                        error=error,
                    )
                    batch["current_email"] = email or batch.get("current_email") or ""
                    append_batch_event(
                        batch,
                        f"Account {idx}/{total} final retry failed for {email or 'pending-email'} via {proxy or 'direct'}: {error}",
                    )
                    current["current_batch"] = batch

                mutate_replenishment_status(_mutate)
                record_domain_stat_result(
                    config,
                    email=email,
                    register_ok=False,
                    codex_ok=False,
                )
                return

            def _mutate_retry(current: Dict[str, Any]) -> None:
                batch = (
                    normalize_batch_status(current.get("current_batch"))
                    or create_empty_batch_status()
                )
                upsert_batch_account(
                    batch,
                    idx=idx,
                    total=total,
                    email=email,
                    proxy=proxy,
                    status="retrying",
                    error=f"Attempt {attempt} failed: {error}",
                )
                batch["current_email"] = email or batch.get("current_email") or ""
                batch["current_proxy"] = proxy or batch.get("current_proxy") or ""
                append_batch_event(
                    batch,
                    f"Account {idx}/{total} attempt {attempt} failed for {email or 'pending-email'} via {proxy or 'direct'}: {error}",
                )
                current["current_batch"] = batch

            mutate_replenishment_status(_mutate_retry)
            return

        if event_type == "account_failed":
            idx = int(payload.get("idx") or 0)
            total = int(payload.get("total") or 0)
            email = str(payload.get("email") or "")
            error = str(payload.get("error") or "unknown error")

            def _mutate(current: Dict[str, Any]) -> None:
                batch = (
                    normalize_batch_status(current.get("current_batch"))
                    or create_empty_batch_status()
                )
                batch["register_failed"] = int(batch.get("register_failed") or 0) + 1
                batch["last_error"] = error
                batch["current_email"] = email or batch.get("current_email") or ""
                upsert_batch_account(
                    batch,
                    idx=idx,
                    total=total,
                    email=email,
                    status="register_failed",
                    error=error,
                )
                append_batch_event(
                    batch,
                    f"Account {idx}/{total} registration failed for {email or 'pending-email'}: {error}",
                )
                current["current_batch"] = batch

            mutate_replenishment_status(_mutate)
            record_domain_stat_result(
                config,
                email=email,
                register_ok=False,
                codex_ok=False,
            )
            return

        if event_type == "batch_finished":
            elapsed_seconds = float(payload.get("elapsed_seconds") or 0.0)
            update_current_batch_status(
                status="uploading",
                event_message=(
                    f"Batch {batch_attempt} register stage finished. "
                    f"success={payload.get('success_count') or 0}, failed={payload.get('fail_count') or 0}, "
                    f"elapsed={elapsed_seconds:.1f}s."
                ),
            )

    return _progress_hook


def run_register_batch(
    batch_size: int,
    config: Dict[str, Any],
    *,
    batch_attempt: int,
    on_token_ready: Optional[Callable[[str], None]] = None,
) -> Tuple[List[str], str, str]:
    sync_register_mail_config(config)

    output_file = os.path.join(
        ensure_runtime_dir(), f"batch_register_{int(time.time())}.txt"
    )
    os.makedirs(os.path.dirname(output_file), exist_ok=True)

    register_token_dir = get_register_token_dir()
    if not os.path.exists(register_token_dir):
        os.makedirs(register_token_dir, exist_ok=True)

    existing_snapshot = snapshot_register_token_files(register_token_dir)
    use_proxy = config.get("codex_replenish_use_proxy", True)
    proxy_pool_text = config.get("codex_replenish_proxy_pool", "")
    configured_worker_count = max(
        1, int(config.get("codex_replenish_worker_count", batch_size) or batch_size)
    )
    actual_workers = min(batch_size, configured_worker_count)
    runtime_email_domain, email_selection_mode = resolve_replenishment_email_domain(
        config
    )
    selected_domain = runtime_email_domain
    emitted_files: Set[str] = set()
    watcher_stop = threading.Event()
    watcher_error: List[str] = []

    def _emit_ready_file(file_name: str) -> None:
        if file_name in emitted_files:
            return
        emitted_files.add(file_name)
        if on_token_ready:
            on_token_ready(file_name)

    def _watch_register_tokens() -> None:
        if not on_token_ready:
            return
        while not watcher_stop.wait(REGISTER_TOKEN_WATCH_POLL_SECONDS):
            try:
                current_snapshot = snapshot_register_token_files(register_token_dir)
                ready_files = detect_ready_changed_register_tokens(
                    existing_snapshot,
                    current_snapshot,
                    emitted=emitted_files,
                )
                for file_name in ready_files:
                    _emit_ready_file(file_name)
            except Exception as exc:
                message = f"register token watcher failed: {exc}"
                watcher_error.append(message)
                logger.warning(message)
                append_replenishment_event(message)
                return

    watcher_thread = (
        threading.Thread(
            target=_watch_register_tokens,
            name=f"replenish-watch-{batch_attempt}",
            daemon=True,
        )
        if on_token_ready
        else None
    )

    try:
        register = load_internal_register_module(config)
        proxy_runtime = configure_register_proxy_mode(
            register, bool(use_proxy), proxy_pool_text
        )
        email_runtime = configure_register_email_domain_strategy(register, config)
        selected_domain = str(
            email_runtime.get("batch_domain_label") or selected_domain or ""
        )
        runtime_email_domain = str(
            email_runtime.get("runtime_email_domain") or runtime_email_domain or ""
        )
        email_selection_mode = str(
            email_runtime.get("selection_mode") or email_selection_mode or ""
        )
        start_current_batch_status(
            attempt=batch_attempt,
            requested=batch_size,
            workers=actual_workers,
            selected_domain=selected_domain,
            email_selection_mode=email_selection_mode,
        )
        update_running_replenishment_status(
            proxy_pool_size=int(proxy_runtime.get("proxy_count") or 0),
            summary=build_replenishment_summary("running"),
        )
        log_file = str(read_replenishment_status().get("log_file") or output_file)
        os.makedirs(os.path.dirname(log_file), exist_ok=True)
        if watcher_thread:
            watcher_thread.start()
        with open(log_file, "a", encoding="utf-8") as log_handle:
            tee_stdout = TeeLineWriter(sys.stdout, log_handle)
            tee_stderr = TeeLineWriter(sys.stderr, log_handle)
            with (
                contextlib.redirect_stdout(tee_stdout),
                contextlib.redirect_stderr(tee_stderr),
            ):
                register.run_batch(
                    total_accounts=batch_size,
                    output_file=output_file,
                    max_workers=actual_workers,
                    proxy=None,
                    email_provider=str(
                        email_runtime.get("email_provider")
                        or config.get("mail_email_provider")
                        or "mailfree"
                    ),
                    email_domain=runtime_email_domain,
                    extract_codex=True,
                    progress_hook=build_register_progress_hook(batch_attempt, config),
                )
    except Exception as e:
        logger.error(f"Registration failed: {e}")
        append_replenishment_event(f"Registration batch failed: {e}")
        update_current_batch_status(
            status="failed",
            last_error=str(e),
            event_message=f"Register stage crashed: {e}",
        )
        finish_current_batch_status(status="failed", error=str(e))
        raise
    finally:
        watcher_stop.set()
        if watcher_thread:
            watcher_thread.join(timeout=5)

    updated_snapshot = snapshot_register_token_files(register_token_dir)
    if on_token_ready:
        for file_name in detect_ready_changed_register_tokens(
            existing_snapshot,
            updated_snapshot,
            emitted=emitted_files,
            allow_unstable=True,
        ):
            _emit_ready_file(file_name)
    changed_files = detect_changed_register_tokens(existing_snapshot, updated_snapshot)
    remaining_files = [
        file_name for file_name in changed_files if file_name not in emitted_files
    ]
    logger.info(
        "Registration batch finished. requested=%s changed_token_files=%s streamed_token_files=%s remaining_token_files=%s",
        batch_size,
        len(changed_files),
        len(emitted_files),
        len(remaining_files),
    )
    update_current_batch_status(
        status="uploading",
        event_message=f"Detected {len(changed_files)} token file(s); streamed {len(emitted_files)} during registration, {len(remaining_files)} waiting for final upload.",
    )
    return remaining_files, selected_domain, email_selection_mode


def replenish(needed: int, config: Dict[str, Any], state_path: str):
    """
    Triggers replenishment of needed codex accounts using the register module.
    Uses small batches so it can stop when the healthy target is reached.
    """
    if needed <= 0:
        return

    cpa_url = config.get("cpa_url", "")
    management_key = config.get("management_key", "")
    target_count = int(
        config.get("codex_replenish_target_count", config.get("codex_target_count", 0))
        or 0
    )
    configured_batch_size = max(
        1,
        int(
            config.get("codex_replenish_batch_size", DEFAULT_REGISTRATION_BATCH_SIZE)
            or DEFAULT_REGISTRATION_BATCH_SIZE
        ),
    )
    failed_names: List[str] = []
    success_uploads = 0
    total_new_files = 0
    registration_attempts = 0
    remaining_budget = max(needed * 3, needed + 10, configured_batch_size)
    upload_state_lock = threading.Lock()

    estimated_active = count_normal_accounts(
        cpa_url, management_key, load_runtime_state(state_path)
    )
    logger.info(f"Target reached: No, needed: {needed}. Starting replenishment...")
    start_replenishment_status(
        "replenish", config, needed=needed, healthy_count=estimated_active
    )
    target_limit = target_count if target_count > 0 else estimated_active + needed
    update_running_replenishment_status(
        healthy_count=estimated_active,
        needed=max(0, target_limit - estimated_active),
        uploaded=0,
        failed=0,
        failed_names=[],
        new_token_files=0,
        summary=build_replenishment_summary("started"),
    )

    while estimated_active < target_limit and remaining_budget > 0:
        latest_runtime_active = count_normal_accounts(
            cpa_url, management_key, load_runtime_state(state_path)
        )
        estimated_active = max(estimated_active, latest_runtime_active)
        if estimated_active >= target_limit:
            logger.info(
                "Stopping replenishment before next batch because runtime already reached target. active=%s target=%s",
                estimated_active,
                target_limit,
            )
            break

        batch_size = min(
            configured_batch_size, target_limit - estimated_active, remaining_budget
        )
        if batch_size <= 0:
            break

        registration_attempts += 1
        remaining_budget -= batch_size
        update_running_replenishment_status(
            healthy_count=estimated_active,
            needed=max(0, target_limit - estimated_active),
            uploaded=success_uploads,
            failed=len(failed_names),
            failed_names=failed_names,
            new_token_files=total_new_files,
            summary=build_replenishment_summary("running"),
        )
        batch_seen_files: Set[str] = set()

        def handle_batch_token(file_name: str) -> None:
            nonlocal success_uploads, estimated_active, total_new_files
            with upload_state_lock:
                if file_name in batch_seen_files:
                    return
                batch_seen_files.add(file_name)
                total_new_files += 1

            full_path = os.path.join(get_register_token_dir(), file_name)
            result = process_token_for_cpa(
                cpa_url,
                management_key,
                full_path,
                validate_before_upload=False,
                cleanup_on_success=True,
            )

            with upload_state_lock:
                if result["uploaded"]:
                    success_uploads += 1
                    if result["healthy"]:
                        estimated_active += 1

                    def _mutate_uploaded(current: Dict[str, Any]) -> None:
                        batch = (
                            normalize_batch_status(current.get("current_batch"))
                            or create_empty_batch_status()
                        )
                        batch["upload_succeeded"] = (
                            int(batch.get("upload_succeeded") or 0) + 1
                        )
                        upsert_batch_account(
                            batch,
                            email=file_name.removesuffix(".json"),
                            status="completed"
                            if not str(result.get("failure_reason") or "")
                            else "uploaded",
                            upload_ok=True,
                            error="",
                        )
                        append_batch_event(
                            batch, f"Uploaded {file_name} to CPA successfully."
                        )
                        current["current_batch"] = batch

                    mutate_replenishment_status(_mutate_uploaded)
                else:
                    failed_names.append(file_name)
                    failure_reason = str(
                        result.get("failure_reason") or "unknown error"
                    )

                    def _mutate_upload_failed(current: Dict[str, Any]) -> None:
                        batch = (
                            normalize_batch_status(current.get("current_batch"))
                            or create_empty_batch_status()
                        )
                        batch["upload_failed"] = (
                            int(batch.get("upload_failed") or 0) + 1
                        )
                        batch["last_error"] = failure_reason
                        upsert_batch_account(
                            batch,
                            email=file_name.removesuffix(".json"),
                            status="upload_failed",
                            upload_ok=False,
                            error=failure_reason,
                        )
                        append_batch_event(
                            batch, f"Upload failed for {file_name}: {failure_reason}"
                        )
                        current["current_batch"] = batch

                    mutate_replenishment_status(_mutate_upload_failed)

                update_running_replenishment_status(
                    healthy_count=estimated_active,
                    needed=max(0, target_limit - estimated_active),
                    uploaded=success_uploads,
                    failed=len(failed_names),
                    failed_names=failed_names,
                    new_token_files=total_new_files,
                    summary=build_replenishment_summary("running"),
                )

        new_files, _selected_domain, _email_selection_mode = run_register_batch(
            batch_size,
            config,
            batch_attempt=registration_attempts,
            on_token_ready=handle_batch_token,
        )

        for file_name in new_files:
            handle_batch_token(file_name)

        if not batch_seen_files:
            still_needed = max(0, target_limit - estimated_active)
            logger.warning(
                "Registration batch produced no changed token files. attempts=%s remaining_budget=%s still_needed=%s",
                registration_attempts,
                remaining_budget,
                still_needed,
            )
            update_running_replenishment_status(
                healthy_count=estimated_active,
                needed=still_needed,
                uploaded=success_uploads,
                failed=len(failed_names),
                failed_names=failed_names,
                new_token_files=total_new_files,
                summary=build_replenishment_summary("running"),
            )
            update_current_batch_status(
                status="failed",
                last_error="No token files were generated.",
                event_message=(
                    "No Codex token artifacts were generated for this batch. "
                    "Still below target, continue next registration batch."
                ),
            )
            finish_current_batch_status(
                status="failed", error="No token files were generated."
            )
            continue

        batch_snapshot = (
            normalize_batch_status(read_replenishment_status().get("current_batch"))
            or create_empty_batch_status()
        )
        batch_final_status = (
            "succeeded"
            if int(batch_snapshot.get("register_failed") or 0) == 0
            and int(batch_snapshot.get("codex_failed") or 0) == 0
            and int(batch_snapshot.get("upload_failed") or 0) == 0
            else "partial"
            if int(batch_snapshot.get("register_succeeded") or 0) > 0
            or int(batch_snapshot.get("upload_succeeded") or 0) > 0
            else "failed"
        )
        finish_current_batch_status(
            status=batch_final_status, error=str(batch_snapshot.get("last_error") or "")
        )

        logger.info(
            "Replenish loop progress: attempts=%s uploaded=%s failed=%s estimated_active=%s target=%s remaining_budget=%s",
            registration_attempts,
            success_uploads,
            len(failed_names),
            estimated_active,
            target_limit,
            remaining_budget,
        )

    summary = build_replenishment_summary(
        "success" if success_uploads > 0 else "failed"
    )
    logger.info("Replenishment complete. %s", summary)
    finish_replenishment_status(
        uploaded=success_uploads,
        failed=len(failed_names),
        failed_names=failed_names,
        summary=summary,
        new_token_files=total_new_files,
        healthy_count=estimated_active,
    )


def backfill_missing_uploads(
    config: Dict[str, Any], limit: Optional[int] = None
) -> int:
    cpa_url = config.get("cpa_url", "")
    management_key = config.get("management_key", "")
    register_token_dir = get_register_token_dir()
    failed_names: List[str] = []
    register_total = 0
    cpa_total = 0
    missing_total = 0

    start_replenishment_status("backfill_missing", config, limit=limit)

    if not os.path.isdir(register_token_dir):
        logger.error("Register token directory not found: %s", register_token_dir)
        finish_replenishment_status(
            error=f"Register token directory not found: {register_token_dir}",
            summary=build_replenishment_summary("backfill_failed"),
        )
        return 1

    register_files = list_register_token_files(register_token_dir)
    register_total = len(register_files)
    cpa_names = fetch_cpa_auth_file_names(cpa_url, management_key)
    cpa_total = len(cpa_names)
    missing_files = [name for name in register_files if name not in cpa_names]
    missing_total = len(missing_files)

    if limit is not None and limit > 0:
        missing_files = missing_files[:limit]

    logger.info(
        "Backfill scan complete. register_total=%s cpa_total=%s missing=%s limit=%s",
        len(register_files),
        len(cpa_names),
        len(missing_files),
        limit if limit is not None else "all",
    )
    update_running_replenishment_status(
        uploaded=0,
        failed=0,
        failed_names=[],
        register_total=register_total,
        cpa_total=cpa_total,
        missing_count=missing_total,
        new_token_files=0,
        summary=build_replenishment_summary("backfill_started"),
    )

    uploaded = 0
    failed = 0
    for file_name in missing_files:
        full_path = os.path.join(register_token_dir, file_name)
        result = process_token_for_cpa(
            cpa_url,
            management_key,
            full_path,
            validate_before_upload=False,
            cleanup_on_success=True,
        )
        if result["uploaded"]:
            uploaded += 1
        else:
            failed += 1
            failed_names.append(file_name)

        update_running_replenishment_status(
            uploaded=uploaded,
            failed=failed,
            failed_names=failed_names,
            register_total=register_total,
            cpa_total=cpa_total,
            missing_count=missing_total,
            new_token_files=uploaded + failed,
            summary=build_replenishment_summary("running"),
        )

    logger.info("Backfill finished. uploaded=%s failed=%s", uploaded, failed)
    finish_replenishment_status(
        error=""
        if failed == 0
        else f"{failed} token file(s) failed to upload during backfill.",
        uploaded=uploaded,
        failed=failed,
        failed_names=failed_names,
        summary=build_replenishment_summary(
            "backfill_finished" if failed == 0 else "backfill_failed"
        ),
        register_total=register_total,
        cpa_total=cpa_total,
        missing_count=missing_total,
    )
    return 0 if failed == 0 else 1


def main():
    parser = argparse.ArgumentParser(description="Codex Account Replenisher")
    parser.add_argument(
        "--config", default="frontend/config.yaml", help="Path to config.yaml"
    )
    parser.add_argument(
        "--state",
        default="runtime/credential_runtime_state.json",
        help="Path to runtime state",
    )
    parser.add_argument(
        "--needed",
        type=int,
        help="Number of accounts to replenish (if provided, skips check)",
    )
    parser.add_argument(
        "--backfill-missing",
        action="store_true",
        help="Upload token files present in register/codex_tokens but missing from CPA",
    )
    parser.add_argument(
        "--backfill-limit",
        type=int,
        help="Optional max number of missing token files to backfill",
    )
    args = parser.parse_args()

    mode = "backfill_missing" if args.backfill_missing else "replenish"
    lock = ReplenishmentLock(mode)
    if not lock.acquire():
        return

    try:
        config = load_config(args.config)

        if args.backfill_missing:
            raise SystemExit(backfill_missing_uploads(config, args.backfill_limit))

        # Use config values or CLI overrides
        target_count = config.get(
            "codex_replenish_target_count", config.get("codex_target_count")
        )
        # Use 0 if missing
        target_count = int(target_count) if target_count is not None else 0

        threshold = config.get("codex_replenish_threshold")
        threshold = int(threshold) if threshold is not None else 0

        enabled = config.get("codex_replenish_enabled", False)

        if not enabled and args.needed is None:
            write_replenishment_idle_status(
                config,
                needed=0,
                summary=build_replenishment_summary("disabled"),
            )
            logger.info("Codex replenishment is disabled in config.")
            return

        if args.needed is not None:
            needed = args.needed
        else:
            if target_count <= 0:
                write_replenishment_idle_status(
                    config,
                    needed=0,
                    summary=build_replenishment_summary("target_zero"),
                )
                logger.info("Target count is 0, nothing to do.")
                return

            state = load_runtime_state(args.state)
            active_count = count_normal_accounts(
                config.get("cpa_url", ""), config.get("management_key", ""), state
            )
            logger.info(
                f"Target: {target_count}, Threshold: {threshold}, Currently Normal: {active_count}"
            )

            if active_count < threshold:
                needed = target_count - active_count
            else:
                needed = 0

        if needed > 0:
            replenish(needed, config, args.state)
        else:
            write_replenishment_idle_status(
                config,
                needed=0,
                summary=build_replenishment_summary("idle"),
            )
            logger.info("No replenishment needed.")
    finally:
        lock.release()


if __name__ == "__main__":
    main()
