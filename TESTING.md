# Testing Strategy

ARCHITECTURE.md section 45 sets the shape of this; this document is the concrete,
current state of it. AGENTS.md section 42 requires this file to be updated whenever the
testing strategy changes.

## Running tests

```text
npm test                # unit + integration tests (no network, no secrets required)
npm run test:live-groq  # real Groq API call — requires .env with GROQ_API_KEY
npm run typecheck       # tsc --noEmit
npm run dry-run         # manual end-to-end pipeline exercise, see below
```

No test framework dependency is used — everything runs on Node's built-in
`node:test`/`node:assert/strict` (AGENTS.md section 40: standard library over a new
dependency where it's sufficient).

## Tiers

**Unit tests** — one file per module, colocated as `<module>.test.ts` next to the
module it tests (not a separate `fixtures/` or `packages/testing/` tree — reasonable at
this codebase's current size per ARCHITECTURE.md section 52's own "may be selected
during scaffolding" language). Test doubles are always named `FakeX`/`StubX`, never
left anonymous or disguised as real implementations (AGENTS.md section 45).

**Integration tests** — `apps/server/core/app-core.test.ts` and
`apps/server/ws/server.test.ts` start a real `ChurchOverlayWsServer` on a real
(ephemeral) port and drive it with real `ws` client connections; `app-core.test.ts`
specifically exercises the full pipeline (WS command in → real `RegexDetector` → real
`KnownValidVerseIndex` → `StubVerseSource` → WS broadcast out) with only the ASR
provider and verse source faked, per AGENTS.md section 33 ("use real external services
only in dedicated integration tests").

**Live tests** — `apps/server/asr/groq-provider.live.test.ts` makes a real request to
the real Groq API. It self-skips cleanly (not a failure) when `GROQ_API_KEY` isn't set,
so no other machine's `npm test` run can fail on a missing secret. Run explicitly via
`npm run test:live-groq`. There is no equivalent live test for `FreeApiSource` against
the real bible-api.com — its unit tests mock every response shape instead, and the
dry-run mode below has been used to manually confirm the real integration works
end-to-end (see its commit history for a live-verified trace).

**Manual end-to-end** — `npm run dry-run` (ARCHITECTURE.md section 44) wires a
`DryRunAsrProvider` into the real `AppCore`, alongside the real detector, index, and
`FreeApiSource`. Typing a line at the terminal pushes it through the complete real
pipeline (detection → hallucination-guard validation → real bible-api.com lookup → real
WS broadcast) and displays the result on the real overlay page. Everything except ASR
itself is genuine.

**Real-Electron NDI probe** — `npm run build && xvfb-run -a electron --no-sandbox dist/scripts/ndi-window-probe.js` builds the real `createNdiWindow()` factory and asserts the emitted frame is 1920x1080 with a transparent background and an opaque box (ARCHITECTURE.md section 109). Manual, not part of `npm test`; it proves the offscreen window, not delivery to an NDI receiver.

**Overlay style, manual rendering check** — the overlay page and the dashboard Overlay view are not part of `npm test`. They were verified by driving the real pages in Chromium (Playwright): the overlay with injected `overlay:style` messages for six palette/design combinations, and the dashboard view against a real `AppCore` and `OverlayStyleController` through an HTTP stand-in for Electron IPC (palette and design pick, name entry, logo import, pointer drag, keyboard nudge, anchors, custom palette, persisted result). The Electron-only parts (native file dialog, `nativeImage` decoding, real IPC) were not exercised.

**Not automated in this repository**: real microphone capture, the real Electron GUI,
and OBS Browser Source rendering. These require an actual desktop session; `npm run
package` builds a real installable app for manual verification. Because the browser
pages themselves can't be driven here, their one non-negotiable invariant — authenticate
the WebSocket with `Sec-WebSocket-Protocol`, never a URL parameter — is asserted directly
against their source by `apps/server/ws/client-handshake.test.ts` (deterministic, no
browser, no network). That guard also fails if the set of shipped pages that open a
WebSocket changes, so a new or renamed page has to be acknowledged deliberately.

## Fixture coverage

ARCHITECTURE.md section 46 lists the fixture categories a v1 test suite should cover.
Current status:

| Fixture | Covered by |
|---|---|
| valid verse | `known-valid-verse-index.test.ts`, `resolve-verse.test.ts` |
| invalid book / chapter / verse | `known-valid-verse-index.test.ts` |
| partial transcript | `transcript-gate.test.ts` |
| final transcript | `transcript-gate.test.ts`, `app-core.test.ts` |
| multiple references | `regex-detector.test.ts` |
| no reference | `regex-detector.test.ts`, `process-transcript.test.ts` |
| API failure | `free-api-source.test.ts`, `resolve-verse.test.ts`, `circuit-breaker.test.ts` |
| malformed API response | `free-api-source.test.ts` |
| WebSocket disconnect | `server.test.ts`; both real WS clients reconnect with capped backoff (see SECURITY.md) |
| invalid WS message | `action-registry.test.ts`, `server.test.ts` |
| diagnostics snapshot contains operational state without secrets | `app-core.test.ts` |
| optional NDI output degrades without the native addon and bounds pending frames | `ndi-output.test.ts` |
| NDI sends straight (non-premultiplied) alpha, keeps a 30/10 fps keep-alive cadence, recovers with bounded backoff, gives up after 5 failures and tears down race-safely | `ndi-output.test.ts` |
| Deepgram provider emits validated partial/final streaming transcripts and recovers after WebSocket failure | `deepgram-provider.test.ts` |
| Deepgram failover starts on demand, routes later frames, and preserves Groq-only startup | `failover-provider.test.ts` |
| Manual ASR return closes the secondary path and restores primary health | `failover-provider.test.ts`, `app-core.test.ts` |
| Successful failover is informational rather than a critical rate-limit error | `app-core.test.ts` |
| Deterministic transcript post-processing preserves words while normalizing input | `asr/postprocess/postprocess.test.ts` |
| Live French phonetic ASR spellings recover Jean, verset, and Ésaïe conservatively | `asr/transcription-corrector.test.ts` |
| Audio chunking remains bounded by duration and frame count | `audio/audio-chunker.test.ts` |
| WER benchmark reports deterministic substitution/deletion/insertion counts | `asr/benchmark/wer.test.ts` |
| default verse display auto-clears after the fixed 2:30 ceiling | `app-core.test.ts` |
| media cue auto-clear duration persists across restart | `media-library.test.ts` |
| media:set-duration accepts positive durations and rejects invalid values | `action-registry.test.ts` |
| every shipped browser page authenticates its WebSocket with a subprotocol and keeps the token out of the connection URL | `client-handshake.test.ts` |
| Web Server Mode advertises token-bearing page URLs, viewer token for read-only pages and operator token only for the remote | `status-payload.test.ts` |
| a silent WebSocket client is dropped by the heartbeat; healthy, busy and heartbeat-disabled clients are not | `ws/server.test.ts` |
| a WebSocket consumer that stops reading is dropped at the queue bound and the server keeps serving others | `ws/server.test.ts` |
| media is streamed with HTTP Range (206, 416), HEAD carries no body, and a vanished file is a 404 | `http/static-server.test.ts` |
| static responses carry nosniff/no-referrer, revalidate with ETag/304, and fonts stay CORS-readable | `http/static-server.test.ts` |
| malformed %-escapes and NUL bytes are 400, non-GET/HEAD methods are 405, directories are 404 | `http/static-server.test.ts` |
| the favicon (`image/svg+xml`) and touch icon (`image/png`) are served with image types, not a generic one | `http/static-server.test.ts` |
| every built-in overlay palette meets the WCAG contrast gate (text 4.5:1, 7:1 high-contrast, accent 3:1; translucent cards over black and white) | `overlay/palettes.test.ts` |
| overlay style input is clamped, enum-checked, hex-only, length-capped; garbage never throws; defaults equal the legacy look | `overlay/overlay-style.test.ts` |
| `overlay:style` is synced on connect, broadcast live with an increasing revision, and is server-only in the registry | `app-core.test.ts`, `action-registry.test.ts` |
| a stored overlay style round-trips, and a corrupt one degrades field-by-field | `config-store.test.ts` |
| logos are accepted only by magic bytes (SVG refused), size/pixel bounded, written atomically, previous logo kept on rejection | `brand-logo.test.ts` |
| operator edits are normalized, broadcast live, persisted debounced, cannot forge the logo version, and fail loudly with no core | `overlay-style-controller.test.ts` |
| `/brand/logo` serves a PNG with nosniff, ETag/304, HEAD, and 404 when absent | `http/static-server.test.ts` |

Two categories from that list have no dedicated fixture, deliberately: **low-quality
transcript** has no v1 provider that exposes a usable quality signal (GroqProvider
never sets `providerConfidence` — see ARCHITECTURE.md section 11, which permits this),
so there is nothing to gate on yet; **stale sequence** has no reordering scenario to
guard against in the current design (a single WebSocket connection preserves order by
construction, and a reconnect starts a fresh connection with no carried-over state), so
a dedicated test would exercise nothing real.

### Offline faster-whisper backend (ARCHITECTURE.md section 113)

| Behavior | Covered by |
|---|---|
| Unsupported platform is reported, never downloaded | `faster-whisper-installer.test.ts` |
| Pinned download, verification, extraction, `._pth`, progress, ready | `faster-whisper-installer.test.ts` (local fixture HTTP server) |
| Tampered wheel refused; no `engine.json` written | `faster-whisper-installer.test.ts` |
| Wheel entry escaping site-packages refused (zip-slip) | `faster-whisper-installer.test.ts` |
| Updated sidecar script replaces the installed copy | `faster-whisper-installer.test.ts` |
| Real engine end to end (manual, Windows x64): install, `/health`, `/inference` with French/English speech | Run once per release; see section 113 for the measured result |
| Dashboard EN/FR key parity, placeholder parity, every `data-i18n` and `t("…")` key defined | `apps/desktop/renderer/i18n.test.ts` |

| Reference split across finals up to 25 s apart; chatter in between; bare trailing number; stale/complete/unrelated fragments never join | `transcript-assembler.test.ts` |
| "un/une Corinthiens" is volume 1; "un Jean" untouched; live mishearings need a volume | `spoken-reference-normalizer.test.ts` |
| Rolling window of finals; a verse read across two finals is matched | `rolling-transcript-window.test.ts` |

| Volume hints (book on screen over rundown plan, ambiguous plan = no hint), bare vs qualified books | `volume-inference.test.ts` |
| A bare volume is a PENDING `inferred` suggestion in auto mode and the relative verse does not also show | `app-core.test.ts` |

| Quiet-point cut, continuous speech not cut, context prompt (planned books, book on screen, previous sentence), forced cut lands at the pause | `local-whisper-provider.test.ts` |
| Decoder thresholds sent to `/inference`; a prompt echo is dropped and retried once without the prompt (both logged with the correlationId); a short reference found in the prompt is not an echo | `local-whisper-provider.test.ts`, `prompt-echo.test.ts` (injected `fetchImpl`) |
| Request timeout: floor, scales with audio, capped, never infinite; a hung engine is aborted with a clear error | `local-whisper-provider.test.ts` |
| After wake: healthy engine left alone, hung engine killed and restarted exactly once, nothing when stopped; resume events debounced to the current engine | `local-whisper-server.test.ts` (fake child process, injected `fetchImpl`) |
| Model download: Range resume, Range ignored (rewrite from zero), cut connection kept for resume then completed, free-space refusal, hash mismatch deletes the partial, oversized body refused | `local-asr-installer.test.ts` (injected `fetchImpl` and `freeBytes`, real temp dir) |
