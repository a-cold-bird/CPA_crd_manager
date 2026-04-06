import argparse
import contextlib
import io
import logging
import os
import sys
from typing import Any, Dict, List

from replenish_codex import (
    configure_internal_register_environment,
    detect_changed_register_tokens,
    disable_process_proxy_env,
    get_register_token_dir,
    load_config,
    load_internal_register_module,
    process_token_for_cpa,
    snapshot_register_token_files,
)


def _extract_failure_reason(events: List[Dict[str, Any]]) -> str:
    for event in events:
        if event.get("type") == "account_failed":
            reason = str(event.get("error") or "").strip()
            if reason:
                return reason
    for event in events:
        if event.get("type") == "account_attempt_failed":
            reason = str(event.get("error") or "").strip()
            if reason:
                return reason
    for event in events:
        if event.get("type") == "account_succeeded" and not bool(event.get("oauth_ok")):
            oauth_error = str(event.get("oauth_error") or "").strip()
            if oauth_error:
                return f"oauth failed: {oauth_error}"
            return "oauth failed"
    return "unknown error"


def _filter_relevant_logs(raw_text: str) -> List[str]:
    lines = []
    for line in str(raw_text or "").splitlines():
        text = line.strip()
        if not text:
            continue
        if "HTTP Request: GET http://127.0.0.1:19000/api/v1/mailbox/" in text:
            continue
        lower = text.lower()
        if (
            "[oauth]" in lower
            or "authorization_code" in lower
            or "add-phone" in lower
            or "consent" in lower
        ):
            lines.append(text)
    return lines[-30:]


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Simple inbucket register + upload runner (no proxy)."
    )
    parser.add_argument(
        "--total",
        type=int,
        default=1,
        help="Total accounts to register",
    )
    parser.add_argument(
        "--workers",
        type=int,
        default=1,
        help="Concurrent registration workers",
    )
    args = parser.parse_args()

    if args.total <= 0:
        print("[FAIL] reason=--total must be > 0")
        return 2

    # Suppress noisy HTTP polling logs from mailbox requests.
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("httpcore").setLevel(logging.WARNING)

    config_path = os.path.join("frontend", "config.yaml")
    output_path = os.path.join("runtime", "simple_registered_accounts.txt")

    config = load_config(config_path)
    cpa_url = str(config.get("cpa_url") or "").strip()
    management_key = str(config.get("management_key") or "").strip()
    if not cpa_url or not management_key:
        print("[FAIL] reason=config missing cpa_url or management_key")
        return 2

    os.makedirs(os.path.dirname(output_path) or ".", exist_ok=True)

    disable_process_proxy_env()
    configure_internal_register_environment(config)
    register = load_internal_register_module(config)

    register_token_dir = get_register_token_dir()
    before_snapshot = snapshot_register_token_files(register_token_dir)

    events: List[Dict[str, Any]] = []

    def hook(event_type: str, **kwargs: Any) -> None:
        payload = {"type": event_type}
        payload.update(kwargs)
        events.append(payload)

    silent_stdout = io.StringIO()
    silent_stderr = io.StringIO()
    with (
        contextlib.redirect_stdout(silent_stdout),
        contextlib.redirect_stderr(silent_stderr),
    ):
        register.run_batch(
            total_accounts=args.total,
            output_file=output_path,
            max_workers=max(1, int(args.workers)),
            proxy=None,
            email_provider="inbucket",
            email_domain=None,
            extract_codex=True,
            use_proxy=False,
            progress_hook=hook,
            debug=False,
        )

    after_snapshot = snapshot_register_token_files(register_token_dir)
    changed_files = detect_changed_register_tokens(before_snapshot, after_snapshot)

    uploaded = 0
    upload_failed = 0
    upload_failure_reasons: List[str] = []
    for file_name in changed_files:
        full_path = os.path.join(register_token_dir, file_name)
        result = process_token_for_cpa(
            cpa_url,
            management_key,
            full_path,
            validate_before_upload=False,
            cleanup_on_success=True,
        )
        if bool(result.get("uploaded")):
            uploaded += 1
        else:
            upload_failed += 1
            reason = str(result.get("failure_reason") or "upload failed").strip()
            upload_failure_reasons.append(f"{file_name}: {reason}")

    batch_finished = [e for e in events if e.get("type") == "batch_finished"]
    success_count = (
        int(batch_finished[-1].get("success_count", 0)) if batch_finished else 0
    )
    fail_count = int(batch_finished[-1].get("fail_count", 0)) if batch_finished else 0

    if uploaded > 0:
        print(
            f"[SUCCESS] registered={success_count} failed={fail_count} uploaded={uploaded} output={output_path}"
        )
        return 0

    reason = _extract_failure_reason(events)
    if upload_failed > 0 and upload_failure_reasons:
        reason = upload_failure_reasons[0]
    elif not changed_files:
        reason = f"no token files generated ({reason})"

    print(
        f"[FAIL] registered={success_count} failed={fail_count} uploaded={uploaded} reason={reason}"
    )
    relevant_logs = _filter_relevant_logs(
        "\n".join([silent_stdout.getvalue(), silent_stderr.getvalue()])
    )
    if relevant_logs:
        print("[DETAILS]")
        for line in relevant_logs:
            print(f"- {line}")
    return 1


if __name__ == "__main__":
    sys.exit(main())
