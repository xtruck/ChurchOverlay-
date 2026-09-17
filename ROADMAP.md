# Roadmap

This file exists so deferred ideas have somewhere to go besides the v1 codebase.
See `ARCHITECTURE.md` section 3 for the authoritative out-of-scope list, section 50 for the extension seams each item slots into, and section 59 for the Phase 2 scope-change record below.

## v1 (current)

Core pipeline only: mic → cloud ASR (Groq) → regex verse detection → hallucination-guarded lookup → OBS overlay. See `ARCHITECTURE.md` for the full spec.

## Phase 2 (approved — scope change recorded in ARCHITECTURE.md section 59)

Audience shift: ChurchOverlay is no longer scoped as one specific church's internal tool — it's meant to be installable by other churches. It stays a local, single-install Electron desktop app (no hosting, no multi-tenant backend); "installable by other churches" means generic branding (a church name/branding step in first-run setup) and no church-specific defaults left in the app, not a hosted product.

Visual refactor of the existing v1 screens (dashboard, overlay, setup screen) is approved as a single full pass first — cosmetic only, no scope or interface changes, no architecture-review requirement of its own (ARCHITECTURE.md section 57 item 4).

Build order below, by risk and dependency — each still needs its own dedicated architecture note before its code starts (ARCHITECTURE.md section 59.3). Voice-driven verse navigation was added mid-session as an extension of the shipped v1 verse pipeline rather than one of the original three Phase 2 items, and is sequenced right after media library since both are now architecture-note-complete and ready to build:

1. **Media library** — architecture note complete (`ARCHITECTURE.md` section 60), not yet implemented. Lowest risk of the three, self-contained. Song lyrics, originally planned alongside this, is dropped from Phase 2 entirely (confirmed explicitly) — this is images/video/audio only. v1 of this feature supports full playback transport (play/pause/seek) for video/audio and voice-triggered media by exact title match, both confirmed explicitly as genuine architectural decisions, not assumed. `MediaCue` concept (image/video/audio via a `kind` discriminant), `media:select`/`media:play`/`media:pause`/`media:seek`/`media:clear`/`media:show` WS actions, server-authoritative playback state with timestamp-and-recompute sync (section 60.5), a sibling `MediaCueDetector` for voice-triggered display (section 60.3), secure local-file handling (never a raw filesystem path handed to the renderer or accepted from a WS payload).
2. **Voice-driven verse navigation** — architecture note complete (`ARCHITECTURE.md` section 61), not yet implemented. An extension of the already-shipped verse pipeline rather than a new domain, raised mid-session and scoped separately from the original three items above. Next/previous verse, next/previous chapter, cancel/clear, and jump-to-a-named-book-and-chapter, all by voice, using a small fixed synonym list per command (confirmed explicitly — not exact-phrase-only, not fuzzy/semantic matching) and server-authoritative current-position tracking with `BOOK_CATALOG`-driven boundary rollover. Every computed reference still passes through `KnownValidVerseIndex.exists()` before display — never bypassed. Does not include mic start/stop by voice (confirmed explicitly excluded).
3. **Service rundown & scenes** — medium risk. A real new stateful subsystem (verse mode / announcement / media cue / blank, stepped through in sequence) needing an explicit state machine, not scattered booleans. Confirmed: live voice-detected verse display keeps running in the background while a rundown is active — it does not get suspended. Not yet decided: the actual precedence between a live-detected verse and the rundown's current scene when both want the overlay at once, NOR between a media cue and a live-detected/navigated verse (the same class of question, now shared with the media library and voice-navigation items above) — this must be settled in this feature's own architecture note.
4. **AI copilot** — highest risk. Confirmed to mean something broader than the `ReferenceInterpreter` idea below alone (sermon/topic assistance, slide suggestions, a chat-style assistant, the reference-proposal idea, or some combination — not yet decided). Whatever form it takes, any AI-proposed Bible reference must still pass through the same hallucination-guard pipeline `RegexDetector`'s output does today (ARCHITECTURE.md section 15) — never trusted directly. Does not proceed to code before its own dedicated architecture review.

## Deferred — not v1, do not implement without an explicit architecture review

Each item below is a candidate future milestone, added as a new implementation behind an existing extension seam (`AsrProvider`, `VerseDetector`, `VerseSource`) wherever possible — not a rewrite.

- **Local / hybrid ASR** (whisper.cpp, Deepgram) — new `AsrProvider` implementation
- **Gemini Live + Google ADK as a `ReferenceInterpreter`** — using Gemini Live's full-duplex streaming understanding to propose a Bible reference directly from speech (instead of transcript + regex). Evaluated and explicitly deferred (not rejected outright): requires real session-management engineering (10-minute forced WebSocket reconnects, resumption tokens, 15-minute context cap without compression) that Groq's stateless per-chunk requests don't need. Its own output would still have to pass through the same hallucination-guard pipeline as any other interpreter — an LLM-proposed reference is never trusted directly, per ARCHITECTURE.md §15. If revisited, build it as an additional `ReferenceInterpreter`/`AsrProvider` implementation alongside Groq/RegexDetector, not a replacement. One candidate building block for Phase 2's AI copilot item above, not the whole of it.
- **Semantic / paraphrase-aware verse detection** — new `VerseDetector` implementation
- **Multiple Bible translations, offline Bible database, vector search** — new `VerseSource` implementations
- Cameras
- Branding engine (as a distinct subsystem — Phase 2's generic-branding first-run step above is a much smaller, already-approved slice of this)
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
