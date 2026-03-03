import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional


@dataclass
class AccountRecord:
    email: str
    password: str
    access_token: Optional[str] = None


def parse_account_line(line: str) -> Optional[AccountRecord]:
    text = (line or "").strip()
    if not text:
        return None
    if text.startswith("#"):
        return None

    # New storage format: JSONL
    if text.startswith("{") and text.endswith("}"):
        try:
            payload = json.loads(text)
        except Exception:
            return None
        if not isinstance(payload, dict):
            return None

        enabled = payload.get("enabled")
        if isinstance(enabled, bool) and not enabled:
            return None

        email = str(payload.get("email") or "").strip()
        password = str(payload.get("password") or "").strip()
        access_token = payload.get("access_token")
        if access_token is not None:
            access_token = str(access_token).strip() or None

        if not email or "@" not in email:
            return None
        if not password:
            return None
        return AccountRecord(email=email, password=password, access_token=access_token)

    parts = text.split("----", 2)
    if len(parts) < 2:
        return None

    email = parts[0].strip()
    password = parts[1].strip()
    access_token = parts[2].strip() if len(parts) == 3 else None
    if access_token == "":
        access_token = None

    if not email or "@" not in email:
        return None
    if not password:
        return None

    return AccountRecord(email=email, password=password, access_token=access_token)


def load_accounts(path: str) -> List[AccountRecord]:
    records: List[AccountRecord] = []
    # utf-8-sig keeps compatibility with Windows BOM files.
    with open(path, "r", encoding="utf-8-sig") as f:
        for line in f:
            item = parse_account_line(line)
            if item:
                records.append(item)
    return records


def export_accounts_jsonl(records: List[AccountRecord], output_path: str) -> Path:
    path = Path(output_path).expanduser().resolve()
    path.parent.mkdir(parents=True, exist_ok=True)
    lines: List[str] = []
    for item in records:
        lines.append(
            json.dumps(
                {
                    "email": item.email,
                    "password": item.password,
                    "access_token": item.access_token or "",
                    "enabled": True,
                    "tags": ["codex"],
                    "note": "",
                },
                ensure_ascii=False,
            )
        )
    path.write_text("\n".join(lines) + ("\n" if lines else ""), encoding="utf-8")
    return path


def pick_account(accounts: List[AccountRecord], index: int = -1) -> AccountRecord:
    if not accounts:
        raise ValueError("No valid account records found.")

    resolved_index = index if index >= 0 else len(accounts) + index
    if resolved_index < 0 or resolved_index >= len(accounts):
        raise IndexError(f"Account index out of range: {index}")

    return accounts[resolved_index]


def build_mailbox_candidates(email: str) -> List[str]:
    items: List[str] = []
    full = (email or "").strip()
    if full:
        items.append(full)
    if "@" in full:
        local = full.split("@", 1)[0].strip()
        if local and local not in items:
            items.append(local)
    return items


def status_has_access_token(status: Dict[str, Any]) -> bool:
    token = status.get("access_token") if isinstance(status, dict) else None
    return isinstance(token, str) and token.strip() != ""


def status_email_matches(status: Dict[str, Any], target_email: str) -> bool:
    if not isinstance(target_email, str) or not target_email.strip():
        return True
    if not isinstance(status, dict):
        return False

    status_email = status.get("email")
    if not isinstance(status_email, str) or not status_email.strip():
        # If API does not provide email, do not block by this field.
        return True

    return status_email.strip().lower() == target_email.strip().lower()


def is_login_success(
    status: Dict[str, Any],
    target_email: str,
    require_access_token: bool = True,
) -> bool:
    if not isinstance(status, dict):
        return False

    if require_access_token and not status_has_access_token(status):
        return False

    if not status_email_matches(status, target_email):
        return False

    if require_access_token:
        return True

    return bool(status.get("logged_in")) or status_has_access_token(status)
