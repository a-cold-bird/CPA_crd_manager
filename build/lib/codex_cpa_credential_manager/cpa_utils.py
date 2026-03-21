import re
from typing import Any, Dict, Optional
from urllib.parse import parse_qs, urlparse


AUTH_URL_PATTERN = re.compile(r"https://auth\.openai\.com/(?:oauth/)?authorize[^\s\"'<>]+", re.IGNORECASE)
CALLBACK_URL_PATTERN = re.compile(
    r"http://localhost:1455/auth/callback\?[^\"'\s<>]*code=[^\"'\s<>]+[^\"'\s<>]*state=[^\"'\s<>]+",
    re.IGNORECASE,
)


def normalize_cpa_base_url(url: str) -> str:
    text = (url or "").strip()
    if not text:
        raise ValueError("CPA base URL is required")
    return text.rstrip("/")


def extract_state_from_url(url: str) -> Optional[str]:
    text = (url or "").strip()
    if not text:
        return None
    try:
        params = parse_qs(urlparse(text).query)
        state = params.get("state", [None])[0]
        return state.strip() if isinstance(state, str) and state.strip() else None
    except Exception:
        return None


def extract_code_from_url(url: str) -> Optional[str]:
    text = (url or "").strip()
    if not text:
        return None
    try:
        params = parse_qs(urlparse(text).query)
        code = params.get("code", [None])[0]
        return code.strip() if isinstance(code, str) and code.strip() else None
    except Exception:
        return None


def build_management_headers(password_or_key: str) -> Dict[str, str]:
    key = (password_or_key or "").strip()
    headers: Dict[str, str] = {"Content-Type": "application/json"}
    if not key:
        return headers

    if key.lower().startswith("bearer "):
        token = key[7:].strip()
        headers["Authorization"] = key
        if token:
            headers["X-Management-Key"] = token
        return headers

    headers["Authorization"] = f"Bearer {key}"
    headers["X-Management-Key"] = key
    return headers


def build_oauth_callback_payload(callback_url: str, provider: str = "codex", state: str = None) -> Dict[str, str]:
    redirect_url = (callback_url or "").strip()
    if not redirect_url:
        raise ValueError("callback_url is required")

    resolved_state = (state or "").strip() or (extract_state_from_url(redirect_url) or "")
    if not resolved_state:
        raise ValueError("state is required in callback_url or explicit state argument")

    return {
        "provider": provider,
        "redirect_url": redirect_url,
        "state": resolved_state,
    }


def extract_first_auth_url(text: str) -> Optional[str]:
    source = text or ""
    matches = AUTH_URL_PATTERN.findall(source)
    if not matches:
        return None
    return matches[0].replace("&amp;", "&")


def extract_first_callback_url(text: str) -> Optional[str]:
    source = text or ""
    matches = CALLBACK_URL_PATTERN.findall(source)
    if not matches:
        return None
    return matches[0].replace("&amp;", "&")


def parse_codex_auth_url_response(payload: Any) -> Dict[str, Optional[str]]:
    data = payload if isinstance(payload, dict) else {}
    status = data.get("status") if isinstance(data.get("status"), str) else None
    url = data.get("url") if isinstance(data.get("url"), str) else None
    state = data.get("state") if isinstance(data.get("state"), str) else None

    clean_url = (url or "").strip() or None
    clean_state = (state or "").strip() or None
    if not clean_state and clean_url:
        clean_state = extract_state_from_url(clean_url)

    return {
        "status": (status or "").strip() or None,
        "url": clean_url,
        "state": clean_state,
    }
