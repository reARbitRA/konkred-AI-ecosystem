"""Konkred Telegram bot entrypoint (Aiogram 3 long polling).

Startup is deliberately defensive:

1. Validate configuration and fail fast with an actionable message.
2. Wait for Redis (FSM storage + history) with bounded retries.
3. Wait for the gateway `/api/health` so a cold-starting gateway container does
   not turn the first user messages into errors.
4. Start polling, writing a heartbeat file that `healthcheck.py` (and the Docker
   HEALTHCHECK / Render health policy) uses to detect a wedged worker.
"""
from __future__ import annotations

import asyncio
import contextlib
import logging
import os
import signal
import sys
import time
from pathlib import Path

from aiogram import Bot, Dispatcher
from aiogram.client.default import DefaultBotProperties
from aiogram.enums import ParseMode
from aiogram.fsm.storage.redis import RedisStorage
from redis.asyncio import Redis

import config
from config import SETTINGS
from gateway_client import gateway_client
from handlers import METRICS, router
from history import HistoryManager

logging.basicConfig(
    level=getattr(logging, SETTINGS.log_level, logging.INFO),
    format="%(asctime)s - [%(levelname)s] - %(name)s - %(message)s",
    stream=sys.stdout,
)
logger = logging.getLogger("konkred-bot")

HEARTBEAT_PATH = Path(SETTINGS.heartbeat_path)
_last_heartbeat = 0.0


def write_heartbeat(force: bool = False) -> None:
    """Touch the heartbeat file at most once per second (cheap, no I/O storm)."""
    global _last_heartbeat  # noqa: PLW0603
    now = time.time()
    if not force and now - _last_heartbeat < 1.0:
        return
    _last_heartbeat = now
    try:
        HEARTBEAT_PATH.parent.mkdir(parents=True, exist_ok=True)
        HEARTBEAT_PATH.write_text(f"{now:.0f}\n", encoding="utf-8")
    except OSError as exc:
        logger.debug("heartbeat write failed: %s", exc)


async def connect_redis() -> Redis:
    """Bounded-retry Redis connection — Redis may still be starting."""
    last_error: Exception | None = None
    deadline = asyncio.get_event_loop().time() + min(SETTINGS.startup_wait_timeout, 120)
    attempt = 0
    while True:
        attempt += 1
        client: Redis = Redis.from_url(
            SETTINGS.redis_url,
            decode_responses=True,
            max_connections=SETTINGS.redis_max_connections,
            socket_timeout=10,
            socket_connect_timeout=5,
            retry_on_timeout=True,
        )
        try:
            await client.ping()
            logger.info("redis connected (attempt %s) at %s", attempt, SETTINGS.redis_url.split("@")[-1])
            return client
        except Exception as exc:  # noqa: BLE001
            last_error = exc
            with contextlib.suppress(Exception):
                await client.aclose()
            if asyncio.get_event_loop().time() >= deadline:
                break
            wait = min(10.0, 1.0 * attempt)
            logger.warning("redis unavailable (%s) — retrying in %.1fs", exc.__class__.__name__, wait)
            await asyncio.sleep(wait)
    raise SystemExit(f"[FATAL] Could not connect to Redis at {SETTINGS.redis_url}: {last_error}")


async def heartbeat_loop() -> None:
    while True:
        write_heartbeat()
        await asyncio.sleep(15)


async def main() -> int:
    problems = config.validate()
    for problem in problems:
        logger.error("config: %s", problem)
    if problems:
        return 2

    write_heartbeat(force=True)
    redis = await connect_redis()
    storage = RedisStorage(redis=redis)
    history_mgr = HistoryManager(redis_conn=redis)

    bot = Bot(
        token=SETTINGS.telegram_bot_token,
        default=DefaultBotProperties(parse_mode=ParseMode.MARKDOWN),
    )
    dp = Dispatcher(storage=storage)
    dp["history_mgr"] = history_mgr
    dp.include_router(router)

    await gateway_client.wait_until_ready(timeout=SETTINGS.startup_wait_timeout, interval=2.0)
    logger.info("gateway probe complete — starting polling loop")

    heartbeat_task = asyncio.create_task(heartbeat_loop(), name="heartbeat")
    stop = asyncio.Event()

    def request_shutdown(signame: str) -> None:
        logger.info("received %s — shutting down gracefully", signame)
        stop.set()

    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        with contextlib.suppress(NotImplementedError, ValueError):
            loop.add_signal_handler(sig, request_shutdown, sig.name)

    try:
        await bot.delete_webhook(drop_pending_updates=SETTINGS.drop_pending_updates)
        polling = asyncio.create_task(dp.start_polling(bot, allowed_updates=dp.resolve_used_update_types()), name="polling")
        done, _pending = await asyncio.wait({polling, asyncio.create_task(stop.wait())}, return_when=asyncio.FIRST_COMPLETED)
        if polling in done:
            exc = polling.exception()
            if exc:
                logger.error("polling terminated: %s", exc)
        else:
            polling.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await polling
    finally:
        heartbeat_task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await heartbeat_task
        logger.info("shutting down (metrics=%s)", METRICS)
        with contextlib.suppress(Exception):
            await dp.storage.close()
        with contextlib.suppress(Exception):
            await gateway_client.close()
        with contextlib.suppress(Exception):
            await history_mgr.close()
        with contextlib.suppress(Exception):
            await bot.session.close()
    return 0


if __name__ == "__main__":
    try:
        sys.exit(asyncio.run(main()))
    except SystemExit:
        raise
    except KeyboardInterrupt:  # pragma: no cover
        sys.exit(0)
    except Exception as fatal:  # noqa: BLE001
        logging.getLogger("konkred-bot").exception("fatal startup error: %s", fatal)
        sys.exit(1)

# Exported so `docker exec`/healthcheck tooling can find the pid file location.
os.environ.setdefault("KONKRED_BOT_MODULE", "main")
