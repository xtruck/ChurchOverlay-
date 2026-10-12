#!/usr/bin/env python3
"""Mine ASR mishearings of book names from real service logs.

When a detected near-miss is followed by the operator typing the right verse, the
app logs a ``correction.candidate`` event: the near-miss text and the reference
the operator meant. This tool turns those pairs into proposed entries for
``PHONETIC_BOOK_ALIASES`` (apps/server/detector/regex-detector.ts):

    nombre: "numbers",   // heard "dans nombre un, le verset 2" for Nombres 1:2

A human always reviews the output; nothing is applied automatically. Each proposal
carries a collision check (how often the word appears in other finals) because an
alias that is also an everyday word ("nombre") can create false references.

Usage:
    python tools/alias_miner.py service.jsonl [more.jsonl ...] [--format text|ts|json]
"""
from __future__ import annotations

import argparse
import difflib
import json
import re
import sys
from collections import Counter
from dataclasses import asdict, dataclass, field
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from churchtools import appdata  # noqa: E402
from churchtools.logs import Event, ReadStats, final_transcripts, iter_events  # noqa: E402
from churchtools.text_norm import strip_accents, words  # noqa: E402

NUMBER_WORDS = {
    "un", "une", "deux", "trois", "quatre", "cinq", "six", "sept", "huit", "neuf", "dix", "onze", "douze",
    "treize", "quatorze", "quinze", "seize", "vingt", "trente", "quarante", "cinquante", "soixante", "cent",
    "one", "two", "three", "four", "five", "seven", "eight", "nine", "ten", "eleven", "twelve",
    "premier", "premiere", "deuxieme", "troisieme",
}
STOPWORDS = {
    "dans", "avec", "pour", "sont", "cette", "le", "la", "les", "des", "une", "est", "que", "qui", "par",
    "sur", "aux", "the", "and", "for", "that", "this", "verset", "versets", "verse", "chapitre", "chapter",
    "allons", "voir", "lire", "lisons", "ouvrons",
}
_REFERENCE = re.compile(r"^(?P<book>.+?)\s+(?P<chapter>\d+):(?P<verse>\d+)$")


def similarity(a: str, b: str) -> float:
    """0..1 string similarity. Uses rapidfuzz when installed, difflib otherwise (same scale)."""
    try:
        from rapidfuzz import fuzz  # type: ignore[import-not-found]

        return fuzz.ratio(a, b) / 100.0
    except ImportError:
        return difflib.SequenceMatcher(None, a, b).ratio()


@dataclass
class Proposal:
    token: str
    book: str
    evidence: int = 0
    examples: list[str] = field(default_factory=list)
    best_similarity: float = 0.0
    seen_in_other_finals: int = 0

    @property
    def risk(self) -> str:
        if self.seen_in_other_finals >= 3:
            return "high"
        if self.seen_in_other_finals >= 1:
            return "medium"
        return "low"


def split_reference(resolved: str) -> str | None:
    match = _REFERENCE.match(resolved.strip())
    return match.group("book") if match else None


def _base_names(names: set[str]) -> set[str]:
    """'1 john' -> 'john': a spoken book word has no volume digit attached."""
    return {re.sub(r"^[123]\s+", "", name) for name in names}


def candidate_token(text: str, known_names: set[str], aliases: dict[str, str], catalog: set[str], min_similarity: float):
    """Pick the word in ``text`` most likely to be the mis-heard book name, or None."""
    tokens = words(text)
    first_number = next((i for i, t in enumerate(tokens) if t.isdigit() or t in NUMBER_WORDS), None)
    bases = _base_names(known_names)
    best: tuple[float, str] | None = None
    for index, token in enumerate(tokens):
        if not token.isalpha() or len(token) < 3 or token in STOPWORDS or token in NUMBER_WORDS:
            continue
        score = max(similarity(token, base) for base in bases)
        if first_number is not None and index == first_number - 1:
            score += 0.15  # the word right before the first number is the likeliest book slot
        if score >= min_similarity and (best is None or score > best[0]):
            best = (score, token)
    if best is None:
        return None
    token = best[1]
    if token in aliases or token in catalog or token in bases:
        return None  # the app already understands this spelling
    return token, min(best[0], 1.0)


def mine(
    events: list[Event],
    aliases: dict[str, str],
    catalog_ids: list[str],
    min_evidence: int = 1,
    min_similarity: float = 0.55,
) -> list[Proposal]:
    catalog = {strip_accents(c).lower() for c in catalog_ids}
    found: dict[tuple[str, str], Proposal] = {}
    for event in events:
        if event.event != "correction.candidate":
            continue
        near_miss = event.metadata.get("nearMissText")
        resolved = event.metadata.get("resolvedReference")
        if not isinstance(near_miss, str) or not isinstance(resolved, str):
            continue
        book = split_reference(resolved)
        if book is None or book not in catalog_ids:
            continue
        picked = candidate_token(near_miss, appdata.names_for_book(book, aliases), aliases, catalog, min_similarity)
        if picked is None:
            continue
        token, score = picked
        proposal = found.setdefault((token, book), Proposal(token=token, book=book))
        proposal.evidence += 1
        proposal.best_similarity = max(proposal.best_similarity, round(score, 2))
        if near_miss not in proposal.examples and len(proposal.examples) < 3:
            proposal.examples.append(near_miss)

    # Collision check: how often does the same word appear in finals that did NOT lead to a correction?
    corrected_texts = {e.metadata.get("nearMissText") for e in events if e.event == "correction.candidate"}
    final_word_counts: Counter[str] = Counter()
    for event in final_transcripts(events):
        text = event.metadata["text"]
        if text in corrected_texts:
            continue
        final_word_counts.update(set(words(text)))
    proposals = [p for p in found.values() if p.evidence >= min_evidence]
    for proposal in proposals:
        proposal.seen_in_other_finals = final_word_counts.get(proposal.token, 0)
    return sorted(proposals, key=lambda p: (-p.evidence, p.risk, p.token))


def render_text(proposals: list[Proposal], stats: ReadStats) -> str:
    lines = [f"Read {stats.events} events ({stats.skipped} non-JSON lines skipped)."]
    if not proposals:
        return "\n".join(lines + ["No new alias proposals: every correction used a spelling the app already knows."])
    lines.append(f"{len(proposals)} proposal(s), review each before adding to PHONETIC_BOOK_ALIASES:\n")
    for p in proposals:
        lines.append(
            f"- {p.token!r} -> {p.book}  evidence={p.evidence}  similarity={p.best_similarity}  "
            f"collision-risk={p.risk} (word seen in {p.seen_in_other_finals} other final(s))"
        )
        for example in p.examples:
            lines.append(f"    heard: {example!r}")
    return "\n".join(lines)


def render_ts(proposals: list[Proposal]) -> str:
    rows = []
    for p in proposals:
        note = f"heard {p.examples[0]!r}; {p.evidence} correction(s); collision-risk {p.risk}"
        rows.append(f'  {p.token}: "{p.book}", // {note}')
    return "\n".join(rows)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("logs", nargs="+", help="JSONL log files ('-' for stdin)")
    parser.add_argument("--format", choices=("text", "ts", "json"), default="text")
    parser.add_argument("--min-evidence", type=int, default=1)
    parser.add_argument("--min-similarity", type=float, default=0.55)
    parser.add_argument("--repo", type=Path, default=appdata.REPO_ROOT)
    args = parser.parse_args(argv)

    stats = ReadStats()
    events = list(iter_events(args.logs, stats))
    proposals = mine(
        events, appdata.load_aliases(args.repo), appdata.load_catalog_ids(args.repo),
        min_evidence=args.min_evidence, min_similarity=args.min_similarity,
    )
    if args.format == "json":
        print(json.dumps([{**asdict(p), "risk": p.risk} for p in proposals], ensure_ascii=False, indent=2))
    elif args.format == "ts":
        print(render_ts(proposals))
    else:
        print(render_text(proposals, stats))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
