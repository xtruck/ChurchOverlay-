#!/usr/bin/env python3
"""Turn a real service log into replay-test cases.

apps/server/detector/sermon-replay.test.ts replays FINAL transcripts through the
detector and the known-valid index with no microphone, ASR or network. This tool
builds new cases from a service log, so every real mishearing becomes a regression
test instead of a memory.

    python tools/log_to_replay.py service.jsonl                 # distinct finals (JSON)
    python tools/log_to_replay.py service.jsonl --with-detector # + current detector outcome, as TS rows

``--with-detector`` runs the REAL built detector (needs ``npm run build``) through
tools/node_helpers/detect_eval.cjs and records what it does TODAY. Those expectations
describe current behaviour, not truth: review every row (especially the ones that
show a verse) before pasting it into the test file.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from churchtools.logs import Event, final_transcripts, iter_events  # noqa: E402
from churchtools.text_norm import words  # noqa: E402

HELPER = Path(__file__).resolve().parent / "node_helpers" / "detect_eval.cjs"


def extract_finals(events: list[Event], min_chars: int = 8) -> list[str]:
    """Distinct final transcripts in log order. Case/punctuation-insensitive de-duplication."""
    seen: set[str] = set()
    out: list[str] = []
    for event in final_transcripts(events):
        text = str(event.metadata["text"]).strip()
        key = " ".join(words(text))
        if len(text) < min_chars or key in seen:
            continue
        seen.add(key)
        out.append(text)
    return out


def run_detector(texts: list[str], node: str = "node") -> list[dict]:
    result = subprocess.run(
        [node, str(HELPER)], input=json.dumps(texts), capture_output=True, text=True, encoding="utf-8", timeout=120
    )
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or f"node exited with {result.returncode}")
    return json.loads(result.stdout)


def ts_string(value: str) -> str:
    return json.dumps(value, ensure_ascii=False)


def render_ts_rows(texts: list[str], outcomes: list[dict]) -> str:
    rows = [
        "// AUTO-GENERATED from a service log: expectations record what the detector does TODAY.",
        "// Review each row before adding it to sermon-replay.test.ts (is the shown verse really what was said?).",
    ]
    for text, outcome in zip(texts, outcomes):
        shown = "[" + ", ".join(ts_string(r) for r in outcome["shown"]) + "]"
        rejected = (
            ", rejected: [" + ", ".join(ts_string(r) for r in outcome["rejected"]) + "]" if outcome["rejected"] else ""
        )
        rows.append(f'  {{ text: {ts_string(text)}, shown: {shown}{rejected}, note: "TODO review (from log)" }},')
    return "\n".join(rows)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("logs", nargs="+")
    parser.add_argument("--min-chars", type=int, default=8)
    parser.add_argument("--with-detector", action="store_true", help="also run the built detector (needs npm run build)")
    parser.add_argument("--only-interesting", action="store_true",
                        help="with --with-detector: keep only finals that show or reject a reference, or that look like near-misses")
    args = parser.parse_args(argv)

    texts = extract_finals(list(iter_events(args.logs)), args.min_chars)
    if not args.with_detector:
        print(json.dumps(texts, ensure_ascii=False, indent=2))
        return 0
    outcomes = run_detector(texts)
    if args.only_interesting:
        keep = [
            i for i, (text, o) in enumerate(zip(texts, outcomes))
            if o["shown"] or o["rejected"] or any(k in text.lower() for k in ("verset", "chapitre", "verse", "chapter"))
        ]
        texts, outcomes = [texts[i] for i in keep], [outcomes[i] for i in keep]
    print(render_ts_rows(texts, outcomes))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
