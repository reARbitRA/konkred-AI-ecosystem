"""Inline keyboards for task selection and session controls."""
from __future__ import annotations

from typing import List, Tuple

from aiogram.types import InlineKeyboardButton, InlineKeyboardMarkup

TASKS: Tuple[Tuple[str, str], ...] = (
    ("General", "general"),
    ("Code Gen", "code-generation"),
    ("Bug Fixing", "bug-fixing"),
    ("Architecture", "architecture"),
    ("Summarize", "summarization"),
    ("Translate", "translate"),
)

VALID_TASK_IDS = frozenset(task_id for _, task_id in TASKS)

CALLBACK_TASK_PREFIX = "set_task:"
CALLBACK_CLEAR = "clear_context"
CALLBACK_STATUS = "show_status"
CALLBACK_HELP = "show_help"

# Telegram caps callback_data at 64 bytes — all of ours are far below that.
MAX_CALLBACK_DATA_BYTES = 64


def get_task_keyboard(current_task: str, columns: int = 2) -> InlineKeyboardMarkup:
    """Task grid with the active task ticked, plus utility row."""
    current = (current_task or "general").lower()
    if current not in VALID_TASK_IDS:
        current = "general"
    columns = max(1, min(int(columns or 2), 3))

    rows: List[List[InlineKeyboardButton]] = []
    row: List[InlineKeyboardButton] = []
    for label, task_id in TASKS:
        prefix = "✅ " if task_id == current else ""
        callback_data = f"{CALLBACK_TASK_PREFIX}{task_id}"
        assert len(callback_data.encode("utf-8")) <= MAX_CALLBACK_DATA_BYTES
        row.append(InlineKeyboardButton(text=f"{prefix}{label}"[:64], callback_data=callback_data))
        if len(row) == columns:
            rows.append(row)
            row = []
    if row:
        rows.append(row)

    rows.append(
        [
            InlineKeyboardButton(text="🗑 Clear Context", callback_data=CALLBACK_CLEAR),
            InlineKeyboardButton(text="📊 Status", callback_data=CALLBACK_STATUS),
        ]
    )
    return InlineKeyboardMarkup(inline_keyboard=rows)


def task_label(task_id: str) -> str:
    for label, candidate in TASKS:
        if candidate == task_id:
            return label
    return "General"


__all__ = [
    "TASKS",
    "VALID_TASK_IDS",
    "get_task_keyboard",
    "task_label",
    "CALLBACK_TASK_PREFIX",
    "CALLBACK_CLEAR",
    "CALLBACK_STATUS",
    "CALLBACK_HELP",
]
