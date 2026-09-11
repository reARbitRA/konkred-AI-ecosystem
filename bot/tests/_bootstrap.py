"""Test helpers: make `bot/` importable and silence noisy loggers."""
from __future__ import annotations

import logging
import os
import sys
from pathlib import Path

BOT_ROOT = Path(__file__).resolve().parent.parent
if str(BOT_ROOT) not in sys.path:
    sys.path.insert(0, str(BOT_ROOT))

# Deterministic, offline defaults for every test run.
os.environ.setdefault("TELEGRAM_BOT_TOKEN", "123456789:test-token-for-unit-tests")
os.environ.setdefault("GATEWAY_URL", "http://gateway.test:3000/api/ai")
os.environ.setdefault("GATEWAY_HEALTH_URL", "http://gateway.test:3000/api/health")
os.environ.setdefault("GATEWAY_API_KEY", "test-internal-key")
os.environ.setdefault("REDIS_URL", "redis://redis.test:6379/0")
os.environ.setdefault("CHUNK_SIZE", "3900")
os.environ.setdefault("PARSE_MODE", "Markdown")
os.environ.setdefault("HEARTBEAT_PATH", "/tmp/konkred-bot-test-heartbeat")
# Keep retry/backoff timings tiny so the suite runs in well under a second.
os.environ.setdefault("GATEWAY_MAX_RETRIES", "2")
os.environ.setdefault("GATEWAY_RETRY_BACKOFF", "0.01")
os.environ.setdefault("GATEWAY_RETRY_BACKOFF_MAX", "0.05")
os.environ.setdefault("GATEWAY_MAX_RETRY_WAIT", "0.2")
os.environ.setdefault("STARTUP_WAIT_TIMEOUT", "1")

logging.disable(logging.CRITICAL)
