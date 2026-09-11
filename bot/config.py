"""Runtime configuration for the Konkred Telegram bot.

Every value is overridable via environment variables (see `.env.example`).
The module never raises at import time — `validate()` is called explicitly from
`main.py` so that container healthchecks and unit tests can import it safely.
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from typing import List


def _get(name: str, default: str = "") -> str:
    value = os.getenv(name)
    return default if value is None else str(value).strip()


def _get_int(name: str, default: int) -> int:
    try:
        return int(float(_get(name, "") or default))
    except (TypeError, ValueError):
        return default


def _get_float(name: str, default: float) -> float:
    try:
        return float(_get(name, "") or default)
    except (TypeError, ValueError):
        return default


def _get_bool(name: str, default: bool = False) -> bool:
    raw = _get(name, "").lower()
    if not raw:
        return default
    return raw in {"1", "true", "yes", "y", "on"}


def _get_list(name: str, default: List[str]) -> List[str]:
    raw = _get(name, "")
    if not raw:
        return list(default)
    return [item.strip() for item in raw.replace(";", ",").split(",") if item.strip()]


@dataclass(frozen=True)
class Settings:
    # --- Telegram -------------------------------------------------------
    telegram_bot_token: str = _get("TELEGRAM_BOT_TOKEN")
    parse_mode: str = _get("PARSE_MODE", "Markdown")
    allowed_user_ids: str = _get("ALLOWED_USER_IDS", "")  # comma separated; empty = open to everyone
    drop_pending_updates: bool = _get_bool("DROP_PENDING_UPDATES", True)

    # --- Gateway --------------------------------------------------------
    gateway_url: str = _get("GATEWAY_URL", "http://gateway:3000/api/ai")
    # Empty = derive from GATEWAY_URL's origin (handy on Render/Koyeb where the
    # gateway is addressed by a public hostname).
    gateway_health_url: str = _get("GATEWAY_HEALTH_URL", "")
    gateway_api_key: str = _get("GATEWAY_API_KEY", "bot-internal-key")
    gateway_timeout: float = _get_float("GATEWAY_TIMEOUT", 120.0)
    gateway_connect_timeout: float = _get_float("GATEWAY_CONNECT_TIMEOUT", 10.0)
    gateway_max_retries: int = _get_int("GATEWAY_MAX_RETRIES", 3)
    gateway_retry_backoff: float = _get_float("GATEWAY_RETRY_BACKOFF", 0.8)
    gateway_retry_backoff_max: float = _get_float("GATEWAY_RETRY_BACKOFF_MAX", 12.0)
    gateway_max_retry_wait: float = _get_float("GATEWAY_MAX_RETRY_WAIT", 20.0)
    startup_wait_timeout: float = _get_float("STARTUP_WAIT_TIMEOUT", 180.0)

    # --- Redis ----------------------------------------------------------
    redis_url: str = _get("REDIS_URL", "redis://redis:6379/0")
    redis_max_connections: int = _get_int("REDIS_MAX_CONNECTIONS", 20)
    history_max_turns: int = _get_int("HISTORY_MAX_TURNS", 10)
    history_ttl_seconds: int = _get_int("HISTORY_TTL_SECONDS", 86400)
    history_max_chars: int = _get_int("HISTORY_MAX_CHARS", 24000)

    # --- Message shaping ------------------------------------------------
    telegram_message_limit: int = _get_int("TELEGRAM_MESSAGE_LIMIT", 4096)
    chunk_size: int = _get_int("CHUNK_SIZE", 3900)
    chunk_delay: float = _get_float("CHUNK_DELAY", 0.05)

    # --- Ops ------------------------------------------------------------
    log_level: str = _get("LOG_LEVEL", "INFO").upper()
    heartbeat_path: str = _get("HEARTBEAT_PATH", "/tmp/konkred-bot-heartbeat")
    heartbeat_max_age: int = _get_int("HEARTBEAT_MAX_AGE", 180)
    default_task: str = _get("DEFAULT_TASK", "general")
    show_footer: bool = _get_bool("SHOW_PROVIDER_FOOTER", True)


SETTINGS = Settings()

TELEGRAM_BOT_TOKEN = SETTINGS.telegram_bot_token
GATEWAY_URL = SETTINGS.gateway_url
GATEWAY_HEALTH_URL = SETTINGS.gateway_health_url
GATEWAY_API_KEY = SETTINGS.gateway_api_key
REDIS_URL = SETTINGS.redis_url


def allowed_user_id_set() -> set:
    """Return the configured allow-list as ints (empty set = allow everyone)."""
    ids = set()
    for raw in SETTINGS.allowed_user_ids.replace(";", ",").split(","):
        raw = raw.strip()
        if not raw:
            continue
        try:
            ids.add(int(raw))
        except ValueError:
            continue
    return ids


def validate() -> List[str]:
    """Return a list of fatal configuration problems (empty list = healthy)."""
    problems: List[str] = []
    if not SETTINGS.telegram_bot_token:
        problems.append("TELEGRAM_BOT_TOKEN is not set (get one from @BotFather).")
    elif ":" not in SETTINGS.telegram_bot_token:
        problems.append("TELEGRAM_BOT_TOKEN does not look like '<bot-id>:<secret>'.")
    if not SETTINGS.gateway_url.startswith(("http://", "https://")):
        problems.append(f"GATEWAY_URL must be an absolute http(s) URL, got: {SETTINGS.gateway_url!r}")
    if not SETTINGS.redis_url.startswith(("redis://", "rediss://", "unix://")):
        problems.append(f"REDIS_URL must start with redis:// or rediss://, got: {SETTINGS.redis_url!r}")
    if not 1 <= SETTINGS.chunk_size <= SETTINGS.telegram_message_limit:
        problems.append("CHUNK_SIZE must be between 1 and TELEGRAM_MESSAGE_LIMIT (4096).")
    if SETTINGS.gateway_max_retries < 0:
        problems.append("GATEWAY_MAX_RETRIES cannot be negative.")
    return problems


if __name__ == "__main__":  # pragma: no cover - manual debugging aid
    for problem in validate():
        print(f"[config] {problem}")
    print("[config] gateway_url =", SETTINGS.gateway_url)
    print("[config] redis_url   =", SETTINGS.redis_url)
    print("[config] chunk_size  =", SETTINGS.chunk_size)
