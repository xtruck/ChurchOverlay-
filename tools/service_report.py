#!/usr/bin/env python3
"""Post-service report from the app's JSONL log.

    python tools/service_report.py service.jsonl > report.md
    python tools/service_report.py service.jsonl --csv latency.csv --chart report.png

Reads (all optional, whatever the log contains): transcripts (partial/final), silence-gate
metrics, ``verse.latency`` (end-to-end ms from final transcript to screen), near-misses,
navigation no-ops, overridden-and-rejected references, quote suggestions, AI helper
failures, ASR errors. Standard library only; ``--chart`` needs matplotlib if you have it.
"""
from __future__ import annotations

import argparse
import csv
import math
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from churchtools.logs import Event, ReadStats, iter_events  # noqa: E402


def percentile(values: list[float], pct: float) -> float:
    """Nearest-rank percentile (no interpolation: reads like what operators felt)."""
    if not values:
        return math.nan
    ordered = sorted(values)
    rank = max(1, math.ceil(pct / 100 * len(ordered)))
    return ordered[rank - 1]


def build_report(events: list[Event]) -> dict:
    stamps = [e.timestamp for e in events if e.timestamp]
    duration_s = (max(stamps) - min(stamps)).total_seconds() if len(stamps) > 1 else 0.0

    transcripts = Counter(e.metadata.get("state") for e in events if e.event == "transcript.received")
    latencies = [e.duration_ms for e in events if e.event == "verse.latency" and e.duration_ms is not None]
    by_delivery: dict[str, list[float]] = {}
    for e in events:
        if e.event == "verse.latency" and e.duration_ms is not None:
            by_delivery.setdefault(str(e.metadata.get("delivery", "unknown")), []).append(e.duration_ms)

    gate = None
    for e in events:  # the last silence-gate snapshot is the session total
        snapshot = e.metadata.get("silenceGate") if e.event == "transcript.received" else None
        if isinstance(snapshot, dict):
            gate = snapshot
    gate_report = None
    if gate and gate.get("framesReceived"):
        received = gate["framesReceived"]
        gate_report = {
            "framesReceived": received,
            "framesForwarded": gate.get("framesForwarded", 0),
            "framesRejected": gate.get("framesRejected", 0),
            "rejectedPct": round(100 * gate.get("framesRejected", 0) / received, 1),
            "averageRms": round(gate.get("averageRms", 0), 1),
            "maxRms": round(gate.get("maxRms", 0), 1),
        }

    finals = transcripts.get("final", 0)
    return {
        "events": len(events),
        "duration_s": duration_s,
        "transcripts": {"partial": transcripts.get("partial", 0), "final": finals},
        "finals_per_minute": round(finals / (duration_s / 60), 1) if duration_s >= 60 else None,
        "verses_shown": len(latencies),
        "latency_ms": {
            "count": len(latencies),
            "p50": percentile(latencies, 50), "p90": percentile(latencies, 90),
            "p95": percentile(latencies, 95), "max": max(latencies) if latencies else math.nan,
        },
        "latency_by_delivery": {k: {"count": len(v), "p50": percentile(v, 50)} for k, v in sorted(by_delivery.items())},
        "silence_gate": gate_report,
        "near_misses": Counter(str(e.metadata.get("text", "")) for e in events if e.event == "detector.near-miss"),
        "navigation_no_ops": Counter(str(e.metadata.get("reason", "?")) for e in events if e.event == "navigation.no-op"),
        "override_rejected": Counter(
            f'{(e.metadata.get("reference") or {}).get("book")} {(e.metadata.get("reference") or {}).get("chapter")}:'
            f'{(e.metadata.get("reference") or {}).get("verse")} ({e.metadata.get("reason", "lookup")})'
            for e in events if e.event == "override.rejected"
        ),
        "quote_suggestions": sum(1 for e in events if e.event == "quote.suggested"),
        "ai_failures": Counter(
            f"{e.event}: {e.error}" for e in events if e.event.startswith("ai.") and "failed" in e.event or e.event == "ai.cleanup-fallback-raw"
        ),
        "ai_circuit": [e.event for e in events if e.event.startswith("ai.circuit")],
        "asr_errors": Counter(e.error or e.event for e in events if e.event in ("transcript.failed", "asr.audio-discarded")),
    }


def _fmt(value: float) -> str:
    return "n/a" if isinstance(value, float) and math.isnan(value) else f"{value:.0f}"


def _table(counter: Counter, limit: int = 8) -> list[str]:
    if not counter:
        return ["_none_"]
    return [f"- {count} x {text}" for text, count in counter.most_common(limit)]


def render_markdown(report: dict, stats: ReadStats | None = None) -> str:
    lat = report["latency_ms"]
    lines = ["# Service report", ""]
    minutes = report["duration_s"] / 60
    lines.append(f"- Log span: **{minutes:.1f} min**, {report['events']} events"
                 + (f" ({stats.skipped} non-JSON lines skipped)" if stats and stats.skipped else ""))
    lines.append(f"- Transcripts: **{report['transcripts']['final']} final**, {report['transcripts']['partial']} partial"
                 + (f" ({report['finals_per_minute']}/min)" if report["finals_per_minute"] else ""))
    lines.append(f"- Verses shown (with latency): **{report['verses_shown']}**")
    lines += ["", "## Latency (final transcript to screen)", ""]
    if lat["count"]:
        lines.append(f"p50 **{_fmt(lat['p50'])} ms**, p90 {_fmt(lat['p90'])} ms, p95 {_fmt(lat['p95'])} ms, max {_fmt(lat['max'])} ms ({lat['count']} verses)")
        for delivery, data in report["latency_by_delivery"].items():
            lines.append(f"- {delivery}: {data['count']} verses, p50 {_fmt(data['p50'])} ms")
    else:
        lines.append("_No verse.latency events in this log._")
    lines += ["", "## Silence gate", ""]
    gate = report["silence_gate"]
    if gate:
        lines.append(f"{gate['framesReceived']} frames received, {gate['framesForwarded']} forwarded, "
                     f"{gate['framesRejected']} rejected (**{gate['rejectedPct']}%**); average RMS {gate['averageRms']}, max {gate['maxRms']}")
    else:
        lines.append("_No silence-gate metrics in this log._")
    lines += ["", "## Heard but not matched (near-misses)", "", *_table(report["near_misses"])]
    lines += ["", "## Navigation commands that did nothing", "", *_table(report["navigation_no_ops"])]
    lines += ["", "## Operator references the app rejected", "", *_table(report["override_rejected"])]
    lines += ["", f"## Quote suggestions offered: {report['quote_suggestions']}", ""]
    lines += ["## AI helper trouble", "", *_table(report["ai_failures"])]
    if report["ai_circuit"]:
        lines.append(f"- circuit events: {', '.join(report['ai_circuit'])}")
    lines += ["", "## ASR trouble", "", *_table(report["asr_errors"]), ""]
    return "\n".join(lines)


def write_csv(events: list[Event], path: Path) -> None:
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(["timestamp", "delivery", "latency_ms", "correlation_id"])
        for e in events:
            if e.event == "verse.latency" and e.duration_ms is not None:
                writer.writerow([e.timestamp.isoformat() if e.timestamp else "", e.metadata.get("delivery", ""), e.duration_ms, e.correlation_id or ""])


def write_chart(events: list[Event], path: Path) -> bool:
    try:
        import matplotlib  # type: ignore[import-not-found]

        matplotlib.use("Agg")
        import matplotlib.pyplot as plt  # type: ignore[import-not-found]
    except ImportError:
        print("matplotlib is not installed: skipping --chart (pip install matplotlib)", file=sys.stderr)
        return False
    latencies = [e.duration_ms for e in events if e.event == "verse.latency" and e.duration_ms is not None]
    finals = [e.timestamp for e in events if e.event == "transcript.received" and e.metadata.get("state") == "final" and e.timestamp]
    fig, (a, b) = plt.subplots(1, 2, figsize=(11, 3.6))
    a.hist(latencies or [0], bins=15)
    a.set(title="Verse latency (ms)", xlabel="ms", ylabel="verses")
    if finals:
        start = min(finals)
        minutes = [int((t - start).total_seconds() // 60) for t in finals]
        counts = Counter(minutes)
        b.bar(sorted(counts), [counts[m] for m in sorted(counts)])
    b.set(title="Final transcripts per minute", xlabel="minute of service", ylabel="finals")
    fig.tight_layout()
    fig.savefig(path, dpi=120)
    return True


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("logs", nargs="+")
    parser.add_argument("--csv", type=Path, help="write per-verse latency rows")
    parser.add_argument("--chart", type=Path, help="write a PNG (needs matplotlib)")
    args = parser.parse_args(argv)
    stats = ReadStats()
    events = list(iter_events(args.logs, stats))
    print(render_markdown(build_report(events), stats))
    if args.csv:
        write_csv(events, args.csv)
    if args.chart:
        write_chart(events, args.chart)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
