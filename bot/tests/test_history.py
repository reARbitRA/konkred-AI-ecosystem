"""Redis-backed history: TTLs, truncation, corrupt data and outage tolerance."""
from __future__ import annotations

import json
import unittest
from typing import Dict, List, Optional

import _bootstrap  # noqa: F401

from history import KEY_PREFIX, MAX_HISTORY_TURNS, HistoryManager  # noqa: E402


class FakeRedis:
    """Minimal in-memory stand-in for redis.asyncio.Redis."""

    def __init__(self, fail_on: Optional[set] = None) -> None:
        self.store: Dict[str, str] = {}
        self.ttls: Dict[str, int] = {}
        self.fail_on = fail_on or set()

    def _maybe_fail(self, op: str) -> None:
        if op in self.fail_on:
            raise ConnectionError(f"redis {op} failed (simulated outage)")

    async def get(self, key: str):
        self._maybe_fail("get")
        return self.store.get(key)

    async def set(self, key: str, value: str, ex: Optional[int] = None):
        self._maybe_fail("set")
        self.store[key] = value
        if ex is not None:
            self.ttls[key] = ex
        return True

    async def delete(self, key: str):
        self._maybe_fail("delete")
        self.store.pop(key, None)
        self.ttls.pop(key, None)
        return 1

    async def ping(self):
        self._maybe_fail("ping")
        return True

    async def aclose(self):
        return None


class HistoryBasicsTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.redis = FakeRedis()
        self.mgr = HistoryManager(redis_conn=self.redis)

    async def test_empty_history(self):
        self.assertEqual(await self.mgr.get_history(1), [])

    async def test_append_and_read_back(self):
        await self.mgr.append_interaction(7, "hello", "hi there")
        history = await self.mgr.get_history(7)
        self.assertEqual(history, [{"role": "user", "content": "hello"}, {"role": "assistant", "content": "hi there"}])

    async def test_key_namespacing(self):
        await self.mgr.append_interaction(42, "a", "b")
        self.assertIn(f"{KEY_PREFIX}42", self.redis.store)

    async def test_ttl_is_applied(self):
        await self.mgr.append_interaction(3, "a", "b")
        self.assertGreater(self.redis.ttls[f"{KEY_PREFIX}3"], 0)

    async def test_history_is_capped_at_max_turns(self):
        for i in range(MAX_HISTORY_TURNS + 15):
            await self.mgr.append_interaction(9, f"q{i}", f"a{i}")
        history = await self.mgr.get_history(9)
        self.assertEqual(len(history), MAX_HISTORY_TURNS * 2)
        self.assertEqual(history[-1]["content"], f"a{MAX_HISTORY_TURNS + 14}")
        # Oldest turns are the ones dropped.
        self.assertNotIn("q0", [m["content"] for m in history])

    async def test_char_budget_drops_oldest_turns(self):
        await self.mgr.append_interaction(11, "seed", "reply")
        await self.mgr.append_interaction(11, "x" * 30000, "y" * 200)
        history = await self.mgr.get_history(11)
        serialised = len(json.dumps(history))
        self.assertLess(serialised, 60000)
        self.assertEqual(history[-1]["content"], "y" * 200)

    async def test_history_never_starts_with_assistant_turn(self):
        for i in range(6):
            await self.mgr.append_interaction(13, f"q{i}" * 500, f"a{i}" * 900)
        history = await self.mgr.get_history(13)
        if history:
            self.assertEqual(history[0]["role"], "user")

    async def test_clear_history(self):
        await self.mgr.append_interaction(5, "a", "b")
        self.assertTrue(await self.mgr.clear_history(5))
        self.assertEqual(await self.mgr.get_history(5), [])

    async def test_turn_count(self):
        await self.mgr.append_interaction(17, "a", "b")
        await self.mgr.append_interaction(17, "c", "d")
        self.assertEqual(await self.mgr.turn_count(17), 2)


class HistoryCorruptionTests(unittest.IsolatedAsyncioTestCase):
    async def test_invalid_json_is_discarded(self):
        redis = FakeRedis()
        redis.store[f"{KEY_PREFIX}21"] = "{not json"
        mgr = HistoryManager(redis_conn=redis)
        self.assertEqual(await mgr.get_history(21), [])

    async def test_wrong_shape_is_discarded(self):
        redis = FakeRedis()
        redis.store[f"{KEY_PREFIX}22"] = json.dumps({"role": "user", "content": "nope"})
        mgr = HistoryManager(redis_conn=redis)
        self.assertEqual(await mgr.get_history(22), [])

    async def test_malformed_entries_are_filtered(self):
        redis = FakeRedis()
        redis.store[f"{KEY_PREFIX}23"] = json.dumps(
            [
                {"role": "user", "content": "good"},
                {"role": "hacker", "content": "bad role"},
                {"role": "assistant", "content": ""},
                "not-an-object",
                {"role": "assistant", "content": "also good"},
            ]
        )
        mgr = HistoryManager(redis_conn=redis)
        history = await mgr.get_history(23)
        self.assertEqual([m["content"] for m in history], ["good", "also good"])

    async def test_bytes_payload_is_decoded(self):
        class BytesRedis(FakeRedis):
            async def get(self, key):
                raw = self.store.get(key)
                return raw.encode() if isinstance(raw, str) else raw

        redis = BytesRedis()
        redis.store[f"{KEY_PREFIX}24"] = json.dumps([{"role": "user", "content": "hi"}])
        mgr = HistoryManager(redis_conn=redis)
        self.assertEqual((await mgr.get_history(24))[0]["content"], "hi")


class HistoryOutageTests(unittest.IsolatedAsyncioTestCase):
    async def test_reads_degrade_to_empty(self):
        mgr = HistoryManager(redis_conn=FakeRedis(fail_on={"get"}))
        self.assertEqual(await mgr.get_history(31), [])

    async def test_writes_report_failure_without_raising(self):
        mgr = HistoryManager(redis_conn=FakeRedis(fail_on={"set"}))
        self.assertFalse(await mgr.append_interaction(32, "a", "b"))

    async def test_clear_reports_failure_without_raising(self):
        mgr = HistoryManager(redis_conn=FakeRedis(fail_on={"delete"}))
        self.assertFalse(await mgr.clear_history(33))

    async def test_close_tolerates_missing_aclose(self):
        class LegacyRedis(FakeRedis):
            async def close(self):  # redis-py < 5 style
                return None

            aclose = None

        mgr = HistoryManager(redis_conn=LegacyRedis())
        await mgr.close()


if __name__ == "__main__":
    unittest.main(verbosity=2)
