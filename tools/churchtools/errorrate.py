"""Word and character error rates (stdlib Levenshtein; no jiwer needed)."""
from __future__ import annotations

from typing import Callable, Sequence


def edit_distance(ref: Sequence, hyp: Sequence) -> int:
    """Levenshtein distance between two sequences (insertions, deletions, substitutions all cost 1)."""
    if not ref:
        return len(hyp)
    if not hyp:
        return len(ref)
    previous = list(range(len(hyp) + 1))
    for i, r in enumerate(ref, start=1):
        current = [i]
        for j, h in enumerate(hyp, start=1):
            cost = 0 if r == h else 1
            current.append(min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost))
        previous = current
    return previous[-1]


def error_rate(ref: Sequence, hyp: Sequence) -> float:
    """Edit distance / reference length. An empty reference gives 0.0 for an empty hypothesis, else 1.0."""
    if not ref:
        return 0.0 if not hyp else 1.0
    return edit_distance(ref, hyp) / len(ref)


def wer(reference: str, hypothesis: str, normalize: Callable[[str], list[str]] | None = None) -> float:
    normalize = normalize or (lambda s: s.split())
    return error_rate(normalize(reference), normalize(hypothesis))


def cer(reference: str, hypothesis: str) -> float:
    def squash(s: str) -> list[str]:
        return list("".join(s.split()))

    return error_rate(squash(reference), squash(hypothesis))
