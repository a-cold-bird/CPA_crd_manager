"""Doc."""

# Legacy header text removed during encoding cleanup.
"""Doc."""

import os
import re
import uuid
import json
import random
import string
import time
import sys
import asyncio
import threading
import traceback
import secrets
import hashlib
import base64
from concurrent.futures import ThreadPoolExecutor, as_completed
from urllib.parse import urlparse, parse_qs, urlencode

from curl_cffi import requests as curl_requests
from curl_cffi.requests import AsyncSession as CurlAsyncSession
from .proxy_utils import load_proxy_candidates
from .utf8_utils import clean_display_text, ensure_utf8_stdio


ensure_utf8_stdio()
_builtin_print = print


def print(*args, **kwargs):
    sanitized_args = tuple(clean_display_text(arg) for arg in args)
    return _builtin_print(*sanitized_args, **kwargs)


# ================= Configuration =================
def _load_config():
    """Doc."""
    config = {
        "total_accounts": 3,
        "duckmail_api_base": "https://api.duckmail.sbs",
        "duckmail_bearer": "",
        "proxy": "",
        "proxy_list_url": "https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/countries/US/data.txt",
        "proxy_validate_enabled": True,
        "proxy_validate_timeout_seconds": 6,
        "proxy_validate_workers": 40,
        "proxy_validate_test_url": "https://auth.openai.com/",
        "proxy_max_retries_per_request": 30,
        "proxy_bad_ttl_seconds": 180,
        "proxy_retry_attempts_per_account": 3,
        "stable_proxy_file": "stable_proxy.txt",
        "stable_proxy": "",
        "prefer_stable_proxy": True,
        "output_file": "registered_accounts.txt",
        "enable_oauth": True,
        "oauth_required": True,
        "oauth_issuer": "https://auth.openai.com",
        "oauth_client_id": "app_EMoamEEZ73f0CkXaXp7hrann",
        "oauth_redirect_uri": "http://localhost:1455/auth/callback",
        "ak_file": "ak.txt",
        "rk_file": "rk.txt",
        "token_json_dir": "codex_tokens",
    }

    config_path = os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "config.json"
    )
    if os.path.exists(config_path):
        try:
            with open(config_path, "r", encoding="utf-8") as f:
                file_config = json.load(f)
                config.update(file_config)
        except Exception as e:
            print(f"[Config] Failed to load config.json: {e}")

    # Environment overrides
    config["duckmail_api_base"] = os.environ.get(
        "DUCKMAIL_API_BASE", config["duckmail_api_base"]
    )
    config["duckmail_bearer"] = os.environ.get(
        "DUCKMAIL_BEARER", config["duckmail_bearer"]
    )
    config["proxy"] = os.environ.get("PROXY", config["proxy"])
    config["proxy_list_url"] = os.environ.get(
        "PROXY_LIST_URL", config["proxy_list_url"]
    )
    config["proxy_validate_enabled"] = os.environ.get(
        "PROXY_VALIDATE_ENABLED", config["proxy_validate_enabled"]
    )
    config["proxy_validate_timeout_seconds"] = float(
        os.environ.get(
            "PROXY_VALIDATE_TIMEOUT_SECONDS", config["proxy_validate_timeout_seconds"]
        )
    )
    config["proxy_validate_workers"] = int(
        os.environ.get("PROXY_VALIDATE_WORKERS", config["proxy_validate_workers"])
    )
    config["proxy_validate_test_url"] = os.environ.get(
        "PROXY_VALIDATE_TEST_URL", config["proxy_validate_test_url"]
    )
    config["total_accounts"] = int(
        os.environ.get("TOTAL_ACCOUNTS", config["total_accounts"])
    )
    config["proxy_max_retries_per_request"] = int(
        os.environ.get(
            "PROXY_MAX_RETRIES_PER_REQUEST", config["proxy_max_retries_per_request"]
        )
    )
    config["proxy_bad_ttl_seconds"] = int(
        os.environ.get("PROXY_BAD_TTL_SECONDS", config["proxy_bad_ttl_seconds"])
    )
    config["proxy_retry_attempts_per_account"] = int(
        os.environ.get(
            "PROXY_RETRY_ATTEMPTS_PER_ACCOUNT",
            config["proxy_retry_attempts_per_account"],
        )
    )
    config["stable_proxy_file"] = os.environ.get(
        "STABLE_PROXY_FILE", config["stable_proxy_file"]
    )
    config["stable_proxy"] = os.environ.get("STABLE_PROXY", config["stable_proxy"])
    config["prefer_stable_proxy"] = os.environ.get(
        "PREFER_STABLE_PROXY", config["prefer_stable_proxy"]
    )
    config["enable_oauth"] = os.environ.get("ENABLE_OAUTH", config["enable_oauth"])
    config["oauth_required"] = os.environ.get(
        "OAUTH_REQUIRED", config["oauth_required"]
    )
    config["oauth_issuer"] = os.environ.get("OAUTH_ISSUER", config["oauth_issuer"])
    config["oauth_client_id"] = os.environ.get(
        "OAUTH_CLIENT_ID", config["oauth_client_id"]
    )
    config["oauth_redirect_uri"] = os.environ.get(
        "OAUTH_REDIRECT_URI", config["oauth_redirect_uri"]
    )
    config["ak_file"] = os.environ.get("AK_FILE", config["ak_file"])
    config["rk_file"] = os.environ.get("RK_FILE", config["rk_file"])
    config["token_json_dir"] = os.environ.get(
        "TOKEN_JSON_DIR", config["token_json_dir"]
    )

    return config


def _as_bool(value):
    if isinstance(value, bool):
        return value
    if value is None:
        return False
    return str(value).strip().lower() in {"1", "true", "yes", "y", "on"}


_CONFIG = _load_config()
DUCKMAIL_API_BASE = _CONFIG["duckmail_api_base"]
DUCKMAIL_BEARER = _CONFIG["duckmail_bearer"]
DEFAULT_TOTAL_ACCOUNTS = _CONFIG["total_accounts"]
DEFAULT_PROXY = _CONFIG["proxy"]
PROXY_LIST_URL = _CONFIG["proxy_list_url"]
PROXY_VALIDATE_ENABLED = _as_bool(_CONFIG.get("proxy_validate_enabled", True))
PROXY_VALIDATE_TIMEOUT_SECONDS = max(
    1.0, float(_CONFIG.get("proxy_validate_timeout_seconds", 6))
)
PROXY_VALIDATE_WORKERS = max(1, int(_CONFIG.get("proxy_validate_workers", 40)))
PROXY_VALIDATE_TEST_URL = (
    str(_CONFIG.get("proxy_validate_test_url", "https://auth.openai.com/")).strip()
    or "https://auth.openai.com/"
)
PROXY_MAX_RETRIES_PER_REQUEST = max(
    1, int(_CONFIG.get("proxy_max_retries_per_request", 30))
)
PROXY_BAD_TTL_SECONDS = max(10, int(_CONFIG.get("proxy_bad_ttl_seconds", 180)))
PROXY_RETRY_ATTEMPTS_PER_ACCOUNT = max(
    1, int(_CONFIG.get("proxy_retry_attempts_per_account", 3))
)
STABLE_PROXY_FILE = _CONFIG.get("stable_proxy_file", "stable_proxy.txt")
STABLE_PROXY_RAW = _CONFIG.get("stable_proxy", "")
PREFER_STABLE_PROXY = _as_bool(_CONFIG.get("prefer_stable_proxy", True))
DEFAULT_OUTPUT_FILE = _CONFIG["output_file"]
ENABLE_OAUTH = _as_bool(_CONFIG.get("enable_oauth", True))
OAUTH_REQUIRED = _as_bool(_CONFIG.get("oauth_required", True))
OAUTH_ISSUER = _CONFIG["oauth_issuer"].rstrip("/")
OAUTH_CLIENT_ID = _CONFIG["oauth_client_id"]
OAUTH_REDIRECT_URI = _CONFIG["oauth_redirect_uri"]
AK_FILE = _CONFIG["ak_file"]
RK_FILE = _CONFIG["rk_file"]
TOKEN_JSON_DIR = _CONFIG["token_json_dir"]

# Shared DuckMail mailbox session helper.
# asyncio.Lock：用于异步注册流程的打印/文件操作
_print_lock = asyncio.Lock()
_file_lock = asyncio.Lock()
# threading.Lock：仅用于 ProxyPool 内部同步线程池打印（在 asyncio.to_thread 中运行）
_proxy_print_lock = threading.Lock()


def _log_timestamp():
    return time.strftime("%Y-%m-%d %H:%M:%S")


def _normalize_proxy(proxy: str):
    if not proxy:
        return None
    value = str(proxy).strip()
    if not value:
        return None
    if "://" in value:
        return value
    return f"http://{value}"


STABLE_PROXY = _normalize_proxy(STABLE_PROXY_RAW)
DIRECT_PROXIES = {"http": "", "https": ""}


def _normalize_proxy_list_url(url: str):
    value = (url or "").strip()
    if not value:
        return "https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/countries/US/data.txt"

    m = re.match(r"^https?://github\.com/([^/]+)/([^/]+)/blob/([^/]+)/(.+)$", value)
    if m:
        owner, repo, branch, path = m.groups()
        return f"https://raw.githubusercontent.com/{owner}/{repo}/{branch}/{path}"
    return value


class ProxyPool:
    """Doc."""

    def __init__(
        self,
        list_url: str,
        fallback_proxy: str = None,
        max_retries_per_request: int = 30,
        bad_ttl_seconds: int = 180,
        validate_enabled: bool = True,
        validate_timeout_seconds: float = 6,
        validate_workers: int = 40,
        validate_test_url: str = "https://auth.openai.com/",
        prefer_stable_proxy: bool = True,
    ):
        self.list_url = _normalize_proxy_list_url(list_url)
        self.fallback_proxy = _normalize_proxy(fallback_proxy)
        self.max_retries_per_request = max(1, int(max_retries_per_request))
        self.bad_ttl_seconds = max(10, int(bad_ttl_seconds))
        self.validate_enabled = bool(validate_enabled)
        self.validate_timeout_seconds = max(1.0, float(validate_timeout_seconds))
        self.validate_workers = max(1, int(validate_workers))
        self.validate_test_url = (
            str(validate_test_url).strip() or "https://auth.openai.com/"
        )
        self.prefer_stable_proxy = bool(prefer_stable_proxy)
        self._lock = threading.Lock()
        self._loaded = False
        self._proxies = []
        self._index = 0
        self._bad_until = {}
        self._last_fetched_count = 0
        self._last_valid_count = 0
        self._stable_proxy = None
        self._last_error = ""

    def set_fallback(self, proxy: str):
        normalized = _normalize_proxy(proxy)
        if normalized:
            with self._lock:
                self.fallback_proxy = normalized

    def set_stable_proxy(self, proxy: str):
        normalized = _normalize_proxy(proxy)
        if not normalized:
            return
        with self._lock:
            self._stable_proxy = normalized
            self._bad_until.pop(normalized, None)

    def set_prefer_stable_proxy(self, enabled: bool):
        with self._lock:
            self.prefer_stable_proxy = bool(enabled)

    def get_stable_proxy(self):
        with self._lock:
            return self._stable_proxy

    def _fetch_proxies(self):
        try:
            base_dir = os.path.dirname(os.path.abspath(__file__))
            return list(load_proxy_candidates(base_dir=base_dir))
        except Exception as exc:
            with self._lock:
                self._last_error = f"load_proxy_candidates failed: {str(exc)[:160]}"
            return []

    def _validate_single_proxy(self, proxy: str):
        try:
            res = curl_requests.get(
                self.validate_test_url,
                timeout=self.validate_timeout_seconds,
                allow_redirects=False,
                proxies={"http": proxy, "https": proxy},
                impersonate="chrome131",
            )
            return 200 <= res.status_code < 500
        except Exception:
            return False

    def _filter_valid_proxies(self, proxies):
        if not self.validate_enabled or not proxies:
            return list(proxies)

        workers = min(self.validate_workers, len(proxies))
        valid = []
        total = len(proxies)
        done = 0
        started_at = time.time()
        last_log_at = started_at

        with _proxy_print_lock:
            print(
                f"[ProxyCheck] validating proxies: total={total}, workers={workers}, "
                f"timeout={self.validate_timeout_seconds}s, url={self.validate_test_url}"
            )

        with ThreadPoolExecutor(max_workers=workers) as executor:
            futures = {
                executor.submit(self._validate_single_proxy, proxy): proxy
                for proxy in proxies
            }
            for future in as_completed(futures):
                proxy = futures[future]
                done += 1
                try:
                    if future.result():
                        valid.append(proxy)
                except Exception:
                    pass

                now = time.time()
                if done == total or (now - last_log_at) >= 1.5:
                    with _proxy_print_lock:
                        print(
                            f"[ProxyCheck] progress={done}/{total}, valid={len(valid)}"
                        )
                    last_log_at = now

        elapsed = time.time() - started_at
        with _proxy_print_lock:
            print(
                f"[ProxyCheck] done: valid={len(valid)}/{total}, elapsed={elapsed:.1f}s"
            )
        return valid

    def refresh(self, force=False):
        with self._lock:
            if self._loaded and not force:
                return

        fetched_proxies = self._fetch_proxies()
        fallback_proxy = self.fallback_proxy
        proxies = []
        for proxy in fetched_proxies:
            normalized = _normalize_proxy(proxy)
            if normalized and normalized not in proxies:
                proxies.append(normalized)
        if fallback_proxy and fallback_proxy not in proxies:
            proxies.append(fallback_proxy)
        last_error = ""

        with self._lock:
            self._last_fetched_count = len(fetched_proxies)
            self._last_valid_count = len(proxies)
            if proxies:
                self._proxies = proxies
                self._index = 0
                self._bad_until = {}
                self._last_error = ""
            elif not self._proxies:
                self._proxies = []
                self._index = 0
                self._last_error = last_error
            else:
                self._last_error = last_error
            self._loaded = True

    def next_proxy(self):
        self.refresh()
        with self._lock:
            if not self._proxies:
                return None
            now = time.time()
            stable = self._stable_proxy if self.prefer_stable_proxy else None
            if stable and len(self._proxies) <= 1:
                stable_bad_until = self._bad_until.get(stable, 0)
                if stable_bad_until and stable_bad_until <= now:
                    self._bad_until.pop(stable, None)
                    stable_bad_until = 0
                if stable_bad_until > now:
                    self._stable_proxy = None
                else:
                    return stable

            total = len(self._proxies)
            for _ in range(total):
                proxy = self._proxies[self._index]
                self._index = (self._index + 1) % total

                bad_until = self._bad_until.get(proxy, 0)
                if bad_until and bad_until <= now:
                    self._bad_until.pop(proxy, None)
                    bad_until = 0

                if bad_until > now:
                    continue
                return proxy

            fallback = self.fallback_proxy
            if fallback:
                bad_until = self._bad_until.get(fallback, 0)
                if bad_until and bad_until <= now:
                    self._bad_until.pop(fallback, None)
                    bad_until = 0
                if bad_until <= now:
                    return fallback
            # Keep the newest stable proxy at the front so subsequent workers can reuse it quickly.
            proxy = self._proxies[self._index]
            self._index = (self._index + 1) % total
            return proxy

    def report_bad(self, proxy: str, error=None):
        normalized = _normalize_proxy(proxy)
        if not normalized:
            return

        until = time.time() + self.bad_ttl_seconds
        with self._lock:
            self._bad_until[normalized] = until
            if self._stable_proxy == normalized:
                self._stable_proxy = None
            if error:
                self._last_error = f"{normalized} -> {str(error)[:160]}"

    def report_success(self, proxy: str):
        normalized = _normalize_proxy(proxy)
        if not normalized:
            return
        with self._lock:
            self._stable_proxy = normalized
            self._bad_until.pop(normalized, None)

    def request_retry_limit(self):
        self.refresh()
        with self._lock:
            pool_size = len(self._proxies)
            if self.fallback_proxy and self.fallback_proxy not in self._proxies:
                pool_size += 1
            max_retries = self.max_retries_per_request
        return max(1, min(max_retries, max(1, pool_size)))

    def info(self):
        with self._lock:
            now = time.time()
            bad_count = 0
            for until in self._bad_until.values():
                if until > now:
                    bad_count += 1
            return {
                "mode": "candidate-pool" if self._proxies else "direct",
                "list_url": self.list_url,
                "count": len(self._proxies),
                "fetched_count": self._last_fetched_count,
                "validated_count": self._last_valid_count,
                "validate_enabled": self.validate_enabled,
                "validate_test_url": self.validate_test_url,
                "validate_timeout_seconds": self.validate_timeout_seconds,
                "validate_workers": self.validate_workers,
                "bad_count": bad_count,
                "fallback_proxy": self.fallback_proxy,
                "stable_proxy": self._stable_proxy,
                "prefer_stable_proxy": self.prefer_stable_proxy,
                "max_retries_per_request": self.max_retries_per_request,
                "bad_ttl_seconds": self.bad_ttl_seconds,
                "last_error": self._last_error,
            }


_proxy_pool = ProxyPool(
    PROXY_LIST_URL,
    fallback_proxy=DEFAULT_PROXY,
    max_retries_per_request=PROXY_MAX_RETRIES_PER_REQUEST,
    bad_ttl_seconds=PROXY_BAD_TTL_SECONDS,
    validate_enabled=PROXY_VALIDATE_ENABLED,
    validate_timeout_seconds=PROXY_VALIDATE_TIMEOUT_SECONDS,
    validate_workers=PROXY_VALIDATE_WORKERS,
    validate_test_url=PROXY_VALIDATE_TEST_URL,
    prefer_stable_proxy=PREFER_STABLE_PROXY,
)
_stable_proxy_loaded = False


def _get_proxy_pool(fallback_proxy=None):
    global _stable_proxy_loaded
    _proxy_pool.set_prefer_stable_proxy(PREFER_STABLE_PROXY)
    if not _stable_proxy_loaded:
        stable = STABLE_PROXY or _load_stable_proxy_from_file()
        if stable:
            _proxy_pool.set_stable_proxy(stable)
        _stable_proxy_loaded = True
    if fallback_proxy:
        _proxy_pool.set_fallback(fallback_proxy)
    return _proxy_pool


def _is_proxy_related_error(exc: Exception):
    class_name = exc.__class__.__name__.lower()
    if "proxy" in class_name:
        return True

    curl_code = getattr(exc, "code", None)
    if curl_code in {5, 6, 7, 28, 35, 47, 52, 55, 56, 97}:
        return True

    msg = str(exc).lower()
    keywords = [
        "proxy",
        "connect tunnel failed",
        "could not connect",
        "connection refused",
        "timed out",
    ]
    for word in keywords:
        if word in msg:
            return True
    return False


def _enable_proxy_rotation(session, fallback_proxy=None, fixed_proxy=None):
    # Disable internal proxy rotation; rely on system/environment proxy.
    return session


_CHROME_PROFILES = [
    {
        "major": 131,
        "impersonate": "chrome131",
        "build": 6778,
        "patch_range": (69, 205),
        "sec_ch_ua": '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
    },
]


def _random_chrome_version():
    profile = random.choice(_CHROME_PROFILES)
    major = profile["major"]
    build = profile["build"]
    patch = random.randint(*profile["patch_range"])
    full_ver = f"{major}.0.{build}.{patch}"
    ua = f"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{full_ver} Safari/537.36"
    return profile["impersonate"], major, full_ver, ua, profile["sec_ch_ua"]


async def _random_delay(low=0.3, high=1.0):
    await asyncio.sleep(random.uniform(low, high))


def _make_trace_headers():
    trace_id = random.randint(10**17, 10**18 - 1)
    parent_id = random.randint(10**17, 10**18 - 1)
    tp = f"00-{uuid.uuid4().hex}-{format(parent_id, '016x')}-01"
    return {
        "traceparent": tp,
        "tracestate": "dd=s:1;o:rum",
        "x-datadog-origin": "rum",
        "x-datadog-sampling-priority": "1",
        "x-datadog-trace-id": str(trace_id),
        "x-datadog-parent-id": str(parent_id),
    }


def _generate_pkce():
    code_verifier = (
        base64.urlsafe_b64encode(secrets.token_bytes(64)).rstrip(b"=").decode("ascii")
    )
    digest = hashlib.sha256(code_verifier.encode("ascii")).digest()
    code_challenge = base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")
    return code_verifier, code_challenge


class SentinelTokenGenerator:
    """Doc."""

    MAX_ATTEMPTS = 500000
    ERROR_PREFIX = "wQ8Lk5FbGpA2NcR9dShT6gYjU7VxZ4D"

    def __init__(self, device_id=None, user_agent=None):
        self.device_id = device_id or str(uuid.uuid4())
        self.user_agent = user_agent or (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/145.0.0.0 Safari/537.36"
        )
        self.requirements_seed = str(random.random())
        self.sid = str(uuid.uuid4())

    @staticmethod
    def _fnv1a_32(text: str):
        h = 2166136261
        for ch in text:
            h ^= ord(ch)
            h = (h * 16777619) & 0xFFFFFFFF
        h ^= h >> 16
        h = (h * 2246822507) & 0xFFFFFFFF
        h ^= h >> 13
        h = (h * 3266489909) & 0xFFFFFFFF
        h ^= h >> 16
        h &= 0xFFFFFFFF
        return format(h, "08x")

    def _get_config(self):
        now_str = time.strftime(
            "%a %b %d %Y %H:%M:%S GMT+0000 (Coordinated Universal Time)",
            time.gmtime(),
        )
        perf_now = random.uniform(1000, 50000)
        time_origin = time.time() * 1000 - perf_now
        nav_prop = random.choice(
            [
                "vendorSub",
                "productSub",
                "vendor",
                "maxTouchPoints",
                "scheduling",
                "userActivation",
                "doNotTrack",
                "geolocation",
                "connection",
                "plugins",
                "mimeTypes",
                "pdfViewerEnabled",
                "webkitTemporaryStorage",
                "webkitPersistentStorage",
                "hardwareConcurrency",
                "cookieEnabled",
                "credentials",
                "mediaDevices",
                "permissions",
                "locks",
                "ink",
            ]
        )
        nav_val = f"{nav_prop}-undefined"

        return [
            "1920x1080",
            now_str,
            4294705152,
            random.random(),
            self.user_agent,
            "https://sentinel.openai.com/sentinel/20260124ceb8/sdk.js",
            None,
            None,
            "en-US",
            "en-US,en",
            random.random(),
            nav_val,
            random.choice(
                ["location", "implementation", "URL", "documentURI", "compatMode"]
            ),
            random.choice(
                ["Object", "Function", "Array", "Number", "parseFloat", "undefined"]
            ),
            perf_now,
            self.sid,
            "",
            random.choice([4, 8, 12, 16]),
            time_origin,
        ]

    @staticmethod
    def _base64_encode(data):
        raw = json.dumps(data, separators=(",", ":"), ensure_ascii=False).encode(
            "utf-8"
        )
        return base64.b64encode(raw).decode("ascii")

    def _run_check(self, start_time, seed, difficulty, config, nonce):
        config[3] = nonce
        config[9] = round((time.time() - start_time) * 1000)
        data = self._base64_encode(config)
        hash_hex = self._fnv1a_32(seed + data)
        diff_len = len(difficulty)
        if hash_hex[:diff_len] <= difficulty:
            return data + "~S"
        return None

    def generate_token(self, seed=None, difficulty=None):
        seed = seed if seed is not None else self.requirements_seed
        difficulty = str(difficulty or "0")
        start_time = time.time()
        config = self._get_config()

        for i in range(self.MAX_ATTEMPTS):
            result = self._run_check(start_time, seed, difficulty, config, i)
            if result:
                return "gAAAAAB" + result
        return "gAAAAAB" + self.ERROR_PREFIX + self._base64_encode(str(None))

    def generate_requirements_token(self):
        config = self._get_config()
        config[3] = 1
        config[9] = round(random.uniform(5, 50))
        data = self._base64_encode(config)
        return "gAAAAAC" + data


async def fetch_sentinel_challenge(
    session,
    device_id,
    flow="authorize_continue",
    user_agent=None,
    sec_ch_ua=None,
    impersonate=None,
    error_sink=None,
):
    generator = SentinelTokenGenerator(device_id=device_id, user_agent=user_agent)
    req_body = {
        "p": generator.generate_requirements_token(),
        "id": device_id,
        "flow": flow,
    }
    headers = {
        "Content-Type": "text/plain;charset=UTF-8",
        "Referer": "https://sentinel.openai.com/backend-api/sentinel/frame.html",
        "Origin": "https://sentinel.openai.com",
        "User-Agent": user_agent or "Mozilla/5.0",
        "sec-ch-ua": sec_ch_ua
        or '"Not:A-Brand";v="99", "Google Chrome";v="145", "Chromium";v="145"',
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"Windows"',
    }

    kwargs = {
        "data": json.dumps(req_body),
        "headers": headers,
        "timeout": 20,
    }
    if impersonate:
        kwargs["impersonate"] = impersonate

    debug_proxy = str(os.environ.get("SENTINEL_DEBUG_PROXY", "") or "").strip()
    attempts = []
    if debug_proxy:
        attempts.append(
            {"verify": False, "proxies": {"http": debug_proxy, "https": debug_proxy}}
        )
    attempts.append({})

    last_error = None
    for extra in attempts:
        try:
            resp = await session.post(
                "https://sentinel.openai.com/backend-api/sentinel/req",
                **kwargs,
                **extra,
            )
        except Exception as exc:
            last_error = exc
            continue

        if resp.status_code != 200:
            if isinstance(error_sink, dict):
                error_sink.update(
                    {
                        "code": f"sentinel_http_{resp.status_code}",
                        "message": clean_display_text(resp.text[:500])
                        or f"Sentinel challenge failed with HTTP {resp.status_code}",
                        "status_code": resp.status_code,
                    }
                )
            return None

        try:
            return resp.json()
        except Exception as exc:
            last_error = exc
            break

    if isinstance(error_sink, dict):
        error_sink.update(
            {
                "code": "sentinel_request_failed",
                "message": clean_display_text(
                    str(last_error or "Sentinel challenge request failed")
                )[:500],
            }
        )
    return None


async def build_sentinel_token(
    session,
    device_id,
    flow="authorize_continue",
    user_agent=None,
    sec_ch_ua=None,
    impersonate=None,
    error_sink=None,
):
    challenge = await fetch_sentinel_challenge(
        session,
        device_id,
        flow=flow,
        user_agent=user_agent,
        sec_ch_ua=sec_ch_ua,
        impersonate=impersonate,
        error_sink=error_sink,
    )
    if not challenge:
        return None

    c_value = challenge.get("token", "")
    if not c_value:
        if isinstance(error_sink, dict):
            error_sink.update(
                {
                    "code": "sentinel_token_missing",
                    "message": "Sentinel challenge response missing token",
                }
            )
        return None

    pow_data = challenge.get("proofofwork") or {}
    generator = SentinelTokenGenerator(device_id=device_id, user_agent=user_agent)

    if pow_data.get("required") and pow_data.get("seed"):
        p_value = generator.generate_token(
            seed=pow_data.get("seed"),
            difficulty=pow_data.get("difficulty", "0"),
        )
    else:
        p_value = generator.generate_requirements_token()

    return json.dumps(
        {
            "p": p_value,
            "t": "",
            "c": c_value,
            "id": device_id,
            "flow": flow,
        },
        separators=(",", ":"),
    )


def _extract_code_from_url(url: str):
    if not url or "code=" not in url:
        return None
    try:
        return parse_qs(urlparse(url).query).get("code", [None])[0]
    except Exception:
        return None


def _decode_jwt_payload(token: str):
    try:
        parts = token.split(".")
        if len(parts) != 3:
            return {}
        payload = parts[1]
        padding = 4 - len(payload) % 4
        if padding != 4:
            payload += "=" * padding
        decoded = base64.urlsafe_b64decode(payload)
        return json.loads(decoded)
    except Exception:
        return {}


def _write_append(path: str, text: str):
    """同步追加写文件，供 asyncio.to_thread 调用。"""
    with open(path, "a", encoding="utf-8") as f:
        f.write(text)


def _write_json(path: str, data: dict):
    """同步写 JSON 文件，供 asyncio.to_thread 调用。"""
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False)


def _write_text(path: str, text: str):
    """同步覆盖写文件，供 asyncio.to_thread 调用。"""
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)


async def _save_codex_tokens(email: str, tokens: dict):
    access_token = tokens.get("access_token", "")
    refresh_token = tokens.get("refresh_token", "")
    id_token = tokens.get("id_token", "")

    if access_token:
        async with _file_lock:
            await asyncio.to_thread(_write_append, AK_FILE, f"{access_token}\n")

    if refresh_token:
        async with _file_lock:
            await asyncio.to_thread(_write_append, RK_FILE, f"{refresh_token}\n")

    if not access_token:
        return

    payload = _decode_jwt_payload(access_token)
    auth_info = payload.get("https://api.openai.com/auth", {})
    account_id = auth_info.get("chatgpt_account_id", "")

    exp_timestamp = payload.get("exp")
    expired_str = ""
    if isinstance(exp_timestamp, int) and exp_timestamp > 0:
        from datetime import datetime, timezone, timedelta

        exp_dt = datetime.fromtimestamp(exp_timestamp, tz=timezone(timedelta(hours=8)))
        expired_str = exp_dt.strftime("%Y-%m-%dT%H:%M:%S+08:00")

    from datetime import datetime, timezone, timedelta

    now = datetime.now(tz=timezone(timedelta(hours=8)))
    token_data = {
        "type": "codex",
        "email": email,
        "expired": expired_str,
        "id_token": id_token,
        "account_id": account_id,
        "access_token": access_token,
        "session_token": tokens.get("session_token", ""),
        "last_refresh": now.strftime("%Y-%m-%dT%H:%M:%S+08:00"),
        "refresh_token": refresh_token,
    }

    base_dir = os.path.dirname(os.path.abspath(__file__))
    token_dir = (
        TOKEN_JSON_DIR
        if os.path.isabs(TOKEN_JSON_DIR)
        else os.path.join(base_dir, TOKEN_JSON_DIR)
    )
    os.makedirs(token_dir, exist_ok=True)

    token_path = os.path.join(token_dir, f"{email}.json")
    async with _file_lock:
        await asyncio.to_thread(_write_json, token_path, token_data)


def _stable_proxy_path():
    base_dir = os.path.dirname(os.path.abspath(__file__))
    return (
        STABLE_PROXY_FILE
        if os.path.isabs(STABLE_PROXY_FILE)
        else os.path.join(base_dir, STABLE_PROXY_FILE)
    )


def _load_stable_proxy_from_file():
    path = _stable_proxy_path()
    if not os.path.exists(path):
        return None
    try:
        with open(path, "r", encoding="utf-8") as f:
            line = f.readline().strip()
        return _normalize_proxy(line)
    except Exception:
        return None


def _sync_save_stable_proxy_to_config(normalized: str, config_path: str):
    """同步版本，供 asyncio.to_thread 调用。"""
    try:
        with open(config_path, "r", encoding="utf-8") as f:
            config = json.load(f)
        config["stable_proxy"] = normalized
        with open(config_path, "w", encoding="utf-8") as f:
            json.dump(config, f, ensure_ascii=False, indent=2)
            f.write("\n")
    except Exception:
        pass


async def _save_stable_proxy_to_config(proxy: str):
    normalized = _normalize_proxy(proxy)
    if not normalized:
        return

    config_path = os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "config.json"
    )
    if not os.path.exists(config_path):
        return

    async with _file_lock:
        await asyncio.to_thread(
            _sync_save_stable_proxy_to_config, normalized, config_path
        )


async def _save_stable_proxy_to_file(proxy: str):
    normalized = _normalize_proxy(proxy)
    if not normalized:
        return
    path = _stable_proxy_path()
    async with _file_lock:
        await asyncio.to_thread(_write_text, path, f"{normalized}\n")


def _generate_password(length=14):
    lower = string.ascii_lowercase
    upper = string.ascii_uppercase
    digits = string.digits
    special = "!@#$%&*"
    pwd = [
        random.choice(lower),
        random.choice(upper),
        random.choice(digits),
        random.choice(special),
    ]
    all_chars = lower + upper + digits + special
    pwd += [random.choice(all_chars) for _ in range(length - 4)]
    random.shuffle(pwd)
    return "".join(pwd)


# ================= DuckMail 闂侇參宕欓懞銉︽ =================


from .email_utils import (
    create_test_email,
    fetch_verification_code,
    snapshot_mailbox_ids,
    snapshot_mailbox_max_id,
)


async def create_temp_email(provider="mailfree", domain=None):
    """Doc."""
    email, mailbox = await create_test_email(provider=provider, domain=domain)
    if email:
        password = _generate_password()
        # Current mailbox providers use the full email address as mail_token / mailbox key.
        return email, password, email
    raise Exception("Failed to create temporary email")


async def create_otp_wait_context(mail_token: str):
    return {
        "started_at": time.time(),
        "seen_email_ids": await snapshot_mailbox_ids(mail_token)
        if mail_token
        else set(),
        "baseline_email_id": await snapshot_mailbox_max_id(mail_token)
        if mail_token
        else None,
        "tried_codes": set(),
    }


async def wait_for_verification_email(
    mail_token: str, timeout: int = 120, otp_context=None, exclude_codes=None
):
    """Doc."""
    context = otp_context or await create_otp_wait_context(mail_token)
    max_wait = max(1, int(timeout))
    return await fetch_verification_code(
        mail_token,
        max_wait=max_wait,
        interval=2,
        known_email_ids=context.setdefault("seen_email_ids", set()),
        exclude_codes=exclude_codes or context.get("tried_codes"),
        min_received_at=context.get("started_at"),
        min_email_id=context.get("baseline_email_id"),
        log_fn=print,
    )


def _random_name():
    first = random.choice(
        [
            "James",
            "Emma",
            "Liam",
            "Olivia",
            "Noah",
            "Ava",
            "Ethan",
            "Sophia",
            "Lucas",
            "Mia",
            "Mason",
            "Isabella",
            "Logan",
            "Charlotte",
            "Alexander",
            "Amelia",
            "Benjamin",
            "Harper",
            "William",
            "Evelyn",
            "Henry",
            "Abigail",
            "Sebastian",
            "Emily",
            "Jack",
            "Elizabeth",
        ]
    )
    last = random.choice(
        [
            "Smith",
            "Johnson",
            "Brown",
            "Davis",
            "Wilson",
            "Moore",
            "Taylor",
            "Clark",
            "Hall",
            "Young",
            "Anderson",
            "Thomas",
            "Jackson",
            "White",
            "Harris",
            "Martin",
            "Thompson",
            "Garcia",
            "Robinson",
            "Lewis",
            "Walker",
            "Allen",
            "King",
            "Wright",
            "Scott",
            "Green",
        ]
    )
    return f"{first} {last}"


def _random_birthdate():
    y = random.randint(1985, 2002)
    m = random.randint(1, 12)
    d = random.randint(1, 28)
    return f"{y}-{m:02d}-{d:02d}"


class ChatGPTRegister:
    BASE = "https://chatgpt.com"
    AUTH = "https://auth.openai.com"

    def __init__(
        self,
        proxy: str = None,
        tag: str = "",
        fixed_proxy: str = None,
        impersonate: str = "chrome120",
        email_provider: str = "mailfree",
        email_domain: str = None,
        debug: bool = False,
    ):
        self.tag = tag
        self.email_provider = email_provider
        self.email_domain = email_domain
        self.debug = bool(debug)
        self.device_id = str(uuid.uuid4())
        self.auth_session_logging_id = str(uuid.uuid4())
        (
            self.impersonate,
            self.chrome_major,
            self.chrome_full,
            self.ua,
            self.sec_ch_ua,
        ) = _random_chrome_version()

        self.session: CurlAsyncSession | None = None

        self.proxy = proxy
        self.fixed_proxy = fixed_proxy
        self._callback_url = None
        self.last_protocol_error = {
            "code": "",
            "message": "",
            "stage": "",
            "status_code": None,
            "response_excerpt": "",
        }

    async def _log(self, step, method, url, status, body=None):
        timestamp = _log_timestamp()
        prefix = f"[{timestamp}] "
        if self.tag:
            prefix += f"[{self.tag}] "
        lines = [
            f"\n{'=' * 60}",
            f"{prefix}[Step] {step}",
            f"{prefix}[{method}] {url}",
            f"{prefix}[Status] {status}",
        ]
        if body:
            response_limit = 8000 if self.debug else 1000
            try:
                lines.append(
                    f"{prefix}[Response] {json.dumps(body, indent=2, ensure_ascii=False)[:response_limit]}"
                )
            except Exception:
                lines.append(f"{prefix}[Response] {str(body)[:response_limit]}")
        lines.append(f"{'=' * 60}")
        async with _print_lock:
            print("\n".join(lines))

    async def _print(self, msg):
        prefix = f"[{_log_timestamp()}] "
        if self.tag:
            prefix += f"[{self.tag}] "
        async with _print_lock:
            print(f"{prefix}{msg}")

    def _parse_json_or_raise(self, response, step_name: str):
        if response.status_code >= 400:
            raise Exception(f"{step_name} failed ({response.status_code})")

        try:
            data = response.json()
        except Exception:
            body = (response.text or "")[: (2000 if self.debug else 200)].replace(
                "\n", " "
            )
            raise Exception(
                f"{step_name} returned invalid JSON (status={response.status_code}, body={body})"
            )
        return data

    # ==================== DuckMail ====================

    def _make_session(self) -> CurlAsyncSession:
        """创建并配置 AsyncSession。"""
        session = CurlAsyncSession(impersonate=self.impersonate)
        if self.proxy:
            # curl_cffi AsyncSession 接受字符串代理
            session.proxies = self.proxy  # type: ignore[assignment]
        # else: 不设置 proxy，走直连或环境变量
        session.verify = True
        session.headers.update(
            {
                "User-Agent": self.ua,
                "Accept-Language": random.choice(
                    [
                        "en-US,en;q=0.9",
                        "en-US,en;q=0.9,zh-CN;q=0.8",
                        "en,en-US;q=0.9",
                        "en-US,en;q=0.8",
                    ]
                ),
                "sec-ch-ua": self.sec_ch_ua,
                "sec-ch-ua-mobile": "?0",
                "sec-ch-ua-platform": '"Windows"',
                "sec-ch-ua-arch": '"x86"',
                "sec-ch-ua-bitness": '"64"',
                "sec-ch-ua-full-version": f'"{self.chrome_full}"',
                "sec-ch-ua-platform-version": f'"{random.randint(10, 15)}.0.0"',
            }
        )
        session.cookies.set("oai-did", self.device_id, domain="chatgpt.com")
        return session

    async def create_temp_email(self):
        email, mail_token = await create_test_email(
            provider=self.email_provider, domain=self.email_domain
        )
        if not email:
            raise Exception("email_utils temporary email creation failed")
        return email, "dummy_pwd", mail_token

    async def create_otp_wait_context(self, mail_token: str):
        seen_email_ids = await snapshot_mailbox_ids(mail_token) if mail_token else set()
        return {
            "started_at": time.time(),
            "seen_email_ids": seen_email_ids,
            "baseline_email_id": await snapshot_mailbox_max_id(mail_token)
            if mail_token
            else None,
            "tried_codes": set(),
        }

    @staticmethod
    def _extract_error_info(data):
        if not isinstance(data, dict):
            return "", ""
        error_block = data.get("error") if isinstance(data.get("error"), dict) else {}
        error_code = str(error_block.get("code") or data.get("code") or "").strip()
        error_message = str(
            error_block.get("message") or data.get("message") or data.get("text") or ""
        ).strip()
        return error_code, error_message

    async def wait_for_verification_email(
        self, mail_token: str, timeout: int = 120, otp_context=None, exclude_codes=None
    ):
        """Doc."""
        await self._print(
            f"[OTP] waiting for verification email (timeout={timeout}s)..."
        )
        context = otp_context or await self.create_otp_wait_context(mail_token)
        code = await fetch_verification_code(
            mail_token,
            max_wait=max(1, int(timeout)),
            interval=2,
            known_email_ids=context.setdefault("seen_email_ids", set()),
            exclude_codes=exclude_codes or context.get("tried_codes"),
            min_received_at=context.get("started_at"),
            min_email_id=context.get("baseline_email_id"),
            log_fn=self._print,
        )
        if code:
            await self._print(f"[OTP] received code: {code}")
            return code
        await self._print(
            f"[OTP] waiting for OTP email up to {timeout}s; polling mailbox"
        )
        return None

    # ==================== Session / Register Flow ====================

    async def visit_homepage(self):
        url = f"{self.BASE}/"
        r = await self.session.get(
            url,
            headers={
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
                "Upgrade-Insecure-Requests": "1",
            },
            allow_redirects=True,
        )
        await self._log(
            "0. Visit homepage",
            "GET",
            url,
            r.status_code,
            {"cookies_count": len(self.session.cookies)},
        )
        if r.status_code != 200:
            raise Exception(f"Visit homepage failed ({r.status_code})")

    async def get_csrf(self) -> str:
        url = f"{self.BASE}/api/auth/csrf"
        r = await self.session.get(
            url, headers={"Accept": "application/json", "Referer": f"{self.BASE}/"}
        )
        data = self._parse_json_or_raise(r, "Get CSRF")
        token = data.get("csrfToken", "")
        await self._log("1. Get CSRF", "GET", url, r.status_code, data)
        if not token:
            raise Exception("Failed to get CSRF token")
        return token

    async def signin(self, email: str, csrf: str) -> str:
        url = f"{self.BASE}/api/auth/signin/openai"
        params = {
            "prompt": "login",
            "ext-oai-did": self.device_id,
            "auth_session_logging_id": self.auth_session_logging_id,
            "screen_hint": "login_or_signup",
            "login_hint": email,
        }
        form_data = {"callbackUrl": f"{self.BASE}/", "csrfToken": csrf, "json": "true"}
        r = await self.session.post(
            url,
            params=params,
            data=form_data,
            headers={
                "Content-Type": "application/x-www-form-urlencoded",
                "Accept": "application/json",
                "Referer": f"{self.BASE}/",
                "Origin": self.BASE,
            },
        )
        data = self._parse_json_or_raise(r, "Signin")
        authorize_url = data.get("url", "")
        await self._log("2. Signin", "POST", url, r.status_code, data)
        if not authorize_url:
            raise Exception("Failed to get authorize URL")
        return authorize_url

    async def authorize(self, url: str) -> str:
        r = await self.session.get(
            url,
            headers={
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                "Referer": f"{self.BASE}/",
                "Upgrade-Insecure-Requests": "1",
            },
            allow_redirects=True,
        )
        final_url = str(r.url)
        response_excerpt = clean_display_text((r.text or "")[:500]).strip()
        response_headers = {
            key: value
            for key, value in r.headers.items()
            if str(key or "").lower()
            in {
                "content-type",
                "server",
                "cf-ray",
                "set-cookie",
                "location",
                "cache-control",
            }
        }
        await self._log(
            "3. Authorize",
            "GET",
            url,
            r.status_code,
            {
                "final_url": final_url,
                "headers": response_headers,
                "response_excerpt": response_excerpt,
            },
        )
        if r.status_code >= 400:
            error_code = f"http_{r.status_code}"
            error_message = f"authorize failed with HTTP {r.status_code}"
            lowered_excerpt = response_excerpt.lower()
            if (
                "just a moment" in lowered_excerpt
                or "enable javascript and cookies to continue" in lowered_excerpt
                or "_cf_chl_opt" in lowered_excerpt
            ):
                error_code = "cloudflare_challenge"
                error_message = "Cloudflare challenge blocked authorize request"
            self.last_protocol_error = {
                "stage": "authorize",
                "code": error_code,
                "message": error_message,
                "status_code": r.status_code,
                "response_excerpt": response_excerpt,
            }
            raise Exception(f"Authorize failed ({r.status_code})")
        return final_url

    async def register(self, email: str, password: str):
        url = f"{self.AUTH}/api/accounts/user/register"
        headers = {
            "Content-Type": "application/json",
            "Accept": "application/json",
            "Referer": f"{self.AUTH}/create-account/password",
            "Origin": self.AUTH,
        }
        headers.update(_make_trace_headers())
        r = await self.session.post(
            url, json={"username": email, "password": password}, headers=headers
        )
        try:
            data = r.json()
        except Exception:
            data = {"text": r.text[:500]}
        await self._log("4. Register", "POST", url, r.status_code, data)
        return r.status_code, data

    async def send_otp(self):
        url = f"{self.AUTH}/api/accounts/email-otp/send"
        r = await self.session.get(
            url,
            headers={
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                "Referer": f"{self.AUTH}/create-account/password",
                "Upgrade-Insecure-Requests": "1",
            },
            allow_redirects=True,
        )
        try:
            data = r.json()
        except Exception:
            data = {"final_url": str(r.url), "status": r.status_code}
        await self._log("5. Send OTP", "GET", url, r.status_code, data)
        return r.status_code, data

    async def validate_otp(self, code: str):
        url = f"{self.AUTH}/api/accounts/email-otp/validate"
        headers = {
            "Content-Type": "application/json",
            "Accept": "application/json",
            "Referer": f"{self.AUTH}/email-verification",
            "Origin": self.AUTH,
        }
        headers.update(_make_trace_headers())
        r = await self.session.post(url, json={"code": code}, headers=headers)
        try:
            data = r.json()
        except Exception:
            data = {"text": r.text[:500]}
        await self._log("6. Validate OTP", "POST", url, r.status_code, data)
        return r.status_code, data

    async def create_account(self, name: str, birthdate: str):
        url = f"{self.AUTH}/api/accounts/create_account"
        headers = {
            "Content-Type": "application/json",
            "Accept": "application/json",
            "Referer": f"{self.AUTH}/about-you",
            "Origin": self.AUTH,
        }
        headers.update(_make_trace_headers())
        r = await self.session.post(
            url, json={"name": name, "birthdate": birthdate}, headers=headers
        )
        try:
            data = r.json()
        except Exception:
            data = {"text": r.text[:500]}
        await self._log("7. Create Account", "POST", url, r.status_code, data)
        if isinstance(data, dict):
            cb = data.get("continue_url") or data.get("url") or data.get("redirect_url")
            if cb:
                self._callback_url = cb
        return r.status_code, data

    async def callback(self, url: str = None):
        if not url:
            url = self._callback_url
        if not url:
            await self._print("[!] No callback URL, skipping.")
            return None, None

        # Retry once for occasional callback empty-reply / transient network failures.
        for i in range(2):
            try:
                r = await self.session.get(
                    url,
                    headers={
                        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                        "Upgrade-Insecure-Requests": "1",
                    },
                    allow_redirects=True,
                    timeout=30,
                )
                await self._log(
                    "8. Callback", "GET", url, r.status_code, {"final_url": str(r.url)}
                )
                return r.status_code, {"final_url": str(r.url)}
            except Exception as e:
                if i == 0:
                    await self._print(
                        f"[Callback] transient failure, retrying once: {e}"
                    )
                    await asyncio.sleep(2)
                else:
                    raise e

    # ==================== Main Register Flow ====================

    async def run_register(self, email, password, name, birthdate, mail_token):
        """Doc."""
        otp_context = (
            await self.create_otp_wait_context(mail_token) if mail_token else None
        )
        await self.visit_homepage()
        await _random_delay(0.3, 0.8)
        csrf = await self.get_csrf()
        await _random_delay(0.2, 0.5)
        auth_url = await self.signin(email, csrf)
        await _random_delay(0.3, 0.8)

        final_url = await self.authorize(auth_url)
        final_path = urlparse(final_url).path
        await _random_delay(0.3, 0.8)

        await self._print(f"[Auth] authorize path: {final_path}")

        need_otp = False

        if "create-account/password" in final_path:
            await self._print("[Auth] reached an unsupported auth step")
            await _random_delay(0.5, 1.0)
            status, data = await self.register(email, password)
            if status != 200:
                raise Exception(f"Register failed ({status}): {data}")
            # Account registration succeeded; send OTP and continue with verification.
            await _random_delay(0.3, 0.8)
            await self.send_otp()
            need_otp = True
        elif "email-verification" in final_path or "email-otp" in final_path:
            await self._print(
                "[OTP] authorize already reached email verification; waiting for OTP"
            )
            # Some flows reach email-verification directly from authorize without an explicit send_otp step.
            need_otp = True
        elif "about-you" in final_path:
            await self._print("[OTP] OTP validation failed during authorize flow")
            await _random_delay(0.5, 1.0)
            await self.create_account(name, birthdate)
            await _random_delay(0.3, 0.5)
            await self.callback()
            return True
        elif "callback" in final_path or "chatgpt.com" in final_url:
            await self._print("[Auth] callback/chatgpt final URL reached")
            return True
        else:
            await self._print(
                f"[Auth] unexpected final URL, falling back to register+otp: {final_url}"
            )
            await self.register(email, password)
            await self.send_otp()
            need_otp = True

        if need_otp:
            otp_deadline = time.time() + 120
            status, data = 0, {}
            while time.time() < otp_deadline:
                otp_code = await self.wait_for_verification_email(
                    mail_token,
                    timeout=max(1, int(otp_deadline - time.time())),
                    otp_context=otp_context,
                    exclude_codes=(otp_context or {}).get("tried_codes"),
                )
                if not otp_code:
                    break

                if otp_context is not None:
                    otp_context.setdefault("tried_codes", set()).add(otp_code)

                await _random_delay(0.3, 0.8)
                status, data = await self.validate_otp(otp_code)
                if status == 200:
                    break

                error_code, error_message = self._extract_error_info(data)
                if (
                    error_code == "wrong_email_otp_code"
                    or "wrong code" in error_message.lower()
                ):
                    await self._print(
                        "[OTP] wrong_email_otp_code; re-sending OTP and waiting again..."
                    )
                    await self.send_otp()
                    await _random_delay(1.0, 2.0)
                    continue

                raise Exception(f"OTP validation request failed ({status}): {data}")

            if status != 200:
                raise Exception(
                    f"OTP validation failed ({status}): {data or 'OTP validation returned no payload'}"
                )

        await _random_delay(0.5, 1.5)
        status, data = await self.create_account(name, birthdate)
        if status != 200:
            raise Exception(f"Create account failed ({status}): {data}")
        await _random_delay(0.2, 0.5)
        await self.callback()
        return True

    def _decode_oauth_session_cookie(self):
        jar = getattr(self.session.cookies, "jar", None)
        if jar is not None:
            cookie_items = list(jar)
        else:
            cookie_items = []

        for c in cookie_items:
            name = getattr(c, "name", "") or ""
            if "oai-client-auth-session" not in name:
                continue

            raw_val = (getattr(c, "value", "") or "").strip()
            if not raw_val:
                continue

            candidates = [raw_val]
            try:
                from urllib.parse import unquote

                decoded = unquote(raw_val)
                if decoded != raw_val:
                    candidates.append(decoded)
            except Exception:
                pass

            for val in candidates:
                try:
                    if (val.startswith('"') and val.endswith('"')) or (
                        val.startswith("'") and val.endswith("'")
                    ):
                        val = val[1:-1]

                    part = val.split(".")[0] if "." in val else val
                    pad = 4 - len(part) % 4
                    if pad != 4:
                        part += "=" * pad
                    raw = base64.urlsafe_b64decode(part)
                    data = json.loads(raw.decode("utf-8"))
                    if isinstance(data, dict):
                        return data
                except Exception:
                    continue
        return None

    async def _oauth_allow_redirect_extract_code(self, url: str, referer: str = None):
        headers = {
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Upgrade-Insecure-Requests": "1",
            "User-Agent": self.ua,
        }
        if referer:
            headers["Referer"] = referer

        try:
            resp = await self.session.get(
                url,
                headers=headers,
                allow_redirects=True,
                timeout=30,
                impersonate=self.impersonate,
            )
            final_url = str(resp.url)
            code = _extract_code_from_url(final_url)
            if code:
                await self._print(
                    "[OAuth] allow_redirect extracted code from final URL"
                )
                return code

            for r in getattr(resp, "history", []) or []:
                loc = r.headers.get("Location", "")
                code = _extract_code_from_url(loc)
                if code:
                    await self._print(
                        "[OAuth] allow_redirect extracted code from history Location"
                    )
                    return code
                code = _extract_code_from_url(str(r.url))
                if code:
                    await self._print(
                        "[OAuth] allow_redirect extracted code from history URL"
                    )
                    return code
        except Exception as e:
            maybe_localhost = re.search(r"(https?://localhost[^\s\'\"]+)", str(e))
            if maybe_localhost:
                code = _extract_code_from_url(maybe_localhost.group(1))
                if code:
                    await self._print(
                        "[OAuth] allow_redirect extracted code from localhost callback"
                    )
                    return code
            await self._print(f"[OAuth] allow_redirect failed: {e}")

        return None

    async def _oauth_follow_for_code(
        self, start_url: str, referer: str = None, max_hops: int = 16
    ):
        headers = {
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Upgrade-Insecure-Requests": "1",
            "User-Agent": self.ua,
        }
        if referer:
            headers["Referer"] = referer

        current_url = start_url
        last_url = start_url

        for hop in range(max_hops):
            try:
                resp = await self.session.get(
                    current_url,
                    headers=headers,
                    allow_redirects=False,
                    timeout=30,
                    impersonate=self.impersonate,
                )
            except Exception as e:
                maybe_localhost = re.search(r"(https?://localhost[^\s\'\"]+)", str(e))
                if maybe_localhost:
                    code = _extract_code_from_url(maybe_localhost.group(1))
                    if code:
                        await self._print(
                            f"[OAuth] follow[{hop + 1}] captured localhost callback URL"
                        )
                        return code, maybe_localhost.group(1)
                await self._print(f"[OAuth] follow[{hop + 1}] request failed: {e}")
                return None, last_url

            last_url = str(resp.url)
            await self._print(
                f"[OAuth] follow[{hop + 1}] {resp.status_code} {last_url[:140]}"
            )
            code = _extract_code_from_url(last_url)
            if code:
                return code, last_url

            if resp.status_code in (301, 302, 303, 307, 308):
                loc = resp.headers.get("Location", "")
                if not loc:
                    return None, last_url
                if loc.startswith("/"):
                    loc = f"{OAUTH_ISSUER}{loc}"
                code = _extract_code_from_url(loc)
                if code:
                    return code, loc
                current_url = loc
                headers["Referer"] = last_url
                continue

            return None, last_url

        return None, last_url

    async def _oauth_submit_workspace_and_org(self, consent_url: str):
        session_data = self._decode_oauth_session_cookie()
        if not session_data:
            jar = getattr(self.session.cookies, "jar", None)
            if jar is not None:
                cookie_names = [getattr(c, "name", "") for c in list(jar)]
            else:
                cookie_names = list(self.session.cookies.keys())
            await self._print(
                f"[OAuth] missing oai-client-auth-session cookie, cookies={cookie_names[:12]}"
            )
            return None

        workspaces = session_data.get("workspaces", [])
        if not workspaces:
            await self._print(
                "[OAuth] session bootstrap returned workspace information"
            )
            return None

        workspace_id = (workspaces[0] or {}).get("id")
        if not workspace_id:
            await self._print("[OAuth] workspace_id resolved")
            return None

        h = {
            "Accept": "application/json",
            "Content-Type": "application/json",
            "Origin": OAUTH_ISSUER,
            "Referer": consent_url,
            "User-Agent": self.ua,
            "oai-device-id": self.device_id,
        }
        h.update(_make_trace_headers())

        resp = await self.session.post(
            f"{OAUTH_ISSUER}/api/accounts/workspace/select",
            json={"workspace_id": workspace_id},
            headers=h,
            allow_redirects=False,
            timeout=30,
            impersonate=self.impersonate,
        )
        await self._print(f"[OAuth] workspace/select -> {resp.status_code}")

        if resp.status_code in (301, 302, 303, 307, 308):
            loc = resp.headers.get("Location", "")
            if loc.startswith("/"):
                loc = f"{OAUTH_ISSUER}{loc}"
            code = _extract_code_from_url(loc)
            if code:
                return code
            code, _ = await self._oauth_follow_for_code(loc, referer=consent_url)
            if not code:
                code = await self._oauth_allow_redirect_extract_code(
                    loc, referer=consent_url
                )
            return code

        if resp.status_code != 200:
            await self._print(f"[OAuth] workspace/select failed: {resp.status_code}")
            return None

        try:
            ws_data = resp.json()
        except Exception:
            await self._print("[OAuth] workspace/select returned non-JSON response")
            return None

        ws_next = ws_data.get("continue_url", "")
        orgs = ws_data.get("data", {}).get("orgs", [])
        ws_page = (ws_data.get("page") or {}).get("type", "")
        await self._print(
            f"[OAuth] workspace/select page={ws_page or '-'} next={(ws_next or '-')[:140]}"
        )

        org_id = None
        project_id = None
        if orgs:
            org_id = (orgs[0] or {}).get("id")
            projects = (orgs[0] or {}).get("projects", [])
            if projects:
                project_id = (projects[0] or {}).get("id")

        if org_id:
            org_body = {"org_id": org_id}
            if project_id:
                org_body["project_id"] = project_id

            h_org = dict(h)
            if ws_next:
                h_org["Referer"] = (
                    ws_next
                    if ws_next.startswith("http")
                    else f"{OAUTH_ISSUER}{ws_next}"
                )

            resp_org = await self.session.post(
                f"{OAUTH_ISSUER}/api/accounts/organization/select",
                json=org_body,
                headers=h_org,
                allow_redirects=False,
                timeout=30,
                impersonate=self.impersonate,
            )
            await self._print(f"[OAuth] organization/select -> {resp_org.status_code}")
            if resp_org.status_code in (301, 302, 303, 307, 308):
                loc = resp_org.headers.get("Location", "")
                if loc.startswith("/"):
                    loc = f"{OAUTH_ISSUER}{loc}"
                code = _extract_code_from_url(loc)
                if code:
                    return code
                code, _ = await self._oauth_follow_for_code(
                    loc, referer=h_org.get("Referer")
                )
                if not code:
                    code = await self._oauth_allow_redirect_extract_code(
                        loc, referer=h_org.get("Referer")
                    )
                return code

            if resp_org.status_code == 200:
                try:
                    org_data = resp_org.json()
                except Exception:
                    await self._print(
                        "[OAuth] organization/select returned non-JSON response"
                    )
                    return None

                org_next = org_data.get("continue_url", "")
                org_page = (org_data.get("page") or {}).get("type", "")
                await self._print(
                    f"[OAuth] organization/select page={org_page or '-'} next={(org_next or '-')[:140]}"
                )
                if org_next:
                    if org_next.startswith("/"):
                        org_next = f"{OAUTH_ISSUER}{org_next}"
                    code, _ = await self._oauth_follow_for_code(
                        org_next, referer=h_org.get("Referer")
                    )
                    if not code:
                        code = await self._oauth_allow_redirect_extract_code(
                            org_next, referer=h_org.get("Referer")
                        )
                    return code

        if ws_next:
            if ws_next.startswith("/"):
                ws_next = f"{OAUTH_ISSUER}{ws_next}"
            code, _ = await self._oauth_follow_for_code(ws_next, referer=consent_url)
            if not code:
                code = await self._oauth_allow_redirect_extract_code(
                    ws_next, referer=consent_url
                )
            return code

        return None

    async def perform_codex_oauth_login_http(
        self, email: str, password: str, mail_token: str = None
    ):
        excerpt_limit = 2000 if self.debug else 500
        self.last_protocol_error = {
            "code": "",
            "message": "",
            "stage": "",
            "status_code": None,
            "response_excerpt": "",
        }

        def _remember_protocol_error(
            stage: str,
            code: str = "",
            message: str = "",
            status_code=None,
            response_excerpt: str = "",
        ):
            self.last_protocol_error = {
                "code": str(code or "").strip(),
                "message": clean_display_text(str(message or "").strip())[
                    :excerpt_limit
                ],
                "stage": stage,
                "status_code": status_code,
                "response_excerpt": clean_display_text(
                    str(response_excerpt or "").strip()
                )[:excerpt_limit],
            }

        def _cookie_names(limit: int = 12):
            jar = getattr(self.session.cookies, "jar", None)
            if jar is not None:
                try:
                    return [getattr(c, "name", "") for c in list(jar)[:limit]]
                except Exception:
                    return []
            try:
                return list(self.session.cookies.keys())[:limit]
            except Exception:
                return []

        def _has_cookie(cookie_name: str) -> bool:
            jar = getattr(self.session.cookies, "jar", None)
            if jar is not None:
                try:
                    return any(getattr(c, "name", "") == cookie_name for c in list(jar))
                except Exception:
                    pass
            try:
                return cookie_name in self.session.cookies.keys()
            except Exception:
                return cookie_name in _cookie_names(limit=50)

        def _response_excerpt(resp) -> str:
            if resp is None:
                return ""
            try:
                data = resp.json()
            except Exception:
                return clean_display_text(resp.text[:excerpt_limit])

            if isinstance(data, dict):
                err_code, err_message = self._extract_error_info(data)
                if err_code or err_message:
                    return clean_display_text(
                        " / ".join(part for part in (err_code, err_message) if part)
                    )[:excerpt_limit]
                return clean_display_text(json.dumps(data, ensure_ascii=False))[
                    :excerpt_limit
                ]

            return clean_display_text(str(data))[:excerpt_limit]

        await self._print("[OAuth] starting Codex OAuth flow...")
        otp_context = (
            await self.create_otp_wait_context(mail_token) if mail_token else None
        )

        # Seed auth.openai.com with oai-did on both cookie domains.
        self.session.cookies.set("oai-did", self.device_id, domain=".auth.openai.com")
        self.session.cookies.set("oai-did", self.device_id, domain="auth.openai.com")

        code_verifier, code_challenge = _generate_pkce()
        state = secrets.token_urlsafe(24)

        authorize_params = {
            "response_type": "code",
            "client_id": OAUTH_CLIENT_ID,
            "redirect_uri": OAUTH_REDIRECT_URI,
            "scope": "openid profile email offline_access",
            "code_challenge": code_challenge,
            "code_challenge_method": "S256",
            "state": state,
        }
        authorize_url = f"{OAUTH_ISSUER}/oauth/authorize?{urlencode(authorize_params)}"

        def _oauth_json_headers(referer: str):
            h = {
                "Accept": "application/json",
                "Content-Type": "application/json",
                "Origin": OAUTH_ISSUER,
                "Referer": referer,
                "User-Agent": self.ua,
                "oai-device-id": self.device_id,
            }
            h.update(_make_trace_headers())
            return h

        async def _bootstrap_oauth_session():
            primary_resp = None
            fallback_resp = None
            self._print("[OAuth] 1/7 GET /oauth/authorize")
            try:
                r = await self.session.get(
                    authorize_url,
                    headers={
                        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                        "Referer": f"{self.BASE}/",
                        "Upgrade-Insecure-Requests": "1",
                        "User-Agent": self.ua,
                    },
                    allow_redirects=True,
                    timeout=30,
                    impersonate=self.impersonate,
                )
            except Exception as e:
                await self._print(f"[OAuth] /oauth/authorize request failed: {e}")
                _remember_protocol_error(
                    "oauth_bootstrap", code="authorize_request_failed", message=str(e)
                )
                return False, "", False

            primary_resp = r
            final_url = str(r.url)
            redirects = len(getattr(r, "history", []) or [])
            await self._print(
                f"[OAuth] /oauth/authorize -> {r.status_code}, final={(final_url or '-')[:140]}, redirects={redirects}"
            )

            has_login = _has_cookie("login_session")
            await self._print(
                f"[OAuth] login_session: {'present' if has_login else 'missing'} / cookies={_cookie_names()}"
            )

            if not has_login:
                await self._print(
                    "[OAuth] login_session missing; retrying oauth2 auth bootstrap"
                )
                oauth2_url = f"{OAUTH_ISSUER}/api/oauth/oauth2/auth"
                try:
                    r2 = await self.session.get(
                        oauth2_url,
                        headers={
                            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                            "Referer": authorize_url,
                            "Upgrade-Insecure-Requests": "1",
                            "User-Agent": self.ua,
                        },
                        params=authorize_params,
                        allow_redirects=True,
                        timeout=30,
                        impersonate=self.impersonate,
                    )
                    fallback_resp = r2
                    final_url = str(r2.url)
                    redirects2 = len(getattr(r2, "history", []) or [])
                    await self._print(
                        f"[OAuth] /api/oauth/oauth2/auth -> {r2.status_code}, final={(final_url or '-')[:140]}, redirects={redirects2}"
                    )
                except Exception as e:
                    await self._print(
                        f"[OAuth] /api/oauth/oauth2/auth request failed: {e}"
                    )
                    _remember_protocol_error(
                        "oauth_bootstrap", code="oauth2_auth_failed", message=str(e)
                    )

                has_login = _has_cookie("login_session")
                await self._print(
                    f"[OAuth] login_session(after fallback): {'present' if has_login else 'missing'} / cookies={_cookie_names()}"
                )

            effective_resp = fallback_resp or primary_resp
            bootstrap_ok = (
                bool(effective_resp)
                and int(getattr(effective_resp, "status_code", 0) or 0) < 400
                and str(final_url or "").startswith(OAUTH_ISSUER)
            )
            if not bootstrap_ok:
                await self._print(
                    "[OAuth] bootstrap unusable; skipping authorize/continue"
                )
                _remember_protocol_error(
                    "oauth_bootstrap",
                    code=f"http_{getattr(effective_resp, 'status_code', 'bootstrap_failed')}",
                    message=f"OAuth bootstrap failed with HTTP {getattr(effective_resp, 'status_code', 'unknown')}",
                    status_code=getattr(effective_resp, "status_code", None),
                    response_excerpt=_response_excerpt(effective_resp),
                )
            return has_login, final_url, bootstrap_ok

        async def _post_authorize_continue(referer_url: str):
            sentinel_error = {}
            sentinel_authorize = await build_sentinel_token(
                self.session,
                self.device_id,
                flow="authorize_continue",
                user_agent=self.ua,
                sec_ch_ua=self.sec_ch_ua,
                impersonate=self.impersonate,
                error_sink=sentinel_error,
            )
            if not sentinel_authorize:
                await self._print("[OAuth] authorize_continue sentinel token missing")
                _remember_protocol_error(
                    "authorize_continue_sentinel",
                    code=sentinel_error.get("code") or "sentinel_token_missing",
                    message=sentinel_error.get("message")
                    or "Failed to build sentinel token for authorize_continue",
                    status_code=sentinel_error.get("status_code"),
                )
                return None

            headers_continue = _oauth_json_headers(referer_url)
            headers_continue["openai-sentinel-token"] = sentinel_authorize

            try:
                return await self.session.post(
                    f"{OAUTH_ISSUER}/api/accounts/authorize/continue",
                    json={"username": {"kind": "email", "value": email}},
                    headers=headers_continue,
                    timeout=30,
                    allow_redirects=False,
                    impersonate=self.impersonate,
                )
            except Exception as e:
                await self._print(f"[OAuth] authorize/continue request failed: {e}")
                _remember_protocol_error(
                    "authorize_continue",
                    code="authorize_continue_request_failed",
                    message=str(e),
                )
                return None

        (
            has_login_session,
            authorize_final_url,
            bootstrap_ok,
        ) = await _bootstrap_oauth_session()
        if not authorize_final_url or not bootstrap_ok:
            if (
                bootstrap_ok is False
                and (self.last_protocol_error or {}).get("stage") == "oauth_bootstrap"
            ):
                return None
            if not (self.last_protocol_error or {}).get("stage"):
                _remember_protocol_error(
                    "oauth_bootstrap",
                    code="bootstrap_url_missing",
                    message="OAuth bootstrap did not produce a usable final URL",
                )
            return None

        continue_referer = (
            authorize_final_url
            if authorize_final_url.startswith(OAUTH_ISSUER)
            else f"{OAUTH_ISSUER}/log-in"
        )

        await self._print("[OAuth] 2/7 POST /api/accounts/authorize/continue")
        resp_continue = await _post_authorize_continue(continue_referer)
        if resp_continue is None:
            return None

        await self._print(f"[OAuth] /authorize/continue -> {resp_continue.status_code}")
        if resp_continue.status_code == 400 and "invalid_auth_step" in (
            resp_continue.text or ""
        ):
            await self._print(
                "[OAuth] invalid_auth_step; retrying bootstrap via authorize"
            )
            has_login_session, authorize_final_url, bootstrap_ok = (
                _bootstrap_oauth_session()
            )
            if not authorize_final_url or not bootstrap_ok:
                return None
            continue_referer = (
                authorize_final_url
                if authorize_final_url.startswith(OAUTH_ISSUER)
                else f"{OAUTH_ISSUER}/log-in"
            )
            resp_continue = await _post_authorize_continue(continue_referer)
            if resp_continue is None:
                return None
            await self._print(
                f"[OAuth] /authorize/continue(retry) -> {resp_continue.status_code}"
            )

        if resp_continue.status_code != 200:
            await self._print(
                f"[OAuth] authorize/continue failed body: {resp_continue.text[:180]}"
            )
            try:
                continue_error = resp_continue.json()
            except Exception:
                continue_error = {}
            error_code, error_message = self._extract_error_info(continue_error)
            _remember_protocol_error(
                "authorize_continue",
                code=error_code or f"http_{resp_continue.status_code}",
                message=error_message
                or f"authorize_continue failed with HTTP {resp_continue.status_code}",
                status_code=resp_continue.status_code,
                response_excerpt=_response_excerpt(resp_continue),
            )
            return None

        try:
            continue_data = resp_continue.json()
        except Exception:
            await self._print(
                "[OAuth] authorize/continue response could not be parsed cleanly"
            )
            _remember_protocol_error(
                "authorize_continue",
                code="authorize_continue_parse_failed",
                message="authorize_continue response could not be parsed as JSON",
                status_code=resp_continue.status_code,
                response_excerpt=_response_excerpt(resp_continue),
            )
            return None

        continue_url = continue_data.get("continue_url", "")
        page_type = (continue_data.get("page") or {}).get("type", "")
        await self._print(
            f"[OAuth] continue page={page_type or '-'} next={(continue_url or '-')[:140]}"
        )

        await self._print("[OAuth] 3/7 POST /api/accounts/password/verify")
        sentinel_pwd_error = {}
        sentinel_pwd = await build_sentinel_token(
            self.session,
            self.device_id,
            flow="password_verify",
            user_agent=self.ua,
            sec_ch_ua=self.sec_ch_ua,
            impersonate=self.impersonate,
            error_sink=sentinel_pwd_error,
        )
        if not sentinel_pwd:
            await self._print("[OAuth] password_verify sentinel token missing")
            _remember_protocol_error(
                "password_verify_sentinel",
                code=sentinel_pwd_error.get("code") or "sentinel_token_missing",
                message=sentinel_pwd_error.get("message")
                or "Failed to build sentinel token for password_verify",
                status_code=sentinel_pwd_error.get("status_code"),
            )
            return None

        headers_verify = _oauth_json_headers(f"{OAUTH_ISSUER}/log-in/password")
        headers_verify["openai-sentinel-token"] = sentinel_pwd

        try:
            resp_verify = await self.session.post(
                f"{OAUTH_ISSUER}/api/accounts/password/verify",
                json={"password": password},
                headers=headers_verify,
                timeout=30,
                allow_redirects=False,
                impersonate=self.impersonate,
            )
        except Exception as e:
            await self._print(f"[OAuth] password/verify request failed: {e}")
            _remember_protocol_error(
                "password_verify", code="password_verify_request_failed", message=str(e)
            )
            return None

        await self._print(f"[OAuth] /password/verify -> {resp_verify.status_code}")
        if resp_verify.status_code != 200:
            await self._print(
                f"[OAuth] password/verify failed body: {resp_verify.text[:180]}"
            )
            try:
                verify_error = resp_verify.json()
            except Exception:
                verify_error = {}
            error_code, error_message = self._extract_error_info(verify_error)
            _remember_protocol_error(
                "password_verify",
                code=error_code or f"http_{resp_verify.status_code}",
                message=error_message
                or f"password_verify failed with HTTP {resp_verify.status_code}",
                status_code=resp_verify.status_code,
                response_excerpt=_response_excerpt(resp_verify),
            )
            return None

        try:
            verify_data = resp_verify.json()
        except Exception:
            await self._print(
                "[OAuth] password/verify response could not be parsed cleanly"
            )
            _remember_protocol_error(
                "password_verify",
                code="password_verify_parse_failed",
                message="password_verify response could not be parsed as JSON",
                status_code=resp_verify.status_code,
                response_excerpt=_response_excerpt(resp_verify),
            )
            return None

        continue_url = verify_data.get("continue_url", "") or continue_url
        page_type = (verify_data.get("page") or {}).get("type", "") or page_type
        await self._print(
            f"[OAuth] verify page={page_type or '-'} next={(continue_url or '-')[:140]}"
        )

        need_oauth_otp = (
            page_type == "email_otp_verification"
            or "email-verification" in (continue_url or "")
            or "email-otp" in (continue_url or "")
        )

        if need_oauth_otp:
            await self._print("[OAuth] 4/7 waiting for OAuth OTP email")
            if not mail_token:
                await self._print(
                    "[OAuth] OAuth OTP requires a mail_token mailbox identifier"
                )
                _remember_protocol_error(
                    "email_otp",
                    code="otp_missing",
                    message="mail_token missing for protocol OTP flow",
                )
                return None

            headers_otp = _oauth_json_headers(f"{OAUTH_ISSUER}/email-verification")
            tried_codes = set()
            otp_success = False
            otp_deadline = time.time() + 120

            while time.time() < otp_deadline and not otp_success:
                code = await self.wait_for_verification_email(
                    mail_token,
                    timeout=max(1, int(otp_deadline - time.time())),
                    otp_context=otp_context,
                    exclude_codes=tried_codes,
                )
                if not code:
                    break

                tried_codes.add(code)
                if otp_context is not None:
                    otp_context.setdefault("tried_codes", set()).add(code)
                await self._print(f"[OAuth] received OTP: {code}")
                try:
                    resp_otp = await self.session.post(
                        f"{OAUTH_ISSUER}/api/accounts/email-otp/validate",
                        json={"code": code},
                        headers=headers_otp,
                        timeout=30,
                        allow_redirects=False,
                        impersonate=self.impersonate,
                    )
                except Exception as e:
                    await self._print(f"[OAuth] email-otp/validate request failed: {e}")
                    _remember_protocol_error(
                        "email_otp_validate",
                        code="email_otp_request_failed",
                        message=str(e),
                    )
                    continue

                await self._print(
                    f"[OAuth] /email-otp/validate -> {resp_otp.status_code}"
                )
                if resp_otp.status_code != 200:
                    otp_error = {}
                    try:
                        otp_error = resp_otp.json()
                    except Exception:
                        otp_error = {}
                    error_block = (
                        otp_error.get("error")
                        if isinstance(otp_error.get("error"), dict)
                        else {}
                    )
                    error_code = str(
                        error_block.get("code") or otp_error.get("code") or ""
                    ).strip()
                    error_message = str(
                        error_block.get("message")
                        or otp_error.get("message")
                        or resp_otp.text[:500]
                    ).strip()
                    if error_code or error_message:
                        _remember_protocol_error(
                            "email_otp_validate",
                            code=error_code,
                            message=error_message,
                            status_code=resp_otp.status_code,
                            response_excerpt=_response_excerpt(resp_otp),
                        )
                    await self._print(
                        f"[OAuth] OTP validation failed body: {resp_otp.text[:160]}"
                    )
                    if error_code in {"account_deactivated", "max_check_attempts"}:
                        await self._print(f"[OAuth] OTP terminal error: {error_code}")
                        break
                    if (
                        error_code == "wrong_email_otp_code"
                        or "wrong code" in error_message.lower()
                    ):
                        await self._print(
                            "[OAuth] wrong_email_otp_code; waiting for a new OTP..."
                        )
                    await asyncio.sleep(2)
                    continue

                try:
                    otp_data = resp_otp.json()
                except Exception:
                    await self._print(
                        "[OAuth] email-otp/validate response parse failed"
                    )
                    _remember_protocol_error(
                        "email_otp_validate",
                        code="email_otp_parse_failed",
                        message="email_otp validation response could not be parsed as JSON",
                        status_code=resp_otp.status_code,
                        response_excerpt=_response_excerpt(resp_otp),
                    )
                    await asyncio.sleep(2)
                    continue

                continue_url = otp_data.get("continue_url", "") or continue_url
                page_type = (otp_data.get("page") or {}).get("type", "") or page_type
                await self._print(
                    f"[OAuth] OTP verified page={page_type or '-'} next={(continue_url or '-')[:140]}"
                )
                otp_success = True
                break

            if not otp_success:
                await self._print(
                    f"[OAuth] OAuth OTP validation failed after {len(tried_codes)} attempts"
                )
                if not (self.last_protocol_error or {}).get("stage"):
                    _remember_protocol_error(
                        "email_otp_validate",
                        code="otp_validation_failed",
                        message=f"OAuth OTP validation failed after {len(tried_codes)} attempts",
                    )
                return None

        code = None
        consent_url = continue_url
        if consent_url and consent_url.startswith("/"):
            consent_url = f"{OAUTH_ISSUER}{consent_url}"

        if not consent_url and "consent" in page_type:
            consent_url = f"{OAUTH_ISSUER}/sign-in-with-chatgpt/codex/consent"

        if consent_url:
            code = _extract_code_from_url(consent_url)

        if not code and consent_url:
            await self._print(
                "[OAuth] 5/7 follow continue_url to resolve authorization code"
            )
            code, _ = await self._oauth_follow_for_code(
                consent_url, referer=f"{OAUTH_ISSUER}/log-in/password"
            )

        consent_hint = (
            ("consent" in (consent_url or ""))
            or ("sign-in-with-chatgpt" in (consent_url or ""))
            or ("workspace" in (consent_url or ""))
            or ("organization" in (consent_url or ""))
            or ("consent" in page_type)
            or ("organization" in page_type)
        )

        if not code and consent_hint:
            if not consent_url:
                consent_url = f"{OAUTH_ISSUER}/sign-in-with-chatgpt/codex/consent"
            await self._print("[OAuth] 6/7 handling workspace/org selection")
            code = await self._oauth_submit_workspace_and_org(consent_url)

        if not code:
            fallback_consent = f"{OAUTH_ISSUER}/sign-in-with-chatgpt/codex/consent"
            await self._print("[OAuth] 6/7 falling back to consent path")
            code = await self._oauth_submit_workspace_and_org(fallback_consent)
            if not code:
                code, _ = await self._oauth_follow_for_code(
                    fallback_consent, referer=f"{OAUTH_ISSUER}/log-in/password"
                )

        if not code:
            await self._print("[OAuth] missing authorization code")
            _remember_protocol_error(
                "authorization_code",
                code="authorization_code_missing",
                message="Authorization code not resolved",
            )
            return None

        await self._print("[OAuth] 7/7 POST /oauth/token")
        token_resp = await self.session.post(
            f"{OAUTH_ISSUER}/oauth/token",
            headers={
                "Content-Type": "application/x-www-form-urlencoded",
                "User-Agent": self.ua,
            },
            data={
                "grant_type": "authorization_code",
                "code": code,
                "redirect_uri": OAUTH_REDIRECT_URI,
                "client_id": OAUTH_CLIENT_ID,
                "code_verifier": code_verifier,
            },
            timeout=60,
            impersonate=self.impersonate,
        )
        await self._print(f"[OAuth] /oauth/token -> {token_resp.status_code}")

        if token_resp.status_code != 200:
            await self._print(
                f"[OAuth] token request failed: {token_resp.status_code} {token_resp.text[:200]}"
            )
            try:
                token_error = token_resp.json()
            except Exception:
                token_error = {}
            error_code, error_message = self._extract_error_info(token_error)
            _remember_protocol_error(
                "oauth_token",
                code=error_code or f"http_{token_resp.status_code}",
                message=error_message
                or f"oauth/token failed with HTTP {token_resp.status_code}",
                status_code=token_resp.status_code,
                response_excerpt=_response_excerpt(token_resp),
            )
            return None

        try:
            data = token_resp.json()
        except Exception:
            await self._print("[OAuth] token response parse failed")
            _remember_protocol_error(
                "oauth_token",
                code="oauth_token_parse_failed",
                message="OAuth token response could not be parsed as JSON",
                status_code=token_resp.status_code,
                response_excerpt=_response_excerpt(token_resp),
            )
            return None

        if not data.get("access_token"):
            await self._print("[OAuth] token response missing access_token")
            _remember_protocol_error(
                "oauth_token",
                code="access_token_missing",
                message="OAuth token response missing access_token",
            )
            return None

        session_token = self.session.cookies.get("__Secure-next-auth.session-token")
        if session_token:
            data["session_token"] = session_token
            # Shared temp session file removed to avoid cross-account token mix-ups.

        await self._print("[OAuth] Codex token acquired")
        return data


# ==================== Registration Worker ====================


async def _register_one(
    idx,
    total,
    proxy,
    output_file,
    email_provider="mailfree",
    email_domain=None,
    extract_codex=True,
    progress_hook=None,
    use_proxy=True,
    debug=False,
):
    """Doc."""
    pool = _get_proxy_pool(fallback_proxy=proxy) if use_proxy else None
    last_error = "unknown error"
    email = ""

    for attempt in range(1, PROXY_RETRY_ATTEMPTS_PER_ACCOUNT + 1):
        reg = None
        current_proxy = pool.next_proxy() if pool else None
        proxy_label = current_proxy or "direct"
        if callable(progress_hook):
            progress_hook(
                "account_started",
                idx=idx,
                total=total,
                attempt=attempt,
                proxy=proxy_label,
            )

        try:
            reg = ChatGPTRegister(
                proxy=current_proxy,
                fixed_proxy=current_proxy,
                tag=f"{idx}-try{attempt}",
                email_provider=email_provider,
                email_domain=email_domain,
                debug=debug,
            )
            reg.session = reg._make_session()
            await reg._print(
                f"[Proxy] attempt {attempt}/{PROXY_RETRY_ATTEMPTS_PER_ACCOUNT}: {proxy_label}"
            )

            # 1. Create a temporary mailbox.
            reg._print("[DuckMail] creating temporary mailbox...")
            email, email_pwd, mail_token = await reg.create_temp_email()
            tag = email.split("@")[0]
            reg.tag = tag

            chatgpt_password = _generate_password()
            name = _random_name()
            birthdate = _random_birthdate()

            async with _print_lock:
                print(f"\n{'=' * 60}")
                print(f"  [{idx}/{total}] Account: {email}")
                print(f"  ChatGPT password: {chatgpt_password}")
                print(f"  Mailbox password: {email_pwd}")
                print(f"  Profile: {name} | Birthdate: {birthdate}")
                print(f"  Proxy: {proxy_label}")
                print(f"{'=' * 60}")

            # 2. Register account.
            await reg.run_register(email, chatgpt_password, name, birthdate, mail_token)

            # 3. Optionally extract Codex OAuth credentials.
            oauth_ok = not bool(extract_codex)
            if ENABLE_OAUTH and extract_codex:
                await reg._print("[OAuth] extracting Codex token...")
                tokens = await reg.perform_codex_oauth_login_http(
                    email, chatgpt_password, mail_token=mail_token
                )
                oauth_ok = bool(tokens and tokens.get("access_token"))
                if oauth_ok:
                    await _save_codex_tokens(email, tokens)
                    await reg._print("[OAuth] token artifacts persisted")
                else:
                    msg = "OAuth extraction failed"
                    if OAUTH_REQUIRED:
                        await reg._print(
                            f"[OAuth] {msg} (preserving registered account with oauth=fail)"
                        )
                    else:
                        await reg._print(f"[OAuth] {msg} (continuing by config)")
            elif not extract_codex:
                await reg._print(
                    "[OAuth] Codex extraction disabled for this registration batch"
                )

            # 4. Promote working proxy and persist registration metadata.
            if current_proxy and pool:
                pool.report_success(current_proxy)
                await _save_stable_proxy_to_file(current_proxy)
                await _save_stable_proxy_to_config(current_proxy)

            # 5. Persist account credentials.
            async with _file_lock:
                with open(output_file, "a", encoding="utf-8") as out:
                    out.write(
                        f"{email}----{chatgpt_password}----{email_pwd}"
                        f"----oauth={'ok' if oauth_ok else 'fail'}----proxy={proxy_label}\n"
                    )

            async with _print_lock:
                oauth_suffix = " | oauth=ok" if oauth_ok else " | oauth=fail"
                print(
                    f"\n[OK] [{tag}] {email} registered successfully | proxy={proxy_label}{oauth_suffix}"
                )
            if callable(progress_hook):
                progress_hook(
                    "account_succeeded",
                    idx=idx,
                    total=total,
                    attempt=attempt,
                    email=email,
                    proxy=proxy_label,
                    oauth_ok=bool(oauth_ok),
                )
            if reg.session:
                await reg.session.close()
                reg.session = None
            return True, email, None

        except Exception as e:
            last_error = str(e)
            if current_proxy and pool:
                pool.report_bad(current_proxy, error=e)
            if debug:
                async with _print_lock:
                    traceback.print_exc()

            async with _print_lock:
                print(
                    f"\n[FAIL] [{idx}] attempt {attempt}/{PROXY_RETRY_ATTEMPTS_PER_ACCOUNT} "
                    f"failed: {last_error} | proxy={proxy_label}"
                )
            if callable(progress_hook):
                progress_hook(
                    "account_attempt_failed",
                    idx=idx,
                    total=total,
                    attempt=attempt,
                    email=email,
                    proxy=proxy_label,
                    error=last_error,
                    final=attempt >= PROXY_RETRY_ATTEMPTS_PER_ACCOUNT,
                )

            if attempt >= PROXY_RETRY_ATTEMPTS_PER_ACCOUNT:
                async with _print_lock:
                    traceback.print_exc()
                break

    if callable(progress_hook):
        progress_hook(
            "account_failed",
            idx=idx,
            total=total,
            email=email,
            error=last_error,
        )
    return False, None, f"registration failed after proxy retries: {last_error}"


async def _run_batch_async(
    total_accounts: int,
    output_file: str,
    max_workers: int,
    proxy,
    email_provider: str,
    email_domain,
    extract_codex: bool,
    use_proxy: bool,
    progress_hook,
    debug: bool,
    proxy_info: dict,
):
    """真异步批量注册核心：用 asyncio.Semaphore 控制并发数。"""
    actual_workers = min(max_workers, total_accounts)

    sem = asyncio.Semaphore(actual_workers)

    async def _bounded(idx):
        async with sem:
            return await _register_one(
                idx,
                total_accounts,
                proxy,
                output_file,
                email_provider,
                email_domain,
                extract_codex,
                progress_hook,
                use_proxy,
                debug,
            )

    tasks = [asyncio.create_task(_bounded(idx)) for idx in range(1, total_accounts + 1)]
    results = await asyncio.gather(*tasks, return_exceptions=True)

    success_count = 0
    fail_count = 0
    for idx, result in enumerate(results, start=1):
        if isinstance(result, Exception):
            fail_count += 1
            print(f"  [FAIL {idx}] worker crashed: {result}")
        elif isinstance(result, tuple):
            ok, email, err = result
            if ok:
                success_count += 1
            else:
                fail_count += 1
                print(f"  [FAIL {idx}] {err}")
        else:
            fail_count += 1

    return success_count, fail_count


def run_batch(
    total_accounts: int = 3,
    output_file="registered_accounts.txt",
    max_workers=3,
    proxy=None,
    email_provider="mailfree",
    email_domain=None,
    extract_codex=True,
    use_proxy=True,
    progress_hook=None,
    debug=False,
):
    """Doc. 同步入口，内部启动 asyncio 事件循环执行真异步并发注册。"""

    if use_proxy:
        pool = _get_proxy_pool(fallback_proxy=proxy)
        pool.refresh(force=True)
        proxy_info = pool.info()
    else:
        proxy_info = {
            "prefer_stable_proxy": False,
            "validate_enabled": False,
            "count": 0,
            "max_retries_per_request": 0,
            "bad_ttl_seconds": 0,
            "bad_count": 0,
            "fallback_proxy": "",
            "stable_proxy": "",
        }

    actual_workers = min(max_workers, total_accounts)
    if callable(progress_hook):
        progress_hook(
            "batch_started",
            total_accounts=total_accounts,
            workers=actual_workers,
            output_file=output_file,
            email_provider=email_provider,
            email_domain=email_domain,
            extract_codex=bool(extract_codex),
            use_proxy=bool(use_proxy),
            debug=bool(debug),
        )
    print(f"\n{'#' * 60}")
    print("  ChatGPT batch register (DuckMail)")
    print(f"  Total accounts: {total_accounts} | workers: {actual_workers}")
    print(f"  DuckMail: {DUCKMAIL_API_BASE}")
    print(f"  Debug: {'on' if debug else 'off'}")
    print(f"  Concurrency: asyncio.Semaphore({actual_workers}) [真异步并发]")
    print(
        f"  Proxy mode: {'proxy_utils candidate pool (round-robin) with direct fallback' if use_proxy else 'direct (no proxy)'}"
    )
    print(
        f"  Prefer stable proxy: {'on' if proxy_info['prefer_stable_proxy'] else 'off'} (single-proxy fallback only)"
    )
    print(f"  Account retry budget: {PROXY_RETRY_ATTEMPTS_PER_ACCOUNT} per account")
    print(
        f"  Proxy validate config: {'on' if proxy_info['validate_enabled'] else 'off'} (registration now reads configured proxy candidates)"
    )
    print(f"  Configured fallback proxies: {proxy_info['count']}")
    print(f"  Proxy retries per request: {proxy_info['max_retries_per_request']}")
    print(f"  Bad proxy TTL: {proxy_info['bad_ttl_seconds']}s")
    if proxy_info["bad_count"] > 0:
        print(f"  Cooling proxies: {proxy_info['bad_count']}")
    if proxy_info["fallback_proxy"]:
        print(f"  Fallback proxy: {proxy_info['fallback_proxy']}")
    if proxy_info["stable_proxy"]:
        print(f"  Stable proxy: {proxy_info['stable_proxy']}")
    print(f"  Stable proxy file: {_stable_proxy_path()}")
    print(
        f"  OAuth: {'on' if ENABLE_OAUTH else 'off'} | required: {'yes' if OAUTH_REQUIRED else 'no'}"
    )
    if ENABLE_OAUTH:
        print(f"  OAuth Issuer: {OAUTH_ISSUER}")
        print(f"  OAuth Client: {OAUTH_CLIENT_ID}")
        print(f"  Token output: {TOKEN_JSON_DIR}/, {AK_FILE}, {RK_FILE}")
    print(f"  Output file: {output_file}")
    print(f"{'#' * 60}\n")

    start_time = time.time()

    # 启动异步事件循环
    success_count, fail_count = asyncio.run(
        _run_batch_async(
            total_accounts=total_accounts,
            output_file=output_file,
            max_workers=max_workers,
            proxy=proxy,
            email_provider=email_provider,
            email_domain=email_domain,
            extract_codex=bool(extract_codex),
            use_proxy=bool(use_proxy),
            progress_hook=progress_hook,
            debug=bool(debug),
            proxy_info=proxy_info,
        )
    )

    elapsed = time.time() - start_time
    avg = elapsed / total_accounts if total_accounts else 0
    print(f"\n{'#' * 60}")
    print(f"  Total elapsed: {elapsed:.1f}s")
    print(
        f"  Total: {total_accounts} | Success: {success_count} | Failed: {fail_count}"
    )
    print(f"  Average per account: {avg:.1f}s")
    if success_count > 0:
        print(f"  Saved to: {output_file}")
    print(f"{'#' * 60}")
    if callable(progress_hook):
        progress_hook(
            "batch_finished",
            total_accounts=total_accounts,
            success_count=success_count,
            fail_count=fail_count,
            elapsed_seconds=elapsed,
            output_file=output_file,
        )


def main():
    print("=" * 60)
    print("  ChatGPT batch register (DuckMail mailbox)")
    print("=" * 60)

    # Removed DUCKMAIL_BEARER check in main

    env_proxy = (
        os.environ.get("HTTPS_PROXY")
        or os.environ.get("https_proxy")
        or os.environ.get("ALL_PROXY")
        or os.environ.get("all_proxy")
    )
    default_fallback_proxy = _normalize_proxy(DEFAULT_PROXY)
    env_fallback_proxy = _normalize_proxy(env_proxy)
    proxy = default_fallback_proxy or env_fallback_proxy
    proxy_source = (
        "config.json(proxy)"
        if default_fallback_proxy
        else ("env(HTTPS_PROXY/ALL_PROXY)" if env_fallback_proxy else "none")
    )

    print(
        "[Info] Proxy mode: proxy_utils candidate pool (round-robin) with direct fallback"
    )
    print(
        f"[Info] Proxy validation config retained: {'on' if PROXY_VALIDATE_ENABLED else 'off'} | target: {PROXY_VALIDATE_TEST_URL}"
    )
    print(f"[Info] Prefer stable proxy: {'on' if PREFER_STABLE_PROXY else 'off'}")
    print(f"[Info] Retry budget per account: {PROXY_RETRY_ATTEMPTS_PER_ACCOUNT}")
    if proxy:
        print(f"[Info] Using proxy source: {proxy_source} -> {proxy}")
    else:
        print(
            "[Info] No fallback proxy configured; direct session settings will be used"
        )

    # 閺夊牊鎸搁崣鍡椻枖閸炰粙寮导鏉戞
    total_accounts = 100
    max_workers = 10

    run_batch(
        total_accounts=total_accounts,
        output_file=DEFAULT_OUTPUT_FILE,
        max_workers=max_workers,
        proxy=proxy,
    )


if __name__ == "__main__":
    main()
