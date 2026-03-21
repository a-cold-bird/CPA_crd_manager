import json
import os
import threading
from hashlib import sha256


_ROUND_ROBIN_LOCK = threading.Lock()
_ROUND_ROBIN_INDEX = 0


def normalize_proxy(proxy: str):
    if not proxy:
        return ""
    value = str(proxy).strip()
    if not value:
        return ""
    if "://" in value:
        return value
    return f"http://{value}"


def colon_proxy_to_url(raw: str):
    value = str(raw or "").strip()
    if not value:
        return ""
    if "://" in value:
        return normalize_proxy(value)
    parts = value.split(":")
    if len(parts) >= 4:
        host = parts[0].strip()
        port = parts[1].strip()
        username = parts[2].strip()
        password = ":".join(parts[3:]).strip()
        if host and port and username and password:
            return f"http://{username}:{password}@{host}:{port}"
    return normalize_proxy(value)


def load_preferred_proxy(base_dir=None):
    env_proxy = (
        os.environ.get("STABLE_PROXY")
        or os.environ.get("PROXY")
        or os.environ.get("HTTPS_PROXY")
        or os.environ.get("https_proxy")
        or os.environ.get("ALL_PROXY")
        or os.environ.get("all_proxy")
        or ""
    ).strip()
    if env_proxy:
        return normalize_proxy(env_proxy)

    root = base_dir or os.path.dirname(os.path.abspath(__file__))
    config_path = os.path.join(root, "config.json")
    if os.path.exists(config_path):
        try:
            with open(config_path, "r", encoding="utf-8") as f:
                config = json.load(f)
            config_proxy = normalize_proxy(config.get("stable_proxy") or config.get("proxy") or "")
            if config_proxy:
                return config_proxy
        except Exception:
            pass

    stable_proxy_path = os.path.join(root, "stable_proxy.txt")
    if os.path.exists(stable_proxy_path):
        try:
            with open(stable_proxy_path, "r", encoding="utf-8") as f:
                line = f.readline().strip()
            return normalize_proxy(line)
        except Exception:
            pass

    return ""


def load_proxy_candidates(base_dir=None):
    root = base_dir or os.path.dirname(os.path.abspath(__file__))
    candidates = []

    env_proxy = (
        os.environ.get("STABLE_PROXY")
        or os.environ.get("PROXY")
        or os.environ.get("HTTPS_PROXY")
        or os.environ.get("https_proxy")
        or os.environ.get("ALL_PROXY")
        or os.environ.get("all_proxy")
        or ""
    ).strip()
    if env_proxy:
        normalized = normalize_proxy(env_proxy)
        if normalized:
            candidates.append(normalized)

    config_path = os.path.join(root, "config.json")
    if os.path.exists(config_path):
        try:
            with open(config_path, "r", encoding="utf-8") as f:
                config = json.load(f)
            configured = config.get("stable_proxies") or []
            if isinstance(configured, list):
                for item in configured:
                    normalized = colon_proxy_to_url(item)
                    if normalized and normalized not in candidates:
                        candidates.append(normalized)
            config_proxy = normalize_proxy(config.get("stable_proxy") or config.get("proxy") or "")
            if config_proxy and config_proxy not in candidates:
                candidates.append(config_proxy)
        except Exception:
            pass

    stable_proxies_path = os.path.join(root, "stable_proxies.txt")
    if os.path.exists(stable_proxies_path):
        try:
            with open(stable_proxies_path, "r", encoding="utf-8") as f:
                for line in f:
                    normalized = colon_proxy_to_url(line.strip())
                    if normalized and normalized not in candidates:
                        candidates.append(normalized)
        except Exception:
            pass

    stable_proxy_path = os.path.join(root, "stable_proxy.txt")
    if os.path.exists(stable_proxy_path):
        try:
            with open(stable_proxy_path, "r", encoding="utf-8") as f:
                for line in f:
                    normalized = colon_proxy_to_url(line.strip())
                    if normalized and normalized not in candidates:
                        candidates.append(normalized)
        except Exception:
            pass

    return candidates


def select_proxy(proxy_key=None, base_dir=None):
    candidates = load_proxy_candidates(base_dir=base_dir)
    if not candidates:
        return ""

    key = str(proxy_key or "").strip()
    if key:
        digest = sha256(key.encode("utf-8")).hexdigest()
        index = int(digest[:8], 16) % len(candidates)
        return candidates[index]

    global _ROUND_ROBIN_INDEX
    with _ROUND_ROBIN_LOCK:
        proxy = candidates[_ROUND_ROBIN_INDEX % len(candidates)]
        _ROUND_ROBIN_INDEX += 1
        return proxy


def build_proxy_dict(proxy_url: str):
    normalized = normalize_proxy(proxy_url)
    if not normalized:
        return {"http": "", "https": ""}
    return {"http": normalized, "https": normalized}


def build_proxy_dict_for_key(proxy_key=None, base_dir=None):
    return build_proxy_dict(select_proxy(proxy_key=proxy_key, base_dir=base_dir))
