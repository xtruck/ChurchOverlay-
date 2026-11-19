#!/usr/bin/env python3
"""Score ASR providers against a reference transcript (word/character error rate).

AGENTS.md section 34: measure before choosing. Given what was REALLY said (a reference
transcript you typed or corrected) and what each provider produced, this prints a table
of WER, CER and number accuracy. Numbers matter most here: "Jean 3:16" heard as "Jean 3:60"
is one wrong word to a WER score but the wrong verse on screen, so ``number_recall`` (the
share of reference numbers the provider got, in order) is reported separately.

Hypotheses come from plain text files, or straight from a service log (the FINAL transcripts
of one provider's session, joined in order):

    python tools/asr_bakeoff.py --reference said.txt \\
        --hyp groq=groq.txt --hyp deepgram=deepgram.txt --hyp local=whisper.txt
    python tools/asr_bakeoff.py --reference said.txt --from-log groq=service-groq.jsonl

Standard library only (a tiny Levenshtein); if you prefer jiwer, the numbers agree for
the default normalisation (lower-case, no punctuation, accents kept).
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import asdict, dataclass
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from churchtools.errorrate import cer, error_rate  # noqa: E402
from churchtools.logs import final_transcripts, iter_events  # noqa: E402
from churchtools.text_norm import strip_accents  # noqa: E402

_PUNCT = re.compile(r"[^\w\s']", re.UNICODE)


def normalise(text: str, keep_accents: bool = True) -> list[str]:
    """Lower-case, strip punctuation (keep apostrophes inside words), optionally strip accents."""
    text = text.lower().replace("’", "'")
    if not keep_accents:
        text = strip_accents(text)
    return _PUNCT.sub(" ", text).split()


def numbers_in(tokens: list[str]) -> list[str]:
    return [t for t in tokens if t.isdigit()]


def number_recall(ref_tokens: list[str], hyp_tokens: list[str]) -> float | None:
    """Fraction of reference numbers found in the hypothesis, in order (longest common subsequence)."""
    ref, hyp = numbers_in(ref_tokens), numbers_in(hyp_tokens)
    if not ref:
        return None
    previous = [0] * (len(hyp) + 1)
    for r in ref:
        current = [0]
        for j, h in enumerate(hyp, start=1):
            current.append(previous[j - 1] + 1 if r == h else max(previous[j], current[j - 1]))
        previous = current
    return previous[-1] / len(ref)


@dataclass
class Score:
    provider: str
    wer: float
    cer: float
    number_recall: float | None
    ref_words: int
    hyp_words: int


def score(provider: str, reference: str, hypothesis: str, keep_accents: bool = True) -> Score:
    ref, hyp = normalise(reference, keep_accents), normalise(hypothesis, keep_accents)
    return Score(provider, error_rate(ref, hyp), cer(" ".join(ref), " ".join(hyp)), number_recall(ref, hyp), len(ref), len(hyp))


def hypothesis_from_log(path: str) -> str:
    return " ".join(str(e.metadata["text"]) for e in final_transcripts(iter_events([path])))


def render(scores: list[Score]) -> str:
    lines = ["| provider | WER | CER | number recall | ref words | hyp words |", "|---|---|---|---|---|---|"]
    for s in sorted(scores, key=lambda s: s.wer):
        recall = "n/a" if s.number_recall is None else f"{s.number_recall:.1%}"
        lines.append(f"| {s.provider} | {s.wer:.1%} | {s.cer:.1%} | {recall} | {s.ref_words} | {s.hyp_words} |")
    return "\n".join(lines)


def _pair(value: str) -> tuple[str, str]:
    name, _, path = value.partition("=")
    if not name or not path:
        raise argparse.ArgumentTypeError("expected NAME=PATH")
    return name, path


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--reference", required=True, type=Path, help="text of what was actually said")
    parser.add_argument("--hyp", action="append", default=[], type=_pair, metavar="NAME=FILE")
    parser.add_argument("--from-log", action="append", default=[], type=_pair, metavar="NAME=LOG.jsonl")
    parser.add_argument("--ignore-accents", action="store_true", help="treat é/e as the same (default: accents count)")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)
    if not args.hyp and not args.from_log:
        parser.error("give at least one --hyp or --from-log")

    reference = args.reference.read_text(encoding="utf-8")
    hypotheses = [(n, Path(p).read_text(encoding="utf-8")) for n, p in args.hyp] + [(n, hypothesis_from_log(p)) for n, p in args.from_log]
    scores = [score(name, reference, text, keep_accents=not args.ignore_accents) for name, text in hypotheses]
    print(json.dumps([asdict(s) for s in scores], indent=2) if args.json else render(scores))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
