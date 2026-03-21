import re
import sys
from typing import Any


def ensure_utf8_stdio() -> None:
    for stream_name in ("stdout", "stderr"):
        stream = getattr(sys, stream_name, None)
        reconfigure = getattr(stream, "reconfigure", None)
        if callable(reconfigure):
            try:
                reconfigure(encoding="utf-8", errors="replace")
            except Exception:
                pass


def _looks_like_mojibake(text: str) -> bool:
    if not text:
        return False
    non_ascii = sum(1 for ch in text if ord(ch) > 127)
    ascii_count = sum(1 for ch in text if ord(ch) <= 127)
    return non_ascii >= 4 and ascii_count >= 4


def clean_display_text(value: Any) -> str:
    text = str(value)
    if not _looks_like_mojibake(text):
        return text
    cleaned = re.sub(r"[^\x00-\x7F]+", " ", text)
    cleaned = re.sub(r"[?]{2,}", " ", cleaned)
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    return cleaned or "[encoding-cleaned]"
