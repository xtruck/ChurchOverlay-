# Third-party notices

## open-whisper (MIT)

The faster-whisper sidecar (`apps/server/asr/faster-whisper-sidecar/server.py`) adapts engine
logic from <https://github.com/AstyanM/open-whisper> (`backend/src/transcription/whisper_client.py`):
CPU/CUDA model selection with a dummy-run check, segment quality filtering and the repetition
hallucination guard.

Copyright (c) AstyanM. Licensed under the MIT License; the copyright notice and permission notice
of that project apply to the adapted portions.

## Downloaded on demand (not redistributed with the app)

faster-whisper (MIT), CTranslate2 (MIT), the Systran faster-whisper models (MIT), CPython (PSF
license), and the wheels pinned in `apps/desktop/main/faster-whisper-manifest.ts` are downloaded at
the operator's request from their original hosts and keep their own licenses.
