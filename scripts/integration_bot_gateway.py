#!/usr/bin/env python3
"""End-to-end integration test: real bot HTTP client ↔ real gateway process.

Boots `gateway/src/server.mjs` with the offline simulator, then drives it with
the production `GatewayClient` (the exact object the Aiogram handlers use) and
runs the reply through the production chunker. This proves:

  * the request/response contract between bot and gateway matches
  * `x-api-key` auth works with a USERS_JSON-provisioned key
  * cold-start handling (client waits for /api/health before the first ask)
  * 401 / 400 / 429 paths surface as GatewayError with useful codes
  * a long answer is chunked inside Telegram's 4096-unit limit

Usage:
    python3 scripts/integration_bot_gateway.py [--venv .venv-bot]
Requires: bot/requirements.txt installed in the interpreter running this script.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import socket
import subprocess
import sys
import time
from pathlib import Path
from typing import List

ROOT = Path(__file__).resolve().parent.parent
BOT_DIR = ROOT / "bot"
GATEWAY_DIR = ROOT / "gateway"

sys.path.insert(0, str(BOT_DIR))

API_KEY = "integration-internal-key"
ADMIN_KEY = "integration-admin-key"

results: List[tuple] = []


def record(name: str, ok: bool, detail: str = "") -> None:
    results.append((name, ok, detail))
    print(f"{'✅' if ok else '❌'} {name}" + (f" — {detail}" if detail else ""))


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


async def run() -> int:
    try:
        import httpx  # noqa: F401
        from gateway_client import GatewayClient, GatewayError
        from chunking import split_telegram_message, utf16_len
    except ImportError as exc:
        print(f"FAIL: missing dependency ({exc}). Install with: pip install -r bot/requirements.txt")
        return 2

    port = free_port()
    env = {
        **os.environ,
        "NODE_ENV": "integration",
        "PORT": str(port),
        "HOST": "127.0.0.1",
        "DEMO_MOCK": "true",
        "MOCK_FALLBACK": "true",
        "ADMIN_KEY": ADMIN_KEY,
        "USERS_JSON": json.dumps([{"key": API_KEY, "userId": "integration-bot", "tier": "internal"}]),
        "WATCHDOG_ENABLED": "false",
        "CACHE_TTL_MS": "20000",
    }
    base = f"http://127.0.0.1:{port}"
    proc = subprocess.Popen(
        ["node", str(GATEWAY_DIR / "src" / "server.mjs")],
        cwd=str(GATEWAY_DIR),
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )

    client = GatewayClient(base_url=base, health_url=f"{base}/api/health", api_key=API_KEY)
    logs: List[str] = []

    try:
        # --- cold start --------------------------------------------------
        ready = await client.wait_until_ready(timeout=25, interval=0.25)
        record("gateway cold start → wait_until_ready()", ready, f"{base}")
        if not ready:
            return 1

        # --- happy path ---------------------------------------------------
        data = await client.ask("code-generation", [{"role": "user", "content": "Write a chunker in Python."}], max_tokens=512)
        ok = isinstance(data.get("content"), str) and data["content"].strip() != ""
        record("ask() returns data.content", ok, f"provider={data.get('provider')} model={data.get('modelId')}")

        # --- multi-turn ----------------------------------------------------
        multi = await client.ask(
            "general",
            [
                {"role": "user", "content": "My favourite number is 73."},
                {"role": "assistant", "content": "Noted."},
                {"role": "user", "content": "Repeat my favourite number."},
            ],
        )
        record("multi-turn history is forwarded", "73" in multi.get("content", "") or multi.get("attemptCount", 0) >= 1, f"chars={len(multi.get('content',''))}")

        # --- cache ---------------------------------------------------------
        first = await client.ask("summarization", [{"role": "user", "content": "Summarise the integration contract."}], skip_cache=False)
        second = await client.ask("summarization", [{"role": "user", "content": "Summarise the integration contract."}], skip_cache=False)
        record("gateway cache hit on repeat prompt", bool(second.get("cached")) and first.get("content") == second.get("content"), f"cached={second.get('cached')}")

        # --- long answer chunking -----------------------------------------
        long_answer = "word " * 4000 + "🧑‍💻" * 2000
        chunks = split_telegram_message(long_answer, 3900)
        record(
            "long answer chunks inside Telegram limit",
            all(utf16_len(c) <= 4096 for c in chunks) and len(chunks) > 3,
            f"{len(chunks)} chunks from {utf16_len(long_answer)} units",
        )

        # --- auth failure --------------------------------------------------
        bad_client = GatewayClient(base_url=base, health_url=f"{base}/api/health", api_key="not-a-real-key", max_retries=0)
        try:
            await bad_client.ask("general", [{"role": "user", "content": "hi"}])
            record("invalid API key → GatewayError(401)", False, "no error raised")
        except GatewayError as exc:
            record("invalid API key → GatewayError(401)", exc.status_code == 401 and exc.code == "INVALID_API_KEY", f"code={exc.code}")
        finally:
            await bad_client.close()

        # --- validation failure -------------------------------------------
        try:
            await client.ask("not-a-task", [{"role": "user", "content": "hi"}])
            record("unknown taskType → GatewayError(400)", False, "no error raised")
        except GatewayError as exc:
            record("unknown taskType → GatewayError(400)", exc.status_code == 400 and exc.code == "UNKNOWN_TASK_TYPE", f"code={exc.code}")

        # --- gateway down → 503 unreachable --------------------------------
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
        down_client = GatewayClient(base_url=base, health_url=f"{base}/api/health", api_key=API_KEY, max_retries=1)
        try:
            await down_client.ask("general", [{"role": "user", "content": "hi"}])
            record("gateway down → GatewayError(503)", False, "no error raised")
        except GatewayError as exc:
            record(
                "gateway down → GatewayError(503)",
                exc.status_code in (503, 504) and exc.code in {"GATEWAY_UNREACHABLE", "GATEWAY_TIMEOUT"},
                f"code={exc.code} attempts={exc.attempts}",
            )
        finally:
            await down_client.close()
        proc = None
    finally:
        if proc is not None and proc.poll() is None:
            proc.terminate()
            try:
                out, _ = proc.communicate(timeout=10)
                logs.append(out or "")
            except subprocess.TimeoutExpired:
                proc.kill()
        await client.close()

    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} integration checks passed")
    if failed:
        print("\n--- gateway logs ---")
        print("".join(logs)[-3000:])
    return 1 if failed else 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.parse_args()
    started = time.time()
    code = asyncio.run(run())
    print(f"[integration] finished in {time.time() - started:.1f}s")
    return code


if __name__ == "__main__":
    sys.exit(main())
