import re
import time
import os
import secrets
from datetime import datetime, timezone

import random
import requests

import json

# 默认域名邮箱配置
API_BASE = "REDACTED_BASE"
USERNAME = ""
PASSWORD = ""
EMAIL_DOMAIN = "REDACTED_DOMAIN"
EMAIL_DOMAINS = [EMAIL_DOMAIN]


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


def _load_mail_config():
    global API_BASE, USERNAME, PASSWORD, EMAIL_DOMAIN, EMAIL_DOMAINS, EMAIL_PROVIDERS
    base_dir = os.path.dirname(os.path.abspath(__file__))
    config_path = os.path.join(base_dir, "config.json")
    if os.path.exists(config_path):
        try:
            with open(config_path, "r", encoding="utf-8") as f:
                c = json.load(f)
                API_BASE = c.get("mail_api_base", API_BASE)
                USERNAME = c.get("mail_username", USERNAME)
                PASSWORD = c.get("mail_password", PASSWORD)
                EMAIL_DOMAIN = c.get("mail_email_domain", EMAIL_DOMAIN)
                configured_domains = _normalize_domain_list(c.get("mail_email_domains"))
                EMAIL_DOMAINS = configured_domains or [
                    str(EMAIL_DOMAIN or "").strip().lower()
                ]
        except Exception as e:
            print(f"Failed to load mail config from config.json: {e}")


_load_mail_config()

API_BASE = str(os.environ.get("MAIL_API_BASE", API_BASE) or API_BASE).strip()
USERNAME = str(os.environ.get("MAIL_USERNAME", USERNAME) or USERNAME).strip()
PASSWORD = str(os.environ.get("MAIL_PASSWORD", PASSWORD) or PASSWORD)
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
DEFAULT_EMAIL_PROVIDER = "mailfree"
EMAIL_PROVIDERS = {
    "mailfree": {
        "id": "mailfree",
        "label": "Domain Mailbox",
        "api_base": API_BASE,
        "domains": EMAIL_DOMAINS,
    }
}

# 会话管理
_session_cookie = None
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


def _http_session():
    session = requests.Session()
    session.trust_env = False
    session.proxies.update(DIRECT_PROXIES)
    return session


def _login():
    """登录获取 session cookie"""
    global _session_cookie
    if _session_cookie:
        return True

    try:
        with _http_session() as session:
            res = session.post(
                f"{API_BASE}/api/login",
                json={"username": USERNAME, "password": PASSWORD},
                headers={"Content-Type": "application/json"},
                verify=False,
            )
        if res.status_code == 200:
            # 从响应中获取 cookie
            _session_cookie = res.cookies.get_dict()
            return True
        return False
    except Exception as e:
        print(f"登录失败: {e}")
        return False


def _ensure_mail_session():
    return bool(_session_cookie) or _login()


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
            # Mail API often returns naive UTC strings like "2026-03-18 15:07:55".
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
            # Mail API currently returns naive UTC strings like "2026-03-17 20:35:56".
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
    return " ".join(
        str(detail.get(key) or "")
        for key in (
            "subject",
            "verification_code",
            "text",
            "preview",
            "html",
            "html_content",
            "content",
        )
    )


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


def create_test_email(provider=None, domain=None):
    """创建邮箱 - 直接生成邮箱地址，无需调用 API 创建"""
    try:
        provider_id = str(provider or DEFAULT_EMAIL_PROVIDER).strip().lower()
        provider_config = EMAIL_PROVIDERS.get(provider_id)
        if not provider_config:
            raise ValueError(f"Unsupported email provider: {provider}")
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
        email = f"{random_name}@{domain_value}"

        # 登录获取 session (用于后续读取邮件)
        if not _login():
            print("无法登录邮箱服务")
            return None, None

        # 这个邮箱服务是 catch-all 类型，任何发到该域名的邮件都可以收到
        # 返回 email 作为 jwt (实际上是 mailbox 标识)
        return email, email
    except Exception as e:
        print(f"创建邮箱失败: {e}")
        return None, None


def list_mailbox_emails(mailbox):
    """获取邮箱列表，用于 snapshot 和过滤旧 OTP。"""
    try:
        if not _ensure_mail_session():
            return []

        with _http_session() as session:
            res = session.get(
                f"{API_BASE}/api/emails",
                params={"mailbox": mailbox},
                cookies=_session_cookie,
                headers={"Content-Type": "application/json"},
                verify=False,
            )

        if res.status_code != 200:
            return []

        data = res.json()
        return data if isinstance(data, list) else []
    except Exception as e:
        print(f"获取邮件列表失败: {e}")
        return []


def snapshot_mailbox_ids(mailbox):
    """记录当前邮箱已有的邮件 ID，只读取本次登录后新增的邮件。"""
    ids = set()
    for item in list_mailbox_emails(mailbox):
        email_id = str(item.get("id") or "").strip()
        if email_id:
            ids.add(email_id)
    return ids


def snapshot_mailbox_max_id(mailbox):
    max_id = None
    for item in list_mailbox_emails(mailbox):
        email_id = _coerce_email_id((item or {}).get("id"))
        if email_id is None:
            continue
        if max_id is None or email_id > max_id:
            max_id = email_id
    return max_id


def fetch_email_detail(email_id):
    try:
        if not _ensure_mail_session():
            return None

        with _http_session() as session:
            detail_res = session.get(
                f"{API_BASE}/api/email/{email_id}",
                cookies=_session_cookie,
                headers={"Content-Type": "application/json"},
                verify=False,
            )

        if detail_res.status_code != 200:
            return None

        detail = detail_res.json()
        return detail if isinstance(detail, dict) else None
    except Exception as e:
        print(f"获取邮件详情失败: {e}")
        return None


def fetch_first_email(mailbox):
    """获取邮箱列表中的第一封邮件内容。"""
    emails = list_mailbox_emails(mailbox)
    if not emails:
        return None

    email_id = str((emails[0] or {}).get("id") or "").strip()
    if not email_id:
        return None

    detail = fetch_email_detail(email_id)
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


def fetch_verification_code(
    mailbox,
    max_wait=60,
    interval=1,
    known_email_ids=None,
    exclude_codes=None,
    min_received_at=None,
    min_email_id=None,
    log_fn=None,
):
    """轮询邮箱获取验证码，只接受本次登录之后的新邮件。"""
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
        for message in list_mailbox_emails(mailbox):
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

            detail = fetch_email_detail(email_id)
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

        time.sleep(interval)
    return None
