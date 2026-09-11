"""Aiogram 3 routers for the Konkred bot.

Key robustness properties
--------------------------
* **Long messages never crash**: `chunking.split_telegram_message` measures the
  *UTF-16* length Telegram actually enforces, so a 20k-character answer full of
  emoji is split safely instead of raising
  `TelegramBadRequest: message is too long`.
* **Markdown failures never crash**: every send is attempted with the configured
  parse mode and transparently re-sent as plain text if Telegram rejects the
  entities (LLM output routinely contains unbalanced `*`/`_`/backticks).
* **Telegram flood control** (`TelegramRetryAfter`) is honoured with a sleep +
  single retry rather than propagating.
* **Gateway errors** (429 rate limit, 503 capacity, cold-start unreachable) are
  translated into short, human messages with a concrete "try again in Ns".
"""
from __future__ import annotations

import asyncio
import logging
import time
from typing import Any, Dict, List, Optional

from aiogram import F, Router, types
from aiogram.enums import ParseMode
from aiogram.exceptions import TelegramBadRequest, TelegramForbiddenError, TelegramRetryAfter
from aiogram.filters import Command, CommandStart
from aiogram.fsm.context import FSMContext
from aiogram.fsm.state import State, StatesGroup
from aiogram.utils.chat_action import ChatActionSender

from chunking import chunk_with_footer, split_telegram_message, utf16_len
from config import SETTINGS, allowed_user_id_set
from gateway_client import GatewayError, gateway_client
from history import HistoryManager
from keyboards import (
    CALLBACK_CLEAR,
    CALLBACK_STATUS,
    CALLBACK_TASK_PREFIX,
    VALID_TASK_IDS,
    get_task_keyboard,
    task_label,
)

logger = logging.getLogger("konkred.handlers")
router = Router(name="konkred")

STARTED_AT = time.time()
METRICS: Dict[str, int] = {"messages": 0, "replies": 0, "gateway_errors": 0, "send_fallbacks": 0, "chunks_sent": 0}


class UserSession(StatesGroup):
    task = State()


# Re-exported for backwards compatibility with the original codebook snippets.
__all__ = [
    "router",
    "UserSession",
    "split_telegram_message",
    "send_long_message",
    "METRICS",
]


# --------------------------------------------------------------------------- #
# Sending helpers
# --------------------------------------------------------------------------- #
async def _send_once(message: types.Message, text: str, parse_mode: Optional[str]) -> types.Message:
    """Send with the requested parse mode, falling back to plain text on error."""
    try:
        return await message.answer(text, parse_mode=parse_mode, disable_web_page_preview=True)
    except TelegramBadRequest as exc:
        lowered = str(exc).lower()
        parse_problem = any(
            hint in lowered
            for hint in ("can't parse", "parse", "entities", "message is too long", "unsupported")
        )
        if parse_mode and parse_problem:
            METRICS["send_fallbacks"] += 1
            logger.info("parse_mode=%s rejected (%s) — resending as plain text", parse_mode, exc)
            if "too long" in lowered:
                # Extremely defensive: re-split even tighter and send plain.
                for piece in split_telegram_message(text, SETTINGS.telegram_message_limit - 96):
                    await message.answer(piece, disable_web_page_preview=True)
                    METRICS["chunks_sent"] += 1
                return message
            return await message.answer(text, disable_web_page_preview=True)
        raise


async def send_long_message(
    message: types.Message,
    text: str,
    parse_mode: Optional[str] = None,
    chunk_size: Optional[int] = None,
    reply_markup: Optional[Any] = None,
) -> int:
    """Split `text` and send every chunk safely. Returns the number of chunks sent.

    `reply_markup` (if any) is attached to the final chunk only, so a keyboard is
    never duplicated across a multi-message answer.
    """
    if text is None:
        return 0
    mode = parse_mode if parse_mode is not None else SETTINGS.parse_mode
    mode = mode if mode in {ParseMode.MARKDOWN, ParseMode.HTML, ParseMode.MARKDOWN_V2, ""} else None
    if mode == "":
        mode = None

    limit = chunk_size or SETTINGS.chunk_size
    chunks = split_telegram_message(str(text), limit)
    if not chunks:
        return 0

    sent = 0
    last_index = len(chunks) - 1
    for index, chunk in enumerate(chunks):
        if not chunk.strip():
            continue
        try:
            if reply_markup is not None and index == last_index:
                await message.answer(chunk, reply_markup=reply_markup)
                sent += 1
                METRICS["chunks_sent"] += 1
                continue
            await _send_once(message, chunk, mode)
        except TelegramRetryAfter as exc:
            wait = min(int(getattr(exc, "retry_after", 3) or 3), 60)
            logger.warning("flood control: sleeping %ss", wait)
            await asyncio.sleep(wait + 0.25)
            await _send_once(message, chunk, mode)
        except TelegramForbiddenError as exc:
            logger.warning("cannot message chat %s: %s", message.chat.id, exc)
            return sent
        sent += 1
        METRICS["chunks_sent"] += 1
        if index < len(chunks) - 1:
            await asyncio.sleep(SETTINGS.chunk_delay)
    return sent


UNREACHABLE_CODES = {"GATEWAY_UNREACHABLE", "GATEWAY_TIMEOUT", "POOL_TIMEOUT"}


def _error_text(exc: GatewayError) -> str:
    """Map a gateway failure onto a short, actionable Telegram message."""
    if exc.code in UNREACHABLE_CODES or exc.status_code == 0:
        return "🔌 **Gateway unreachable.** It may still be cold-starting — retry in a few seconds."
    if exc.status_code == 429:
        wait = exc.retry_after or 60
        return f"⏳ **Rate limited.** Upstream capacity ceiling reached — retry in ~{wait}s."
    if exc.status_code in (401, 403):
        return "⛔ **Gateway auth failure.** The bot's `GATEWAY_API_KEY` is not accepted — check `USERS_JSON`."
    if exc.status_code == 413:
        return "📚 **Prompt too long** for every available model. Trim the conversation with `/clear` and retry."
    if exc.status_code == 451:
        return "🚫 A provider content filter blocked this request. Rephrase or switch task mode."
    if exc.status_code in (502, 503, 504):
        hint = f" Retry in ~{exc.retry_after}s." if exc.retry_after else " Please retry shortly."
        return f"⚠️ **All providers saturated.**{hint}"
    if 400 <= exc.status_code < 500:
        return f"⛔ **Request rejected ({exc.code}).** {exc.message[:300]}"
    return f"⛔ **Gateway error `{exc.code}` (HTTP {exc.status_code}):** {exc.message[:400]}"


# --------------------------------------------------------------------------- #
# Commands
# --------------------------------------------------------------------------- #
@router.message(CommandStart())
async def handle_start(message: types.Message, state: FSMContext) -> None:
    await state.set_state(UserSession.task)
    await state.update_data(task=SETTINGS.default_task)
    await send_long_message(
        message,
        "⚡ **Konkred Gateway Active**\n\n"
        "Stateful, multi-turn AI chat backed by a quota-aware multi-provider pool "
        "(Gemini · Groq · Cerebras · Mistral · OpenRouter · Cloudflare · GitHub) with "
        "automatic fallback when a free tier is exhausted.\n\n"
        "**Commands:** `/task` switch mode · `/clear` wipe memory · `/status` health\n\n"
        "Select your active operational task below:",
        reply_markup=get_task_keyboard(SETTINGS.default_task),
    )


@router.message(Command("help"))
async def handle_help(message: types.Message) -> None:
    await send_long_message(
        message,
        "**Konkred bot help**\n\n"
        "• `/start` — welcome + task selector\n"
        "• `/task <name>` — switch mode (general, code-generation, bug-fixing, architecture, summarization, translate)\n"
        "• `/clear` — purge stored conversation memory\n"
        "• `/status` — gateway + bot health snapshot\n\n"
        "Just send any text message to chat. Long answers are split automatically.",
    )


@router.message(Command("task"))
async def handle_task_command(message: types.Message, state: FSMContext) -> None:
    raw = (message.text or "").split(maxsplit=1)
    if len(raw) < 2 or not raw[1].strip():
        names = ", ".join(sorted(VALID_TASK_IDS))
        current = (await state.get_data()).get("task", SETTINGS.default_task)
        await send_long_message(
            message,
            f"**Available tasks:** {names}\n\nUsage: `/task code-generation`, or pick one below:",
            reply_markup=get_task_keyboard(current),
        )
        return

    requested = raw[1].strip().lower().replace(" ", "-")
    if requested not in VALID_TASK_IDS:
        await send_long_message(message, f"❓ Unknown task `{requested}`. Valid: {', '.join(sorted(VALID_TASK_IDS))}")
        return

    await state.set_state(UserSession.task)
    await state.update_data(task=requested)
    await send_long_message(message, f"✅ Task mode set to **{task_label(requested)}** (`{requested}`).")


@router.message(Command("clear"))
async def handle_clear_command(message: types.Message, history_mgr: HistoryManager) -> None:
    cleared = await history_mgr.clear_history(message.from_user.id)
    await send_long_message(message, "🧹 Conversation memory cleared." if cleared else "⚠️ Could not reach Redis; memory may still be cached.")


@router.message(Command("status"))
async def handle_status_command(message: types.Message, state: FSMContext, history_mgr: HistoryManager) -> None:
    turns = await history_mgr.turn_count(message.from_user.id)
    task = (await state.get_data()).get("task", SETTINGS.default_task)
    reachable = await gateway_client.ping(timeout=3.0)
    uptime = int(time.time() - STARTED_AT)
    lines = [
        "**Konkred status**",
        f"• Bot uptime: {uptime // 3600}h {(uptime % 3600) // 60}m {uptime % 60}s",
        f"• Gateway: {'✅ reachable' if reachable else '❌ unreachable'} — `{SETTINGS.gateway_url}`",
        f"• Redis: `{SETTINGS.redis_url.split('@')[-1]}`",
        f"• Stored turns: {turns} (max {SETTINGS.history_max_turns})",
        f"• Active task: `{task}`",
        f"• Messages handled: {METRICS['messages']} · replies: {METRICS['replies']}",
        f"• Gateway errors: {METRICS['gateway_errors']} · parse fallbacks: {METRICS['send_fallbacks']}",
    ]
    await send_long_message(message, "\n".join(lines))


# --------------------------------------------------------------------------- #
# Callbacks
# --------------------------------------------------------------------------- #
@router.callback_query(F.data.startswith(CALLBACK_TASK_PREFIX))
async def handle_task_selection(callback: types.CallbackQuery, state: FSMContext) -> None:
    selected = (callback.data or "").split(":", 1)[1].strip().lower()
    if selected not in VALID_TASK_IDS:
        await callback.answer("Unknown task", show_alert=False)
        return
    await state.set_state(UserSession.task)
    await state.update_data(task=selected)
    try:
        if callback.message is not None:
            await callback.message.edit_reply_markup(reply_markup=get_task_keyboard(selected))
    except TelegramBadRequest as exc:
        logger.debug("keyboard not edited: %s", exc)
    await callback.answer(f"Switched to: {task_label(selected)}")


@router.callback_query(F.data == CALLBACK_CLEAR)
async def handle_clear_context(callback: types.CallbackQuery, history_mgr: HistoryManager) -> None:
    await history_mgr.clear_history(callback.from_user.id)
    await callback.answer("Context cleared.")
    if callback.message is not None:
        await send_long_message(callback.message, "🧹 Conversation memory cleared.")


@router.callback_query(F.data == CALLBACK_STATUS)
async def handle_status_callback(callback: types.CallbackQuery, history_mgr: HistoryManager) -> None:
    reachable = await gateway_client.ping(timeout=3.0)
    turns = await history_mgr.turn_count(callback.from_user.id)
    await callback.answer(f"Gateway {'OK' if reachable else 'unreachable'} · {turns} stored turns")


# --------------------------------------------------------------------------- #
# Chat
# --------------------------------------------------------------------------- #
@router.message(F.text & ~F.text.startswith("/"))
async def handle_chat_message(message: types.Message, state: FSMContext, history_mgr: HistoryManager) -> None:
    if message.from_user is None:  # channel posts / anonymous admins
        return
    if not _authorized(message.from_user.id):
        logger.info("ignoring message from unauthorized user %s", message.from_user.id)
        return

    METRICS["messages"] += 1
    user_id = message.from_user.id
    data = await state.get_data()
    active_task = data.get("task") or SETTINGS.default_task
    if active_task not in VALID_TASK_IDS:
        active_task = SETTINGS.default_task

    prompt = (message.text or "").strip()
    if not prompt:
        return

    prior_history: List[Dict[str, str]] = await history_mgr.get_history(user_id)
    messages_payload = prior_history + [{"role": "user", "content": prompt}]

    logger.info("user=%s task=%s chars=%s history=%s", user_id, active_task, utf16_len(prompt), len(prior_history) // 2)

    try:
        async with ChatActionSender.typing(bot=message.bot, chat_id=message.chat.id, initial_sleep=0.5, interval=4):
            result = await gateway_client.ask(
                task_type=active_task,
                messages=messages_payload,
                max_tokens=2500,
                temperature=0.3,
            )
    except GatewayError as exc:
        METRICS["gateway_errors"] += 1
        logger.warning("gateway error for user=%s: %s", user_id, exc)
        await send_long_message(message, _error_text(exc), parse_mode=None)
        return
    except asyncio.CancelledError:
        raise
    except Exception as exc:  # noqa: BLE001 - never let an update die silently
        METRICS["gateway_errors"] += 1
        logger.exception("unexpected failure handling update")
        await send_long_message(message, f"❌ **Unexpected error:** `{type(exc).__name__}: {str(exc)[:300]}`", parse_mode=None)
        return

    content = str(result.get("content") or "").strip()
    if not content:
        await send_long_message(message, "⚠️ The gateway returned an empty completion. Try again or switch task mode.", parse_mode=None)
        return

    await history_mgr.append_interaction(user_id, prompt, content)

    footer = ""
    if SETTINGS.show_footer:
        provider = result.get("provider", "unknown")
        model = result.get("model", "unknown")
        cached = " (cached)" if result.get("cached") else ""
        attempts = result.get("attemptCount")
        attempt_note = f" · {attempts} attempt(s)" if isinstance(attempts, int) and attempts > 1 else ""
        usage = result.get("usage") or {}
        tokens = usage.get("totalTokens") if isinstance(usage, dict) else None
        token_note = f" · {tokens} tok" if tokens else ""
        footer = f"\n\n—\n⚙️ `{provider}` / `{model}`{cached}{attempt_note}{token_note}"

    chunks = chunk_with_footer(content, footer, SETTINGS.chunk_size)
    METRICS["replies"] += 1
    for index, chunk in enumerate(chunks):
        await send_long_message(message, chunk, chunk_size=SETTINGS.telegram_message_limit)
        if index < len(chunks) - 1:
            await asyncio.sleep(SETTINGS.chunk_delay)


@router.message(~F.text)
async def handle_unsupported(message: types.Message) -> None:
    if message.from_user is None or not _authorized(message.from_user.id):
        return
    await send_long_message(
        message,
        "ℹ️ I only handle text prompts right now. Send your question as plain text, or `/help` for commands.",
        parse_mode=None,
    )


_ALLOWED_IDS: Optional[set] = None


def _authorized(user_id: int) -> bool:
    global _ALLOWED_IDS  # noqa: PLW0603 - cached once per process
    if _ALLOWED_IDS is None:
        _ALLOWED_IDS = allowed_user_id_set()
    return not _ALLOWED_IDS or int(user_id) in _ALLOWED_IDS


@router.errors()
async def on_error(event: types.ErrorEvent) -> bool:
    logger.exception("unhandled dispatcher error: %s", getattr(event, "exception", event))
    return True
