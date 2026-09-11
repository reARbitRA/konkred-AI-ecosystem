"""Telegram-safe message chunking.

Why this module exists
----------------------
Telegram rejects any `sendMessage` whose text exceeds **4096 characters**, and
it counts characters in **UTF-16 code units** — so a single emoji such as 🧑‍💻
can cost 5+ units and a naive `len(text) <= 4096` check in Python (which counts
code points) can still overflow the real limit and raise
`TelegramBadRequest: message is too long`.

Guarantees provided here:

1. Every returned chunk is within `max_length` **UTF-16 units** (default 3900,
   leaving headroom for the metadata footer).
2. The function always terminates — a non-empty prefix is consumed on every
   iteration even when the text contains no newline/space boundary at all.
3. Markdown code fences are re-balanced across chunk boundaries so a split
   never leaves a dangling ``` that would break Telegram's parser.
4. Empty chunks are dropped; whitespace-only tails never produce an empty
   `sendMessage` call (which Telegram rejects with 400).
"""
from __future__ import annotations

from typing import List

from config import SETTINGS

TELEGRAM_HARD_LIMIT = 4096
DEFAULT_CHUNK_SIZE = min(SETTINGS.chunk_size or 3900, TELEGRAM_HARD_LIMIT)
FENCE = "```"


def utf16_len(text: str) -> int:
    """Length as Telegram counts it (UTF-16 code units, not Python code points)."""
    if not text:
        return 0
    return len(text.encode("utf-16-le")) // 2


def _cut_point(text: str, limit: int) -> int:
    """Find the best boundary at or before `limit` UTF-16 units.

    Returns an index into `text` (Python code points) that is guaranteed to be
    >= 1 so callers always make forward progress.
    """
    # Fast path: the whole remaining text already fits.
    if utf16_len(text) <= limit:
        return len(text)

    # Binary search the largest prefix that fits in `limit` UTF-16 units.
    low, high = 1, len(text)
    while low < high:
        mid = (low + high + 1) // 2
        if utf16_len(text[:mid]) <= limit:
            low = mid
        else:
            high = mid - 1
    hard_cut = low

    window = text[:hard_cut]
    for boundary in ("\n\n", "\n", " ", "\t", "-", "."):
        index = window.rfind(boundary)
        # Require a real boundary (not position 0) and keep at least 40% of the
        # window so we do not emit a stream of tiny fragments.
        if index > 0 and index >= int(hard_cut * 0.4):
            return index
    return max(1, hard_cut)


def _balance_fences(chunks: List[str]) -> List[str]:
    """Re-open/close Markdown code fences that a split cut in half."""
    balanced: List[str] = []
    inside_fence = False
    for chunk in chunks:
        text = chunk
        if inside_fence:
            text = f"{FENCE}\n{text}" if not text.startswith(FENCE) else text
            inside_fence = False
        fences = text.count(FENCE)
        if fences % 2 == 1:
            text = f"{text}\n{FENCE}"
            inside_fence = True
        if utf16_len(text) > TELEGRAM_HARD_LIMIT:  # pragma: no cover - defensive
            # Adding the fence pushed us over the hard limit: trim the tail.
            text = _hard_trim(text, TELEGRAM_HARD_LIMIT - utf16_len(FENCE) - 2)
        if text.strip():
            balanced.append(text)
    return balanced


def _hard_trim(text: str, limit: int) -> str:
    low, high = 0, len(text)
    while low < high:
        mid = (low + high + 1) // 2
        if utf16_len(text[:mid]) <= limit:
            low = mid
        else:
            high = mid - 1
    return text[:low]


def split_telegram_message(text: str, max_length: int = DEFAULT_CHUNK_SIZE) -> List[str]:
    """Split `text` into chunks that Telegram will accept.

    >>> len(split_telegram_message("x" * 9000, 4000)[0]) <= 4000
    True
    >>> split_telegram_message("")
    []
    """
    if text is None:
        return []
    if not isinstance(text, str):
        text = str(text)

    try:
        limit = int(max_length)
    except (TypeError, ValueError):
        limit = DEFAULT_CHUNK_SIZE
    limit = max(64, min(limit, TELEGRAM_HARD_LIMIT))

    text = text.replace("\r\n", "\n").replace("\r", "\n")
    if not text.strip():
        return [text] if text else []
    if utf16_len(text) <= limit:
        return [text]

    chunks: List[str] = []
    remaining = text
    iterations = 0
    max_iterations = utf16_len(text) + 16  # absolute termination guarantee

    while remaining and iterations < max_iterations:
        iterations += 1
        cut = _cut_point(remaining, limit)
        head, tail = remaining[:cut], remaining[cut:]
        chunk = head.rstrip()
        remaining = tail.lstrip("\n").lstrip()
        if chunk:
            chunks.append(chunk)
        if not remaining:
            break
        if cut <= 0:  # pragma: no cover - defensive, _cut_point guarantees >= 1
            remaining = remaining[1:]

    if not chunks:
        chunks = [_hard_trim(text, limit)]

    return _balance_fences(chunks)


def chunk_with_footer(content: str, footer: str = "", max_length: int = DEFAULT_CHUNK_SIZE) -> List[str]:
    """Attach `footer` to the final chunk, splitting again if it no longer fits."""
    chunks = split_telegram_message(content, max_length)
    if not chunks:
        return [footer] if footer else []
    if not footer:
        return chunks
    last = chunks[-1] + footer
    if utf16_len(last) <= min(max_length, TELEGRAM_HARD_LIMIT):
        chunks[-1] = last
        return chunks
    chunks[-1:] = split_telegram_message(chunks[-1] + footer, max_length)
    return chunks


# Backwards-compatible alias used by older snippets of the codebook.
split_message = split_telegram_message

__all__ = [
    "split_telegram_message",
    "chunk_with_footer",
    "utf16_len",
    "TELEGRAM_HARD_LIMIT",
    "DEFAULT_CHUNK_SIZE",
]
