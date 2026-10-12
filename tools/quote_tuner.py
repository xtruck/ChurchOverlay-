#!/usr/bin/env python3
"""Tune the verse-quotation matcher against the bundled Louis Segond text.

The matcher (apps/server/detector/quote-matcher.ts) recognises a verse read aloud
without its reference, and AppCore only ever offers it as a pending suggestion. Its
thresholds (shingle, minRuns, minCoverage, dominance) were chosen by reasoning, not
measurement. This tool measures them:

  * POSITIVES  - real verses, read exactly and "ASR-noisy" (dropped / swapped words);
                 the right answer is that verse.
  * NEGATIVES  - text that must NOT match: two halves of different verses glued
                 together, plus ordinary sermon sentences (add your own with --negatives).

For every parameter set it runs the REAL built matcher (tools/node_helpers/quote_eval.cjs,
needs ``npm run build``) and reports recall, wrong-verse rate and false-positive rate,
then recommends the highest-recall set whose false-positive rate is within ``--max-fp``.

    python tools/quote_tuner.py                      # default grid, 300 positives
    python tools/quote_tuner.py --quick --noise 0.2  # small grid, noisier readings

A recommendation is evidence, not a decision: change the defaults only after reviewing
the table (a miss is cheap, a wrong suggestion costs operator attention).
"""
from __future__ import annotations

import argparse
import itertools
import json
import random
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from churchtools import appdata  # noqa: E402

HELPER = Path(__file__).resolve().parent / "node_helpers" / "quote_eval.cjs"
DEFAULTS = {"shingle": 5, "minRuns": 4, "minCoverage": 0.35, "dominance": 2}
SERMON_SENTENCES = [
    "Frères et soeurs, nous sommes réunis ce matin pour louer le Seigneur ensemble dans la joie",
    "Je voudrais vous parler aujourd'hui de la fidélité de Dieu dans les moments difficiles de notre vie",
    "Prenez le temps de prier chaque jour et de lire la parole de Dieu avec un coeur ouvert",
    "Il y a quelques années j'ai traversé une épreuve que je n'oublierai jamais et Dieu était là",
    "Nous allons maintenant passer aux annonces de la semaine puis nous prendrons l'offrande",
]


@dataclass
class Query:
    id: int
    text: str
    kind: str  # "exact" | "noisy" | "negative"
    truth: str | None  # "john 3:16" for positives, None for negatives


def load_verses(repo: Path = appdata.REPO_ROOT) -> list[tuple[str, str]]:
    """(catalog reference like 'john 3:16', verse text) for every verse in the bundled LSG file."""
    keys = appdata.load_offline_keys(repo)
    data = json.loads((repo / "apps/server/verse/data/fra_lsg.json").read_text(encoding="utf-8"))
    verses: list[tuple[str, str]] = []
    for offline_key, chapters in data.items():
        book = keys.get(offline_key)
        if not book:
            continue
        for chapter, by_verse in chapters.items():
            for verse, text in by_verse.items():
                verses.append((f"{book} {chapter}:{verse}", text))
    return verses


def add_noise(text: str, noise: float, rng: random.Random, vocabulary: list[str]) -> str:
    """ASR-like damage: drop a word, or swap it for a random one, each with probability ``noise``/2."""
    out = []
    for word in text.split():
        roll = rng.random()
        if roll < noise / 2:
            continue
        out.append(rng.choice(vocabulary) if roll < noise else word)
    return " ".join(out)


def make_queries(verses, n: int, noise: float, seed: int, extra_negatives: list[str]) -> list[Query]:
    rng = random.Random(seed)
    pool = [v for v in verses if len(v[1].split()) >= 10]  # a 3-word verse cannot be quoted distinctively
    vocabulary = [w for _, t in rng.sample(pool, min(200, len(pool))) for w in t.split()]
    chosen = rng.sample(pool, min(n, len(pool)))
    queries: list[Query] = []
    for reference, text in chosen:
        queries.append(Query(len(queries), text, "exact", reference))
        queries.append(Query(len(queries), add_noise(text, noise, rng, vocabulary), "noisy", reference))
    # Bible-flavoured text that is NOT a quotation: 3-word chunks from four unrelated verses. No run longer than
    # 3 consecutive words comes from one verse, so a match here is a real false positive. (Gluing two HALF verses
    # together would be wrong: half a verse read aloud is a genuine quotation the matcher should recognise.)
    for _ in range(n):
        chunks = []
        for _, text in rng.sample(pool, 4):
            tokens = text.split()
            start = rng.randrange(0, max(1, len(tokens) - 3))
            chunks.extend(tokens[start:start + 3])
        queries.append(Query(len(queries), " ".join(chunks), "negative", None))
    for sentence in SERMON_SENTENCES + extra_negatives:
        queries.append(Query(len(queries), sentence, "negative", None))
    return queries


def run_matcher(grid: list[dict], queries: list[Query], node: str = "node") -> list[list[dict]]:
    payload = json.dumps({"grid": grid, "queries": [{"id": q.id, "text": q.text} for q in queries]})
    result = subprocess.run([node, str(HELPER)], input=payload, capture_output=True, text=True, encoding="utf-8", timeout=1800)
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or f"node exited with {result.returncode}")
    return json.loads(result.stdout)["results"]


def adjacent(a: str, b: str) -> bool:
    """Same book and chapter, neighbouring verse: a reading that runs over is expected, not an error."""
    (ba, va), (bb, vb) = a.rsplit(":", 1), b.rsplit(":", 1)
    return ba == bb and abs(int(va) - int(vb)) <= 1


def score(queries: list[Query], matches: list[dict]) -> dict:
    by_id = {m["id"]: m["match"] for m in matches}
    pos = [q for q in queries if q.truth]
    neg = [q for q in queries if not q.truth]
    exact = sum(1 for q in pos if by_id[q.id] == q.truth)
    near = sum(1 for q in pos if by_id[q.id] not in (None, q.truth) and adjacent(by_id[q.id], q.truth))
    wrong = sum(1 for q in pos if by_id[q.id] not in (None, q.truth) and not adjacent(by_id[q.id], q.truth))
    false_pos = sum(1 for q in neg if by_id[q.id] is not None)
    by_kind = {k: (sum(1 for q in pos if q.kind == k and by_id[q.id] == q.truth), sum(1 for q in pos if q.kind == k)) for k in ("exact", "noisy")}
    return {
        "recall": exact / len(pos) if pos else 0.0,
        "recall_exact_reading": by_kind["exact"][0] / by_kind["exact"][1] if by_kind["exact"][1] else 0.0,
        "recall_noisy_reading": by_kind["noisy"][0] / by_kind["noisy"][1] if by_kind["noisy"][1] else 0.0,
        "adjacent": near / len(pos) if pos else 0.0,
        "wrong": wrong / len(pos) if pos else 0.0,
        "false_positive": false_pos / len(neg) if neg else 0.0,
        "positives": len(pos), "negatives": len(neg),
    }


def build_grid(quick: bool) -> list[dict]:
    shingles, runs, coverage, dominance = ([5], [4, 6], [0.35, 0.5], [2]) if quick else ([4, 5, 6], [3, 4, 5, 6], [0.25, 0.35, 0.5], [2])
    grid = [dict(zip(DEFAULTS, combo)) for combo in itertools.product(shingles, runs, coverage, dominance)]
    return grid if DEFAULTS in grid else [DEFAULTS, *grid]


def recommend(rows: list[tuple[dict, dict]], max_fp: float) -> tuple[dict, dict] | None:
    ok = [r for r in rows if r[1]["false_positive"] <= max_fp and r[1]["wrong"] <= max_fp]
    return max(ok, key=lambda r: (r[1]["recall"], -r[1]["false_positive"])) if ok else None


def render(rows: list[tuple[dict, dict]], best) -> str:
    lines = ["| shingle | minRuns | minCoverage | dominance | recall | exact | noisy | adjacent | wrong | false-pos | |", "|---|---|---|---|---|---|---|---|---|---|---|"]
    for params, s in sorted(rows, key=lambda r: -r[1]["recall"]):
        tag = " **current**" if params == DEFAULTS else ""
        tag += " **<- best within limit**" if best and params == best[0] else ""
        lines.append(
            f"| {params['shingle']} | {params['minRuns']} | {params['minCoverage']} | {params['dominance']} | {s['recall']:.1%} | "
            f"{s['recall_exact_reading']:.1%} | {s['recall_noisy_reading']:.1%} | {s['adjacent']:.1%} | {s['wrong']:.1%} | {s['false_positive']:.1%} |{tag} |"
        )
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("-n", type=int, default=300, help="verses to sample (each gives an exact and a noisy reading)")
    parser.add_argument("--noise", type=float, default=0.15, help="share of words damaged in the noisy reading")
    parser.add_argument("--seed", type=int, default=7)
    parser.add_argument("--max-fp", type=float, default=0.0, help="largest acceptable false-positive / wrong-verse rate")
    parser.add_argument("--quick", action="store_true")
    parser.add_argument("--negatives", type=Path, help="file with one ordinary (non-Bible) sentence per line")
    args = parser.parse_args(argv)

    extra = [l.strip() for l in args.negatives.read_text(encoding="utf-8").splitlines() if l.strip()] if args.negatives else []
    queries = make_queries(load_verses(), args.n, args.noise, args.seed, extra)
    grid = build_grid(args.quick)
    print(f"{len(queries)} queries x {len(grid)} parameter sets (building each index takes ~1 s)...", file=sys.stderr)
    rows = [(params, score(queries, matches)) for params, matches in zip(grid, run_matcher(grid, queries))]
    best = recommend(rows, args.max_fp)
    print(render(rows, best))
    print("\n" + (f"Best within limits: {best[0]}" if best else f"No parameter set keeps false positives within {args.max_fp:.0%}."))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
