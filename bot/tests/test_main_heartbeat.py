"""Heartbeat lifecycle in `main.main()`: it must start before the Redis and
gateway waits, and must be cancelled on every exit path."""
from __future__ import annotations

import asyncio
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import _bootstrap  # noqa: F401

import main  # noqa: E402


def _live_heartbeat_tasks() -> list:
    return [t for t in asyncio.all_tasks() if t.get_name() == "heartbeat" and not t.done()]


class HeartbeatLifecycleTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.hb_path = Path(self._tmp.name) / "heartbeat"
        patcher = mock.patch.object(main, "HEARTBEAT_PATH", self.hb_path)
        patcher.start()
        self.addCleanup(patcher.stop)
        validate = mock.patch.object(main.config, "validate", return_value=[])
        validate.start()
        self.addCleanup(validate.stop)

    async def test_heartbeat_written_before_redis_wait_and_cancelled_on_failure(self) -> None:
        seen_at_redis_wait: dict[str, bool] = {}

        async def failing_connect_redis():
            seen_at_redis_wait["heartbeat_file_exists"] = self.hb_path.exists()
            seen_at_redis_wait["heartbeat_task_alive"] = bool(_live_heartbeat_tasks())
            raise SystemExit("[FATAL] Could not connect to Redis (simulated)")

        with mock.patch.object(main, "connect_redis", side_effect=failing_connect_redis):
            with self.assertRaises(SystemExit):
                await main.main()

        self.assertTrue(seen_at_redis_wait["heartbeat_file_exists"], "heartbeat must exist before Redis wait")
        self.assertTrue(seen_at_redis_wait["heartbeat_task_alive"], "heartbeat task must run during Redis wait")
        self.assertEqual(_live_heartbeat_tasks(), [], "heartbeat task must be cancelled after failure")

    async def test_heartbeat_cancelled_when_gateway_never_ready(self) -> None:
        fake_redis = mock.MagicMock()
        wait_mock = mock.AsyncMock(side_effect=RuntimeError("gateway never became ready"))

        with mock.patch.object(main, "connect_redis", mock.AsyncMock(return_value=fake_redis)), \
             mock.patch.object(main, "RedisStorage", mock.MagicMock()), \
             mock.patch.object(main, "HistoryManager", mock.MagicMock()), \
             mock.patch.object(main, "Bot", mock.MagicMock()), \
             mock.patch.object(main, "Dispatcher", mock.MagicMock()), \
             mock.patch.object(main.gateway_client, "wait_until_ready", wait_mock):
            with self.assertRaises(RuntimeError):
                await main.main()

        wait_mock.assert_awaited_once()
        self.assertTrue(self.hb_path.exists(), "heartbeat must already be running during the gateway wait")
        self.assertEqual(_live_heartbeat_tasks(), [], "heartbeat task must be cancelled after failure")


if __name__ == "__main__":
    unittest.main()
