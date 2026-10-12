"""Reading the app's structured JSONL logs.

The app writes one JSON object per line to stdout (see packages/shared/logger.ts):
``{"timestamp", "level", "component", "event", "correlationId", "sequence",
"durationMs", "error", "metadata"}``. Redirect it to a file to keep a service's log.

The reader is deliberately forgiving: a pasted or truncated log has lines that
are not JSON (or are cut in half). Those are counted, never fatal.
"""
from __future__ import annotations

import json
import sys
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Iterable, Iterator


@dataclass
class ReadStats:
    lines: int = 0
    events: int = 0
    skipped: int = 0


@dataclass
class Event:
    raw: dict
    timestamp: datetime | None = None
    level: str = ""
    component: str = ""
    event: str = ""
    correlation_id: str | None = None
    metadata: dict = field(default_factory=dict)

    @property
    def duration_ms(self) -> float | None:
        value = self.raw.get("durationMs")
        return float(value) if isinstance(value, (int, float)) else None

    @property
    def error(self) -> str | None:
        value = self.raw.get("error")
        return value if isinstance(value, str) else None


def parse_timestamp(value: object) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc)
    except ValueError:
        return None


def parse_line(line: str) -> Event | None:
    line = line.strip()
    if not line.startswith("{"):
        return None
    try:
        raw = json.loads(line)
    except json.JSONDecodeError:
        return None
    if not isinstance(raw, dict) or not isinstance(raw.get("event"), str):
        return None
    metadata = raw.get("metadata")
    return Event(
        raw=raw,
        timestamp=parse_timestamp(raw.get("timestamp")),
        level=str(raw.get("level", "")),
        component=str(raw.get("component", "")),
        event=raw["event"],
        correlation_id=raw.get("correlationId") if isinstance(raw.get("correlationId"), str) else None,
        metadata=metadata if isinstance(metadata, dict) else {},
    )


def iter_events(paths: Iterable[str], stats: ReadStats | None = None) -> Iterator[Event]:
    """Yield events from log files ("-" means stdin). Bad lines are counted in ``stats``."""
    stats = stats if stats is not None else ReadStats()
    for path in paths:
        handle = sys.stdin if path == "-" else open(path, encoding="utf-8", errors="replace")
        try:
            for line in handle:
                if not line.strip():
                    continue
                stats.lines += 1
                event = parse_line(line)
                if event is None:
                    stats.skipped += 1
                    continue
                stats.events += 1
                yield event
        finally:
            if handle is not sys.stdin:
                handle.close()


def final_transcripts(events: Iterable[Event]) -> Iterator[Event]:
    """The ``transcript.received`` events whose state is ``final`` (the only ones that enter detection)."""
    for event in events:
        if event.event == "transcript.received" and event.metadata.get("state") == "final":
            text = event.metadata.get("text")
            if isinstance(text, str) and text.strip():
                yield event
