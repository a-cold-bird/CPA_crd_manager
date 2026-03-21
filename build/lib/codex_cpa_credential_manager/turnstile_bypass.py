"""
Turnstile Bypass Module for DrissionPage
Uses a Chrome extension to patch MouseEvent properties and shadow DOM to click the checkbox.
"""

import os
import tempfile
import json
import shutil
import subprocess
from typing import Optional
from sys import platform

try:
    from DrissionPage import Chromium, ChromiumOptions
except ImportError:
    subprocess.check_call(['pip', 'install', 'DrissionPage'])
    from DrissionPage import Chromium, ChromiumOptions


# Chrome extension manifest - runs script in MAIN world for all frames
MANIFEST_CONTENT = {
    "manifest_version": 3,
    "name": "Turnstile Patcher",
    "version": "0.1",
    "content_scripts": [{
        "js": ["./script.js"],
        "matches": ["<all_urls>"],
        "run_at": "document_start",
        "all_frames": True,
        "world": "MAIN"
    }]
}

# Script that patches MouseEvent prototype to bypass Turnstile detection
SCRIPT_CONTENT = """
function getRandomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}
let screenX = getRandomInt(800, 1200);
let screenY = getRandomInt(400, 600);
Object.defineProperty(MouseEvent.prototype, 'screenX', { value: screenX, configurable: true });
Object.defineProperty(MouseEvent.prototype, 'screenY', { value: screenY, configurable: true });

Object.defineProperty(navigator, 'webdriver', { get: () => undefined, configurable: true });
Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'], configurable: true });
Object.defineProperty(navigator, 'platform', { get: () => 'Win32', configurable: true });
Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5], configurable: true });

if (!window.chrome) {
    Object.defineProperty(window, 'chrome', {
        value: { runtime: {} },
        configurable: true
    });
}
"""


def _create_extension() -> str:
    """Create temporary extension directory with manifest and script."""
    temp_dir = tempfile.mkdtemp(prefix='turnstile_extension_')

    try:
        # Write manifest.json
        manifest_path = os.path.join(temp_dir, 'manifest.json')
        with open(manifest_path, 'w', encoding='utf-8') as f:
            json.dump(MANIFEST_CONTENT, f, indent=4)

        # Write script.js
        script_path = os.path.join(temp_dir, 'script.js')
        with open(script_path, 'w', encoding='utf-8') as f:
            f.write(SCRIPT_CONTENT.strip())

        return temp_dir

    except Exception as e:
        _cleanup_extension(temp_dir)
        raise Exception(f"Failed to create extension: {e}")


def _cleanup_extension(path: str):
    """Clean up temporary extension files."""
    try:
        if os.path.exists(path):
            shutil.rmtree(path)
    except Exception as e:
        print(f"Failed to clean up temp files: {e}")


def get_patched_browser(options: ChromiumOptions = None, headless: bool = False) -> Chromium:
    """
    Create a browser instance with Turnstile bypass extension loaded.

    Args:
        options: ChromiumOptions object, if None creates default config
        headless: Whether to run in headless mode

    Returns:
        Chromium: Configured browser instance with Turnstile bypass
    """
    # Determine platform-specific user agent
    platform_id = "Windows NT 10.0; Win64; x64"
    if platform == "linux" or platform == "linux2":
        platform_id = "X11; Linux x86_64"
    elif platform == "darwin":
        platform_id = "Macintosh; Intel Mac OS X 10_15_7"

    user_agent = f"Mozilla/5.0 ({platform_id}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.6943.99 Safari/537.36"

    if options is None:
        options = ChromiumOptions().auto_port()

    if headless is True:
        options.headless(True)

    # Browser disguise (aligned with GPT_team_helper automation profile)
    options.set_user_agent(user_agent)
    options.set_pref("intl.accept_languages", "en-US,en")
    options.set_argument("--lang=en-US")
    options.set_argument("--window-size=1920,1080")
    options.set_argument("--no-sandbox")
    options.set_argument("--disable-setuid-sandbox")
    options.set_argument("--disable-dev-shm-usage")
    options.set_argument("--disable-accelerated-2d-canvas")
    options.set_argument("--disable-gpu")
    options.set_argument("--disable-blink-features=AutomationControlled")
    options.set_argument("--disable-web-security")
    options.set_argument("--disable-features=IsolateOrigins,site-per-process")

    # Validation checks
    if "--blink-settings=imagesEnabled=false" in options._arguments:
        raise RuntimeError("To bypass Turnstile, imagesEnabled must be True")
    if "--incognito" in options._arguments:
        raise RuntimeError("Cannot bypass Turnstile in incognito mode. Please run in normal browser mode.")

    extension_path = None
    try:
        extension_path = _create_extension()
        options.add_extension(extension_path)
        browser = Chromium(options)
        # Clean up extension after browser loads it
        shutil.rmtree(extension_path)
        return browser

    except Exception as e:
        if extension_path and os.path.exists(extension_path):
            shutil.rmtree(extension_path)
        raise e


def _kill_browser_process_tree(pid: int, timeout: float = 5.0) -> bool:
    """Best-effort kill for leaked browser process tree on Windows."""
    if os.name != "nt":
        return False
    try:
        pid_int = int(pid)
    except Exception:
        return False
    if pid_int <= 0:
        return False

    try:
        completed = subprocess.run(
            ["taskkill", "/PID", str(pid_int), "/T", "/F"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=timeout,
            check=False,
        )
        return completed.returncode == 0
    except Exception:
        return False


def _is_browser_process_running(pid: int, timeout: float = 3.0) -> bool:
    """Check whether a browser-like process with given pid still exists on Windows."""
    if os.name != "nt":
        return False
    try:
        pid_int = int(pid)
    except Exception:
        return False
    if pid_int <= 0:
        return False

    try:
        completed = subprocess.run(
            ["tasklist", "/FI", f"PID eq {pid_int}", "/FO", "CSV", "/NH"],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=timeout,
            check=False,
            text=True,
            encoding="utf-8",
            errors="ignore",
        )
        line = (completed.stdout or "").strip().lower()
        if not line or line.startswith("info:"):
            return False
        if f'"{pid_int}"' not in line:
            return False
        return any(name in line for name in ("chrome.exe", "msedge.exe", "chromium"))
    except Exception:
        return False


def kill_browser_processes_for_user_data_dir(user_data_dir: Optional[str], timeout: float = 5.0) -> int:
    """
    Kill browser processes whose command line references a specific user-data-dir.
    This is a fallback for cases where browser.quit() returns but child processes remain.
    """
    if os.name != "nt":
        return 0
    target = str(user_data_dir or "").strip()
    if not target:
        return 0
    escaped = target.replace("'", "''")
    ps_script = (
        "$target = '" + escaped + "';"
        "$killed = 0;"
        "Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | "
        "Where-Object { $_.CommandLine -and ($_.Name -match '^(chrome|msedge|chromium)\\.exe$') -and $_.CommandLine.Contains($target) } | "
        "ForEach-Object { "
        "try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop; $script:killed++ } catch {} "
        "}; "
        "Write-Output $killed;"
    )
    try:
        completed = subprocess.run(
            ["powershell", "-NoProfile", "-Command", ps_script],
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            timeout=timeout,
            check=False,
            text=True,
            encoding="utf-8",
            errors="ignore",
        )
        raw = (completed.stdout or "").strip().splitlines()
        if not raw:
            return 0
        return int(raw[-1].strip())
    except Exception:
        return 0


def safe_quit_browser(
    browser: Optional[Chromium],
    force: bool = True,
    timeout: float = 5.0,
    kill_fallback: bool = True,
    user_data_dir: Optional[str] = None,
) -> bool:
    """
    Close Chromium reliably.

    DrissionPage's default quit() may leave background chromium processes in some cases.
    This wrapper uses force quit first, then taskkill by browser pid as fallback.
    """
    if browser is None:
        return True

    browser_pid = None
    try:
        browser_pid = getattr(browser, "process_id", None)
    except Exception:
        browser_pid = None

    closed = False
    try:
        if force:
            browser.quit(timeout=timeout, force=True)
        else:
            browser.quit()
        closed = True
    except Exception:
        closed = False

    if kill_fallback and browser_pid and _is_browser_process_running(browser_pid):
        _kill_browser_process_tree(browser_pid, timeout=timeout)
    if kill_fallback and user_data_dir:
        kill_browser_processes_for_user_data_dir(user_data_dir, timeout=timeout)

    return closed


def click_turnstile_checkbox(tab, timeout: int = 30) -> bool:
    """
    Wait for Turnstile to load and click the checkbox using shadow DOM traversal.

    This is the key function - it navigates through the shadow DOM hierarchy
    to find and click the actual checkbox element inside the Turnstile iframe.

    Args:
        tab: ChromiumTab object from get_patched_browser()
        timeout: Maximum wait time in seconds

    Returns:
        bool: True if Turnstile verification passed, False otherwise
    """
    try:
        # Wait for Turnstile response element to appear
        if not tab.wait.eles_loaded("@name=cf-turnstile-response", timeout=timeout):
            print("Turnstile component not detected on page")
            return False

        # Navigate through shadow DOM hierarchy:
        # 1. Find the hidden input element
        solution = tab.ele("@name=cf-turnstile-response")

        # 2. Get its parent wrapper (cf-turnstile div)
        wrapper = solution.parent()

        # 3. Access shadow root and find the iframe inside
        iframe = wrapper.shadow_root.ele("tag:iframe")

        # 4. Get iframe body's shadow root
        iframe_body = iframe.ele("tag:body").shadow_root

        # 5. Find the checkbox input inside
        checkbox = iframe_body.ele("tag:input", timeout=20)

        # 6. Find the success indicator
        success = iframe_body.ele("@id=success")

        # 7. Click the checkbox
        checkbox.click()

        # 8. Wait for success indicator to appear
        if tab.wait.ele_displayed(success, timeout=3):
            return True
        else:
            # Sometimes need a second click
            try:
                checkbox.click()
                return tab.wait.ele_displayed(success, timeout=3)
            except:
                return False

    except Exception as e:
        print(f"Turnstile handling failed: {e}")
        return False


def get_turnstile_token(tab, timeout: int = 30) -> str:
    """
    Get the Turnstile token value after successful verification.

    Args:
        tab: ChromiumTab object
        timeout: Maximum wait time

    Returns:
        str: The Turnstile token, or empty string if not found
    """
    try:
        if tab.wait.eles_loaded("@name=cf-turnstile-response", timeout=timeout):
            solution = tab.ele("@name=cf-turnstile-response")
            token = solution.attr("value") or solution.value
            return token if token else ""
        return ""
    except Exception as e:
        print(f"Failed to get Turnstile token: {e}")
        return ""


if __name__ == "__main__":
    # Test the bypass on a Turnstile demo page
    print("Testing Turnstile bypass...")

    browser = get_patched_browser(headless=False)
    tab = browser.latest_tab

    tab.get("https://turnstile.zeroclover.io/")
    print(f"Clicking Turnstile: {click_turnstile_checkbox(tab)}")

    # Try to submit
    submit_btn = tab.ele("@type=submit")
    if submit_btn:
        submit_btn.click()
        tab.wait.load_start()

        if tab.ele("Captcha success!"):
            print("Captcha success!")
        elif tab.ele("Captcha failed!"):
            print("Captcha failed!")

    input("Press Enter to close browser...")
    browser.quit()
