import argparse
import json
import os
import re
import shutil
import socket
import tempfile
import threading
import time
from typing import Any, Dict, List, Optional, Tuple

import requests

from app_defaults import DEFAULT_CPA_PASSWORD, DEFAULT_CPA_URL
from cpa_utils import (
    build_management_headers,
    build_oauth_callback_payload,
    extract_code_from_url,
    extract_first_auth_url,
    extract_first_callback_url,
    extract_state_from_url,
    normalize_cpa_base_url,
    parse_codex_auth_url_response,
)
from email_utils import extract_verification_code, fetch_first_email
from login_utils import AccountRecord, build_mailbox_candidates, load_accounts, pick_account
import turnstile_bypass


AUTH_LOG_HINTS = (
    "requesting codex oauth auth url",
    "captured auth url",
    "auth_url:",
    "auth_state:",
)
FATAL_OAUTH_TEXT_HINTS = (
    "too many failed attempts",
    "oops, an error occurred",
    "there is a problem with your account",
    "temporarily blocked",
)
DELETED_OAUTH_TEXT_HINTS = (
    "you do not have an account because it has been deleted or deactivated",
    "deleted or deactivated",
    "账号已被删除",
    "账号已停用",
)
_log_ctx = threading.local()


def _should_skip_log(message: str, suppress_auth_logs: bool) -> bool:
    if not suppress_auth_logs:
        return False
    text = str(message or "").strip().lower()
    if not text:
        return False
    return any(hint in text for hint in AUTH_LOG_HINTS)


def log(message: str):
    cfg = getattr(_log_ctx, "cfg", None) or {}
    if not bool(cfg.get("verbose", True)):
        return
    if _should_skip_log(message, bool(cfg.get("suppress_auth_logs", False))):
        return
    ts = time.strftime("%H:%M:%S")
    prefix = str(cfg.get("prefix") or "").strip()
    if prefix:
        print(f"[{ts}] [{prefix}] {message}")
    else:
        print(f"[{ts}] {message}")


def mask_email(email: str) -> str:
    if "@" not in email:
        return email
    name, domain = email.split("@", 1)
    return f"{name[:2]}***@{domain}" if len(name) > 2 else f"{name[:1]}***@{domain}"


def mask_state(state: Optional[str]) -> str:
    text = (state or "").strip()
    if not text:
        return "none"
    if len(text) <= 10:
        return text
    return f"{text[:6]}...{text[-4:]}"


def build_state_timing_diagnostics(
    auth_url: Optional[str],
    auth_state: Optional[str],
    callback_url: Optional[str],
    auth_url_ts: Optional[float],
    callback_capture_ts: Optional[float],
    callback_submit_ts: Optional[float],
) -> Dict[str, Any]:
    resolved_auth_state = (auth_state or extract_state_from_url(auth_url or "") or "").strip() or None
    callback_state = extract_state_from_url(callback_url or "")

    state_match: Optional[bool]
    if resolved_auth_state and callback_state:
        state_match = resolved_auth_state == callback_state
    else:
        state_match = None

    auth_to_callback_seconds = None
    callback_to_submit_seconds = None
    auth_to_submit_seconds = None
    if auth_url_ts and callback_capture_ts and callback_capture_ts >= auth_url_ts:
        auth_to_callback_seconds = round(callback_capture_ts - auth_url_ts, 3)
    if callback_capture_ts and callback_submit_ts and callback_submit_ts >= callback_capture_ts:
        callback_to_submit_seconds = round(callback_submit_ts - callback_capture_ts, 3)
    if auth_url_ts and callback_submit_ts and callback_submit_ts >= auth_url_ts:
        auth_to_submit_seconds = round(callback_submit_ts - auth_url_ts, 3)

    return {
        "auth_state": resolved_auth_state,
        "callback_state": callback_state,
        "state_match": state_match,
        "auth_to_callback_seconds": auth_to_callback_seconds,
        "callback_to_submit_seconds": callback_to_submit_seconds,
        "auth_to_submit_seconds": auth_to_submit_seconds,
    }


def _resolve_browser_path() -> Optional[str]:
    candidates = [
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    ]
    for path in candidates:
        if os.path.exists(path):
            return path
    return None


def _build_options(headless: bool):
    from DrissionPage import ChromiumOptions

    options = ChromiumOptions()
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    free_port = sock.getsockname()[1]
    sock.close()
    options.set_local_port(free_port)

    browser_path = _resolve_browser_path()
    if browser_path:
        options.set_browser_path(browser_path)

    profile_dir = tempfile.mkdtemp(prefix="dp_cpa_profile_")
    options.set_user_data_path(profile_dir)
    if headless:
        options.set_argument("--headless=new")

    return options, profile_dir


def _resolve_oauth_browser_mode() -> str:
    """
    Resolve OAuth browser mode.
    Default is patched mode for better WebSocket/DevTools stability.
    Set OAUTH_BROWSER_MODE=clean to force plain Chromium mode.
    """
    raw = str(os.environ.get("OAUTH_BROWSER_MODE", "patched") or "").strip().lower()
    if raw in ("clean", "plain"):
        return "clean"
    return "patched"


def _create_oauth_browser(options, headless: bool):
    mode = _resolve_oauth_browser_mode()
    if mode == "patched":
        log("OAuth browser mode: patched")
        return turnstile_bypass.get_patched_browser(options=options, headless=headless)

    # Clean mode: use plain Chromium with only _build_options() settings.
    from DrissionPage import Chromium

    log("OAuth browser mode: clean")
    try:
        return Chromium(options)
    except Exception as e:
        text = str(e or "")
        if any(h in text for h in ("Handshake status 404", "WebSocketBadStatusException", "BrowserConnectError")):
            log("OAuth clean mode failed; fallback to patched")
            return turnstile_bypass.get_patched_browser(options=options, headless=headless)
        raise


def _is_browser_init_retryable_error(error: Exception) -> bool:
    text = str(error or "")
    if not text:
        return False
    hints = (
        "Handshake status 404",
        "WebSocketBadStatusException",
        "BrowserConnectError",
        "'NoneType' object has no attribute 'send'",
        "connection refused",
        "Connection refused",
    )
    return any(h in text for h in hints)


def _open_oauth_browser_with_retry(headless: bool, attempts: int = 3):
    last_error: Optional[Exception] = None
    max_attempts = max(1, int(attempts or 1))
    for i in range(1, max_attempts + 1):
        options, profile_dir = _build_options(headless=headless)
        browser = None
        try:
            browser = _create_oauth_browser(options=options, headless=headless)
            # Touch DevTools channel once to avoid half-open session.
            tab = browser.latest_tab
            _ = tab.url
            try:
                tab.run_js("return 1")
            except Exception:
                pass
            return browser, profile_dir
        except Exception as e:
            last_error = e
            if browser:
                try:
                    turnstile_bypass.safe_quit_browser(browser, force=True, timeout=5.0, user_data_dir=profile_dir)
                except Exception:
                    pass
            try:
                turnstile_bypass.kill_browser_processes_for_user_data_dir(profile_dir, timeout=5.0)
            except Exception:
                pass
            shutil.rmtree(profile_dir, ignore_errors=True)
            if i >= max_attempts or not _is_browser_init_retryable_error(e):
                raise
            log(f"Browser init retry {i}/{max_attempts} due to: {e}")
            time.sleep(0.8)
    if last_error:
        raise last_error
    raise RuntimeError("Browser init failed")


def safe_ele(tab, selector: str, timeout: float = 1.5):
    try:
        return tab.ele(selector, timeout=timeout)
    except Exception:
        return None


def safe_eles(tab, selector: str, timeout: float = 1.5):
    try:
        return tab.eles(selector, timeout=timeout) or []
    except Exception:
        return []


def click_ele(ele) -> bool:
    if not ele:
        return False
    try:
        ele.click()
        return True
    except Exception:
        try:
            ele.run_js("this.click()")
            return True
        except Exception:
            return False


def fill_ele(ele, value: str) -> bool:
    if not ele:
        return False
    try:
        ele.clear()
    except Exception:
        pass
    try:
        ele.input(value)
        return True
    except Exception:
        return False


def click_by_texts(tab, texts: List[str], timeout: float = 2.0) -> bool:
    for text in texts:
        ele = safe_ele(tab, f"text:{text}", timeout=timeout)
        if click_ele(ele):
            return True
    return False


def click_submit_like(tab) -> bool:
    submit = safe_ele(tab, "tag:button@type=submit", timeout=1.5)
    if click_ele(submit):
        return True
    return click_by_texts(
        tab,
        [
            "Continue",
            "Log in",
            "Login",
            "Sign in",
            "Next",
            "Submit",
            "Allow",
            "Authorize",
            "Accept",
            "继续",
            "下一步",
            "登录",
            "授权",
            "允许",
            "提交",
        ],
        timeout=1.5,
    )


def wait_and_fill_first(tab, selectors: List[str], value: str, max_wait: float = 20.0) -> bool:
    end = time.time() + max_wait
    while time.time() < end:
        for selector in selectors:
            ele = safe_ele(tab, selector, timeout=1.2)
            if fill_ele(ele, value):
                return True
        time.sleep(0.4)
    return False


def exists_css(tab, selectors: str) -> bool:
    try:
        js = "return !!document.querySelector(" + json.dumps(selectors) + ");"
        return bool(tab.run_js(js))
    except Exception:
        return False


def _is_email_step(tab) -> bool:
    return exists_css(tab, "input[type='email'],input[name='email'],input[id='email'],input[autocomplete='email']")


def _is_password_step(tab) -> bool:
    return exists_css(tab, "input[type='password'],input[name='password'],input[id='password']")


def _is_verify_step(tab) -> bool:
    return exists_css(
        tab,
        "input[name='code'],input[name='otp'],input[name='token'],"
        "input[autocomplete='one-time-code'],input[inputmode='numeric'],input[placeholder*='code' i]",
    )


def _classify_oauth_page_error(text: str) -> Optional[str]:
    source = str(text or "").strip().lower()
    if not source:
        return None
    for hint in DELETED_OAUTH_TEXT_HINTS:
        if hint in source:
            return "account_deleted_or_deactivated"
    for hint in FATAL_OAUTH_TEXT_HINTS:
        if hint in source:
            return hint
    return None


def _detect_oauth_fatal_error(tab) -> Optional[str]:
    text = ""
    try:
        text = tab.run_js("return (document.body && document.body.innerText) ? document.body.innerText : '';") or ""
    except Exception:
        text = ""
    return _classify_oauth_page_error(text)


def _fill_verify_code(tab, code: str) -> bool:
    otp_inputs = []
    otp_inputs.extend(safe_eles(tab, "tag:input@inputmode=numeric", 1.0))
    otp_inputs.extend(safe_eles(tab, "tag:input@autocomplete=one-time-code", 1.0))

    unique_inputs = []
    seen = set()
    for item in otp_inputs:
        marker = id(item)
        if marker not in seen:
            seen.add(marker)
            unique_inputs.append(item)

    one_char = []
    for ele in unique_inputs:
        try:
            if str(ele.attr("maxlength") or "").strip() == "1":
                one_char.append(ele)
        except Exception:
            continue

    if len(one_char) >= 6:
        for i, ch in enumerate(code[:6]):
            fill_ele(one_char[i], ch)
        return True

    return wait_and_fill_first(
        tab,
        [
            "tag:input@name=code",
            "tag:input@name=otp",
            "tag:input@name=token",
            "tag:input@autocomplete=one-time-code",
            "tag:input@inputmode=numeric",
            "tag:input@@placeholder:code",
            "tag:input",
        ],
        code,
        max_wait=10.0,
    )


def fetch_login_email_code(email: str, max_wait: int = 90) -> Optional[str]:
    candidates = build_mailbox_candidates(email)
    for sec in range(max_wait):
        for mailbox in candidates:
            content = fetch_first_email(mailbox)
            code = extract_verification_code(content or "")
            if code:
                log(f"Found verification code from mailbox={mailbox}: {code}")
                return code
        if sec > 0 and sec % 10 == 0:
            log(f"Waiting verification email... {sec}s")
        time.sleep(1)
    return None


def detect_cpa_ready(tab) -> bool:
    try:
        url = str(tab.url or "").lower()
    except Exception:
        url = ""
    if "oauth" in url:
        return True
    body = ""
    try:
        body = (tab.run_js("return (document.body && document.body.innerText) ? document.body.innerText : '';") or "").lower()
    except Exception:
        body = ""
    return "codex oauth" in body or "callback url" in body or "oauth" in body


def open_cpa_oauth_page(tab, cpa_url: str):
    base = normalize_cpa_base_url(cpa_url)
    candidates = [
        base,
        f"{base}/management.html#/oauth",
        f"{base}/#/oauth",
    ]
    for url in candidates:
        try:
            tab.get(url)
            tab.wait.load_start()
            time.sleep(1.2)
        except Exception:
            continue
        if detect_cpa_ready(tab):
            return True
    return False


def login_cpa_panel(tab, cpa_url: str, cpa_password: str, max_wait: int = 30) -> Tuple[bool, Optional[str]]:
    if not open_cpa_oauth_page(tab, cpa_url):
        return False, "Failed to open CPA page"

    if detect_cpa_ready(tab):
        # If password input is present we still need login submit.
        pass

    pwd_input = wait_and_fill_first(
        tab,
        [
            "tag:input@type=password",
            "tag:input@name=password",
            "tag:input@@placeholder:password",
            "tag:input@@placeholder:密码",
        ],
        cpa_password,
        max_wait=8.0,
    )
    if pwd_input:
        if not click_submit_like(tab):
            return False, "CPA login button not found"

    end = time.time() + max_wait
    while time.time() < end:
        if detect_cpa_ready(tab):
            # If password box still visible, continue waiting.
            if safe_ele(tab, "tag:input@type=password", timeout=0.5):
                time.sleep(0.8)
                continue
            return True, None
        click_by_texts(tab, ["OAuth", "oauth", "授权"], timeout=0.8)
        time.sleep(0.8)

    return False, "CPA panel did not reach OAuth page"


def extract_auth_url_from_page(tab) -> Optional[str]:
    try:
        text = tab.run_js("return document.documentElement ? document.documentElement.outerHTML : '';") or ""
    except Exception:
        text = ""
    auth_url = extract_first_auth_url(str(text))
    if auth_url:
        return auth_url

    # Try href/value collection.
    try:
        combined = tab.run_js(
            """
            return (() => {
                const parts = [];
                for (const a of document.querySelectorAll('a[href]')) parts.push(a.getAttribute('href') || '');
                for (const i of document.querySelectorAll('input[value], textarea')) parts.push(i.value || '');
                return parts.join('\\n');
            })();
            """
        ) or ""
    except Exception:
        combined = ""
    return extract_first_auth_url(str(combined))


def trigger_codex_auth_link_generation(tab):
    # Try direct text buttons first.
    click_by_texts(tab, ["Login", "Log in", "Open Link", "Open", "登录", "打开链接"], timeout=1.2)
    # Try a JS click near Codex card.
    try:
        tab.run_js(
            """
            (() => {
                const cards = [...document.querySelectorAll('div,section,article')];
                for (const card of cards) {
                    const text = (card.innerText || '').toLowerCase();
                    if (!text.includes('codex')) continue;
                    const btns = card.querySelectorAll('button,a,[role="button"]');
                    for (const b of btns) {
                        const t = ((b.innerText || b.textContent || '').trim().toLowerCase());
                        if (
                            t.includes('login') ||
                            t.includes('log in') ||
                            t.includes('open') ||
                            t.includes('登录') ||
                            t.includes('打开')
                        ) {
                            b.click();
                            return true;
                        }
                    }
                }
                return false;
            })();
            """
        )
    except Exception:
        pass


def get_codex_auth_link(tab, max_wait: int = 25) -> Optional[str]:
    auth_url = extract_auth_url_from_page(tab)
    if auth_url:
        return auth_url

    end = time.time() + max_wait
    while time.time() < end:
        trigger_codex_auth_link_generation(tab)
        time.sleep(1.5)
        auth_url = extract_auth_url_from_page(tab)
        if auth_url:
            return auth_url
    return None


def request_codex_auth_url_via_api(cpa_url: str, cpa_password: str, is_webui: bool = True) -> Tuple[Optional[str], Optional[str], Optional[str]]:
    endpoint = normalize_cpa_base_url(cpa_url) + "/v0/management/codex-auth-url"
    headers = build_management_headers(cpa_password)
    params = {"is_webui": "true" if is_webui else "false"}

    session = requests.Session()
    session.trust_env = False

    try:
        resp = session.get(endpoint, params=params, headers=headers, timeout=30)
    except Exception as e:
        return None, None, f"CPA auth-url API request failed: {e}"

    try:
        data = resp.json()
    except Exception:
        data = {"raw": resp.text}

    if resp.status_code != 200:
        return None, None, f"CPA auth-url API returned {resp.status_code}: {str(data)[:220]}"

    parsed = parse_codex_auth_url_response(data)
    auth_url = parsed.get("url")
    auth_state = parsed.get("state")
    if auth_url:
        return auth_url, auth_state, None

    return None, auth_state, f"CPA auth-url API did not return url: {str(data)[:220]}"


def run_openai_oauth_and_capture_callback(tab, auth_url: str, account: AccountRecord, max_wait: int = 120) -> Tuple[Optional[str], Optional[str]]:
    try:
        tab.get(auth_url)
        tab.wait.load_start()
        time.sleep(1.2)
    except Exception as e:
        return None, f"Failed to open auth URL: {e}"

    email_done = False
    password_done = False
    verify_done = False

    end = time.time() + max_wait
    while time.time() < end:
        fatal_hint = _detect_oauth_fatal_error(tab)
        if fatal_hint:
            if fatal_hint == "account_deleted_or_deactivated":
                return None, "OAuth account deleted_or_deactivated"
            return None, f"OAuth fatal page detected: {fatal_hint}"

        try:
            current_url = str(tab.url or "")
        except Exception:
            current_url = ""

        if ("localhost" in current_url or "callback" in current_url) and extract_code_from_url(current_url):
            return current_url, None

        # Some browser/runtime variants keep callback URL in page text/html without setting location.
        try:
            html = tab.run_js("return document.documentElement ? document.documentElement.outerHTML : '';") or ""
        except Exception:
            html = ""
        callback_in_html = extract_first_callback_url(str(html))
        if callback_in_html and extract_code_from_url(callback_in_html):
            return callback_in_html, None

        if _is_verify_step(tab) and not verify_done:
            log("OAuth verification step detected, fetching code...")
            code = fetch_login_email_code(account.email, max_wait=90)
            if not code:
                return None, "OAuth verification code not found"
            if not _fill_verify_code(tab, code):
                return None, "Failed to fill OAuth verification code"
            time.sleep(0.4)
            click_submit_like(tab)
            verify_done = True
            time.sleep(1.0)
            continue

        if _is_password_step(tab) and not password_done:
            log("OAuth password step detected")
            if not wait_and_fill_first(
                tab,
                [
                    "tag:input@type=password",
                    "tag:input@name=password",
                    "tag:input@id=password",
                    "tag:input@autocomplete=current-password",
                    "tag:input@autocomplete=new-password",
                ],
                account.password,
                max_wait=20.0,
            ):
                return None, "OAuth password input not found"
            time.sleep(0.3)
            click_submit_like(tab)
            password_done = True
            time.sleep(1.0)
            continue

        if _is_email_step(tab) and not email_done:
            log(f"OAuth email step detected: {mask_email(account.email)}")
            if not wait_and_fill_first(
                tab,
                [
                    "tag:input@type=email",
                    "tag:input@name=email",
                    "tag:input@id=email",
                    "tag:input@autocomplete=email",
                ],
                account.email,
                max_wait=20.0,
            ):
                return None, "OAuth email input not found"
            time.sleep(0.3)
            click_submit_like(tab)
            email_done = True
            time.sleep(1.0)
            continue

        click_by_texts(tab, ["Allow", "Authorize", "Accept", "Continue", "允许", "授权", "继续"], timeout=0.8)
        time.sleep(1.0)

    return None, "OAuth callback URL not captured before timeout"


def submit_callback_via_api(cpa_url: str, cpa_password: str, callback_url: str) -> Dict[str, Any]:
    endpoint = normalize_cpa_base_url(cpa_url) + "/v0/management/oauth-callback"
    headers = build_management_headers(cpa_password)
    payload = build_oauth_callback_payload(callback_url, provider="codex")

    session = requests.Session()
    # Ignore system proxy variables to avoid local proxy pollution in automation env.
    session.trust_env = False
    resp = session.post(endpoint, json=payload, headers=headers, timeout=30)
    raw = resp.text
    try:
        data = resp.json()
    except Exception:
        data = {"raw": raw}

    ok = resp.status_code == 200 and (not isinstance(data, dict) or data.get("status", "ok") == "ok")
    return {
        "ok": ok,
        "status_code": resp.status_code,
        "data": data,
        "endpoint": endpoint,
        "payload": payload,
    }


def run_cpa_callback_test(
    cpa_url: str,
    cpa_password: str,
    account: AccountRecord,
    callback_url: str = None,
    headless: bool = False,
    verbose: bool = True,
    suppress_auth_logs: bool = False,
    log_prefix: str = "",
) -> Dict[str, Any]:
    result: Dict[str, Any] = {
        "success": False,
        "error": None,
        "callback_url": callback_url,
        "api_result": None,
        "auth_url": None,
        "auth_state": None,
        "callback_state": None,
        "state_match": None,
        "timing": {
            "auth_to_callback_seconds": None,
            "callback_to_submit_seconds": None,
            "auth_to_submit_seconds": None,
        },
    }

    browser = None
    profile_dir = None
    prev_cfg = getattr(_log_ctx, "cfg", None)
    _log_ctx.cfg = {
        "verbose": bool(verbose),
        "suppress_auth_logs": bool(suppress_auth_logs),
        "prefix": str(log_prefix or "").strip(),
    }
    auth_url_ts: Optional[float] = None
    callback_capture_ts: Optional[float] = None
    callback_submit_ts: Optional[float] = None
    try:
        if callback_url:
            log("Using provided callback URL; skipping browser capture.")
            api_result = submit_callback_via_api(cpa_url, cpa_password, callback_url)
            result["api_result"] = api_result
            result["success"] = bool(api_result.get("ok"))
            if not result["success"]:
                api_data = api_result.get("data") if isinstance(api_result.get("data"), dict) else {}
                api_err = str(api_data.get("error") or api_data.get("message") or "")
                result["error"] = (
                    f"CPA API rejected callback. status={api_result.get('status_code')}"
                    + (f", error={api_err}" if api_err else "")
                )
            return result

        log("Requesting Codex OAuth auth URL via CPA API...")
        auth_url, auth_state, api_auth_err = request_codex_auth_url_via_api(cpa_url, cpa_password, is_webui=True)
        result["auth_url"] = auth_url
        result["auth_state"] = auth_state

        if auth_url:
            auth_url_ts = time.time()
            log("Captured auth URL from CPA API")
            log(f"OAuth link => {auth_url}")
        else:
            log("Initializing browser...")
            browser, profile_dir = _open_oauth_browser_with_retry(headless=headless, attempts=3)
            tab = browser.latest_tab
            log("Browser initialized")

            ok, err = login_cpa_panel(tab, cpa_url, cpa_password, max_wait=30)
            if not ok:
                result["error"] = err or "CPA login failed"
                return result
            log("CPA panel login passed")

            if api_auth_err:
                log(f"CPA API auth URL unavailable: {api_auth_err}; fallback to panel extraction")
            auth_url = get_codex_auth_link(tab, max_wait=30)
            result["auth_url"] = auth_url
            if not auth_url:
                result["error"] = "Failed to get Codex OAuth auth URL from CPA API and panel"
                return result
            auth_url_ts = time.time()
            log("Captured auth URL from CPA panel")
            log(f"OAuth link => {auth_url}")

        if browser is None:
            log("Initializing browser...")
            browser, profile_dir = _open_oauth_browser_with_retry(headless=headless, attempts=3)
            tab = browser.latest_tab
            log("Browser initialized")

        callback_url, err = run_openai_oauth_and_capture_callback(tab, auth_url, account, max_wait=140)
        result["callback_url"] = callback_url
        if err:
            result["error"] = err
            return result
        callback_capture_ts = time.time()
        log(f"Captured callback URL: {callback_url[:120]}...")

        diag = build_state_timing_diagnostics(
            auth_url=result.get("auth_url"),
            auth_state=result.get("auth_state"),
            callback_url=callback_url,
            auth_url_ts=auth_url_ts,
            callback_capture_ts=callback_capture_ts,
            callback_submit_ts=callback_submit_ts,
        )
        result["auth_state"] = diag["auth_state"]
        result["callback_state"] = diag["callback_state"]
        result["state_match"] = diag["state_match"]
        result["timing"] = {
            "auth_to_callback_seconds": diag["auth_to_callback_seconds"],
            "callback_to_submit_seconds": diag["callback_to_submit_seconds"],
            "auth_to_submit_seconds": diag["auth_to_submit_seconds"],
        }
        log(
            "OAuth diag: "
            f"auth_state={mask_state(result['auth_state'])}, "
            f"callback_state={mask_state(result['callback_state'])}, "
            f"match={result['state_match']}, "
            f"auth_to_callback={result['timing']['auth_to_callback_seconds']}s"
        )

        callback_submit_ts = time.time()
        api_result = submit_callback_via_api(cpa_url, cpa_password, callback_url)
        result["api_result"] = api_result
        result["success"] = bool(api_result.get("ok"))
        diag = build_state_timing_diagnostics(
            auth_url=result.get("auth_url"),
            auth_state=result.get("auth_state"),
            callback_url=callback_url,
            auth_url_ts=auth_url_ts,
            callback_capture_ts=callback_capture_ts,
            callback_submit_ts=callback_submit_ts,
        )
        result["auth_state"] = diag["auth_state"]
        result["callback_state"] = diag["callback_state"]
        result["state_match"] = diag["state_match"]
        result["timing"] = {
            "auth_to_callback_seconds": diag["auth_to_callback_seconds"],
            "callback_to_submit_seconds": diag["callback_to_submit_seconds"],
            "auth_to_submit_seconds": diag["auth_to_submit_seconds"],
        }
        if not result["success"]:
            api_data = api_result.get("data") if isinstance(api_result.get("data"), dict) else {}
            api_err = str(api_data.get("error") or api_data.get("message") or "")
            result["error"] = (
                f"CPA API rejected callback. status={api_result.get('status_code')}"
                + (f", error={api_err}" if api_err else "")
            )
            log(
                "OAuth submit diag: "
                f"status={api_result.get('status_code')}, "
                f"match={result['state_match']}, "
                f"auth_to_submit={result['timing']['auth_to_submit_seconds']}s, "
                f"callback_to_submit={result['timing']['callback_to_submit_seconds']}s"
            )

    except Exception as e:
        result["error"] = str(e)
    finally:
        _log_ctx.cfg = prev_cfg
        if browser:
            turnstile_bypass.safe_quit_browser(browser, force=True, timeout=5.0, user_data_dir=profile_dir)
        if profile_dir:
            try:
                turnstile_bypass.kill_browser_processes_for_user_data_dir(profile_dir, timeout=5.0)
            except Exception:
                pass
            shutil.rmtree(profile_dir, ignore_errors=True)

    return result


def main() -> int:
    parser = argparse.ArgumentParser(description="Single CPA OAuth callback test")
    parser.add_argument("--cpa-url", default=os.environ.get("CPA_BASE_URL", DEFAULT_CPA_URL), help="CPA base URL")
    parser.add_argument("--cpa-password", default=os.environ.get("CPA_PASSWORD", DEFAULT_CPA_PASSWORD), help="CPA management password/key")
    parser.add_argument("--account-file", default="gpt.txt", help="Account file path")
    parser.add_argument("--index", type=int, default=-1, help="Account index in account file (default: -1)")
    parser.add_argument("--callback-url", default=None, help="Direct callback URL; if set, skip browser capture")
    parser.add_argument("--headless", action="store_true", help="Run browser headless")
    args = parser.parse_args()

    try:
        accounts = load_accounts(args.account_file)
        account = pick_account(accounts, args.index)
    except Exception as e:
        print(f"[ERROR] Account load failed: {e}")
        return 1

    print("=" * 60)
    print("  Single CPA Callback Test")
    print("=" * 60)
    print(f"  CPA URL: {args.cpa_url}")
    print(f"  Account: {mask_email(account.email)}")
    print(f"  Account file/index: {args.account_file} / {args.index}")
    print(f"  Headless: {'yes' if args.headless else 'no'}")
    print(f"  Direct callback mode: {'yes' if bool(args.callback_url) else 'no'}")
    print("=" * 60)

    result = run_cpa_callback_test(
        cpa_url=args.cpa_url,
        cpa_password=args.cpa_password,
        account=account,
        callback_url=args.callback_url,
        headless=args.headless,
    )

    print()
    print("=" * 60)
    print("  CPA Callback Result")
    print("=" * 60)
    print(f"  success: {result.get('success')}")
    print(f"  error: {result.get('error')}")
    print(f"  auth_url: {result.get('auth_url')}")
    print(f"  auth_state: {result.get('auth_state')}")
    print(f"  callback_url: {result.get('callback_url')}")
    api = result.get("api_result") or {}
    print(f"  api.ok: {api.get('ok')}")
    print(f"  api.status_code: {api.get('status_code')}")
    data = api.get("data")
    if isinstance(data, dict):
        print(f"  api.data: {json.dumps(data, ensure_ascii=False)[:300]}")
    else:
        print(f"  api.data: {str(data)[:300]}")
    print("=" * 60)

    return 0 if result.get("success") else 1


if __name__ == "__main__":
    raise SystemExit(main())
