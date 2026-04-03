import os
import random
import re
import time
from typing import Optional

import requests

API_BASE = os.environ.get("MAIL_API_BASE", "").strip()
USERNAME = os.environ.get("MAIL_USERNAME", "").strip()
PASSWORD = os.environ.get("MAIL_PASSWORD", "").strip()
EMAIL_DOMAIN = (
    os.environ.get("MAIL_EMAIL_DOMAIN", "example.com").strip() or "example.com"
)

_session_cookie = None


def _login() -> bool:
    global _session_cookie
    if _session_cookie:
        return True
    if not PASSWORD:
        return False

    try:
        session = requests.Session()
        session.trust_env = False
        res = session.post(
            f"{API_BASE}/api/login",
            json={"username": USERNAME, "password": PASSWORD},
            headers={"Content-Type": "application/json"},
            timeout=20,
        )
        if res.status_code == 200:
            _session_cookie = res.cookies.get_dict()
            return True
        return False
    except Exception:
        return False


def generate_random_name() -> str:
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
    last_name = random.choice(last_names)
    random_num = random.randint(100, 9999)
    return f"{first_name[0]}{last_name}{random_num}"


def create_test_email():
    random_name = generate_random_name()
    email = f"{random_name}@{EMAIL_DOMAIN}"
    if not _login():
        return None, None
    return email, email


def fetch_first_email(mailbox: str) -> Optional[str]:
    global _session_cookie
    if not mailbox:
        return None

    try:
        if not _session_cookie and not _login():
            return None

        session = requests.Session()
        session.trust_env = False
        res = session.get(
            f"{API_BASE}/api/emails",
            params={"mailbox": mailbox},
            cookies=_session_cookie,
            headers={"Content-Type": "application/json"},
            timeout=20,
        )
        if res.status_code != 200:
            return None

        data = res.json()
        if not data:
            return None

        latest_email = data[0] if isinstance(data, list) else None
        email_id = latest_email.get("id") if isinstance(latest_email, dict) else None
        if not email_id:
            return None

        detail_res = session.get(
            f"{API_BASE}/api/email/{email_id}",
            cookies=_session_cookie,
            headers={"Content-Type": "application/json"},
            timeout=20,
        )
        if detail_res.status_code != 200:
            return None
        detail = detail_res.json()
        if not isinstance(detail, dict):
            return None
        content = f"{detail.get('subject', '')} {detail.get('text', '')} {detail.get('html', '')} {detail.get('content', '')}"
        return content
    except Exception:
        return None


def extract_verification_code(content: str) -> Optional[str]:
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


def fetch_verification_code(
    mailbox: str, max_wait: int = 60, interval: int = 1
) -> Optional[str]:
    for _ in range(max_wait):
        content = fetch_first_email(mailbox)
        code = extract_verification_code(content or "")
        if code:
            return code
        time.sleep(interval)
    return None
