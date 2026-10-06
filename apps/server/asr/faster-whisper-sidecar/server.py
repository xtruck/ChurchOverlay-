"""Local faster-whisper transcription sidecar for ChurchOverlay.

Speaks the same tiny HTTP contract as whisper.cpp's `whisper-server`, so the
app's LocalWhisperProvider talks to either engine unchanged:

    GET  /health     -> 200 once the model is loaded
    POST /inference  -> multipart: file (16 kHz mono WAV), language, prompt,
                        temperature  ->  {"text": "..."}

Only the standard library plus faster-whisper's own dependencies are used.
Binds to 127.0.0.1 only. Engine logic (CPU/CUDA selection with a dummy-run
check, segment quality filtering, repetition-hallucination guard) is adapted
from the open-whisper project's whisper_client.py (MIT, (c) AstyanM) -
see THIRD_PARTY_NOTICES.md.
"""

from __future__ import annotations

import argparse
import json
import sys
import threading
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from io import BytesIO

MAX_BODY_BYTES = 16 * 1024 * 1024  # ~8 min of 16 kHz mono 16-bit audio
COMPRESSION_RATIO_MAX = 2.4
AVG_LOGPROB_MIN = -1.0
NO_SPEECH_PROB_MAX = 0.6
# Decoder thresholds, the faster-whisper equivalents of the entropy_thold /
# logprob_thold fields the provider sends to whisper.cpp (faster-whisper
# ignores those form fields). -1.25 is OpenWhispr's tuned logprob threshold
# (whisperServer.js, MIT); 2.4 is faster-whisper's own compression default,
# made explicit. With one fixed temperature there is no fallback re-decode:
# they decide when a window counts as silence (no_speech AND low logprob).
DECODER_LOG_PROB_THRESHOLD = -1.25
DECODER_COMPRESSION_RATIO_THRESHOLD = COMPRESSION_RATIO_MAX


def is_hallucinated(text: str, max_repeats: int = 3) -> bool:
    """True when a 1-6 word phrase repeats back to back more than max_repeats times."""
    words = text.split()
    for size in range(1, 7):
        run = 1
        for i in range(size, len(words) - size + 1, size):
            if words[i : i + size] == words[i - size : i]:
                run += 1
                if run > max_repeats:
                    return True
            else:
                run = 1
    return False


def parse_multipart(content_type: str, body: bytes) -> dict[str, bytes]:
    """Minimal multipart/form-data parser (the cgi module is gone in Python 3.13)."""
    marker = "boundary="
    index = content_type.find(marker)
    if index < 0:
        raise ValueError("missing multipart boundary")
    boundary = content_type[index + len(marker) :].split(";")[0].strip().strip('"')
    delimiter = b"--" + boundary.encode()
    fields: dict[str, bytes] = {}
    for part in body.split(delimiter)[1:]:
        if part.startswith(b"--"):
            break
        head, _, payload = part.lstrip(b"\r\n").partition(b"\r\n\r\n")
        if payload.endswith(b"\r\n"):
            payload = payload[:-2]
        name = None
        for line in head.decode("utf-8", "replace").split("\r\n"):
            if line.lower().startswith("content-disposition"):
                for token in line.split(";"):
                    token = token.strip()
                    if token.startswith("name="):
                        name = token[5:].strip('"')
        if name is not None:
            fields[name] = payload
    return fields


def wav_to_float32(data: bytes):
    import numpy as np

    with wave.open(BytesIO(data), "rb") as reader:
        if reader.getnchannels() != 1 or reader.getsampwidth() != 2 or reader.getframerate() != 16000:
            raise ValueError("expected 16 kHz mono 16-bit PCM WAV")
        frames = reader.readframes(reader.getnframes())
    return np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0


class Engine:
    def __init__(self, model_dir: str, device: str, threads: int) -> None:
        from faster_whisper import WhisperModel

        compute_type = "int8" if device == "cpu" else "float16"
        self.model = WhisperModel(model_dir, device=device, compute_type=compute_type, cpu_threads=threads)
        self.device = device
        self.lock = threading.Lock()  # one inference at a time; the provider already serialises
        self.ready = False

    def warm_up(self) -> None:
        import numpy as np

        # CUDA errors (cuBLAS/cuDNN missing) only surface on a real run.
        list(self.model.transcribe(np.zeros(16000, dtype=np.float32), beam_size=1)[0])
        self.ready = True

    def transcribe(self, audio, language: str | None, prompt: str | None, temperature: float) -> str:
        with self.lock:
            segments, _info = self.model.transcribe(
                audio,
                language=language,
                initial_prompt=prompt or None,
                temperature=temperature,
                beam_size=1,
                vad_filter=True,
                vad_parameters={"min_silence_duration_ms": 300},
                condition_on_previous_text=False,
                suppress_blank=True,
                no_speech_threshold=NO_SPEECH_PROB_MAX,
                log_prob_threshold=DECODER_LOG_PROB_THRESHOLD,
                compression_ratio_threshold=DECODER_COMPRESSION_RATIO_THRESHOLD,
            )
            kept: list[str] = []
            for segment in segments:
                if segment.compression_ratio > COMPRESSION_RATIO_MAX:
                    continue
                if segment.avg_logprob < AVG_LOGPROB_MIN:
                    continue
                if segment.no_speech_prob > NO_SPEECH_PROB_MAX:
                    continue
                kept.append(segment.text.strip())
        text = " ".join(part for part in kept if part)
        return "" if is_hallucinated(text) else text


def make_handler(engine: Engine):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *_args) -> None:  # keep stderr for real errors only
            return

        def _json(self, status: int, payload: dict) -> None:
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self) -> None:
            if self.path == "/health":
                if engine.ready:
                    self._json(200, {"status": "ok", "device": engine.device})
                else:
                    self._json(503, {"status": "loading"})
            else:
                self._json(404, {"error": "not found"})

        def do_POST(self) -> None:
            if self.path != "/inference":
                self._json(404, {"error": "not found"})
                return
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if length <= 0 or length > MAX_BODY_BYTES:
                    self._json(413, {"error": "bad body size"})
                    return
                fields = parse_multipart(self.headers.get("Content-Type", ""), self.rfile.read(length))
                if "file" not in fields:
                    self._json(400, {"error": "missing file"})
                    return
                language = fields.get("language", b"auto").decode("utf-8", "replace").strip().lower()
                language = None if language in ("", "auto") else language[:8]
                prompt = fields.get("prompt", b"").decode("utf-8", "replace")[:1000]
                try:
                    temperature = min(1.0, max(0.0, float(fields.get("temperature", b"0").decode() or 0)))
                except ValueError:
                    temperature = 0.0
                audio = wav_to_float32(fields["file"])
                text = engine.transcribe(audio, language, prompt, temperature)
                self._json(200, {"text": text})
            except ValueError as error:
                self._json(400, {"error": str(error)})
            except Exception as error:  # report to the provider, which surfaces it as an ASR error
                print(f"inference failed: {error!r}", file=sys.stderr, flush=True)
                self._json(500, {"error": "inference failed"})

    return Handler


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-dir", required=True)
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--device", choices=["cpu", "cuda"], default="cpu")
    parser.add_argument("--threads", type=int, default=4)
    args = parser.parse_args()

    engine = Engine(args.model_dir, args.device, args.threads)
    server = ThreadingHTTPServer(("127.0.0.1", args.port), make_handler(engine))
    # Serve /health (503 "loading") while the warm-up inference runs.
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        engine.warm_up()
    except Exception as error:
        print(f"warm-up failed: {error!r}", file=sys.stderr, flush=True)
        sys.exit(2)
    threading.Event().wait()


if __name__ == "__main__":
    main()
