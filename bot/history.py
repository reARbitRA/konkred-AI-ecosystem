"""Per-user conversation history stored in Redis.

Hardened against:
* Redis outages (every call degrades to "no history" instead of crashing the
  update handler — the bot keeps answering, just statelessly).
* Corrupt / non-JSON values and legacy payloads.
* Unbounded growth: turns are capped *and* the serialised blob is capped in
  characters so a single huge prompt cannot blow the context window.
"""
from __future__ import annotations

import json
import logging
from typing import Dict, List, Optional

from redis.asyncio import Redis

from config import SETTINGS

logger = logging.getLogger("konkred.history")

MAX_HISTORY_TURNS = SETTINGS.history_max_turns
TTL_SECONDS = SETTINGS.history_ttl_seconds
MAX_HISTORY_CHARS = SETTINGS.history_max_chars
KEY_PREFIX = "konkred:history:"
VALID_ROLES = {"system", "user", "assistant"}


class HistoryManager:
    def __init__(self, redis_conn: Redis) -> None:
        self.redis = redis_conn

    @staticmethod
    def _key(user_id: int) -> str:
        return f"{KEY_PREFIX}{int(user_id)}"

    async def get_history(self, user_id: int) -> List[Dict[str, str]]:
        try:
            raw = await self.redis.get(self._key(user_id))
        except Exception as exc:  # noqa: BLE001 - degrade gracefully
            logger.warning("history read failed for %s: %s", user_id, exc)
            return []
        if not raw:
            return []
        if isinstance(raw, bytes):
            try:
                raw = raw.decode("utf-8", errors="replace")
            except Exception:  # noqa: BLE001
                return []
        try:
            parsed = json.loads(raw)
        except (ValueError, TypeError) as exc:
            logger.warning("dropping corrupt history for %s: %s", user_id, exc)
            return []
        return self._sanitize(parsed)

    @staticmethod
    def _sanitize(parsed: object) -> List[Dict[str, str]]:
        if not isinstance(parsed, list):
            return []
        clean: List[Dict[str, str]] = []
        for item in parsed:
            if not isinstance(item, dict):
                continue
            role = str(item.get("role", "user")).lower()
            content = item.get("content", "")
            if role not in VALID_ROLES or not isinstance(content, str) or not content:
                continue
            clean.append({"role": role, "content": content})
        return clean[: MAX_HISTORY_TURNS * 2]

    def _truncate_to_char_budget(self, history: List[Dict[str, str]]) -> List[Dict[str, str]]:
        """Cap the serialised history at MAX_HISTORY_CHARS.

        The newest turn always survives — trimming its content if it is
        oversized — because dropping it would erase the exchange the user just
        had (and would leave the bot answering with no context at all).
        """
        if not history:
            return []

        budget = MAX_HISTORY_CHARS
        tail = history[-2:] if len(history) >= 2 else history[-1:]
        kept: List[Dict[str, str]] = []

        for message in reversed(tail):
            content = message["content"]
            allowed = max(200, budget - 16)
            if len(content) > allowed:
                content = "…[truncated]\n" + content[-allowed:]
            kept.append({"role": message["role"], "content": content})
            budget -= len(content) + 16
        kept.reverse()

        # Walk backwards through older turns while they still fit.
        for message in reversed(history[: len(history) - len(tail)]):
            cost = len(message["content"]) + 16
            if cost > budget:
                break
            budget -= cost
            kept.insert(0, message)

        # Never start a window on an orphaned assistant turn.
        while len(kept) > 1 and kept[0]["role"] != "user":
            kept.pop(0)
        return kept

    async def append_interaction(self, user_id: int, user_content: str, assistant_content: str) -> bool:
        history = await self.get_history(user_id)
        history.append({"role": "user", "content": str(user_content)})
        history.append({"role": "assistant", "content": str(assistant_content)})

        history = history[-(MAX_HISTORY_TURNS * 2):]
        history = self._truncate_to_char_budget(history)

        try:
            await self.redis.set(self._key(user_id), json.dumps(history, ensure_ascii=False), ex=TTL_SECONDS)
            return True
        except Exception as exc:  # noqa: BLE001
            logger.warning("history write failed for %s: %s", user_id, exc)
            return False

    async def clear_history(self, user_id: int) -> bool:
        try:
            await self.redis.delete(self._key(user_id))
            return True
        except Exception as exc:  # noqa: BLE001
            logger.warning("history clear failed for %s: %s", user_id, exc)
            return False

    async def turn_count(self, user_id: int) -> int:
        return len(await self.get_history(user_id)) // 2

    async def close(self) -> None:
        close = getattr(self.redis, "aclose", None) or getattr(self.redis, "close", None)
        if close is None:
            return
        try:
            result = close()
            if hasattr(result, "__await__"):
                await result
        except Exception as exc:  # noqa: BLE001 - shutdown path
            logger.debug("redis close error: %s", exc)


__all__ = ["HistoryManager", "MAX_HISTORY_TURNS", "TTL_SECONDS", "KEY_PREFIX"]
