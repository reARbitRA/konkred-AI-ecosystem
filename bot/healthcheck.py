#!/usr/bin/env python3
"""Container healthcheck for the bot worker.

The bot has no inbound HTTP port (Telegram long polling is outbound-only), so
liveness is expressed as a heartbeat file written by `main.py`. This script
exits 0 when the heartbeat is fresh, 1 otherwise — which is exactly the contract
Docker's HEALTHCHECK and Render/Koyeb worker health policies expect.

Usage:  python healthcheck.py [heartbeat_path] [max_age_seconds]
"""
from __future__ import annotations

import os
import sys
import time
from pathlib import Path

DEFAULT_PATH = os.getenv("HEARTBEAT_PATH", "/tmp/konkred-bot-heartbeat")
DEFAULT_MAX_AGE = int(os.getenv("HEARTBEAT_MAX_AGE", "180"))


def main(argv: list[str]) -> int:
    path = Path(argv[1] if len(argv) > 1 else DEFAULT_PATH)
    try:
        max_age = int(argv[2]) if len(argv) > 2 else DEFAULT_MAX_AGE
    except ValueError:
        max_age = DEFAULT_MAX_AGE

    if not path.exists():
        print(f"UNHEALTHY: heartbeat file missing at {path}")
        return 1

    try:
        age = time.time() - path.stat().st_mtime
    except OSError as exc:
        print(f"UNHEALTHY: cannot stat heartbeat ({exc})")
        return 1

    if age > max_age:
        print(f"UNHEALTHY: heartbeat is {age:.0f}s old (limit {max_age}s)")
        return 1

    print(f"OK: heartbeat {age:.0f}s old")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
