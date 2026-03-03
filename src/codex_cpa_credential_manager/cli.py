import argparse
import json
import os
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple


def _bootstrap_local_modules() -> None:
    pkg_dir = Path(__file__).resolve().parent
    pkg_text = str(pkg_dir)
    if pkg_text not in sys.path:
        sys.path.insert(0, pkg_text)


_bootstrap_local_modules()

from login_utils import AccountRecord, load_accounts, parse_account_line  # type: ignore  # noqa: E402
from cpa_callback_test import run_cpa_callback_test  # type: ignore  # noqa: E402


def _json_print(payload: Dict[str, Any]) -> None:
    print(json.dumps(payload, ensure_ascii=False, indent=2))


def _parse_indexes_csv(raw: str) -> List[int]:
    text = str(raw or "").strip()
    if not text:
        return []
    items: List[int] = []
    for part in text.split(","):
        part = part.strip()
        if not part:
            continue
        try:
            idx = int(part)
        except Exception:
            continue
        if idx >= 0:
            items.append(idx)
    return sorted(set(items))


def _select_indexes(total: int, start: int, limit: int, indexes: str) -> List[int]:
    explicit = _parse_indexes_csv(indexes)
    if explicit:
        return [idx for idx in explicit if 0 <= idx < total]

    begin = max(0, int(start or 0))
    if begin >= total:
        return []
    if int(limit or 0) <= 0:
        return list(range(begin, total))
    end = min(total, begin + int(limit))
    return list(range(begin, end))


def _read_lines(path: str) -> List[str]:
    p = Path(path)
    if not p.exists():
        return []
    return p.read_text(encoding="utf-8-sig").splitlines(keepends=True)


def _write_lines(path: str, lines: List[str]) -> None:
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text("".join(lines), encoding="utf-8")


def _load_submitted_emails(success_file: str) -> set[str]:
    emails: set[str] = set()
    for line in _read_lines(success_file):
        text = line.strip()
        if not text:
            continue
        email = text.split("----", 1)[0].strip().lower()
        if email:
            emails.add(email)
    return emails


def _append_text(path: str, text: str) -> None:
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    with p.open("a", encoding="utf-8") as wf:
        wf.write(text)


def _timestamp() -> str:
    return time.strftime("%H:%M:%S")


def _append_detail_log(path: str, message: str) -> None:
    if not path:
        return
    _append_text(path, f"[{_timestamp()}] {message}\n")


def _extract_submit_fields(api_result: Dict[str, Any], success: bool, error: Optional[str]) -> Tuple[int, str, str, str]:
    status_code = int(api_result.get("status_code") or 0)
    data = api_result.get("data")
    data_dict = data if isinstance(data, dict) else {}
    submit_error = str(data_dict.get("error") or "")
    auth_status = "ok" if success else str(data_dict.get("status") or "not_checked")
    auth_error = str(data_dict.get("error") or "") if not success else ""
    final_error = str(error or submit_error or auth_error or "").strip()
    return status_code, auth_status, auth_error, final_error


def _is_transient_browser_error(message: str) -> bool:
    text = str(message or "").strip().lower()
    if not text:
        return False
    hints = (
        "nonetype' object has no attribute 'send'",
        "handshake status 404",
        "websocketbadstatusexception",
        "browserconnecterror",
        "浏览器连接失败",
        "connection refused",
        "devtools",
    )
    return any(hint in text for hint in hints)


def _run_oauth_login(
    cpa_url: str,
    management_key: str,
    account: AccountRecord,
    headless: bool,
    callback_url: str = "",
) -> Dict[str, Any]:
    transient_retries = int(os.environ.get("OAUTH_TRANSIENT_RETRIES", "1") or 1)
    max_attempts = max(1, transient_retries + 1)
    fallback_headed_raw = str(os.environ.get("OAUTH_FALLBACK_HEADED", "1") or "").strip().lower()
    fallback_headed = fallback_headed_raw not in ("0", "false", "no", "off")
    current_headless = bool(headless)
    last_payload: Optional[Dict[str, Any]] = None

    for attempt in range(1, max_attempts + 1):
        result = run_cpa_callback_test(
            cpa_url=cpa_url,
            cpa_password=management_key,
            account=account,
            callback_url=callback_url or None,
            headless=current_headless,
            verbose=True,
        )
        api_result = result.get("api_result") or {}
        success = bool(result.get("success"))
        status_code, auth_status, auth_error, final_error = _extract_submit_fields(
            api_result=api_result,
            success=success,
            error=result.get("error"),
        )

        detail = {
            "success": success,
            "error": final_error or None,
            "account": account.email,
            "auth_url": result.get("auth_url") or "",
            "auth_state": result.get("auth_state") or "",
            "callback_url": result.get("callback_url") or "",
            "callback_state": result.get("callback_state") or "",
            "state_match": result.get("state_match"),
            "submit_http_status": status_code,
            "submit_error": final_error,
            "auth_status": auth_status,
            "auth_error": auth_error,
            "internal_attempt": attempt,
            "internal_max_attempts": max_attempts,
            "run_headless": bool(current_headless),
        }

        payload = {
            "status": "ok" if success else "error",
            "error": final_error,
            "provider": "codex",
            "state": str(detail.get("callback_state") or detail.get("auth_state") or ""),
            "http_status": status_code,
            "report_file": "",
            "detail": detail,
        }
        last_payload = payload

        if success:
            return payload

        if attempt >= max_attempts or not _is_transient_browser_error(final_error):
            return payload

        next_headless = current_headless
        if fallback_headed and current_headless:
            next_headless = False

        print(
            f"[{time.strftime('%H:%M:%S')}] [oauth-login] transient browser error, retry "
            f"{attempt}/{max_attempts}: {final_error} (next_headless={'yes' if next_headless else 'no'})"
        )
        current_headless = next_headless
        time.sleep(1.0)

    return last_payload or {
        "status": "error",
        "error": "oauth login failed with unknown error",
        "provider": "codex",
        "state": "",
        "http_status": 0,
        "report_file": "",
        "detail": {"success": False, "error": "oauth login failed with unknown error", "submit_http_status": 0, "auth_status": "not_checked"},
    }


def cmd_oauth_account_preview(args: argparse.Namespace) -> int:
    try:
        accounts = load_accounts(args.account_file)
    except Exception as error:
        _json_print({"error": f"failed to load account file: {error}"})
        return 1

    total = len(accounts)
    mode = "single" if str(args.mode or "batch").strip().lower() == "single" else "batch"

    if mode == "single":
        idx = int(args.index)
        if idx < 0 or idx >= total:
            _json_print({"error": f"index out of range: {idx}"})
            return 1
        indexes = [idx]
    else:
        indexes = _select_indexes(total=total, start=int(args.start), limit=int(args.limit), indexes="")

    payload_accounts = []
    for idx in indexes:
        item = accounts[idx]
        payload_accounts.append(
            {
                "index": idx,
                "email": item.email,
                "provider": str(args.provider or "codex"),
                "channel": str(args.provider or "codex"),
                "has_access_token": bool(item.access_token),
                "has_recovery_email": False,
                "has_totp_url": False,
            }
        )

    _json_print(
        {
            "mode": mode,
            "total_accounts": total,
            "selected": len(indexes),
            "indexes": indexes,
            "accounts": payload_accounts,
        }
    )
    return 0


def cmd_oauth_account_delete(args: argparse.Namespace) -> int:
    delete_indexes = _parse_indexes_csv(args.indexes)
    if not delete_indexes:
        _json_print({"error": "indexes is required"})
        return 1

    lines = _read_lines(args.account_file)
    if not lines:
        _json_print({"error": f"account file not found or empty: {args.account_file}"})
        return 1

    delete_set = set(delete_indexes)
    valid_idx = -1
    deleted = 0
    kept: List[str] = []
    hit: set[int] = set()

    for line in lines:
        parsed = parse_account_line(line.strip())
        if parsed is None:
            kept.append(line)
            continue
        valid_idx += 1
        if valid_idx in delete_set:
            deleted += 1
            hit.add(valid_idx)
            continue
        kept.append(line)

    missing = sorted([idx for idx in delete_indexes if idx not in hit])

    _write_lines(args.account_file, kept)

    detail = {
        "file": args.account_file,
        "provider": str(args.provider or "codex"),
        "requested": len(delete_indexes),
        "deleted": deleted,
        "missing": len(missing),
        "missing_indexes": missing,
        "total_before": valid_idx + 1,
        "total_after": (valid_idx + 1) - deleted,
    }
    _json_print({"detail": detail})
    return 0


def cmd_oauth_login(args: argparse.Namespace) -> int:
    try:
        accounts = load_accounts(args.account_file)
        idx = int(args.index)
        account = accounts[idx]
    except Exception as error:
        _json_print(
            {
                "status": "error",
                "error": f"failed to load account: {error}",
                "provider": "codex",
                "state": "",
                "http_status": 0,
                "report_file": "",
                "detail": {"success": False, "error": f"failed to load account: {error}", "submit_http_status": 0, "auth_status": "not_checked"},
            }
        )
        return 1

    try:
        payload = _run_oauth_login(
            cpa_url=args.cpa_url,
            management_key=args.management_key,
            account=account,
            headless=bool(args.headless),
            callback_url=str(args.callback_url or ""),
        )
        _json_print(payload)
        return 0 if payload.get("status") == "ok" else 1
    except Exception as error:
        _json_print(
            {
                "status": "error",
                "error": str(error),
                "provider": "codex",
                "state": "",
                "http_status": 0,
                "report_file": "",
                "detail": {"success": False, "error": str(error), "submit_http_status": 0, "auth_status": "not_checked"},
            }
        )
        return 1


def cmd_oauth_login_batch(args: argparse.Namespace) -> int:
    try:
        accounts = load_accounts(args.account_file)
    except Exception as error:
        _json_print({"error": f"failed to load account file: {error}"})
        return 1

    selected_indexes = _select_indexes(
        total=len(accounts),
        start=int(args.start),
        limit=int(args.limit),
        indexes=str(args.indexes or ""),
    )

    result_file = str(args.result_file or "runtime/batch_login_callback_results.jsonl").strip()
    success_file = str(args.success_file or "runtime/batch_login_callback_success.txt").strip()
    detail_log_file = str(args.detail_log_file or "runtime/batch_login_callback_detail.log").strip()

    Path(result_file).parent.mkdir(parents=True, exist_ok=True)
    Path(success_file).parent.mkdir(parents=True, exist_ok=True)
    Path(detail_log_file).parent.mkdir(parents=True, exist_ok=True)

    if args.dry_run:
        summary = {
            "checked_at_utc": time.strftime("%Y-%m-%d %H:%M:%S UTC", time.gmtime()),
            "mode": "cpa_codex_login_callback_batch",
            "cpa_url": args.cpa_url,
            "total_accounts": len(accounts),
            "selected": len(selected_indexes),
            "workers": 1,
            "retries": int(args.retries),
            "skip_submitted": bool(args.skip_submitted),
            "dry_run": True,
            "success": 0,
            "failed": 0,
            "skipped": 0,
            "result_file": result_file,
            "success_file": success_file,
            "detail_log_file": detail_log_file,
        }
        _json_print(summary)
        return 0

    submitted_emails = _load_submitted_emails(success_file) if args.skip_submitted else set()

    Path(result_file).write_text("", encoding="utf-8")
    if not args.skip_submitted:
        Path(success_file).write_text("", encoding="utf-8")

    success_count = 0
    failed_count = 0
    skipped_count = 0

    for idx in selected_indexes:
        account = accounts[idx]
        email_key = account.email.strip().lower()

        if args.skip_submitted and email_key in submitted_emails:
            skipped_count += 1
            row = {
                "index": idx,
                "email": account.email,
                "success": False,
                "error": "skipped submitted",
                "submit_http_status": 0,
                "auth_status": "skipped",
            }
            _append_text(result_file, json.dumps(row, ensure_ascii=False) + "\n")
            _append_detail_log(detail_log_file, f"[idx={idx}] [email={account.email}] [SKIP] submitted")
            continue

        _append_detail_log(detail_log_file, f"[idx={idx}] [email={account.email}] [FLOW] start")
        payload = _run_oauth_login(
            cpa_url=args.cpa_url,
            management_key=args.management_key,
            account=account,
            headless=bool(args.headless),
            callback_url="",
        )
        detail = payload.get("detail") if isinstance(payload.get("detail"), dict) else {}
        ok = bool(detail.get("success"))
        row = {
            "index": idx,
            "email": account.email,
            "success": ok,
            "error": detail.get("error") if not ok else "",
            "submit_http_status": int(detail.get("submit_http_status") or 0),
            "auth_status": str(detail.get("auth_status") or ""),
            "callback_url": str(detail.get("callback_url") or ""),
            "state_match": detail.get("state_match"),
        }
        _append_text(result_file, json.dumps(row, ensure_ascii=False) + "\n")

        if ok:
            success_count += 1
            submitted_emails.add(email_key)
            success_line = f"{account.email}----{account.password}----{(account.access_token or '')}----{str(detail.get('callback_url') or '')}\n"
            _append_text(success_file, success_line)
            _append_detail_log(detail_log_file, f"[idx={idx}] [email={account.email}] [DONE] success=True")
        else:
            failed_count += 1
            _append_detail_log(detail_log_file, f"[idx={idx}] [email={account.email}] [DONE] success=False error={row['error']}")

        cooldown = float(args.cooldown or 0)
        if cooldown > 0:
            time.sleep(cooldown)

    summary = {
        "checked_at_utc": time.strftime("%Y-%m-%d %H:%M:%S UTC", time.gmtime()),
        "mode": "cpa_codex_login_callback_batch",
        "cpa_url": args.cpa_url,
        "total_accounts": len(accounts),
        "selected": len(selected_indexes),
        "workers": 1,
        "retries": int(args.retries),
        "skip_submitted": bool(args.skip_submitted),
        "dry_run": False,
        "success": success_count,
        "failed": failed_count,
        "skipped": skipped_count,
        "result_file": str(Path(result_file).resolve()),
        "success_file": str(Path(success_file).resolve()),
        "detail_log_file": str(Path(detail_log_file).resolve()),
        "selected_indexes": selected_indexes,
    }
    _json_print(summary)
    return 0 if failed_count == 0 else 1


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="CPA OAuth helper CLI")
    parser.add_argument("--cpa-url", default=os.environ.get("CPA_BASE_URL", "http://127.0.0.1:8317"))
    parser.add_argument("--management-key", default=os.environ.get("CPA_PASSWORD", "sk-39c5bb"))
    parser.add_argument("--timeout", type=int, default=35)

    sub = parser.add_subparsers(dest="command", required=True)

    p_preview = sub.add_parser("oauth-account-preview")
    p_preview.add_argument("--provider", default="codex")
    p_preview.add_argument("--account-file", required=True)
    p_preview.add_argument("--mode", choices=["single", "batch"], default="batch")
    p_preview.add_argument("--index", type=int, default=0)
    p_preview.add_argument("--start", type=int, default=0)
    p_preview.add_argument("--limit", type=int, default=0)
    p_preview.set_defaults(func=cmd_oauth_account_preview)

    p_delete = sub.add_parser("oauth-account-delete")
    p_delete.add_argument("--provider", default="codex")
    p_delete.add_argument("--account-file", required=True)
    p_delete.add_argument("--indexes", required=True)
    p_delete.set_defaults(func=cmd_oauth_account_delete)

    p_login = sub.add_parser("oauth-login")
    p_login.add_argument("--provider", default="codex")
    p_login.add_argument("--account-file", required=True)
    p_login.add_argument("--index", type=int, default=0)
    p_login.add_argument("--wait-seconds", type=int, default=30)
    p_login.add_argument("--max-wait", type=int, default=180)
    p_login.add_argument("--headless", action="store_true")
    p_login.add_argument("--callback-url", default="")
    p_login.set_defaults(func=cmd_oauth_login)

    p_batch = sub.add_parser("oauth-login-batch")
    p_batch.add_argument("--provider", default="codex")
    p_batch.add_argument("--account-file", required=True)
    p_batch.add_argument("--start", type=int, default=0)
    p_batch.add_argument("--limit", type=int, default=0)
    p_batch.add_argument("--indexes", default="")
    p_batch.add_argument("--workers", type=int, default=1)
    p_batch.add_argument("--retries", type=int, default=0)
    p_batch.add_argument("--wait-seconds", type=int, default=30)
    p_batch.add_argument("--max-wait", type=int, default=180)
    p_batch.add_argument("--headless", action="store_true")
    p_batch.add_argument("--callback-file", default="")
    p_batch.add_argument("--skip-submitted", action="store_true")
    p_batch.add_argument("--cooldown", type=float, default=0.0)
    p_batch.add_argument("--result-file", default="runtime/batch_login_callback_results.jsonl")
    p_batch.add_argument("--success-file", default="runtime/batch_login_callback_success.txt")
    p_batch.add_argument("--detail-log-file", default="runtime/batch_login_callback_detail.log")
    p_batch.add_argument("--dry-run", action="store_true")
    p_batch.set_defaults(func=cmd_oauth_login_batch)

    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()
    exit_code = int(args.func(args))
    raise SystemExit(exit_code)


if __name__ == "__main__":
    main()
