"""Handler-level guards: keyboard integrity, error copy and long-message sends."""
from __future__ import annotations

import asyncio
import unittest
from typing import Any, Dict, List, Optional

import _bootstrap  # noqa: F401

from aiogram.exceptions import TelegramBadRequest, TelegramRetryAfter  # noqa: E402
from aiogram.types import InlineKeyboardMarkup  # noqa: E402

import handlers  # noqa: E402
from handlers import METRICS, _error_text, send_long_message  # noqa: E402
from keyboards import CALLBACK_CLEAR, CALLBACK_TASK_PREFIX, VALID_TASK_IDS, get_task_keyboard, task_label  # noqa: E402
from gateway_client import GatewayError  # noqa: E402


class StubMessage:
    """Stands in for aiogram.types.Message: records every send attempt."""

    def __init__(self, fail_modes: Optional[Dict[str, Exception]] = None, hard_limit: int = 4096) -> None:
        self.sent: List[Dict[str, Any]] = []
        self.fail_modes = fail_modes or {}
        self.hard_limit = hard_limit
        self.chat = type("Chat", (), {"id": 1})()
        self.from_user = type("User", (), {"id": 1, "is_bot": False})()

    async def answer(self, text: str, **kwargs) -> "StubMessage":
        failure = self.fail_modes.get(text[:24]) or self.fail_modes.get("*")
        if failure is not None:
            # one-shot failures only
            if self.fail_modes.get("*") is None:
                del self.fail_modes[text[:24]]
            raise failure
        if len(text.encode("utf-16-le")) // 2 > self.hard_limit:
            raise TelegramBadRequest(method="sendMessage", message="message is too long")
        self.sent.append({"text": text, **kwargs})
        return self


class KeyboardTests(unittest.TestCase):
    def test_every_task_has_a_button(self):
        kb = get_task_keyboard("general")
        self.assertIsInstance(kb, InlineKeyboardMarkup)
        data = [b.callback_data for row in kb.inline_keyboard for b in row]
        for task_id in VALID_TASK_IDS:
            self.assertIn(f"{CALLBACK_TASK_PREFIX}{task_id}", data)

    def test_callback_data_within_telegram_limit(self):
        kb = get_task_keyboard("code-generation")
        for row in kb.inline_keyboard:
            for button in row:
                self.assertLessEqual(len(button.callback_data.encode("utf-8")), 64)
                self.assertLessEqual(len(button.text), 64)

    def test_active_task_is_marked(self):
        kb = get_task_keyboard("translate")
        labels = [b.text for row in kb.inline_keyboard for b in row]
        self.assertTrue(any(label.startswith("✅") and "Translate" in label for label in labels))

    def test_unknown_task_falls_back_to_general(self):
        kb = get_task_keyboard("not-a-task")
        labels = [b.text for row in kb.inline_keyboard for b in row]
        self.assertTrue(any(label.startswith("✅") and "General" in label for label in labels))

    def test_utility_row_present(self):
        kb = get_task_keyboard("general")
        data = [b.callback_data for row in kb.inline_keyboard for b in row]
        self.assertIn(CALLBACK_CLEAR, data)

    def test_task_label_lookup(self):
        self.assertEqual(task_label("code-generation"), "Code Gen")
        self.assertEqual(task_label("unknown"), "General")


class ErrorCopyTests(unittest.TestCase):
    def test_429_mentions_retry_window(self):
        text = _error_text(GatewayError(429, "USER_RPM", "slow down", retry_after=45))
        self.assertIn("45s", text)

    def test_429_without_retry_after_has_default(self):
        self.assertIn("60s", _error_text(GatewayError(429, "USER_RPM", "slow down")))

    def test_503_reads_as_capacity(self):
        self.assertIn("saturated", _error_text(GatewayError(503, "CAPACITY_EXHAUSTED", "all cooling")))

    def test_auth_failure_is_actionable(self):
        self.assertIn("GATEWAY_API_KEY", _error_text(GatewayError(401, "INVALID_API_KEY", "nope")))

    def test_unreachable_reads_as_cold_start(self):
        self.assertIn("cold-starting", _error_text(GatewayError(503, "GATEWAY_UNREACHABLE", "conn refused")))


class SendLongMessageTests(unittest.IsolatedAsyncioTestCase):
    async def test_short_text_single_send(self):
        msg = StubMessage()
        sent = await send_long_message(msg, "hello world", parse_mode=None)
        self.assertEqual(sent, 1)
        self.assertEqual(msg.sent[0]["text"], "hello world")

    async def test_long_text_is_split_into_multiple_sends(self):
        msg = StubMessage()
        sent = await send_long_message(msg, "x" * 12000, parse_mode=None, chunk_size=3900)
        self.assertGreaterEqual(sent, 3)
        for item in msg.sent:
            self.assertLessEqual(len(item["text"].encode("utf-16-le")) // 2, 4096)

    async def test_empty_text_sends_nothing(self):
        msg = StubMessage()
        self.assertEqual(await send_long_message(msg, "", parse_mode=None), 0)
        self.assertEqual(await send_long_message(msg, None, parse_mode=None), 0)

    async def test_parse_failure_falls_back_to_plain_text(self):
        msg = StubMessage(fail_modes={"*": TelegramBadRequest(method="sendMessage", message="Can't parse entities: unexpected end tag")})
        msg.fail_modes = {}
        # Fail only when a parse_mode is supplied.
        original_answer = msg.answer

        async def answer(text, **kwargs):
            if kwargs.get("parse_mode"):
                raise TelegramBadRequest(method="sendMessage", message="Can't parse entities")
            return await original_answer(text, **kwargs)

        msg.answer = answer
        before = METRICS["send_fallbacks"]
        sent = await send_long_message(msg, "*unbalanced markdown", parse_mode="Markdown")
        self.assertEqual(sent, 1)
        self.assertIsNone(msg.sent[-1].get("parse_mode"))
        self.assertEqual(METRICS["send_fallbacks"], before + 1)

    async def test_flood_control_is_retried(self):
        attempts = {"n": 0}
        msg = StubMessage()
        original_answer = msg.answer

        async def answer(text, **kwargs):
            attempts["n"] += 1
            if attempts["n"] == 1:
                raise TelegramRetryAfter(method="sendMessage", message="flood", retry_after=1)
            return await original_answer(text, **kwargs)

        msg.answer = answer
        sent = await send_long_message(msg, "flood me", parse_mode=None)
        self.assertEqual(sent, 1)
        self.assertEqual(attempts["n"], 2)

    async def test_oversized_emoji_payload_never_hits_telegram_limit(self):
        msg = StubMessage()
        text = "🧑‍💻" * 5000
        await send_long_message(msg, text, parse_mode=None, chunk_size=3900)
        self.assertTrue(msg.sent)
        for item in msg.sent:
            self.assertLessEqual(len(item["text"].encode("utf-16-le")) // 2, 4096)


class HandlerRegistrationTests(unittest.TestCase):
    def test_router_has_expected_handlers(self):
        message_handlers = len(handlers.router.message.handlers)
        callback_handlers = len(handlers.router.callback_query.handlers)
        self.assertGreaterEqual(message_handlers, 6)
        self.assertGreaterEqual(callback_handlers, 3)

    def test_splitter_is_reexported_for_codebook_compatibility(self):
        self.assertTrue(callable(handlers.split_telegram_message))

    def test_metrics_counters_exist(self):
        for key in ("messages", "replies", "gateway_errors", "send_fallbacks", "chunks_sent"):
            self.assertIn(key, METRICS)


if __name__ == "__main__":
    unittest.main(verbosity=2)


class ReplyMarkupTests(unittest.IsolatedAsyncioTestCase):
    """A keyboard must ride on the final chunk only — never duplicated."""

    async def test_markup_attached_to_single_chunk(self):
        msg = StubMessage()
        kb = get_task_keyboard("general")
        await send_long_message(msg, "pick a mode", parse_mode=None, reply_markup=kb)
        self.assertEqual(len(msg.sent), 1)
        self.assertIs(msg.sent[0].get("reply_markup"), kb)

    async def test_markup_attached_only_to_last_chunk(self):
        msg = StubMessage()
        kb = get_task_keyboard("translate")
        sent = await send_long_message(msg, "w" * 12000, parse_mode=None, chunk_size=3900, reply_markup=kb)
        self.assertGreaterEqual(sent, 3)
        with_markup = [item for item in msg.sent if item.get("reply_markup") is not None]
        self.assertEqual(len(with_markup), 1)
        self.assertIs(msg.sent[-1].get("reply_markup"), kb)

    async def test_no_markup_means_no_markup_key(self):
        msg = StubMessage()
        await send_long_message(msg, "plain", parse_mode=None)
        self.assertNotIn("reply_markup", msg.sent[0])
