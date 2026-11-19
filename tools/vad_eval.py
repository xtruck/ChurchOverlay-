#!/usr/bin/env python3
"""Evaluate the silence gate (and, optionally, Silero VAD) on recorded audio.

AGENTS.md section 11: the silence gate is an optimisation, not a speech authority, and
must not be replaced "without evidence and testing". This tool produces the evidence.

It re-implements the app's gate exactly (apps/server/audio/silence-gate.ts): per frame,
RMS on the PCM16 scale; a frame is forwarded when RMS >= threshold, and stays forwarded for
a hangover (600 ms) after the last loud frame. The number that matters is SPEECH RECALL:
the share of real speech frames the gate forwards. Dropped speech is the failure that
looks like "the mic doesn't work"; forwarded silence only wastes a cheap ASR call.

    python tools/vad_eval.py room.wav --labels speech.csv
    python tools/vad_eval.py room.wav --labels silero            # needs: pip install silero-vad torch
    python tools/vad_eval.py room.wav --labels speech.csv --sweep 50,100,150,250,400

``speech.csv`` has one speech segment per line: ``start_seconds,end_seconds`` (e.g. made in
Audacity). Input must be 16-bit PCM mono WAV (the app's canonical 16 kHz format; any rate works).
"""
from __future__ import annotations

import argparse
import math
import struct
import sys
import wave
from dataclasses import dataclass
from pathlib import Path

DEFAULT_THRESHOLD = 150.0  # DEFAULT_RMS_THRESHOLD in silence-gate.ts
DEFAULT_HANGOVER_MS = 600.0  # DEFAULT_HANGOVER_MS in silence-gate.ts
DEFAULT_FRAME_SAMPLES = 128  # the capture worklet's quantum: ~129 frames/s at 16 kHz in real service logs


def read_wav(path: Path) -> tuple[int, list[int]]:
    with wave.open(str(path), "rb") as handle:
        if handle.getsampwidth() != 2 or handle.getnchannels() != 1:
            raise ValueError("expected 16-bit PCM mono WAV (convert with: ffmpeg -i in.wav -ac 1 -ar 16000 out.wav)")
        rate = handle.getframerate()
        raw = handle.readframes(handle.getnframes())
    return rate, list(struct.unpack("<%dh" % (len(raw) // 2), raw))


def frame_rms(samples: list[int], frame_samples: int) -> list[float]:
    out = []
    for start in range(0, len(samples) - frame_samples + 1, frame_samples):
        chunk = samples[start:start + frame_samples]
        out.append(math.sqrt(sum(s * s for s in chunk) / frame_samples))
    return out


def gate_decisions(rms_values: list[float], frame_ms: float, threshold: float = DEFAULT_THRESHOLD,
                   hangover_ms: float = DEFAULT_HANGOVER_MS) -> list[bool]:
    """Port of SilenceGate.process(): forwarded = above threshold OR hangover budget left."""
    hangover = 0.0
    decisions = []
    for rms in rms_values:
        above = rms >= threshold
        forwarded = above or hangover > 0
        if above:
            hangover = hangover_ms
        elif hangover > 0:
            hangover = max(0.0, hangover - frame_ms)
        decisions.append(forwarded)
    return decisions


def labels_to_frames(segments: list[tuple[float, float]], n_frames: int, frame_ms: float) -> list[bool]:
    truth = [False] * n_frames
    for start, end in segments:
        for i in range(max(0, int(start * 1000 / frame_ms)), min(n_frames, int(end * 1000 / frame_ms) + 1)):
            truth[i] = True
    return truth


def read_label_csv(path: Path) -> list[tuple[float, float]]:
    segments = []
    for line in path.read_text(encoding="utf-8").splitlines():
        parts = [p.strip() for p in line.split(",")]
        if len(parts) >= 2 and parts[0].replace(".", "", 1).isdigit():
            segments.append((float(parts[0]), float(parts[1])))
    return segments


def silero_segments(path: Path) -> list[tuple[float, float]]:
    """Speech segments from Silero VAD (optional dependency)."""
    try:
        from silero_vad import get_speech_timestamps, load_silero_vad, read_audio  # type: ignore[import-not-found]
    except ImportError as error:
        raise SystemExit("--labels silero needs: pip install silero-vad torch") from error
    audio = read_audio(str(path), sampling_rate=16000)
    stamps = get_speech_timestamps(audio, load_silero_vad(), sampling_rate=16000, return_seconds=True)
    return [(s["start"], s["end"]) for s in stamps]


@dataclass
class Metrics:
    threshold: float
    frames: int
    speech_frames: int
    forwarded_frames: int
    speech_recall: float
    silence_forwarded_pct: float
    dropped_speech_frames: int


def evaluate(rms_values: list[float], truth: list[bool], frame_ms: float, threshold: float, hangover_ms: float) -> Metrics:
    decisions = gate_decisions(rms_values, frame_ms, threshold, hangover_ms)
    speech = sum(truth)
    kept = sum(1 for d, t in zip(decisions, truth) if d and t)
    silence = len(truth) - speech
    wasted = sum(1 for d, t in zip(decisions, truth) if d and not t)
    return Metrics(
        threshold=threshold, frames=len(truth), speech_frames=speech, forwarded_frames=sum(decisions),
        speech_recall=kept / speech if speech else 1.0,
        silence_forwarded_pct=100 * wasted / silence if silence else 0.0,
        dropped_speech_frames=speech - kept,
    )


def render(rows: list[Metrics]) -> str:
    lines = ["| threshold | speech recall | dropped speech frames | silence forwarded | forwarded / total |", "|---|---|---|---|---|"]
    for m in rows:
        flag = " **current**" if m.threshold == DEFAULT_THRESHOLD else ""
        lines.append(f"| {m.threshold:g}{flag} | {m.speech_recall:.2%} | {m.dropped_speech_frames} | {m.silence_forwarded_pct:.1f}% | {m.forwarded_frames}/{m.frames} |")
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("wav", type=Path)
    parser.add_argument("--labels", required=True, help="CSV of start,end seconds of real speech, or the word 'silero'")
    parser.add_argument("--sweep", default=str(int(DEFAULT_THRESHOLD)), help="comma-separated thresholds to compare")
    parser.add_argument("--frame-samples", type=int, default=DEFAULT_FRAME_SAMPLES)
    parser.add_argument("--hangover-ms", type=float, default=DEFAULT_HANGOVER_MS)
    args = parser.parse_args(argv)

    rate, samples = read_wav(args.wav)
    frame_ms = 1000.0 * args.frame_samples / rate
    rms_values = frame_rms(samples, args.frame_samples)
    segments = silero_segments(args.wav) if args.labels == "silero" else read_label_csv(Path(args.labels))
    truth = labels_to_frames(segments, len(rms_values), frame_ms)
    thresholds = [float(t) for t in args.sweep.split(",")]
    print(f"{args.wav.name}: {len(samples) / rate:.1f}s at {rate} Hz, {len(rms_values)} frames of {frame_ms:.1f} ms, "
          f"{sum(truth)} speech frames ({len(segments)} segments)", file=sys.stderr)
    print(render([evaluate(rms_values, truth, frame_ms, t, args.hangover_ms) for t in thresholds]))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
