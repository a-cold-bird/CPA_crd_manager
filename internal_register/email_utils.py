import re
import time
import os
import asyncio
import secrets
from datetime import datetime, timezone

import random
import httpx

import json

# 默认域名邮箱配置
API_BASE = "REDACTED_BASE"
USERNAME = ""
PASSWORD = ""
DUCKMAIL_API_BASE = "https://api.duckmail.sbs"
DUCKMAIL_BEARER = ""
DUCKMAIL_DOMAINS = ["duckmail.sbs"]
EMAIL_DOMAIN = "REDACTED_DOMAIN"
EMAIL_DOMAINS = [EMAIL_DOMAIN]
EMAIL_PROVIDERS = {}


def _normalize_domain_list(value):
    if isinstance(value, (list, tuple, set)):
        raw_items = value
    else:
        raw_items = str(value or "").replace("\r", "\n").replace(",", "\n").split("\n")
    domains = []
    for item in raw_items:
        domain = str(item or "").strip().lower().lstrip("@")
        if domain and domain not in domains:
            domains.append(domain)
    return domains


def _provider_mode(provider_config):
    mode = str((provider_config or {}).get("mode") or "").strip().lower()
    if mode:
        return mode
    if str((provider_config or {}).get("id") or "").strip().lower() == "duckmail":
        return "duckmail"
    api_base = str((provider_config or {}).get("api_base") or "").strip().lower()
    if "duckmail" in api_base:
        return "duckmail"
    if (
        "/api/v1/" in api_base
        or "inbucket" in api_base
        or "mailapizv.uton.me" in api_base
    ):
        return "inbucket"
    return "mailfree"


def _expand_domain_pattern(domain_pattern, local_part):
    domain_value = str(domain_pattern or "").strip().lower().lstrip("@")
    if domain_value.startswith("*."):
        return f"{local_part}.{domain_value[2:]}"
    return domain_value


def _load_mail_config():
    global \
        API_BASE, \
        USERNAME, \
        PASSWORD, \
        DUCKMAIL_API_BASE, \
        DUCKMAIL_BEARER, \
        DUCKMAIL_DOMAINS, \
        EMAIL_DOMAIN, \
        EMAIL_DOMAINS, \
        EMAIL_PROVIDERS
    base_dir = os.path.dirname(os.path.abspath(__file__))
    config_path = os.path.join(base_dir, "config.json")
    if os.path.exists(config_path):
        try:
            with open(config_path, "r", encoding="utf-8") as f:
                c = json.load(f)
                API_BASE = c.get("mail_api_base", API_BASE)
                USERNAME = c.get("mail_username", USERNAME)
                PASSWORD = c.get("mail_password", PASSWORD)
                DUCKMAIL_API_BASE = c.get("duckmail_api_base", DUCKMAIL_API_BASE)
                DUCKMAIL_BEARER = c.get("duckmail_api_key", DUCKMAIL_BEARER)
                DUCKMAIL_DOMAINS = (
                    _normalize_domain_list(c.get("duckmail_mail_domains"))
                    or DUCKMAIL_DOMAINS
                )
                EMAIL_DOMAIN = c.get("mail_email_domain", EMAIL_DOMAIN)
                configured_domains = _normalize_domain_list(c.get("mail_email_domains"))
                EMAIL_DOMAINS = configured_domains or [EMAIL_DOMAIN]
        except Exception as e:
            print(f"Failed to load mail config from config.json: {e}")


DEFAULT_EMAIL_PROVIDER = "mailfree"
EMAIL_PROVIDERS = {
    "mailfree": {
        "id": "mailfree",
        "label": "Domain Mailbox",
        "api_base": API_BASE,
        "domains": EMAIL_DOMAINS,
        "mode": "mailfree",
    }
}


_load_mail_config()

API_BASE = str(os.environ.get("MAIL_API_BASE", API_BASE) or API_BASE).strip()
USERNAME = str(os.environ.get("MAIL_USERNAME", USERNAME) or USERNAME).strip()
PASSWORD = str(os.environ.get("MAIL_PASSWORD", PASSWORD) or PASSWORD)
DUCKMAIL_API_BASE = str(
    os.environ.get("DUCKMAIL_API_BASE", DUCKMAIL_API_BASE) or DUCKMAIL_API_BASE
).strip()
DUCKMAIL_BEARER = str(
    os.environ.get("DUCKMAIL_BEARER", DUCKMAIL_BEARER) or DUCKMAIL_BEARER
).strip()
DUCKMAIL_DOMAINS = (
    _normalize_domain_list(os.environ.get("DUCKMAIL_MAIL_DOMAINS")) or DUCKMAIL_DOMAINS
)
EMAIL_DOMAIN = (
    str(os.environ.get("MAIL_EMAIL_DOMAIN", EMAIL_DOMAIN) or EMAIL_DOMAIN)
    .strip()
    .lower()
)
EMAIL_DOMAINS = (
    _normalize_domain_list(os.environ.get("EMAIL_DOMAINS"))
    or EMAIL_DOMAINS
    or [EMAIL_DOMAIN]
)
if EMAIL_DOMAIN and EMAIL_DOMAIN not in EMAIL_DOMAINS:
    EMAIL_DOMAINS.insert(0, EMAIL_DOMAIN)
EMAIL_PROVIDERS["mailfree"] = {
    "id": "mailfree",
    "label": "Domain Mailbox",
    "api_base": API_BASE,
    "domains": EMAIL_DOMAINS,
    "mode": "mailfree",
}
EMAIL_PROVIDERS["inbucket"] = {
    "id": "inbucket",
    "label": "Inbucket Mailbox",
    "api_base": API_BASE,
    "domains": EMAIL_DOMAINS,
    "mode": "inbucket",
}
EMAIL_PROVIDERS["duckmail"] = {
    "id": "duckmail",
    "label": "DuckMail",
    "api_base": DUCKMAIL_API_BASE,
    "domains": DUCKMAIL_DOMAINS,
    "mode": "duckmail",
    "api_key": DUCKMAIL_BEARER,
}

# 会话管理 — 异步安全
_session_cookie: dict = {}
_login_lock = asyncio.Lock()
# 模块级持久 httpx 客户端（连接复用）
_http_client: httpx.AsyncClient | None = None
_duckmail_tokens: dict[str, str] = {}

DIRECT_PROXIES = {"http": "", "https": ""}
OTP_PRESTART_GRACE_SECONDS = 8.0
EMAIL_TIME_FIELDS = (
    "received_at",
    "receivedAt",
    "created_at",
    "createdAt",
    "updated_at",
    "updatedAt",
    "date",
    "timestamp",
    "time",
)


def _coerce_email_id(value):
    if value in (None, ""):
        return None
    try:
        return int(str(value).strip())
    except (TypeError, ValueError):
        return None


def _get_http_client() -> httpx.AsyncClient:
    """获取模块级持久 httpx 客户端（懒初始化）。"""
    global _http_client
    if _http_client is None or _http_client.is_closed:
        _http_client = httpx.AsyncClient(
            verify=False,
            timeout=30.0,
            follow_redirects=True,
            trust_env=False,
        )
    return _http_client


async def close_http_client():
    """关闭模块级客户端，在程序退出前调用。"""
    global _http_client
    if _http_client is not None and not _http_client.is_closed:
        await _http_client.aclose()
        _http_client = None


async def _login() -> bool:
    """登录获取 session cookie（异步，带竞态保护）。"""
    global _session_cookie
    # 快速路径：已有 cookie
    if _session_cookie:
        return True

    async with _login_lock:
        # double-check：等锁期间其他协程可能已完成登录
        if _session_cookie:
            return True
        try:
            client = _get_http_client()
            res = await client.post(
                f"{API_BASE}/api/login",
                json={"username": USERNAME, "password": PASSWORD},
                headers={"Content-Type": "application/json"},
            )
            if res.status_code == 200:
                _session_cookie = dict(res.cookies)
                return True
            return False
        except Exception as e:
            print(f"登录失败: {e}")
            return False


async def _ensure_mail_session() -> bool:
    return bool(_session_cookie) or await _login()


def _coerce_timestamp(value):
    if value in (None, ""):
        return None

    if isinstance(value, (int, float)):
        stamp = float(value)
        if stamp > 1_000_000_000_000:
            stamp /= 1000.0
        return stamp if stamp > 0 else None

    text = str(value).strip()
    if not text:
        return None

    try:
        numeric = float(text)
        if numeric > 1_000_000_000_000:
            numeric /= 1000.0
        return numeric if numeric > 0 else None
    except ValueError:
        pass

    normalized = text.replace("Z", "+00:00")
    try:
        parsed = datetime.fromisoformat(normalized)
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.timestamp()
    except ValueError:
        pass

    for fmt in (
        "%Y-%m-%d %H:%M:%S",
        "%Y/%m/%d %H:%M:%S",
        "%Y-%m-%d %H:%M",
        "%Y/%m/%d %H:%M",
    ):
        try:
            return datetime.strptime(text, fmt).replace(tzinfo=timezone.utc).timestamp()
        except ValueError:
            continue
    return None


def _extract_message_timestamp(message):
    if not isinstance(message, dict):
        return None
    for field in EMAIL_TIME_FIELDS:
        stamp = _coerce_timestamp(message.get(field))
        if stamp is not None:
            return stamp
    return None


def _build_email_content(detail):
    if not isinstance(detail, dict):
        return ""
    raw_body = detail.get("body")
    body = raw_body if isinstance(raw_body, dict) else {}
    parts = [
        detail.get("subject"),
        detail.get("verification_code"),
        detail.get("text"),
        detail.get("preview"),
        detail.get("html"),
        detail.get("html_content"),
        detail.get("content"),
        body.get("text"),
        body.get("html"),
    ]
    return " ".join(str(part or "") for part in parts)


def _to_base36(value):
    alphabet = "0123456789abcdefghijklmnopqrstuvwxyz"
    number = max(0, int(value))
    if number == 0:
        return "0"
    chars = []
    while number:
        number, remainder = divmod(number, 36)
        chars.append(alphabet[remainder])
    return "".join(reversed(chars))


def generate_random_name():
    """生成随机邮箱名称 (格式: 首字母+姓氏+数字)"""
    first_names = [
        "john",
        "james",
        "robert",
        "michael",
        "david",
        "william",
        "mary",
        "patricia",
        "jennifer",
        "linda",
    ]
    last_names = [
        "smith",
        "johnson",
        "williams",
        "brown",
        "jones",
        "miller",
        "davis",
        "garcia",
        "wilson",
        "moore",
    ]

    first_name = random.choice(first_names)
    last_name = random.choice(last_names)[:4]
    time_part = _to_base36(int(time.time() * 1000))[-8:]
    random_part = _to_base36(secrets.randbelow(36**3)).zfill(3)

    return f"{first_name[0]}{last_name}{time_part}{random_part}"


def get_email_provider_options():
    return [
        {
            "id": provider["id"],
            "label": provider["label"],
            "domains": list(provider.get("domains") or []),
            "default_domain": (provider.get("domains") or [None])[0],
            "api_base": provider.get("api_base"),
        }
        for provider in EMAIL_PROVIDERS.values()
    ]


async def create_test_email(provider=None, domain=None):
    """创建邮箱 - 直接生成邮箱地址，无需调用 API 创建"""
    try:
        global API_BASE, _session_cookie
        provider_id = str(provider or DEFAULT_EMAIL_PROVIDER).strip().lower()
        provider_config = EMAIL_PROVIDERS.get(provider_id)
        if not provider_config:
            raise ValueError(f"Unsupported email provider: {provider}")
        provider_api_base = str(provider_config.get("api_base") or API_BASE).strip()
        if provider_api_base and provider_api_base != API_BASE:
            API_BASE = provider_api_base
            _session_cookie = {}
        allowed_domains = {
            str(item).strip().lower() for item in provider_config.get("domains") or []
        }
        domain_value = (
            str(domain or provider_config.get("domains", [EMAIL_DOMAIN])[0])
            .strip()
            .lower()
        )
        if domain_value not in allowed_domains:
            raise ValueError(
                f"Unsupported email domain for {provider_id}: {domain_value}"
            )
        random_name = generate_random_name()
        domain_value = _expand_domain_pattern(domain_value, random_name)
        email = f"{random_name}@{domain_value}"

        if _provider_mode(provider_config) == "duckmail":
            api_base = str(provider_config.get("api_base") or DUCKMAIL_API_BASE).rstrip(
                "/"
            )
            api_key = str(provider_config.get("api_key") or DUCKMAIL_BEARER).strip()
            if not api_base:
                raise ValueError("DuckMail api_base is required")
            if not api_key:
                raise ValueError("DuckMail api key is required")

            create_password = secrets.token_urlsafe(12)
            client = _get_http_client()
            create_resp = await client.post(
                f"{api_base}/accounts",
                json={
                    "address": email,
                    "password": create_password,
                    "expiresIn": 86400,
                },
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Accept": "application/json",
                    "Content-Type": "application/json",
                },
            )
            if create_resp.status_code not in (200, 201, 409):
                raise ValueError(
                    f"DuckMail create account failed ({create_resp.status_code})"
                )
            token_resp = await client.post(
                f"{api_base}/token",
                json={"address": email, "password": create_password},
                headers={
                    "Accept": "application/json",
                    "Content-Type": "application/json",
                },
            )
            if token_resp.status_code != 200:
                raise ValueError(f"DuckMail token failed ({token_resp.status_code})")
            token_data = token_resp.json() if token_resp.content else {}
            token = str((token_data or {}).get("token") or "").strip()
            if not token:
                raise ValueError("DuckMail token is empty")
            _duckmail_tokens[email] = token
            return email, email

        if _provider_mode(provider_config) == "inbucket":
            return email, email

        # 登录获取 session (用于后续读取邮件)
        if not await _login():
            print("无法登录邮箱服务")
            return None, None

        # 这个邮箱服务是 catch-all 类型，任何发到该域名的邮件都可以收到
        return email, email
    except Exception as e:
        print(f"创建邮箱失败: {e}")
        return None, None


async def list_mailbox_emails(mailbox) -> list:
    """获取邮箱列表，用于 snapshot 和过滤旧 OTP。"""
    try:
        mailbox_key = str(mailbox or "").strip()
        client = _get_http_client()
        duckmail_token = _duckmail_tokens.get(mailbox_key)
        if duckmail_token:
            resp = await client.get(
                f"{DUCKMAIL_API_BASE.rstrip('/')}/messages",
                headers={
                    "Authorization": f"Bearer {duckmail_token}",
                    "Accept": "application/json",
                },
            )
            if resp.status_code != 200:
                return []
            data = resp.json()
            items = data.get("hydra:member") if isinstance(data, dict) else []
            return items if isinstance(items, list) else []

        if "mailapizv.uton.me" in API_BASE or "/api/v1" in API_BASE:
            res = await client.get(
                f"{API_BASE.rstrip('/')}/api/v1/mailbox/{mailbox}",
                headers={"Accept": "application/json", "User-Agent": "Mozilla/5.0"},
            )
        else:
            if not await _ensure_mail_session():
                return []

            res = await client.get(
                f"{API_BASE}/api/emails",
                params={"mailbox": mailbox},
                cookies=_session_cookie,
                headers={"Content-Type": "application/json"},
            )

        if res.status_code != 200:
            return []

        data = res.json()
        return data if isinstance(data, list) else []
    except Exception as e:
        print(f"获取邮件列表失败: {e}")
        return []


async def snapshot_mailbox_ids(mailbox) -> set:
    """记录当前邮箱已有的邮件 ID，只读取本次登录后新增的邮件。"""
    ids = set()
    for item in await list_mailbox_emails(mailbox):
        email_id = str(item.get("id") or "").strip()
        if email_id:
            ids.add(email_id)
    return ids


async def snapshot_mailbox_max_id(mailbox):
    max_id = None
    for item in await list_mailbox_emails(mailbox):
        email_id = _coerce_email_id((item or {}).get("id"))
        if email_id is None:
            continue
        if max_id is None or email_id > max_id:
            max_id = email_id
    return max_id


async def fetch_email_detail(email_id):
    try:
        if isinstance(email_id, tuple) and len(email_id) == 2:
            mailbox, message_id = email_id
        else:
            mailbox, message_id = None, email_id

        client = _get_http_client()
        mailbox_key = str(mailbox or "").strip()
        duckmail_token = _duckmail_tokens.get(mailbox_key)
        if duckmail_token:
            detail_res = await client.get(
                f"{DUCKMAIL_API_BASE.rstrip('/')}/messages/{message_id}",
                headers={
                    "Authorization": f"Bearer {duckmail_token}",
                    "Accept": "application/json",
                },
            )
            if detail_res.status_code != 200:
                return None
            detail = detail_res.json()
            return detail if isinstance(detail, dict) else None

        if "mailapizv.uton.me" in API_BASE or "/api/v1" in API_BASE:
            if not mailbox:
                return None
            detail_res = await client.get(
                f"{API_BASE.rstrip('/')}/api/v1/mailbox/{mailbox}/{message_id}",
                headers={"Accept": "application/json", "User-Agent": "Mozilla/5.0"},
            )
        else:
            if not await _ensure_mail_session():
                return None

            detail_res = await client.get(
                f"{API_BASE}/api/email/{message_id}",
                cookies=_session_cookie,
                headers={"Content-Type": "application/json"},
            )

        if detail_res.status_code != 200:
            return None

        detail = detail_res.json()
        return detail if isinstance(detail, dict) else None
    except Exception as e:
        print(f"获取邮件详情失败: {e}")
        return None


async def fetch_first_email(mailbox):
    """获取邮箱列表中的第一封邮件内容。"""
    emails = await list_mailbox_emails(mailbox)
    if not emails:
        return None

    email_id = str((emails[0] or {}).get("id") or "").strip()
    if not email_id:
        return None

    detail = await fetch_email_detail((mailbox, email_id))
    if not detail:
        return None
    return _build_email_content(detail)


def extract_verification_code(content):
    """从邮件内容中提取验证码"""
    if not content:
        return None

    patterns = [
        r"\b(\d{3}-\d{3})\b",
        r"chatgpt code is\s*([A-Z0-9]{4,8})",
        r"verification code[:：\s]*([A-Z0-9]{4,8})",
        r"one[-\s]?time code[:：\s]*([A-Z0-9]{4,8})",
        r"code[:：\s]*([A-Z0-9]{4,8})",
        r"验证码[:：\s]*([A-Z0-9]{4,8})",
        r"\b(\d{6})\b",
        r"\b(\d{5})\b",
    ]

    for pattern in patterns:
        match = re.search(pattern, content, re.IGNORECASE)
        if match:
            return match.group(1).replace("-", "")
    return None


import urllib3

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)


async def fetch_verification_code(
    mailbox,
    max_wait=60,
    interval=1,
    known_email_ids=None,
    exclude_codes=None,
    min_received_at=None,
    min_email_id=None,
    log_fn=None,
):
    """轮询邮箱获取验证码，只接受本次登录之后的新邮件（异步版）。"""
    tracked_ids = (
        known_email_ids
        if isinstance(known_email_ids, set)
        else set(known_email_ids or [])
    )
    excluded_codes = set(exclude_codes or [])
    deadline = time.time() + max_wait
    baseline_email_id = _coerce_email_id(min_email_id)

    def emit(message):
        if callable(log_fn):
            try:
                log_fn(message)
            except Exception:
                pass

    while time.time() < deadline:
        for message in await list_mailbox_emails(mailbox):
            email_id = str((message or {}).get("id") or "").strip()
            if not email_id or email_id in tracked_ids:
                continue
            numeric_email_id = _coerce_email_id(email_id)
            if (
                baseline_email_id is not None
                and numeric_email_id is not None
                and numeric_email_id <= baseline_email_id
            ):
                tracked_ids.add(email_id)
                emit(
                    f"[OTP] 跳过旧邮件 {email_id} baseline_email_id={baseline_email_id}"
                )
                continue

            detail = await fetch_email_detail((mailbox, email_id))
            payload = detail if isinstance(detail, dict) else message
            if not isinstance(payload, dict):
                emit(f"[OTP] 新邮件 {email_id} 数据尚未就绪，继续重试")
                continue

            received_at = _extract_message_timestamp(payload)
            if received_at is None:
                received_at = _extract_message_timestamp(message)
            if (
                not tracked_ids
                and baseline_email_id is None
                and min_received_at is not None
                and received_at is not None
                and received_at < (float(min_received_at) - OTP_PRESTART_GRACE_SECONDS)
            ):
                tracked_ids.add(email_id)
                emit(f"[OTP] 跳过旧邮件 {email_id} received_at={received_at}")
                continue

            code = extract_verification_code(_build_email_content(payload))
            if not code:
                emit(
                    f"[OTP] 新邮件 {email_id} 详情已就绪，但尚未解析到验证码，继续重试"
                )
                continue
            tracked_ids.add(email_id)
            if code in excluded_codes:
                emit(f"[OTP] 跳过已尝试验证码 {code} (email_id={email_id})")
                continue
            emit(f"[OTP] 命中新验证码 {code} (email_id={email_id})")
            return code

        await asyncio.sleep(interval)
    return None
