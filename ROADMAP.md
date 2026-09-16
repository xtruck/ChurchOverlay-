# Roadmap

This file exists so deferred ideas have somewhere to go besides the v1 codebase.
See `ARCHITECTURE.md` section 3 for the authoritative out-of-scope list and section 50 for the extension seams each item slots into.

## v1 (current)

Core pipeline only: mic → cloud ASR (Groq) → regex verse detection → hallucination-guarded lookup → OBS overlay. See `ARCHITECTURE.md` for the full spec.

## Deferred — not v1, do not implement without an explicit architecture review

Each item below is a candidate future milestone, added as a new implementation behind an existing extension seam (`AsrProvider`, `VerseDetector`, `VerseSource`) wherever possible — not a rewrite.

- **Local / hybrid ASR** (whisper.cpp, Deepgram) — new `AsrProvider` implementation
- **Semantic / paraphrase-aware verse detection** — new `VerseDetector` implementation
- **Multiple Bible translations, offline Bible database, vector search** — new `VerseSource` implementations
- Media library
- Songs / lyrics
- Scenes
- Rundown / service planning
- Cameras
- Branding engine
- AI agent
- MCP server
- ProPresenter integration
- Planning Center integration
- Automated OBS control
- Dynamic plugin loading
- Remote / cloud synchronization
- Multi-user networking
- Mobile application
- Cloud backend

## Adding an item here

If a request during v1 development needs one of the above, flag it as a scope change (per `AGENTS.md` §4) rather than implementing it — add a one-line note here instead if it's new.
