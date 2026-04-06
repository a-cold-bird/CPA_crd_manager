import json
import threading
import time


_thread_local = threading.local()


def _close_thread_runtime():
    runtime = getattr(_thread_local, "runtime", None)
    if not runtime:
        return

    browser = runtime.get("browser")
    playwright = runtime.get("playwright")

    try:
        if browser:
            browser.close()
    except Exception:
        pass

    try:
        if playwright:
            playwright.stop()
    except Exception:
        pass

    _thread_local.runtime = None


def _ensure_thread_runtime(headless=True):
    runtime = getattr(_thread_local, "runtime", None)
    if runtime and runtime.get("headless") == bool(headless):
        return runtime

    _close_thread_runtime()

    from playwright.sync_api import sync_playwright

    p = sync_playwright().start()
    browser = p.chromium.launch(
        headless=bool(headless),
        args=["--no-sandbox", "--disable-blink-features=AutomationControlled"],
    )
    runtime = {
        "playwright": p,
        "browser": browser,
        "headless": bool(headless),
        "created_at": time.time(),
        "uses": 0,
    }
    _thread_local.runtime = runtime
    return runtime


def prepare_sentinel_browser_runtime(headless=True):
    try:
        _ensure_thread_runtime(headless=headless)
        return True
    except Exception:
        return False


def get_sentinel_token_via_browser(
    flow="username_password_create",
    user_agent=None,
    accept_language=None,
    proxy=None,
    timeout_ms=45000,
    frame_url=None,
    headless=True,
    reuse_limit=30,
    max_age_seconds=900,
):
    try:
        runtime = _ensure_thread_runtime(headless=headless)
    except Exception:
        return None

    ua = (
        str(user_agent or "").strip()
        or "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36 Edg/146.0.0.0"
    )
    target_frame_url = (
        str(frame_url or "").strip()
        or "https://sentinel.openai.com/backend-api/sentinel/frame.html"
    )
    proxy_value = str(proxy or "").strip()
    accept_language_value = str(accept_language or "en-US,en;q=0.9").strip()
    locale = accept_language_value.split(",", 1)[0].split(";", 1)[0].strip() or "en-US"
    sdk_timeout_ms = max(10_000, min(int(timeout_ms) - 5_000, 30_000))

    context = None
    page = None
    try:
        context_kwargs = {
            "viewport": {"width": 1920, "height": 1080},
            "user_agent": ua,
            "locale": locale,
            "ignore_https_errors": True,
        }
        if proxy_value:
            context_kwargs["proxy"] = {"server": proxy_value}

        context = runtime["browser"].new_context(**context_kwargs)
        context.set_extra_http_headers({"Accept-Language": accept_language_value})
        page = context.new_page()
        page.goto(target_frame_url, wait_until="domcontentloaded", timeout=timeout_ms)
        page.wait_for_function(
            "() => typeof window.SentinelSDK !== 'undefined' && typeof window.SentinelSDK.token === 'function'",
            timeout=min(timeout_ms, 30000),
        )

        result = page.evaluate(
            """async ({ flowName, sdkTimeoutMs }) => {
                try {
                    const token = await Promise.race([
                        window.SentinelSDK.token(flowName),
                        new Promise((_, reject) => {
                            setTimeout(() => reject(new Error(`SentinelSDK.token timeout after ${sdkTimeoutMs}ms`)), sdkTimeoutMs);
                        }),
                    ]);
                    return { ok: true, token };
                } catch (e) {
                    return { ok: false, error: String(e && e.message ? e.message : e) };
                }
            }""",
            {
                "flowName": str(flow or "username_password_create"),
                "sdkTimeoutMs": int(sdk_timeout_ms),
            },
        )

        token = (result or {}).get("token") if isinstance(result, dict) else None
        if not token:
            return None

        try:
            payload = json.loads(token)
            if not (
                isinstance(payload, dict)
                and payload.get("p")
                and payload.get("c")
                and payload.get("t")
            ):
                return None
        except Exception:
            return None

        return token
    finally:
        try:
            if page:
                page.close()
        except Exception:
            pass
        try:
            if context:
                context.close()
        except Exception:
            pass

        runtime["uses"] = int(runtime.get("uses", 0)) + 1
        runtime_age = time.time() - float(runtime.get("created_at") or time.time())
        if runtime["uses"] >= int(reuse_limit) or runtime_age >= float(max_age_seconds):
            _close_thread_runtime()
