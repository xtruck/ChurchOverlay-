"""Text normalization that mirrors the app.

``quote_tokens`` is the Python twin of ``quoteTokens`` in
apps/server/detector/quote-matcher.ts (NFD accent strip, lower-case, apostrophes
folded away, everything else to spaces), so offline experiments tokenize exactly
like the running matcher.
"""
from __future__ import annotations

import re
import unicodedata

_APOSTROPHES = re.compile("[’'`ʼ‘′]")
_NON_ALNUM = re.compile(r"[^a-z0-9\s]")


def strip_accents(text: str) -> str:
    decomposed = unicodedata.normalize("NFD", text)
    return "".join(ch for ch in decomposed if not unicodedata.combining(ch))


def quote_tokens(text: str) -> list[str]:
    text = strip_accents(text).lower()
    text = _APOSTROPHES.sub("", text)
    text = text.replace("œ", "oe").replace("æ", "ae")
    return _NON_ALNUM.sub(" ", text).split()


def words(text: str) -> list[str]:
    """Accent-free lower-case words (letters and digits), apostrophes kept out of the way."""
    return quote_tokens(text)
