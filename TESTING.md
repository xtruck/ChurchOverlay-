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

**Not automated in this repository**: real microphone capture, the real Electron GUI,
and OBS Browser Source rendering. These require an actual desktop session; `npm run
package` builds a real installable app for manual verification.

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

Two categories from that list have no dedicated fixture, deliberately: **low-quality
transcript** has no v1 provider that exposes a usable quality signal (GroqProvider
never sets `providerConfidence` — see ARCHITECTURE.md section 11, which permits this),
so there is nothing to gate on yet; **stale sequence** has no reordering scenario to
guard against in the current design (a single WebSocket connection preserves order by
construction, and a reconnect starts a fresh connection with no carried-over state), so
a dedicated test would exercise nothing real.
