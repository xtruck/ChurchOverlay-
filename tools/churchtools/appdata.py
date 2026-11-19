"""Reading the app's own tables from its TypeScript source, so offline tools never drift.

The book catalog ids and the French/phonetic alias tables live in TypeScript.
Rather than copy them (and let the copy rot), these helpers parse them straight
from the repository files. The parse is a regex over simple ``key: "value"``
tables and is covered by tests against the real files.
"""
from __future__ import annotations

import re
from pathlib import Path

from .text_norm import strip_accents

REPO_ROOT = Path(__file__).resolve().parents[2]

_ENTRY = re.compile(r'^\s*(?:"([^"]+)"|([A-Za-z0-9_]+))\s*:\s*"([^"]+)"\s*,?\s*(?://.*)?$')


def _table(source: str, name: str) -> dict[str, str]:
    """Parse ``export const NAME ... = { key: "value", ... }`` into a dict."""
    start = re.search(rf"export const {name}\b[^=]*=\s*\{{", source)
    if not start:
        raise ValueError(f"table {name} not found")
    out: dict[str, str] = {}
    for line in source[start.end():].splitlines():
        if line.strip().startswith("}"):
            break
        match = _ENTRY.match(line)
        if match:
            out[match.group(1) or match.group(2)] = match.group(3)
    return out


def load_catalog_ids(repo: Path = REPO_ROOT) -> list[str]:
    source = (repo / "apps/server/verse/book-catalog.ts").read_text(encoding="utf-8")
    return re.findall(r'\bid:\s*"([^"]+)"', source)


def load_aliases(repo: Path = REPO_ROOT) -> dict[str, str]:
    """Alias word -> catalog book id (French names and known phonetic mishearings)."""
    source = (repo / "apps/server/detector/regex-detector.ts").read_text(encoding="utf-8")
    aliases: dict[str, str] = {}
    for table in ("FRENCH_BOOK_ALIASES", "PHONETIC_BOOK_ALIASES"):
        for key, value in _table(source, table).items():
            aliases[strip_accents(key).lower()] = value
    return aliases


def load_offline_keys(repo: Path = REPO_ROOT) -> dict[str, str]:
    """Key used by data/fra_lsg.json for a book -> the app's catalog book id (inverse of OFFLINE_BIBLE_BOOK_KEYS)."""
    source = (repo / "apps/server/verse/offline-bible-book-keys.ts").read_text(encoding="utf-8")
    return {key: catalog_id for catalog_id, key in _table(source, "OFFLINE_BIBLE_BOOK_KEYS").items()}


def names_for_book(book_id: str, aliases: dict[str, str]) -> set[str]:
    """Every spelling the app already knows for one book (its id plus its aliases)."""
    names = {strip_accents(book_id).lower()}
    names.update(alias for alias, target in aliases.items() if target == book_id)
    return names
