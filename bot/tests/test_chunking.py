"""Chunking guarantees — the anti-crash tests for Telegram's 4096 limit."""
from __future__ import annotations

import unittest

import _bootstrap  # noqa: F401  (path + env setup, must come first)

from chunking import (  # noqa: E402
    DEFAULT_CHUNK_SIZE,
    TELEGRAM_HARD_LIMIT,
    chunk_with_footer,
    split_telegram_message,
    utf16_len,
)


class Utf16LengthTests(unittest.TestCase):
    def test_ascii_matches_python_len(self):
        self.assertEqual(utf16_len("hello"), 5)

    def test_non_bmp_characters_cost_two_units(self):
        # 😀 is U+1F600 → a surrogate pair → 2 UTF-16 units, but len() == 1.
        self.assertEqual(len("😀"), 1)
        self.assertEqual(utf16_len("😀"), 2)

    def test_zwj_family_emoji_counts_every_unit(self):
        family = "🧑‍👩‍👧‍👦"
        self.assertGreater(utf16_len(family), len(family))

    def test_empty_and_none(self):
        self.assertEqual(utf16_len(""), 0)
        self.assertEqual(utf16_len(None), 0)


class SplitBasicTests(unittest.TestCase):
    def test_short_text_is_untouched(self):
        text = "short answer"
        self.assertEqual(split_telegram_message(text), [text])

    def test_empty_input_returns_empty_list(self):
        self.assertEqual(split_telegram_message(""), [])
        self.assertEqual(split_telegram_message(None), [])

    def test_whitespace_only_input_is_not_dropped_silently(self):
        self.assertEqual(split_telegram_message("   "), ["   "])

    def test_exact_limit_is_one_chunk(self):
        text = "a" * 3900
        self.assertEqual(len(split_telegram_message(text, 3900)), 1)


class SplitSafetyTests(unittest.TestCase):
    """The regression suite for the original implementation."""

    def test_every_chunk_within_utf16_limit(self):
        text = ("paragraph one. " * 900) + "\n\n" + ("paragraph two " * 900)
        for chunk in split_telegram_message(text, 4000):
            self.assertLessEqual(utf16_len(chunk), TELEGRAM_HARD_LIMIT)

    def test_no_empty_chunks_produced(self):
        text = "\n\n".join(f"section {i}\n" + "x" * 500 for i in range(40))
        chunks = split_telegram_message(text, 3900)
        self.assertTrue(all(c.strip() for c in chunks))

    def test_leading_separators_do_not_cause_infinite_loop(self):
        """Original bug: rfind('\\n\\n') == 0 → zero-length chunk → infinite loop."""
        text = "\n\n" + "a" * 12000
        chunks = split_telegram_message(text, 4000)
        self.assertLessEqual(len(chunks), 6)
        self.assertTrue(all(c for c in chunks))

    def test_no_boundary_characters_at_all_hard_splits(self):
        """A wall of characters with no spaces/newlines must still terminate."""
        text = "x" * 20000
        chunks = split_telegram_message(text, 4000)
        self.assertEqual(len("".join(chunks)), 20000)
        for chunk in chunks:
            self.assertLessEqual(len(chunk), 4000)

    def test_emoji_heavy_text_never_exceeds_hard_limit(self):
        text = "🧑‍💻✨🔥" * 4000  # each grapheme is many UTF-16 units
        chunks = split_telegram_message(text, 3900)
        self.assertGreater(len(chunks), 1)
        for chunk in chunks:
            self.assertLessEqual(utf16_len(chunk), TELEGRAM_HARD_LIMIT, "chunk would be rejected by Telegram")

    def test_content_is_preserved_ignoring_boundary_whitespace(self):
        words = [f"token{i}" for i in range(3000)]
        text = " ".join(words)
        chunks = split_telegram_message(text, 1000)
        rejoined = " ".join(chunks).split()
        self.assertEqual(rejoined, words)

    def test_max_length_is_clamped_to_telegram_limit(self):
        text = "y" * 20000
        for chunk in split_telegram_message(text, 999999):
            self.assertLessEqual(utf16_len(chunk), TELEGRAM_HARD_LIMIT)

    def test_max_length_floor_prevents_pathological_values(self):
        chunks = split_telegram_message("z" * 5000, 0)
        self.assertTrue(chunks)
        for chunk in chunks:
            self.assertLessEqual(utf16_len(chunk), TELEGRAM_HARD_LIMIT)

    def test_crlf_normalisation(self):
        text = "line\r\n" * 3000
        chunks = split_telegram_message(text, 3900)
        self.assertTrue(all("\r" not in c for c in chunks))


class CodeFenceTests(unittest.TestCase):
    def test_unbalanced_fence_is_closed_and_reopened(self):
        code = "```python\n" + "\n".join(f"print({i})" for i in range(900)) + "\n```"
        chunks = split_telegram_message(code, 1200)
        self.assertGreater(len(chunks), 1)
        for chunk in chunks:
            self.assertEqual(chunk.count("```") % 2, 0, f"unbalanced fence in chunk: {chunk[:80]!r}")

    def test_multiple_fences_preserved(self):
        text = "before\n```js\nlet a=1;\n```\nmiddle\n```bash\necho hi\n```\nafter"
        chunks = split_telegram_message(text, 5000)
        self.assertEqual(chunks[0].count("```"), 4)


class FooterTests(unittest.TestCase):
    def test_footer_attached_to_last_chunk(self):
        chunks = chunk_with_footer("answer body", "\n\n—\n⚙️ `mock` / `atlas`", 3900)
        self.assertEqual(len(chunks), 1)
        self.assertTrue(chunks[0].endswith("`mock` / `atlas`"))

    def test_footer_that_overflows_creates_extra_chunk(self):
        content = "c" * 3890
        footer = "\n\n—\n" + "f" * 300
        chunks = chunk_with_footer(content, footer, 3900)
        self.assertGreater(len(chunks), 1)
        for chunk in chunks:
            self.assertLessEqual(utf16_len(chunk), TELEGRAM_HARD_LIMIT)
        self.assertTrue("".join(chunks).endswith("f"))

    def test_empty_content_with_footer(self):
        self.assertEqual(chunk_with_footer("", "footer"), ["footer"])

    def test_default_chunk_size_leaves_footer_headroom(self):
        self.assertLess(DEFAULT_CHUNK_SIZE, TELEGRAM_HARD_LIMIT)


if __name__ == "__main__":
    unittest.main(verbosity=2)
