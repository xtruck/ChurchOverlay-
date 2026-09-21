# ChurchOverlay — Architecture Specification

Version: 1.1
Status: Architecture Baseline
Scope: v1
Last Updated: 2026-09-21

## 1. Purpose

ChurchOverlay is a desktop application designed to listen to spoken Bible references through a microphone, transcribe speech using a cloud ASR provider, detect explicit Bible verse references, resolve those references against a known-valid verse index and Bible source, and display the verified verse in an OBS Browser Source overlay.

The primary design objective is:

Build a small, deterministic, secure and testable live verse pipeline before expanding into a general church presentation platform.

The architecture intentionally favors explicit boundaries and simple interfaces over generalized frameworks or plugin systems.

## 2. v1 Scope

### 2.1 Included

Version 1 includes:

1. Microphone capture.
2. Browser-side audio capture.
3. Canonical audio normalization.
4. Local silence/RMS gating.
5. Cloud ASR.
6. ASR provider abstraction.
7. Transcript partial/final state handling.
8. ASR quality/confidence gating where provider data permits.
9. Explicit Bible reference detection.
10. Verse detector abstraction.
11. Reference normalization.
12. Known-valid verse/reference validation.
13. Bible verse source abstraction.
14. One Bible API implementation.
15. LRU caching.
16. Negative lookup caching.
17. API failure protection.
18. Verified verse display.
19. WebSocket communication.
20. Operator and viewer WebSocket roles.
21. Minimal operator dashboard.
22. OBS Browser Source overlay.
23. Manual verse override.
24. Manual clear.
25. Connection/reconnection handling.
26. Structured logging.
27. Correlation IDs.
28. Deterministic test fixtures.
29. Dry-run/test mode.
30. Secure configuration storage.
31. Crash-safe configuration persistence.

## 3. Explicitly Out of Scope

The following are not implemented in v1.
They must remain documented in `ROADMAP.md` and must not enter the implementation accidentally.

- Local ASR.
- Hybrid ASR.
- Semantic Bible-reference detection.
- Paraphrase detection.
- Vector search.
- Multiple Bible translations.
- Offline Bible database.
- Media library (**implemented; see sections 60 and 74**).
- Songs/lyrics (**removed from Phase 2; see section 60**).
- Scenes (**implemented; see sections 64 and 66**).
- Rundown/service planning (**implemented in memory; persistence remains deferred; see section 64**).
- Cameras.
- Branding engine.
- AI agent (**approved for Phase 2 as a broader AI copilot; sermon-notes side channel implemented, broader copilot remains deferred; see sections 59 and 65.7**).
- MCP server.
- ProPresenter integration.
- Planning Center integration.
- Automated OBS control.
- Dynamic plugin loading.
- Remote/cloud synchronization.
- Multi-user networking.
- Mobile application.
- Cloud backend.

## 4. Architectural Principles

### 4.1 Small v1

Do not solve future problems before they exist.
An interface may exist for a clearly identified extension seam, but a framework must not be built around that interface.

### 4.2 Explicit boundaries

Every major subsystem owns a clearly defined responsibility.

For example:

```text
ASR
does not detect Bible references.

Detector
does not fetch Bible text.

Verse Source
does not decide whether to display a verse.

Overlay
does not issue application commands.
```

### 4.3 Verify before displaying

No unverified verse may reach the overlay.

The invariant is:

```text
Transcript
  ↓
Reference detection
  ↓
Reference validation
  ↓
Verse lookup
  ↓
Verse response validation
  ↓
Display
```

### 4.4 Provider independence without plugin architecture

Provider abstractions exist to make future replacement possible.
They do not constitute a dynamic plugin framework.
v1 uses static implementations.

### 4.5 Fail safely

A failure in:

- ASR
- Bible API
- WebSocket
- microphone
- cache
- renderer

must not cause the entire application to crash.
The application should degrade gracefully.

### 4.6 Observable systems

Important operations must be traceable through structured logs.
Every pipeline execution should have a correlation ID.

## 5. High-Level Architecture

```text
                         ELECTRON APPLICATION
┌──────────────────────────────────────────────────────────────┐
│                                                              │
│   ┌─────────────────┐              ┌──────────────────────┐  │
│   │ Operator        │              │ OBS Overlay          │  │
│   │ Dashboard       │              │ Browser Source       │  │
│   │                 │              │                      │  │
│   │ Mic capture     │              │ Viewer role          │  │
│   │ Controls        │              │ Read-only            │  │
│   │ Transcript      │              │ Verse rendering      │  │
│   └────────┬────────┘              └──────────▲───────────┘  │
│            │                                  │              │
│            │ WebSocket / audio               │ WS events    │
│            ▼                                  │              │
│   ┌──────────────────────────────────────────┴───────────┐  │
│   │                 LOCAL NODE SERVER                    │  │
│   │                    127.0.0.1                         │  │
│   │                                                      │  │
│   │  Audio Ingest                                       │  │
│   │       ↓                                              │  │
│   │  Audio Normalizer                                    │  │
│   │       ↓                                              │  │
│   │  Silence Gate                                        │  │
│   │       ↓                                              │  │
│   │  Application Core                                    │  │
│   │       ↓                                              │  │
│   │  ASR Provider                                        │  │
│   │       ↓                                              │  │
│   │  Transcript Gate                                     │  │
│   │       ↓                                              │  │
│   │  Verse Detector                                      │  │
│   │       ↓                                              │  │
│   │  Reference Validator                                 │  │
│   │       ↓                                              │  │
│   │  Verse Source                                        │  │
│   │       ↓                                              │  │
│   │  Verse Response Validator                             │  │
│   │       ↓                                              │  │
│   │  WS Action Registry                                  │  │
│   └──────────────────────┬───────────────────────────────┘  │
│                          │                                  │
└──────────────────────────┼──────────────────────────────────┘
                           │
               ┌───────────┴────────────┐
               ▼                        ▼
        Cloud ASR Provider         Bible API
```

## 6. Process Architecture

The application consists of three primary execution contexts.

### 6.1 Electron Main Process

Responsibilities:

- application lifecycle
- BrowserWindow management
- secure configuration
- secret handling
- local server lifecycle
- IPC
- crash handling
- logging initialization
- application paths
- graceful shutdown

The main process must not contain business logic for verse detection.

### 6.2 Dashboard Renderer

Responsibilities:

- microphone permission
- microphone capture
- operator controls
- transcript display
- connection status
- manual verse override
- manual clear
- diagnostics/status display

The renderer must not have direct access to:

- filesystem
- API keys
- decrypted secrets
- Node.js APIs
- unrestricted IPC

### 6.3 Overlay Renderer

Responsibilities:

- receive verified presentation events
- render current verse
- render clear state
- maintain visual state
- reconnect to WebSocket
- respond to local emergency clear

The overlay is read-only.
It must not send application control commands.

## 7. Electron Security Boundary

The Electron renderer must use:

```text
nodeIntegration: false
contextIsolation: true
sandbox: true where compatible
```

The preload layer must expose only explicitly required APIs.

Renderer code must never directly access:

```text
fs
process.env secrets
safeStorage
Node crypto
child_process
net
http server internals
```

## 8. Audio Architecture

### 8.1 Canonical format

The application defines one canonical audio representation for the ASR boundary.

Recommended v1 baseline:

```text
Sample rate: 16 kHz
Channels: 1
Sample format: PCM16
Frame duration: explicitly defined by implementation
```

The exact transport encoding may differ between browser capture and server transport, but the ASR boundary must receive a deterministic representation.

### 8.2 Audio pipeline

```text
Microphone
    ↓
getUserMedia()
    ↓
Browser Audio Capture
    ↓
Audio Normalizer
    ↓
Audio Frames
    ↓
WebSocket
    ↓
Server Audio Ingest
    ↓
RMS/Silence Gate
    ↓
ASR Provider
```

### 8.3 Browser audio processing

Microphone capture must explicitly define:

- echo cancellation
- noise suppression
- automatic gain control

Recommended baseline:

```text
echoCancellation: true
noiseSuppression: true
autoGainControl: true
```

These settings must be configurable/testable because browser and operating-system behavior can vary.

## 9. Silence Gate

The silence gate exists to reduce unnecessary ASR requests.
It must not be treated as a speech-recognition system.

Responsibilities:

- measure audio energy
- identify obvious silence
- suppress clearly silent chunks
- preserve speech
- expose metrics

It must never silently discard speech without producing diagnostic information.

Metrics should include:

```text
frames received
frames rejected
frames forwarded
average RMS
maximum RMS
```

## 10. ASR Architecture

### 10.1 Interface

The application must expose a simple provider contract.

Conceptually:

```ts
interface AsrProvider {
  start(): Promise<void>

  sendAudio(audio: AudioFrame): Promise<void>

  stop(): Promise<void>

  onTranscript(
    callback: (result: TranscriptResult) => void
  ): void
}
```

The exact implementation may use a different API shape, but the boundary must remain provider-independent.

### 10.2 Transcript result

Recommended model:

```ts
type TranscriptResult = {
  id: string
  correlationId: string
  sequence: number

  text: string

  state: "partial" | "final"

  providerConfidence?: number

  timestamp: number
}
```

### 10.3 Partial transcript rule

Partial transcripts:

```text
MAY:
- appear in dashboard
- be logged at debug level
- update operator UI

MUST NOT:
- trigger verse detection
- trigger Bible lookup
- trigger verse display
```

Only final transcripts can enter the verse-detection pipeline.

## 11. ASR Confidence

Provider confidence is optional.
The system must not assume that every provider exposes a comparable confidence score.

Therefore:

```text
providerConfidence?: number
```

is optional.

If v1's provider exposes a usable quality signal, the application may apply a configurable threshold.
Otherwise the pipeline must rely on deterministic transcript/reference validation rather than inventing a fake confidence score.

## 12. Verse Detector

### 12.1 Interface

```ts
interface VerseDetector {
  detect(text: string): VerseReference[]
}
```

v1 implementation:

```text
RegexDetector
```

### 12.2 Responsibilities

The detector:

- parses explicit references
- normalizes book names
- extracts chapter
- extracts verse
- returns structured references

The detector must not:

- fetch Bible content
- access the database
- call the Bible API
- send WebSocket messages
- manipulate UI

## 13. Verse Reference

Canonical model:

```ts
type VerseReference = {
  book: string
  chapter: number
  verse: number
}
```

Future ranges may be added later.
v1 should preferably support one verse at a time unless the product requirements explicitly require ranges.

## 14. Reference Validation

Before lookup:

```text
Detected Reference
        ↓
Normalize
        ↓
Book validation
        ↓
Chapter validation
        ↓
Verse validation
        ↓
Known-valid index
```

Invalid references must be rejected.

Examples:

```text
John 999:999
UnknownBook 3:16
John -1:16
```

must never reach the display pipeline.

## 15. Known-Valid Verse Index

The hallucination guard must maintain a trusted representation of valid Bible references.
Its purpose is not to contain verse text.
It answers:

```text
Does this reference exist?
```

Conceptually:

```ts
interface VerseIndex {
  exists(reference: VerseReference): boolean
}
```

Only references passing this check may be sent to `VerseSource`.

## 16. Verse Source

### 16.1 Interface

```ts
interface VerseSource {
  getVerse(
    reference: VerseReference
  ): Promise<Verse | null>
}
```

v1 implementation:

```text
FreeApiSource
```

## 17. Verse Model

Recommended:

```ts
type Verse = {
  reference: VerseReference
  text: string
  translation: string
  source: string
}
```

The presentation layer must not depend on the external API response format.

## 18. Bible API Response Validation

HTTP success does not imply a valid verse response.
Every API response must be schema-validated before becoming a `Verse`.
Invalid responses must be rejected.
The system must never render arbitrary fields from an external response.

## 19. Cache

v1 uses an in-memory LRU cache.

Cache key:

```text
normalized book + chapter + verse + translation
```

Example:

```text
john:3:16:default
```

The cache should store successful verse lookups.

## 20. Negative Cache

Recent failed lookups may also be cached.

Example:

```text
john:999:999 → NOT_FOUND
```

Negative entries should have a shorter lifetime than successful entries.
This prevents repeated invalid detections from repeatedly hitting the external API.

## 21. Bible API Failure Protection

The Verse Source should implement basic failure protection.

Recommended behavior:

```text
Healthy
   ↓
Repeated failures
   ↓
Temporary circuit-open state
   ↓
Cooldown
   ↓
Probe
   ↓
Healthy
```

The application must remain operational while the Bible API is unavailable.
A Bible API outage must not crash the application.

## 22. Application Core

The Application Core is responsible for orchestration.

It coordinates:

```text
ASR
↓
Transcript validation
↓
Verse detector
↓
Reference validation
↓
Verse source
↓
Output event
```

It must not own:

- HTTP implementation
- WebSocket implementation
- UI implementation
- provider-specific API details

## 23. Application Core Pipeline

```text
FINAL TRANSCRIPT
       ↓
Transcript acceptance
       ↓
VerseDetector
       ↓
VerseReference
       ↓
Known-valid index
       ↓
VerseSource
       ↓
Verse validation
       ↓
Verified Verse
       ↓
Presentation event
       ↓
WebSocket
       ↓
Overlay
```

## 24. WebSocket Architecture

The server binds to:

```text
127.0.0.1
```

by default.
It must refuse external binding unless explicit security configuration is present.

## 25. WebSocket Roles

Two roles exist in v1:

```text
operator
viewer
```

Operator
Can:

- start/stop microphone
- override verse
- clear verse
- receive status
- receive transcripts

Viewer
Can:

- receive display events
- receive status necessary for rendering
- perform local emergency clear

Viewer cannot issue application commands.

## 26. WebSocket Authentication

Authentication uses a token supplied through:

```text
Sec-WebSocket-Protocol
```

The token must not be supplied as a URL parameter.

Reasons:

- URL parameters may appear in logs
- URLs may be copied
- browser history may retain them
- proxies may record them

## 27. WebSocket Message Validation

Every inbound message must be schema-validated before processing.
No handler may assume a message is valid merely because JSON parsing succeeded.
Invalid messages must be rejected and logged.

## 28. WebSocket Message Envelope

Recommended structure:

```ts
type WsMessage = {
  id: string
  type: string
  timestamp: number
  correlationId?: string
  sequence?: number
  payload: unknown
}
```

## 29. Commands vs Events

Commands represent requests to the application.

Examples:

```text
mic:start
mic:stop
verse:clear
verse:override
```

Events represent resulting state or information.

Examples:

```text
status:update
transcript:partial
verse:show
```

The overlay consumes events.
It does not issue application commands.

## 30. v1 Action Registry

The initial action registry is deliberately small.

```text
mic:start
mic:stop
verse:clear
verse:override
status:update
transcript:partial
verse:show
```

New actions require an explicit feature requirement.
Do not add speculative actions.

## 31. Message Ordering

Streaming messages must contain sequence numbers where ordering matters.

For example:

```text
transcript seq 41
transcript seq 42
transcript seq 43
```

Consumers should ignore stale messages where appropriate.
This protects against network/event-loop ordering anomalies.

## 32. Correlation IDs

Every pipeline execution should have a correlation ID.

Example:

```text
correlationId:
01KXYZ123...
```

The same ID should appear in:

```text
audio
ASR
detector
lookup
WebSocket
overlay
logs
```

This allows one spoken reference to be traced end-to-end.

## 33. Overlay Architecture

The overlay is a read-only WebSocket client.

It receives:

```text
verse:show
verse:clear
status:update
```

as required.

It must not have access to:

```text
API secrets
filesystem
operator commands
ASR provider
Bible API
application internals
```

## 34. Overlay Connection State

The overlay must represent:

```text
CONNECTING
CONNECTED
RECONNECTING
DISCONNECTED
```

Temporary WebSocket disconnection must not unexpectedly destroy application state.
The visual behavior during disconnection must be deterministic.

## 35. Emergency Clear

Escape-key clear is a local overlay action.

Conceptually:

```text
Escape
 ↓
clear local visual state
```

It should not require a server round trip.
It does not grant the overlay permission to send control commands.

## 36. Manual Override

The operator dashboard may issue:

```text
verse:override
```

The override must still use the same validation pipeline.
It must not allow arbitrary unverified Bible content to be displayed.

## 37. Storage

v1 deliberately has no database.
Configuration is stored as encrypted JSON.

Possible values:

```text
ASR configuration
Bible API configuration
microphone ID
operator token
viewer token
application settings
```

## 38. Secure Storage

Secrets are encrypted using Electron `safeStorage`.
The application must never write plaintext secrets to disk.

Configuration writes must be atomic:

```text
write temp file
      ↓
flush/close
      ↓
rename
```

A corrupted write must not destroy the previous valid configuration.

## 39. ULIDs

Persistent or externally traceable IDs should use ULIDs.

Benefits:

- sortable
- compact
- timestamp-aware
- collision-resistant
- easy to trace in logs

IDs must not be generated from predictable incremental integers.

## 40. Logging

Use structured logs.

Recommended fields:

```text
timestamp
level
component
event
correlationId
messageId
sequence
duration
error
metadata
```

Example:

```json
{
  "level": "info",
  "component": "verse-source",
  "event": "lookup.success",
  "correlationId": "01K...",
  "durationMs": 142
}
```

## 41. Log Levels

Recommended:

```text
ERROR
WARN
INFO
DEBUG
TRACE
```

Sensitive information must never be logged.

Never log:

- API keys
- authentication tokens
- decrypted secrets
- microphone raw audio
- unnecessary personal information

## 42. Performance

Performance must be measurable.

The application should record timing for:

```text
audio capture
ASR latency
detector latency
Bible lookup latency
WebSocket latency
render latency
end-to-end latency
```

Performance should be evaluated using:

```text
P50
P95
P99
```

rather than only average latency.

## 43. Real-Time Target

The target is:

```text
spoken Bible reference
        ↓
verified verse
        ↓
visible overlay
```

with minimal practical latency.

Exact numerical budgets should be established after the first ASR implementation is benchmarked rather than inventing unrealistic numbers beforehand.
The implementation must nevertheless record all relevant timings from the beginning.

## 44. Dry-Run Mode

The application must support deterministic testing without microphone or external ASR.

Example:

```text
Dry Run
   ↓
Synthetic Transcript
   ↓
Detector
   ↓
Validation
   ↓
Verse Source
   ↓
Overlay
```

Example input:

```text
Turn with me to John 3:16
```

(v1's detector is syntactic, not semantic — see section 12 — so dry-run
input must be the same digit-based "Book Chapter:Verse" form real speech
is expected to contain, not a paraphrase or a different language.)

This allows rapid testing of the complete downstream pipeline.

## 45. Test Architecture

Testing levels:

```text
Unit
Integration
Contract
End-to-End
Failure
Performance
```

### 45.1 Unit Tests

Test:

- reference normalization
- regex detection
- reference validation
- cache
- negative cache
- message schemas
- action registry
- configuration handling
- state machines

### 45.2 Integration Tests

Test:

```text
ASR → detector
detector → index
index → verse source
verse source → application core
core → WebSocket
```

### 45.3 Contract Tests

Provider adapters must be tested against their expected interfaces.

For example:

```text
GroqProvider
must behave like
AsrProvider
```

### 45.4 End-to-End Tests

Test:

```text
synthetic transcript
      ↓
verse detection
      ↓
lookup
      ↓
WS
      ↓
overlay
```

## 46. Test Fixtures

Fixtures should include:

```text
valid verse
invalid book
invalid chapter
invalid verse
partial transcript
final transcript
low-quality transcript
multiple references
no reference
API failure
malformed API response
WebSocket disconnect
stale sequence
invalid WS message
```

## 47. Critical Correctness Invariants

The following are architectural invariants.

Invariant 1
Partial transcripts never trigger verse detection.

Invariant 2
Rejected ASR results never reach the detector.

Invariant 3
The detector never fetches verse text.

Invariant 4
The detector never sends display events.

Invariant 5
Unknown references never reach the Bible API.

Invariant 6
Invalid Bible API responses never reach the overlay.

Invariant 7
Only verified verses may generate `verse:show`.

Invariant 8
The overlay cannot issue application commands.

Invariant 9
Renderer processes cannot access secrets.

Invariant 10
All inbound WebSocket messages are schema-validated.

Invariant 11
Provider-specific implementations remain behind interfaces.

Invariant 12
Roadmap features cannot silently enter v1.

## 48. Failure Handling

ASR unavailable
Result:

```text
ASR_ERROR
```

The application remains running.

Bible API unavailable
Result:

```text
VERSE_SOURCE_UNAVAILABLE
```

No unverified verse is displayed.

WebSocket disconnected
Result:

```text
RECONNECTING
```

The client reconnects according to bounded retry logic.

Invalid transcript
Ignore safely and record diagnostics when useful.

Invalid verse
Reject.

Invalid API response
Reject.

Configuration corruption
Preserve previous valid configuration where possible and report the failure.

## 49. Security Model

Security requirements:

1. Local server binds to `127.0.0.1`.
2. External binding is disabled by default.
3. Tokens are not URL parameters.
4. Tokens are encrypted at rest.
5. Renderer cannot access secrets.
6. All WS messages are schema-validated.
7. Overlay is read-only.
8. External API responses are schema-validated.
9. No secrets are logged.
10. No arbitrary code execution through messages.
11. No dynamic plugin loading.
12. No arbitrary filesystem paths from untrusted WS payloads.

## 50. Extension Seams

Exactly four extension seams exist in v1.

AsrProvider
v1:

```text
GroqProvider
```

Future:

```text
whisper.cpp
Deepgram
other providers
```

VerseDetector
v1:

```text
RegexDetector
```

Future:

```text
SemanticDetector
ParaphraseDetector
```

VerseSource
v1:

```text
FreeApiSource
```

Future:

```text
OfflineBibleSource
MultipleTranslationSource
VectorSource
```

WS Action Registry
v1 contains only real product actions.
Future actions are added individually as actual features require them.

## 51. No Dynamic Plugin System

This project must not implement:

```text
plugin discovery
dynamic loading
plugin manifests
runtime module installation
config-driven dependency injection
```

unless a future architecture revision explicitly requires them.
Interfaces are sufficient for v1.

## 52. Recommended Project Structure

```text
churchoverlay/
│
├── apps/
│   ├── desktop/
│   │   ├── main/
│   │   ├── preload/
│   │   └── renderer/
│   │
│   ├── server/
│   │   ├── audio/
│   │   ├── asr/
│   │   ├── detector/
│   │   ├── verse/
│   │   ├── ws/
│   │   └── core/
│   │
│   └── overlay/
│       ├── src/
│       └── public/
│
├── packages/
│   ├── contracts/
│   ├── shared/
│   ├── schemas/
│   └── testing/
│
├── fixtures/
│
├── docs/
│
├── scripts/
│
├── ROADMAP.md
├── ARCHITECTURE.md
├── AGENTS.md
├── SECURITY.md
├── TESTING.md
└── package.json
```

The exact monorepo tooling may be selected during scaffolding.
Do not introduce monorepo infrastructure solely for appearance. It must provide a practical benefit.

## 53. Dependency Direction

Dependencies should flow inward.

```text
UI
 ↓
Application Core
 ↓
Interfaces
 ↓
Adapters
 ↓
External services
```

Examples:

```text
Dashboard → Core
Core → AsrProvider
GroqProvider → external Groq API
```

Not:

```text
Core → Groq SDK
```

## 54. Forbidden Dependencies

The following are forbidden:

```text
Detector → Bible API
Detector → WebSocket
Overlay → Node server internals
Renderer → secrets
UI → provider SDK
Provider → UI
Bible Source → overlay
```

## 55. Architecture Change Policy

Any change affecting:

- module boundaries
- security model
- communication protocol
- provider interfaces
- data contracts
- scope
- process architecture

requires an explicit architecture review.
Do not silently modify architecture while implementing a feature.

## 56. Definition of Done for v1

v1 is complete when:

- microphone capture works reliably
- canonical audio reaches ASR
- silence gating works
- ASR produces partial/final transcripts
- only final transcripts reach detection
- valid Bible references are detected
- invalid references are rejected
- valid verses resolve through the source
- malformed API responses are rejected
- verified verses reach the overlay
- OBS Browser Source displays the verse
- operator override works
- clear works
- authentication works
- overlay is read-only
- secrets are protected
- configuration writes are atomic
- logging works
- correlation IDs work
- reconnect behavior works
- dry-run mode works
- unit tests pass
- integration tests pass
- E2E pipeline passes
- packaging succeeds
- application can recover from expected failures

## 57. Architecture Success Criteria

The architecture is considered successful if:

1. A new ASR provider can be added without rewriting the application core.
2. A new verse source can be added without modifying the detector.
3. The overlay can be changed without modifying ASR.
4. The dashboard can be redesigned without modifying verse validation.
5. External API failure does not crash the application.
6. AI coding agents can work inside individual boundaries without understanding the entire implementation.
7. The v1 codebase remains small enough for a developer to understand.

## 58. Final Architectural Rule

Correctness before cleverness.
Explicit boundaries before abstraction.
Verification before display.
Measurement before optimization.
Real requirements before features.
Small interfaces before frameworks.

This document is the architectural baseline for v1.

## 59. Phase 2 — Approved Scope Expansion

Recorded here per AGENTS.md section 43's requirement that a scope change be explained
(why, what changes, what breaks, what tests are required) before it happens, not folded
in silently. Sections 1-58 above remain the accurate v1 baseline — nothing in them is
retracted by this section. This section governs what comes *after* v1, not a
retroactive rewrite of it.

### 59.1 Why

Two decisions were made together, both confirmed explicitly rather than assumed:

1. **Audience.** ChurchOverlay is no longer scoped as one specific church's internal
   tool — it's meant to be a product other churches can install and run themselves.
   Concretely, this means: it stays a **local, single-install Electron desktop app** —
   no backend, no hosting, no multi-tenant account system (a hosted/multi-tenant
   version is a fundamentally different architecture — real backend, auth, per-tenant
   data isolation — and is explicitly NOT what this section approves; it would need its
   own separate architecture review if ever pursued). What changes is genericness: a
   church name/branding step in first-run setup (today's setup screen only asks for a
   Groq API key), and no church-specific text or defaults left anywhere in UI copy or
   `package.json` metadata.
2. **Feature scope.** Three items from section 3's out-of-scope list are approved to
   move forward: media library & song lyrics, service rundown & scenes, and an AI
   copilot. Each still requires its own dedicated architecture note before its code
   starts (section 59.3) — this section approves the *scope change itself* and the
   *build order*, not a full technical design for all three at once.

### 59.2 What changes

- Sections 2-3's v1 scope lock is amended: media library, songs/lyrics, scenes,
  rundown/service planning, and "AI agent" (now understood as a broader AI copilot, not
  only the `ReferenceInterpreter` idea in `ROADMAP.md`) are no longer permanently
  out-of-scope — see the updated markers in section 3. Everything else on that list
  (local/hybrid ASR, semantic detection, cameras, branding engine as a distinct
  subsystem, MCP server, ProPresenter/Planning Center integration, automated OBS
  control, remote/cloud sync, multi-user networking, mobile application, cloud backend,
  dynamic plugin loading) remains locked out exactly as before. `AGENTS.md` section 4's
  "Do NOT implement" list is amended the same way.
- A visual refactor (internally "Phase 0") of the existing v1 screens — operator
  dashboard, overlay, and the first-run setup screen — is approved as a single full
  pass: same screens, actions, and data, restyled. This does not touch section 2's
  scope list at all; it is exactly the kind of dashboard/overlay redesign section 57
  item 3-4 already says should be possible without touching ASR or verse validation,
  and carries no scope-change requirement on its own. Build order within that pass:
  dashboard first (highest surface area), then overlay, then the setup screen — a
  sequencing choice, not separate rounds of review.
- Build order for the three approved features, chosen by risk and dependency: **media
  library & song lyrics**, then **service rundown & scenes**, then **AI copilot**.
  Media/lyrics is self-contained and never touches the verse pipeline, so it's the
  safest first real addition. Rundown/scenes builds on having media cues to sequence
  and forces state-machine design work (section 48's pattern: named states, defined
  transitions, invalid transitions handled safely) that the AI copilot will also need.
  AI copilot goes last — `ROADMAP.md` already documents why its one concretely-evaluated
  approach (Gemini Live as a `ReferenceInterpreter`) needs real session-management
  engineering the current Groq batch model doesn't, and "AI copilot" has now been
  confirmed to mean something broader than that one idea, which raises its own,
  not-yet-answered design questions (section 59.4).
- Resolved product decisions for the rundown feature, to remove ambiguity before its
  architecture note is written: **live voice-detected verse display keeps running in
  the background while a rundown is active** — starting a rundown does not suspend
  automatic detection. The exact precedence between a live-detected verse and whatever
  scene the rundown currently has on air is still open (section 59.4) and must be
  settled in that feature's own architecture note, not guessed at here.
- Resolved product decision for the media library: v1 of that feature supports
  **images and video/audio backgrounds**, not images only. Video/audio pulls in real
  complexity images alone don't (playback control, a new WS event cadence for a
  running clip) — that complexity is now in scope for this feature, not deferred to a
  later one.

### 59.3 What each feature needs before code (unchanged from the original plan)

Each of the three needs its own short architecture note — which module owns it, which
interface it uses, which invariant it could affect, how it will be tested, confirmation
it's the approved Phase 2 scope and not scope creep beyond it:

- **Media library & song lyrics** — lowest risk. Needs a new `MediaCue`/`LyricsCue`
  concept alongside `Verse`, a new WS event type (`media:show`, distinct from
  `verse:show` — AGENTS.md section 19 keeps the action registry small and adds types
  only when a real feature needs them, which this now is), and secure file handling for
  operator-selected local images/video/audio: either a scoped Electron `dialog` picker
  or a dedicated IPC channel where the main process reads the file and the renderer
  never receives a raw filesystem path (AGENTS.md section 28's secrets/renderer-
  isolation reasoning extended to arbitrary local files). Nothing existing breaks; this
  is additive. Tests needed: a new source unit-tested the way `FreeApiSource` is, a
  WS/action-registry test for `media:show`, and at least one deliberate
  "malicious/traversal path" test — AGENTS.md section 15's "no arbitrary filesystem
  paths from untrusted WS payloads" applies directly here.
- **Service rundown & scenes** — medium risk. A real new stateful subsystem: a
  pre-planned sequence of scenes (verse mode, an announcement slide, a media cue,
  blank) the operator steps through, replacing today's single implicit state (verse
  showing or cleared) with an explicit state machine (named states, defined
  transitions, per section 48). New operator-only WS commands (`scene:next`,
  `scene:previous`, `scene:goto`, `rundown:load`), schema-validated the same way
  `verse:override` is. Its architecture note must settle the precedence question left
  open in section 59.4.
- **AI copilot** — highest risk by a clear margin. `ROADMAP.md`'s existing
  Gemini-Live-as-`ReferenceInterpreter` writeup is one candidate building block, not
  the whole feature now that "AI copilot" has been confirmed to mean something
  broader (section 59.4 has the open question). Whatever form it takes, any
  AI-proposed Bible reference must still pass through the same hallucination-guard
  pipeline `RegexDetector`'s output does today (section 15) — an AI-proposed reference
  is never trusted directly, regardless of which AI approach is eventually chosen. This
  item does not proceed to code before its own dedicated architecture review.

### 59.4 Open questions carried forward (not decided by this section)

- **Rundown/live-detection precedence.** Confirmed: live detection keeps running
  during a rundown. Not yet decided: when both a live-detected verse and the rundown's
  current scene want the overlay at the same moment, which wins, and how does control
  return afterward? This shapes the rundown state machine's actual transition table and
  must be settled in that feature's architecture note before its code starts.
- **AI copilot's actual shape.** Confirmed broader than the `ReferenceInterpreter`
  idea alone. Not yet decided: sermon/topic assistance, auto-generated slide
  suggestions, a chat-style assistant in the dashboard, the original reference-proposal
  idea, or some combination — each has a materially different risk profile and none is
  assumed here. This must be scoped concretely in that feature's own dedicated
  architecture review, per section 59.3, before any code.

## 60. Phase 2 Feature Note — Media Library

Superseded scope note: the original version of this section covered "Media Library &
Song Lyrics." Lyrics/song-text-block support is dropped from Phase 2 entirely
(confirmed explicitly) — this feature is Media Library only (images, video, audio).
`ROADMAP.md` is updated to match.

The dedicated architecture note section 59.3 requires before this feature's code
starts, following AGENTS.md section 56's checklist. This is design only — nothing in
this section is implemented yet.

### 60.1 Which module owns this

A new sibling domain to `apps/server/verse/`, not an extension of it: `apps/server/media/`.
Media cues are not verses — they don't flow through hallucination-guard validation or
`VerseSource` at all. Reusing `Verse`/`VerseSource` machinery for a concept that was
never a Bible reference would violate the section 4.2 boundary ("Verse Source does not
decide whether to display a verse") by stretching what a "verse" means rather than
adding a real sibling. The Electron main process (`apps/desktop/main/index.ts`) owns
the one piece of this that must live there: the native file picker and the
copy-into-app-storage step (section 60.3) — the same place `ConfigStore` already owns
secure local persistence.

Detection is a real exception to "doesn't flow through detection" above: this feature
adds voice-triggered media (section 60.3), a second, sibling `VerseDetector`-shaped
component living in `apps/server/media/`, not in `apps/server/detector/` — it detects
media-cue names, not Bible references, and must never be confused with or merged into
`RegexDetector`.

### 60.2 New contracts

```ts
// packages/contracts/media.ts (new file)
export type MediaCueKind = "image" | "video" | "audio"

export type MediaCue = {
  kind: MediaCueKind
  id: string
  /** Also the voice-trigger phrase — section 60.3. Operator-assigned at import time. */
  title: string
}
```

`id` is a ULID assigned at import time (section 60.3) — never a filesystem path. For
`image`/`video`/`audio`, the overlay resolves `id` to a URL itself (`/media/<id>`,
section 60.3); the WS payload never carries a path or URL directly, matching how
`verse:show`'s payload carries a resolved `Verse`, not instructions for how to fetch
one.

Because v1 of this feature includes full playback transport (section 60.5 — play,
pause, seek), `video`/`audio` cues have real ongoing server-side state, unlike a
`Verse`, which is fire-and-forget. `media:show`'s payload carries that state alongside
the cue:

```ts
// packages/contracts/media.ts (new file), continued
export type MediaPlaybackState = {
  state: "playing" | "paused"
  positionMs: number
  /** Server clock reading when positionMs was true — see section 60.5's sync model. */
  asOfServerTime: number
}

export type MediaShowPayload = {
  cue: MediaCue
  /** Present only for kind "video"/"audio"; omitted for "image", which has no playback concept. */
  playback?: MediaPlaybackState
}
```

Six new WS actions, small and purpose-built per AGENTS.md section 19 — one pair for
display/clear (mirroring `verse:show`/`verse:clear`'s exact shape) plus three
operator-only transport commands that only apply to `video`/`audio` cues:

```text
media:select   (command, operator-only)  — payload: { id: string }
media:play     (command, operator-only)  — payload: null (resumes the active cue)
media:pause    (command, operator-only)  — payload: null (pauses the active cue)
media:seek     (command, operator-only)  — payload: { positionMs: number }
media:clear    (command, operator-only; also broadcast as an event, exactly
                 like verse:clear already is both)
media:show     (event, server -> viewers) — payload: MediaShowPayload
```

`media:select`/`media:seek` never carry the file itself or a raw path — only an `id`
already known to `apps/server/media/`'s library from a prior import (section 60.3), or
a plain millisecond offset. `media:play`/`media:pause`/`media:clear` are rejected if no
cue is currently active (nothing to act on) — schema-validated in `action-registry.ts`
exactly like `verse:override`'s existing pattern.

### 60.3 Voice-triggered media

Confirmed explicitly: a media cue's `title` (assigned by the operator at import time)
doubles as a spoken trigger phrase — saying it during a live service shows the cue
automatically, the same product behavior verse detection already provides for Bible
references.

**Exact-phrase match only, confirmed explicitly (not fuzzy/paraphrase matching).**
This keeps the same deterministic, syntactic-only philosophy AGENTS.md sections 12-14
already establish for `RegexDetector` — a media trigger that fires on close-but-wrong
matches is the same class of risk (a false positive shows the wrong thing at the wrong
moment) as the semantic/paraphrase-aware verse detection `ROADMAP.md` already defers as
high-risk. A new `MediaCueDetector` (`apps/server/media/media-cue-detector.ts`) checks
whether a final transcript's text contains any currently-imported cue's `title`,
case-insensitively, after the same whitespace-normalization `RegexDetector`'s own
`normalizeBookName()` already applies. No stemming, no synonym matching, no fuzzy
distance — a title that isn't said exactly is simply never triggered, which is the
correct, safe failure direction (nothing displays) rather than the unsafe one
(something wrong displays).

**Gated the same way verse detection is.** `MediaCueDetector` only ever sees
transcripts that already passed the existing transcript gate (`state: "final"` only)
— partial transcripts never reach it, mirroring invariant 1 exactly. It runs alongside
`RegexDetector` in the same `onTranscript` handler `resolveTranscriptVerses` already
lives in (AppCore, sections 22-23), not instead of it: a single sentence could
plausibly contain both a spoken verse reference and a spoken cue title, and both
should fire independently.

**One activation path, two triggers.** A detected title and an operator's
`media:select` command both funnel through the same internal "activate this cue"
function in the module from section 60.1 — the same pattern `verse:override` and a
detected verse reference already share by both calling `resolveVerse()` (section 36).
There is no separate code path for "shown by voice" versus "shown by the operator's
click"; only how activation was triggered differs.

**Uniqueness, enforced at import, not at detection time.** `MediaLibrary` rejects
importing a cue whose `title` exactly matches an existing one's — the same way a
filesystem wouldn't let two files share a path — so `MediaCueDetector` never has to
choose between two equally-valid matches. A title that happens to also be a substring
of a longer, unrelated spoken sentence still triggers; this is the same deterministic
tradeoff `RegexDetector` already accepts (syntactic matching over natural-language
understanding), not a new risk category this feature introduces.

### 60.4 File handling and the security boundary this feature actually adds

This is the one part of this feature that can genuinely violate AGENTS.md section 15
("no arbitrary filesystem paths from untrusted WS payloads") if built carelessly, so
it gets the most detail:

1. The operator picks a file via Electron's own `dialog.showOpenDialog`, invoked from
   the main process only (a new IPC handler, e.g. `pick-media-file`, following the
   existing `complete-setup` pattern — the renderer asks, the main process does the
   filesystem-touching work, the renderer gets back an opaque result).
2. The main process copies the selected file into a dedicated, app-owned directory
   under `app.getPath("userData")` (e.g. `.../ChurchOverlay/media/`), naming it by a
   freshly generated ULID plus its original extension. The original path the operator
   picked is never retained or sent anywhere past this step.
3. A new `MediaLibrary` class (`apps/server/media/media-library.ts`) tracks imported
   cues (id -> kind, title, stored filename) and is the only component that turns an
   `id` back into a real file. `resolve(id): MediaCue | null` — returns `null` for any
   unknown id, exactly like `VerseIndex.exists()` returns false for an unknown
   reference, never throwing or leaking a path.
4. `StaticServer` gains one new capability: serving files from `MediaLibrary`'s
   directory under a fixed prefix (`/media/<id>`), resolving `id` through
   `MediaLibrary.resolve()` first — never joining the request path onto the directory
   directly the way its existing `rootDir` serving does. An unknown or malformed id is
   a 404, the same failure shape as any other not-found request; there is no path in
   the request that can ever reach outside the media directory, because no part of the
   request is ever used as a path.
5. Import-time validation: an explicit extension/type allowlist (images:
   `.jpg`/`.jpeg`/`.png`/`.webp`; video: `.mp4`/`.webm`; audio: `.mp3`/`.wav`/`.m4a`),
   matching `FreeApiSource`'s own precedent of validating rather than trusting input
   shape. The threat model here is narrower than an external API response, though:
   the file comes from the operator's own disk via a trusted native OS dialog, not
   from an untrusted network response or a WS payload — the allowlist exists to reject
   obvious mistakes and keep the overlay's `<img>`/`<video>`/`<audio>` handling
   predictable, not to defend against a malicious file the operator deliberately chose
   to import on their own machine.

### 60.5 Playback transport and the sync model

Confirmed explicitly (this was flagged as a genuine architectural fork, not decided
silently, per AGENTS.md section 61): v1 of this feature needs full transport — play,
pause, and seek/scrub, not just show-from-start/clear. That's real additional
complexity, concentrated entirely in one place: the server must hold authoritative
playback state per active cue, because unlike a `Verse`, "currently playing a video at
position X" is ongoing state a newly-connecting or reconnecting viewer needs to catch
up to, not a one-shot event.

**The server is the single source of truth for playback state**, tracked in the same
module that owns `MediaLibrary` (section 60.1). Every operator transport command
(`media:select`/`media:play`/`media:pause`/`media:seek`) updates that server-side state
and immediately re-broadcasts a fresh `media:show` with it — there is no client-side
authority anywhere, including the operator dashboard's own preview.

**Position sync uses a timestamp-and-recompute model, not a running server clock
broadcast continuously.** Every `media:show` carries `positionMs` plus
`asOfServerTime` (the server's own `Date.now()` when that position was true). A
receiving client — the overlay, or the dashboard's own transport UI — computes the
actual position on arrival:

```text
if playback.state === "playing":
  actualPositionMs = playback.positionMs + (Date.now() - playback.asOfServerTime)
else: // "paused"
  actualPositionMs = playback.positionMs
```

This is deliberately simpler than a general media-sync protocol (buffering
acknowledgements, round-trip-time compensation, adaptive drift correction) because
ARCHITECTURE.md section 49's own security model already constrains the real topology:
the WS server binds to `127.0.0.1` only — every client is the same machine. Network
latency between the server and its own overlay/dashboard is negligible in practice, so
a single timestamp-and-recompute step is sufficient; building anything more elaborate
would be solving a distributed-systems problem this app's actual deployment doesn't
have (AGENTS.md section 41: no premature frameworks).

**Reconnect/late-join sync, without giving the overlay a way to ask for one.**
Invariant 8 (section 47) forbids the overlay issuing application commands at all —
adding a "what's currently playing?" query from the viewer would mean adding an
inbound message type for a role that is supposed to never send one, eroding that
invariant for this feature's convenience. Instead: `ChurchOverlayWsServer`'s existing
connection handler (`apps/server/ws/server.ts`) gains one small addition — when a
**viewer** connection opens and a media cue is currently active, the server
immediately sends that one connection a `media:show` with freshly recomputed
`positionMs`/`asOfServerTime`, exactly as if it had just been broadcast. Purely a
server-initiated push on a connection event, not a new inbound capability for viewers.

This same reconnect gap already exists, unaddressed, for `verse:show` (a viewer that
reconnects mid-verse sees nothing until the next detection or clear) — out of scope
for this note to fix, since it wasn't asked for here, but worth flagging as a possible
follow-up consistency improvement once this pattern exists for media.

### 60.6 New correctness invariants this feature adds

Alongside section 47's twelve existing invariants — this feature does touch one
extension of them now (voice-triggered media, section 60.3), so it is no longer true
that it "never goes near detection"; it deliberately mirrors invariant 1 rather than
bypassing it:

Invariant 13
`MediaCueDetector` never sees a partial transcript — only transcripts that already
passed the same transcript gate `RegexDetector` does (`state: "final"` only). This
mirrors invariant 1 exactly, applied to the new detector rather than a new invariant
about a different concern.

Invariant 14
The overlay never loads a file the operator did not import through `MediaLibrary` —
every media URL it ever requests is `/media/<id>`, where `id` came from a `media:show`
broadcast the server itself sent, never from a value the overlay renderer constructs.

Invariant 15
Playback state is authoritative on the server only. No client — overlay or dashboard —
ever advances, computes, or persists `positionMs` on its own initiative; it only ever
recomputes the current position from the most recent `media:show` it received, per
section 60.5's formula. Two clients (the dashboard's own preview and the real overlay)
must never be able to drift into disagreement about what's currently on air, because
neither one owns the state — the server does.

Invariant 16
`media:play`/`media:pause`/`media:seek` never reach the overlay's inbound side at all
— the overlay's role (`viewer`) has an empty `allowedSenders` for every media action,
exactly as it already does for every existing command, per invariant 8.

### 60.7 Tests required

- `MediaLibrary` unit tests: import assigns a fresh ULID, rejects a disallowed
  extension, rejects a duplicate title, `resolve()` returns `null` for an unknown id
  (not a throw).
- `MediaCueDetector` unit tests, mirroring `regex-detector.test.ts`'s style: an exact
  (case-insensitive) title match triggers, a close-but-not-exact phrase does not, a
  transcript containing both a verse reference and a cue title triggers both
  independently, and — mirroring `transcript-gate.test.ts` — a `state: "partial"`
  transcript is never even passed to it.
- `StaticServer`'s new `/media/<id>` route: serves an imported file correctly, 404s an
  unknown id, and — mirroring the existing directory-traversal test's own lesson about
  `fetch()` normalizing `../` client-side — a raw `node:http` request confirming a
  crafted id can never resolve outside the media directory.
- `action-registry.test.ts`: `media:select`/`media:play`/`media:pause`/`media:seek`
  schema validation and operator-only role checks, and `media:clear`'s dual
  command/event shape, mirroring the existing `verse:clear` tests exactly.
- Playback state-machine unit tests (the new module from section 60.1): `play` after
  `pause` resumes from the paused `positionMs`, not from 0; `seek` while paused stays
  paused at the new position; `seek` while playing keeps playing from the new position;
  `play`/`pause`/`seek`/`clear` with no active cue are rejected, not silently ignored.
- The timestamp-and-recompute formula (section 60.5) as an isolated, injectable-clock
  unit test: given a known `asOfServerTime`/`positionMs`/`state` and a known "now",
  the computed `actualPositionMs` matches by hand-calculation — the same style already
  used for `generateUlid`'s known-value test.
- One integration test through the real wiring (mirroring `app-core.test.ts`'s
  pattern): a `media:select` command with a real imported id broadcasts `media:show`
  with `state: "playing"` and `positionMs: 0`; a subsequent `media:pause` broadcasts an
  updated `media:show` with `state: "paused"` and a recomputed `positionMs`; a viewer
  that connects *after* a cue is already active immediately receives a `media:show`
  sync event without sending anything itself (section 60.5's reconnect behavior); an
  unknown id in `media:select` broadcasts nothing.

### 60.8 Confirms this is approved scope

Media library is the first item in `ROADMAP.md`'s Phase 2 section, approved in section
59. Lyrics/song-text-block support, originally planned alongside it, is dropped from
Phase 2 entirely (confirmed explicitly, section 60) — this feature is images/video/audio
only. Also confirmed and folded into this note: full playback transport for
video/audio (section 60.5, confirmed explicitly as a genuine architectural decision,
not assumed) and voice-triggered media by exact title match (section 60.3, likewise
confirmed explicitly). This note specifies how to build exactly what was approved: it
does not add anything beyond that (no multi-cue queueing, no crossfade/transition
effects between cues, no fuzzy/paraphrase title matching, no remote/networked sync
beyond the single local machine section 60.5's model already assumes), and any of
those would be a further scope question, not something this note has quietly folded
in.

## 61. Phase 2 Feature Note — Voice-Driven Verse Navigation

A dedicated architecture note, following the same AGENTS.md section 56 checklist as
section 60. This was raised mid-session as an addition to v1's existing explicit
Bible-reference detection, not part of the original three Phase 2 items in section
59 — it extends the *existing, already-shipped* verse pipeline rather than
introducing a new domain, so it is scoped and confirmed here rather than folded
retroactively into section 59's original approval. Implementation status:
**implemented and tested**.

### 61.1 What was confirmed, explicitly

Four command categories, confirmed by name: next/previous verse, next/previous
chapter, cancel/clear by voice, and jump-to-a-named-book-and-chapter (e.g. "go to
Romans chapter 8" — a bare book+chapter with no verse number, which
`RegexDetector`'s existing pattern does not match today since it requires a
`chapter:verse` colon form). Phrase recognition uses **a small, fixed set of
synonyms per command** (confirmed explicitly, not exact-single-phrase-only and not
fuzzy/semantic matching — see section 61.3). Voice control is scoped to navigation,
clearing, and the media voice-trigger from section 60.3 — **not** microphone
start/stop, which stays a manual dashboard action (confirmed explicitly; also
inherently circular, since the mic must already be listening for any voice command
to be heard at all).

### 61.2 Which module owns this, and why it is NOT `VerseDetector`

`VerseDetector.detect(text): VerseReference[]` is a pure function of the transcript
text alone (section 12) — it has no access to, and needs none, because an explicit
reference like "John 3:16" is fully self-contained. "Next verse" is not: resolving it
requires knowing what is *currently displayed*, which is state, not text. Forcing
navigation through the `VerseDetector` interface would mean either smuggling state
into a seam explicitly documented as stateless, or having every `VerseDetector`
implementation suddenly need a state dependency it was never designed for. Instead,
this is a new pair of components, split the same way detection and resolution are
already split for ordinary references:

- `NavigationCommandDetector` (`apps/server/detector/navigation-command-detector.ts`,
  sibling to `RegexDetector`) — a pure, stateless function of text, exactly like
  `VerseDetector`. It recognizes command phrases and outputs *what was asked for*,
  never a resolved reference.
- `resolveNavigationCommand()` (`apps/server/verse/resolve-navigation-command.ts`,
  sibling to `resolve-verse.ts`) — takes a detected command plus the current
  position (section 61.4) and computes the target `VerseReference` (or a clear),
  using the exact same `BOOK_CATALOG` data `KnownValidVerseIndex` already uses.

Per ARCHITECTURE.md section 50, v1 shipped with exactly four extension seams. Phase
2 is an explicit, approved amendment to v1's scope (section 59) and both this
feature and section 60's `MediaCueDetector` add further seam-shaped components
beyond that original count — expected and fine for approved Phase 2 work, not a
quiet violation of section 50's "exactly four," which describes v1 as shipped, not a
permanent ceiling on the whole project.

```ts
// packages/contracts/verse.ts, extended
export type NavigationCommand =
  | { kind: "next-verse" }
  | { kind: "previous-verse" }
  | { kind: "next-chapter" }
  | { kind: "previous-chapter" }
  | { kind: "goto-chapter"; book: string; chapter: number }
  | { kind: "cancel" }

export interface NavigationCommandDetector {
  detect(text: string): NavigationCommand[]
}
```

### 61.3 Phrase recognition — the confirmed synonym-list approach

Each command maps to a small, explicit, hand-written list of accepted phrases —
still fully deterministic (no stemming, no fuzzy distance, no semantic matching;
same philosophy as section 60.3's exact-title matching, just one list per command
instead of one phrase per media cue):

```text
next-verse:       "next verse", "next"
previous-verse:   "previous verse", "go back", "previous"
next-chapter:     "next chapter"
previous-chapter: "previous chapter"
cancel:           "cancel", "clear", "clear the screen"
goto-chapter:     pattern-matched, not a fixed list — "<book> chapter <number>"
                  (e.g. "go to Romans chapter 8"), reusing RegexDetector's own
                  book-name capture group but requiring the literal word "chapter"
                  and NO trailing ":<verse>" (that form is already
                  RegexDetector's territory and must not double-fire here)
```

Short, common words as synonyms ("next", "previous", "clear") carry real false-
positive risk in ordinary speech ("clear" said in an unrelated sentence, "next" as
in "the next thing I want to say"). This is an accepted, explicit tradeoff of the
confirmed synonym-list approach, not an oversight — mitigated, not eliminated, by
requiring these short synonyms to be the transcript's *entire* trimmed text (a
one- or two-word utterance) rather than matching them as a substring anywhere in a
longer sentence. The longer, more specific phrases ("next verse", "clear the
screen") match as a substring like section 60.3's title matching does, since they
carry enough specificity on their own.

### 61.4 Current-position state and boundary rules

**Server-authoritative, in-memory, updated by every verse display — however it was
triggered.** `AppCore` (sections 22-23) already broadcasts every `verse:show`; it
gains one small addition: after broadcasting, record `{ book, chapter, verse }` as
the current position. This applies uniformly whether the verse came from detection,
a manual `verse:override`, or navigation itself — "next verse" after an operator's
manual override continues from wherever the operator pointed, which is the least
surprising behavior (section 61's own "least surprising, documented" default,
AGENTS.md section 61). `verse:clear` (however triggered) resets it to `null`.

**Boundary rollover uses `BOOK_CATALOG`'s existing order and chapter/verse-count
data** (`apps/server/verse/book-catalog.ts`) — the same dataset `KnownValidVerseIndex`
already validates against, so no new dataset is introduced:

```text
next-verse:       verse+1 if within the current chapter's verse count;
                  else chapter+1, verse 1, if another chapter remains in the book;
                  else the next book in BOOK_CATALOG's order, chapter 1, verse 1;
                  else (Revelation 22:21) no-op.
previous-verse:   mirrors next-verse backward; no-op before Genesis 1:1.
next-chapter:     chapter+1, verse 1, within the book; else next book, chapter 1,
                  verse 1; else no-op at the last book's last chapter.
previous-chapter: chapter-1, verse 1, within the book; else the previous book's
                  LAST chapter, verse 1; else no-op before Genesis chapter 1.
goto-chapter:     the named book's given chapter, verse 1.
```

A "no-op" broadcasts nothing and changes nothing, logged at info level (AGENTS.md
section 25: never silently drop without a trace) — the correct failure direction is
nothing happening, not something incorrect appearing, exactly the same principle
`MediaCueDetector`'s exact-match-only design (section 60.3) already applies.

**Every computed reference is still validated through `KnownValidVerseIndex.exists()`
before display — never skipped, even though it was computed from the same
catalog.** This is not redundant defensiveness: it is the same "never bypass the
hallucination guard for any code path that produces a `VerseReference`" rule
invariant 7 already establishes for every other path, applied consistently to a new
one, rather than a special case that gets to skip it because "we computed it
ourselves."

### 61.5 What this note deliberately leaves open

**Media/verse overlay precedence is not resolved here.** If a media cue (section 60)
is currently showing and a voice-navigated (or detected, or overridden) verse fires,
which one the overlay actually displays is not decided by this note — the same class
of "what's currently on air when two things want the screen" question section 59.4
already deferred for rundown/scenes. Out of scope for this note to invent; flagged
for a follow-up decision once both features exist side by side, not blocking this
one (navigation only needs to track "what verse reference is current," which is
well-defined independent of whatever else the overlay might also be showing).

### 61.6 New correctness invariants this feature adds

Invariant 17
Navigation commands never bypass `KnownValidVerseIndex.exists()`. A computed
reference that fails existence validation (which should not happen given
`BOOK_CATALOG`-derived computation, but is never assumed) broadcasts nothing, exactly
like an invalid detected or overridden reference does today.

Invariant 18
`NavigationCommandDetector` only ever sees final transcripts, mirroring invariant 1
and invariant 13 (section 60.6) — partial transcripts never trigger navigation.

Invariant 19
Current-position state is server-authoritative only, mirroring invariant 15's
playback-state rule for the same reason: no client computes or persists "what verse
is current" itself, it only ever reflects the most recent `verse:show`/`verse:clear`
it received.

### 61.7 Tests required

- `NavigationCommandDetector` unit tests: each fixed synonym triggers its command;
  a short synonym ("next", "clear") embedded inside an unrelated longer sentence does
  NOT trigger (the whole-utterance requirement from section 61.3); the longer
  phrases DO trigger as a substring; `goto-chapter` parses "Romans chapter 8"
  correctly and does not fire on "Romans 8:16" (RegexDetector's own territory).
- `resolveNavigationCommand()` unit tests, using real `BOOK_CATALOG` data: next/
  previous verse within a chapter; rollover at a chapter boundary; rollover at a
  book boundary; no-op at Genesis 1:1 and at Revelation's last verse; next/previous
  chapter with and without a book-boundary crossing; `goto-chapter` for a valid
  book/chapter and for an invalid one (existing `KnownValidVerseIndex` behavior,
  reused, not reimplemented).
- `AppCore`-level integration test (mirroring `app-core.test.ts`): a detected verse
  followed by a spoken "next verse" broadcasts the correct following verse; "cancel"
  after a shown verse broadcasts `verse:clear`; "next verse" with no prior verse
  shown broadcasts nothing.

### 61.8 Confirms this is approved scope

Confirmed explicitly, mid-session, as an extension of the already-shipped verse
pipeline: all four navigation categories in section 61.1, the synonym-list phrase
matching approach in section 61.3, and the explicit exclusion of mic start/stop from
voice control. This note does not decide media/verse overlay precedence (section
61.5) — that remains open for a future decision, not assumed here.

## 62. Phase 2 Feature Note — NDI Output

A dedicated architecture note, following the same AGENTS.md section 56 checklist as
sections 60-61. Raised mid-session as a new capability, not part of the original three
Phase 2 items in section 59 or media library/voice navigation above. The optional
transport is now implemented behind a native-module availability gate; the remaining
SDK redistribution-license review is a release gate, not a reason to weaken the
fallback behavior or block development of the adapter.

### 62.1 What problem this solves, and why it's a real architectural decision

OBS's Browser Source (already built, section 33) already gets the overlay into OBS.
NDI output is a genuinely different transport, not a replacement: it broadcasts the
overlay as a discovered network video source any NDI-compatible receiver can pick up
— OBS via its own NDI plugin, but also vision mixers, other computers on the same
network, or software that has no Browser Source concept at all. This is a real,
legitimate broadcast-production use case, not a redundant alternative to what already
works — but it is genuinely new architecture, not a UI change: it requires rendering
the overlay to actual video frames and requires a native, non-JavaScript dependency,
neither of which any existing seam does.

### 62.2 Which module owns this, and how it reuses what already exists

A new sibling domain, `apps/desktop/main/ndi-output.ts` — main-process-only, since
frame capture requires a real (if offscreen) Chromium renderer, which only the main
process can create (ARCHITECTURE.md section 6.1). It does NOT duplicate the overlay's
HTML/CSS/JS or reimplement rendering: it loads the exact same page StaticServer
already serves to OBS (`apps/overlay/public/index.html`), in an Electron `BrowserWindow`
constructed with `webPreferences: { offscreen: true }` — Electron's own offscreen
rendering feature, built on the same Chromium already embedded in the app, capturing
each rendered frame via the window's `paint` event. No second rendering engine, no
screenshot-polling hack: this is the same overlay, the same code, rendered to a pixel
buffer instead of a visible window.

Each captured frame is handed to the optional native dependency (section 62.3) for NDI
transmission. A bounded one-frame pending slot prevents slow native sends from
creating an unbounded memory queue. This keeps `apps/overlay/public/` completely unaware that NDI exists —
it has no idea whether it's being viewed by OBS's Browser Source, the overlay preview
window, or this offscreen NDI renderer, matching section 57's "the overlay can be
changed without modifying [transport]" success criterion extended to a new transport.

### 62.3 The new dependency — evaluated, not assumed (AGENTS.md section 40)

NDI is a proprietary protocol (Vizrt/NewTek) with no standard-library or pure-JS
implementation possible — a native dependency is unavoidable, unlike most of this
codebase's deliberate zero-dependency stance. The original `grandiose` package is
stale: npm reports version 0.0.4, released in 2018. The current candidate is the
maintained `@stagetimerio/grandiose` fork (0.2.0, Apache-2.0), whose documentation
describes Windows/macOS/Linux support, automatic NDI SDK download, Electron rebuild,
and asar-unpack requirements. Before this is implemented, three things must still be
verified against the maintained fork and NDI's current real terms — not assumed or
fabricated here:

1. **Licensing and redistribution.** What NDI's SDK license actually requires of an
   app that bundles/uses it (branding requirements, redistribution terms, whether the
   free tier is sufficient or "NDI Advanced" licensing is needed for this use case).
2. **Platform/prebuild coverage.** Whether the maintained fork ships compatible
   prebuilt binaries for
   every platform this app targets (Windows/macOS/Linux), or whether some platforms
   would require a native build toolchain at install time — a real
   "might not install cleanly on every machine" risk to know about upfront, not
   discover from a user's failed install.
3. **Maintenance status.** Whether the maintained fork remains actively maintained against
   current Node/Electron ABI versions, given Electron's own Node version can be newer
   than what a native addon's prebuilds were built against.

### 62.4 Fail-safe behavior (ARCHITECTURE.md section 4.5)

NDI output is strictly additive and non-blocking: if the native module fails to
load (missing prebuild, unsupported platform, NDI runtime not installed on the
machine), the application logs the failure and simply does not offer NDI output —
Browser Source and the overlay preview window continue working exactly as they do
today, unaffected. NDI is never a required dependency for the app to start; it is an
optional capability that degrades to "unavailable," never a startup failure.

### 62.5 Open questions this note does not resolve

- **Section 62.3's licensing and packaging gates** — package metadata and the README
  confirm a maintained fork and document Electron packaging steps, but they do not
  establish that the NDI SDK runtime license permits every intended redistribution
  model. A license review and a tested Electron packaging proof on each supported
  platform are still required before code is written.
- **Frame rate / send cadence.** The overlay is mostly static text with occasional
  updates, not continuous motion video — whether to send a continuous fixed-rate frame
  stream (what most NDI receivers expect) or something smarter tied to actual
  `verse:show`/`media:show` events is an implementation decision for whoever writes
  the actual capture loop, not decided here.
- **Operator control surface.** Whether NDI output is always-on once configured, or
  has its own start/stop control in the dashboard (mirroring the mic's own
  start/stop) is not decided here.

### 62.6 Confirms this is approved scope

Confirmed explicitly, mid-session: NDI output is added to `ROADMAP.md`'s Phase 2
section and is implemented as an optional transport. Its native dependency is
loaded dynamically, startup continues when it is missing, Browser Source remains
the fallback, and the remaining licensing/package proof is tracked as a release
gate rather than silently assumed.

## 63. Phase 2 Feature Note — Bilingual Display & French Localization

A dedicated architecture note, following the same AGENTS.md section 56 checklist as
sections 60-62. Raised mid-session: the app's real target audience is a French-
speaking church, not an English-speaking one. This is two related but distinct
changes, both confirmed explicitly rather than assumed:

1. **Verse content** can display in English only, French only, or both at once
   (bilingual, French prioritized/larger).
2. **The app's own interface** (dashboard, setup screen) is translated to French,
   with a language switch — not just the verse content.

Implementation status: **implemented**. The source adapters, bilingual composition,
configuration persistence, live dashboard/voice switching, French UI dictionary, and
the required test coverage described below are present in the repository. This note
remains the authoritative design record; section 83 records the current
implementation-to-architecture audit.

### 63.1 The French Bible source — verified live, not assumed

`api.getbible.net` (a real, live, free, no-API-key-required service — verified
directly, matching this project's existing practice of confirming external API shapes
before writing code against them, not assuming them) serves `ls1910`, Louis Segond
(1910) — the standard French Protestant translation, functionally analogous to KJV's
role for English-speaking Protestants. Its endpoint shape, confirmed by a real
request: `GET https://api.getbible.net/v2/ls1910/{book_nr}/{chapter}.json` returns a
whole chapter, `{ ..., verses: [{ chapter, verse, name, text }, ...] }`; the specific
verse is found by filtering that array. Errors are RFC 9457 `problem+json`.
Rate limits (50 req/s sustained, ~100k/hour) are far beyond a single church's live
service traffic — no bearer token needed for this use case.

`book_nr` uses standard canonical numbering (Genesis=1 ... Revelation=66) — verified
directly against `BOOK_CATALOG`'s own array order (`apps/server/verse/book-catalog.ts`)
rather than assumed: John is `book_nr` 43 there and index 42 (0-based) in
`BOOK_CATALOG`, Matthew is 40, Genesis is 1, Revelation is 66 — an exact match. A new
`GetBibleVerseSource` (`apps/server/verse/get-bible-verse-source.ts`, sibling to
`FreeApiSource`) computes `book_nr` as `BOOK_CATALOG.findIndex(...) + 1`, matching
`FreeApiSource`'s own established pattern: an HTTP 404 or a verse number genuinely
absent from the chapter's `verses` array resolves `null` (confirmed not found); a
network error, non-2xx status, or malformed body throws (a real service failure,
distinguishable by the circuit breaker exactly as section 21 already requires).

**A real risk this note flags rather than silently ignores: versification can differ
between translations.** `ls1910`'s own metadata describes "Segond versification" —
some books (Psalms numbering is the classic example across Bible translation
traditions generally) can split or number verses slightly differently than the
English versification `KnownValidVerseIndex` validates against. A reference confirmed
to exist in English is not guaranteed to have an exact same-numbered match in the
French source. This is treated as an ordinary "confirmed not found" for that source
specifically (resolves `null`, not a thrown error) — section 63.3's bilingual
resolution already tolerates one language resolving and the other not.

### 63.2 Display mode as a `VerseSource` capability, not a new WS action

Confirmed explicitly: the mode setting (English / French / Bilingual) has a
setup-time default AND a live dashboard toggle. The key design decision: **this
never needs a new WS action or protocol change at all.** `verse:show`'s payload is
still just a `Verse` — the overlay does not need to know a "mode" exists; it reacts
to whatever shape of `Verse` it actually receives (section 63.4).

```ts
// packages/contracts/verse.ts, extended
export type DisplayMode = "english" | "french" | "bilingual"
```

A new `LocalizedVerseSource` (`apps/server/verse/localized-verse-source.ts`)
implements the existing `VerseSource` interface — no change to `VerseSource` itself,
`resolveVerse()`, `resolveTranscriptVerses()`, or `AppCore`'s `source` dependency at
all, matching section 57's own success criterion ("a new verse source can be added
without modifying the detector") extended to "without modifying anything downstream
of it either":

```ts
export class LocalizedVerseSource implements VerseSource {
  private mode: DisplayMode
  constructor(
    private readonly english: VerseSource,
    private readonly french: VerseSource,
    initialMode: DisplayMode
  ) { this.mode = initialMode }

  setMode(mode: DisplayMode): void { this.mode = mode }
  getMode(): DisplayMode { return this.mode }

  async getVerse(reference: VerseReference): Promise<Verse | null> {
    if (this.mode === "english") return this.english.getVerse(reference)
    if (this.mode === "french") return this.french.getVerse(reference)
    const [fr, en] = await Promise.all([
      this.french.getVerse(reference),
      this.english.getVerse(reference),
    ])
    if (!fr) return null // French is primary in bilingual mode; if it's not found, there's nothing to show
    return en ? { ...fr, secondary: { text: en.text, translation: en.translation, source: en.source } } : fr
  }
}
```

`setMode`/`getMode` are additions beyond the `VerseSource` interface, the same
documented pattern `GroqProvider.onError` already uses for `AsrProvider` (an optional
capability a specific implementation offers, not a change to the shared interface).
The Electron main process constructs one `LocalizedVerseSource` and injects it as
`AppCore`'s `source` — `AppCore` itself needs zero changes to its resolution logic.

**The live toggle goes through IPC, not WS.** Changing the mode is an operator
configuration action with no reason to round-trip through the WS server: a new
`set-display-mode` IPC handler (main process) updates `ConfigStore` (so the choice
persists as the new default) and calls the live `LocalizedVerseSource.setMode()`
directly, since main process already holds that reference. `get-startup-status`'s
response gains a `displayMode` field so the dashboard can initialize its toggle
control correctly on load.

### 63.3 Data model: `Verse` gains an optional `secondary` field

```ts
// packages/contracts/verse.ts, Verse extended
export type Verse = {
  reference: VerseReference
  text: string
  translation: string
  source: string
  secondary?: {
    text: string
    translation: string
    source: string
  }
}
```

Additive and backward-compatible (AGENTS.md section 43's own required framing:
why/what changes/what breaks/tests) — `text`/`translation`/`reference` keep meaning
exactly what they already do everywhere in the codebase; every existing consumer that
only reads those fields is unaffected. `secondary` is populated only in bilingual
mode. In bilingual mode, the top-level fields carry **French** (primary/prioritized,
confirmed explicitly) and `secondary` carries English — matching section 63.4's
"French larger, on top" layout exactly, since the overlay renders top-level fields as
the primary block.

### 63.4 Overlay rendering: stacked, French primary, auto-shrink extended to two blocks

Confirmed explicitly: stacked layout, French (top-level `Verse` fields) above in the
existing primary verse-text styling, English (`secondary`, when present) below in a
visually secondary treatment (smaller, per section 63.3's own field-priority choice).
`apps/overlay/public/overlay.js`'s existing `fitVerseText()` (added for long-verse
auto-shrink) is extended to measure the COMBINED card height across both text
blocks when `secondary` is present, not just the primary block — the same safe-
shrink-until-it-fits algorithm, just accounting for more content. A single-language
`Verse` (no `secondary`) renders exactly as it already does today — zero visual
change for English-only or French-only mode.

### 63.5 UI localization (i18n) — full dashboard and setup screen

Confirmed explicitly: not just verse-language settings — the operator dashboard and
setup screen's own interface text is translated to French, with a language switch,
English still available. No new dependency (AGENTS.md section 40): a small,
dependency-free key-based lookup, matching this codebase's existing "no build step"
plain-JS renderer files.

- `apps/desktop/renderer/i18n.js` (new): two flat dictionaries (`en`, `fr`) keyed by
  short dot-path strings (e.g. `"mic.title"`), a `t(key)` lookup, and
  `applyTranslations()` which walks every element carrying a `data-i18n="key"`
  attribute and sets its text content. The same pass also translates
  `data-i18n-placeholder`, `data-i18n-aria-label`, and `data-i18n-title` attributes,
  so French mode does not leave accessibility names and tooltips in English — the
  same "plain browser JS, no build step" convention `dashboard.js`/`overlay.js`
  already use.
- `apps/desktop/renderer/index.html` markup gains `data-i18n` attributes on every
  user-facing string (labels, headings, button text, setup-screen copy); strings
  `dashboard.js` generates dynamically (activity-log lines, status text) call `t()`
  directly rather than hardcoding English.
- The chosen UI language persists via `ConfigStore` (a new `uiLanguage` field,
  alongside `displayMode`) — set at setup time, changeable via a header toggle the
  same way `displayMode` has one, both following the identical setup-default +
  live-toggle pattern from section 63.2.
- This is a real, large amount of mechanical translation work (every string in the
  dashboard and setup screen), not a small addition — sized accordingly as its own
  implementation slice, separate from the verse-bilingual work in sections 63.1-63.4.

### 63.6 What this note does not decide

- **Exact French UI copy.** Translating every string accurately is implementation
  work, not an architectural decision — this note establishes the mechanism
  (`data-i18n` + a lookup table), not the actual French text.
- **Whether other languages beyond English/French are ever added.** The `i18n.js`
  dictionary structure accommodates more languages trivially (another top-level key),
  but nothing beyond English/French is in scope here — AGENTS.md section 58's
  "don't invent requirements" applies to speculative additional languages nothing has
  asked for.

### 63.7 Confirms this is approved scope

Confirmed explicitly, mid-session: bilingual verse display (English/French/Bilingual
modes, French prioritized in bilingual mode, both a setup default and a live
dashboard toggle) and full UI localization to French with a language switch. Verified
against a real, live API (`api.getbible.net`/`ls1910`) rather than assumed, and
against `BOOK_CATALOG`'s actual book-numbering order rather than assumed. The
versification-mismatch risk (section 63.1) is flagged, not silently ignored — treated
as an ordinary per-language "not found" case the existing bilingual-resolution design
already tolerates gracefully.

## 64. Phase 2 Feature Note — Service Rundown & Scenes

A dedicated architecture note, following the same AGENTS.md section 56 checklist as
sections 60-63. Implementation status: **implemented in memory**, with dashboard
authoring and live stepping wired. Cross-restart rundown persistence remains
explicitly deferred. This section settles the one open question section 59.4
explicitly deferred: rundown/live-detection precedence.

### 64.1 What this feature is

A rundown is an ordered, pre-planned list of **scenes** an operator steps through
during a service — replacing today's single implicit state (a verse showing, or
nothing) with an explicit state machine (named states, defined transitions, per
section 48). A scene is one of:

```ts
// packages/contracts/rundown.ts (new)
export type RundownScene =
  | { readonly kind: "verse"; readonly reference: VerseReference }
  | { readonly kind: "media"; readonly mediaCueId: string }
  | { readonly kind: "announcement"; readonly title: string; readonly body: string }
  | { readonly kind: "blank" }

export interface Rundown {
  readonly id: string
  readonly title: string
  readonly scenes: readonly RundownScene[]
}
```

An "announcement" scene is a new, minimal kind of content — plain title+body text
overlaid the same way a verse card is today — not a general slide/layout editor; that
would be a materially bigger feature nothing has asked for (AGENTS.md section 39).
(This was later built anyway, deliberately, as its own reviewed scope change — see
section 66.)

### 64.2 Resolved: rundown/live-detection precedence (closes section 59.4)

**Confirmed explicitly: live detection always wins.** A live-detected verse (or a
manual `verse:override`, or voice navigation from section 61 — anything that already
goes through `resolveVerse()`'s hallucination-guard pipeline) always overlays
immediately, regardless of what scene the rundown currently has on air. This matches
the app's original core value proposition (hands-free live scripture display) —
a rundown plans *ahead of time* what to show between moments of live speech, it does
not get to suppress live speech once it happens.

**How control returns afterward — the resolved transition model:**

- Showing a live/overridden/navigated verse while a rundown scene is on air does not
  move the rundown's cursor. The scene that was on air is remembered as **paused**,
  not replaced or lost.
- When the interrupting verse is subsequently cleared (`verse:clear`, from any
  trigger — manual, voice "cancel", or a caller clearing it programmatically) **and**
  a scene was paused, the overlay automatically resumes showing that paused scene —
  the interruption ending is what hands control back, not a separate operator action.
  This is the least-surprising behavior (AGENTS.md section 61): an operator who
  didn't touch the rundown expects it to still be where they left it once the verse
  is gone.
- An explicit rundown action during an interrupt (`scene:next`, `scene:previous`,
  `scene:goto`) is a deliberate operator override and always wins immediately: it
  clears the interrupting verse, discards the "paused scene" (the operator just
  changed their mind about what should be showing), and moves the cursor as
  requested. This mirrors the existing precedent that a manual `verse:override`
  already takes priority as a deliberate operator action.
- If no rundown is loaded at all, behavior is completely unchanged from today —
  this feature only introduces new states when a rundown is actually active.

### 64.3 State machine

```text
states:
  no-rundown         — unchanged v1/Phase 2 behavior; no rundown loaded
  scene-active       — a rundown is loaded; scenes[cursor] is what the overlay shows
  verse-interrupt    — a live/overridden/navigated verse is showing; the rundown
                       (if any) has a paused scene remembered underneath it

transitions:
  no-rundown          --rundown:load-->             scene-active (cursor 0)
  scene-active        --scene:next/previous/goto-->  scene-active (new cursor)
  scene-active        --verse detected/overridden/navigated-->
                                                      verse-interrupt (remembers paused = cursor)
  verse-interrupt     --verse:clear-->               scene-active (cursor = paused), or
                                                      no-rundown if paused was never set
                                                      (interrupt happened with no rundown loaded)
  verse-interrupt     --scene:next/previous/goto-->  scene-active (new cursor, interrupt discarded)
  scene-active/verse-interrupt --rundown:load-->     scene-active (new rundown, cursor 0,
                                                      any interrupt/pause discarded)
```

A "no-op" (e.g. `scene:next` past the rundown's last scene) broadcasts nothing and
changes nothing, logged at info level — the same failure direction section 61.4
already establishes for navigation boundaries, applied consistently here.

### 64.4 Server ownership and WS surface

**Server-authoritative, in-memory** — a new `RundownController`
(`apps/server/rundown/rundown-controller.ts`), owned by `AppCore` alongside
`MediaPlaybackController` and the navigation/current-position state, not a new
top-level seam (same "approved Phase 2 growth beyond v1's four seams" reasoning as
sections 60.2 and 61.2). New operator-only WS commands, schema-validated the same way
`verse:override` and the media commands already are:

```text
rundown:load    { rundown: Rundown }         -- operator-only, loads and activates
scene:next      {}                            -- operator-only
scene:previous  {}                            -- operator-only
scene:goto      { index: number }             -- operator-only
```

Broadcast events mirror the existing `verse:show`/`media:show` pattern — a scene
change broadcasts the appropriate existing event for its kind (`verse:show` for a
`"verse"` scene, `media:show` for a `"media"` scene) plus a new `rundown:state` event
carrying `{ rundownId, cursor, scene, interrupted }` so the dashboard can render
"which scene is active" without re-deriving it from individual verse/media events. An
`"announcement"` scene needs its own pair of events, since nothing existing carries
title+body text: new `announcement:show { title, body }` / `announcement:clear`,
following the exact same shape as every other show/clear pair. A `"blank"` scene
broadcasts `verse:clear`, `media:clear`, **and** `announcement:clear` together, to
guarantee the overlay is actually empty regardless of what was showing before — the
same reasoning, generalized to a third clearable content type.
`ChurchOverlayWsServer`'s existing `onViewerConnected` callback (section 60.4) is
reused, not duplicated, for late-join/reconnect sync of rundown state, the same way
it already syncs media playback state.

### 64.5 What this note deliberately leaves open

- **Rundown authoring UI — now built, resolved as button-based, not drag-and-drop.**
  A new "Service Rundown" card in the operator dashboard (`apps/desktop/renderer/`)
  lets the operator build a scene list (scene-kind picker, per-kind fields for verse/
  media/announcement/blank, an "Add scene" button) with simple ↑/↓/× buttons to
  reorder or remove a drafted scene before loading it via `rundown:load`. Chosen over
  a drag-and-drop list deliberately: no new dependency is needed (AGENTS.md section
  40), and reordering a short pre-service scene list a few times is a low enough
  frequency action that button clicks are not a real usability cost. The loaded
  rundown's active scenes render as a row of clickable chips (`scene:goto` on click),
  with the active chip highlighted and marked when `interrupted` per section 64.2.
  Because `rundown:state` only ever broadcasts the current scene (section 64.4), not
  the whole list, the dashboard renders the full chip row from the scene list it last
  loaded itself — a rundown loaded by some other means (not yet possible; there is
  only one operator dashboard) would only show its single current scene, a graceful
  degradation rather than a guess.
- **Persistence across app restarts — still not implemented, in-memory only.**
  `RundownController`'s loaded rundown lives only in memory, same as today's
  pre-rundown verse-display state — it does not survive an app restart. This remains
  flagged as a genuine gap, not a silent one: an operator restarting the app mid-
  service would need to rebuild or re-load the rundown. Deferred rather than solved
  now since it needs its own decision (a file format, a save location under
  `userData`, and whether the mid-rundown cursor position should also survive a
  restart or just the scene list) — not something to bolt on without that thought.

### 64.6 New correctness invariants this feature adds

Invariant 20
A live-detected, overridden, or voice-navigated verse never fails to display because
a rundown scene is on air — section 64.2's precedence is absolute, not best-effort.

Invariant 21
Rundown state (cursor, paused scene) is server-authoritative only, mirroring
invariant 15 and invariant 19 for the same reason: no client computes or persists
rundown position itself.

Invariant 22
A `"blank"` scene and a cleared interrupt with no paused scene both result in a
genuinely empty overlay (`verse:clear`, `media:clear`, and `announcement:clear` all
fire) — never stale content left on screen because only some of the clear events
were sent.

### 64.7 Tests required

- `RundownController` unit tests: cursor advances/wraps correctly for `scene:next`/
  `scene:previous`/`scene:goto`; out-of-range `scene:goto` is a no-op; loading a new
  rundown resets cursor and discards any paused scene; a verse interrupt pauses the
  current scene and clearing it resumes exactly that scene; an explicit scene
  navigation during an interrupt discards the paused scene instead of resuming it.
- `AppCore`-level integration tests (mirroring `app-core.test.ts`): a detected verse
  while a media scene is active immediately overlays the verse, then clearing it
  resumes the media scene; an operator calling `scene:next` while a verse-interrupt
  is showing switches scenes immediately and does not later resume the discarded
  scene; a `"blank"` scene broadcasts both `verse:clear` and `media:clear`.

### 64.8 Confirms this is approved scope

Confirmed explicitly: the rundown/live-detection precedence question from section
59.4 is resolved as "live detection always wins," with control returning to a paused
scene when the interrupting verse clears, and an explicit rundown action always
discarding a paused scene rather than resuming it. Scene kinds are verse, media,
announcement (new, minimal), and blank — no general slide/layout editor. (Superseded
later, deliberately and explicitly — see section 66, which adds a fifth,
free-form-canvas scene kind as its own reviewed scope change, not a silent
reversal.) Rundown authoring UI and cross-restart persistence are explicitly left
open per section 64.5, not assumed here.

## 65. Phase 2 Feature Note — Web-Research-Driven Enhancements

A dedicated architecture note covering a batch of smaller features, sourced from
researching how established church presentation tools (ProPresenter, EasyWorship,
Proclaim, OpenLP) and newer AI-native competitors (VerseFlash, NaveLight, Pewbeam,
Kairos) handle live scripture display, service planning, and AI-assisted features —
explicitly to find ideas this app didn't already have planned, not to re-litigate
anything already scoped. Design only for each subsection below; implementation
proceeds subsection by subsection, not as one slice.

### 65.1 Elliptical reference resolution ("continuation" references)

**Problem confirmed from real preaching speech patterns**: a preacher says "Romans
chapter 8," then later just "verse 16" or "chapter 9, verse 3" — a full "Book
Chapter:Verse" utterance is the exception in a sermon, not the norm, once the book is
already established. `RegexDetector`'s `REFERENCE_PATTERN` requires a full "Book
Chapter:Verse" every time and has no memory of what was said before — it is
correctly stateless per its own doc comment (ARCHITECTURE.md section 12). This gap
is closed the same way section 61 closed "next verse": as a **new pair of
`NavigationCommand` kinds**, resolved against `currentVersePosition` (the same
server-authoritative state section 61.4 already introduced), not as a change to
`RegexDetector` itself.

```ts
// packages/contracts/verse.ts, NavigationCommand extended
| { readonly kind: "goto-bare-verse"; readonly verse: number }
| { readonly kind: "goto-bare-chapter-verse"; readonly chapter: number; readonly verse: number }
```

Phrase recognition, in `NavigationCommandDetector`:

```text
goto-bare-verse:          "verse <N>" — reuses currentPosition's book AND chapter
goto-bare-chapter-verse:  "chapter <N> verse <M>" (or "chapter <N>, verse <M>") —
                          reuses currentPosition's book only
```

**Both patterns require a negative lookbehind excluding a book name (or a
`goto-chapter`-style "chapter" already attached to one) immediately before
"chapter"/"verse"**, so "Romans chapter 8" (a real `goto-chapter`) and "Romans
chapter 8, verse 16" (destined to be its own full-reference detection once spoken
that way) are never miscaptured as a *bare* continuation using the wrong (current,
not stated) book. The bare-verse pattern additionally excludes a match that is the
tail of a "chapter N ... verse M" phrase already claimed by the bare-chapter-verse
pattern, so one utterance never produces two redundant commands for the same
resolved reference.

Resolution mirrors `goto-chapter`'s existing shape in `resolveNavigationCommand()`:
no-op with no `currentPosition` (nothing to continue from) or an unknown/out-of-range
result (still validated through `KnownValidVerseIndex.exists()` — invariant 17
applies here exactly as it does to every other navigation-computed reference, no
exception for a "simpler" case).

**Known, accepted limitation**: a book name mentioned much earlier in a long,
rambling sentence (not immediately before "chapter"/"verse") could still be missed
by the lookbehind and get treated as a continuation. This is the same class of
tradeoff section 61.3 already accepts for short synonyms — mitigated, not
eliminated, and flagged rather than silently assumed away.

### 65.2 Trigger-source indicator (adapted from "confidence badge")

The research's "visible confidence badge" idea does not translate directly: this
app's detection is fully deterministic (regex match + hallucination-guard
validation), not fuzzy/semantic, so there is no graduated confidence to display —
every accepted detection is equally "exact" by construction (section 15). The
**meaningful equivalent for this architecture** is surfacing *how* a shown verse got
there, since that genuinely varies and is useful operator context: detected from
speech, a manual override, voice navigation, or a rundown scene.

`broadcastVerse()`'s call sites already know this distinction (it is implicit in
which function called them) — this note adds a `trigger` field to `verse:show`'s
payload envelope (not to `Verse` itself, which stays pure verse-content data with no
knowledge of why it's being shown):

```text
trigger: "detected" | "override" | "navigation" | "rundown"
```

Dashboard-only surface (a small label on the Live Preview card) — the overlay (what
the congregation/broadcast sees) does not show this, since it is operator context,
not audience content.

### 65.3 Auto-send vs. review-and-approve mode

**Confirmed explicitly with the user**: auto-send remains the default, unchanged
from today's behavior — this is an additive opt-in mode, not a behavior change
anyone already running the app would notice unless they turn it on.

A new per-install setting (`ConfigStore.verseConfirmationMode: "auto" | "review"`,
defaulting to `"auto"`, same setup-default + live-toggle pattern section 63.2
established for display mode) changes exactly one thing: when a **detected**
reference resolves successfully, instead of calling `broadcastVerse()` immediately,
it is held as a **pending suggestion** and a new operator-only event
(`verse:pending { verse: Verse }`) is sent instead. The operator dashboard shows a
"Verse detected: John 3:16 — show?" prompt with a confirm button, which sends a new
operator command (`verse:confirm-pending`) that then calls `broadcastVerse()` for
real. A new pending suggestion replaces (does not queue behind) any not-yet-confirmed
one — the same "most recent wins" reasoning invariant 15-adjacent state already uses
elsewhere, since an unconfirmed suggestion for a verse spoken two sentences ago is
almost never still wanted once a newer one exists.

**Only affects detection.** Manual override, voice navigation, and rundown scene
activation are all explicit operator-driven actions already — this mode has no
effect on them, matching the confirmed scope ("review" is specifically about
live-detected suggestions, not gating every possible verse-display path).

**Implemented as live-toggle-only, not a setup-screen default**, a small deviation
from "same setup-default + live-toggle pattern as display mode" above: unlike
`displayMode`/`uiLanguage`, there is no setup-screen control for this one. "Auto" is
the confirmed default for every fresh install regardless, so a setup-time choice
would only ever offer switching to "review" one step earlier than the header's own
live toggle already allows — not enough additional value to justify a fourth setup
screen field. `AppCoreHandle` gained a `setVerseConfirmationMode()` method (the same
"main process calls it directly, then persists" shape as `LocalizedVerseSource.setMode()`)
so the live dashboard toggle and `ConfigStore` both stay in sync without a restart.

### 65.4 Voice command to switch translation/display mode

Extends the same synonym-list `NavigationCommandDetector` domain (section 61.3) with
new whole-utterance-adjacent phrases mapped to a new `NavigationCommand` kind:

```text
goto-display-mode: "switch to english", "switch to french", "switch to bilingual"
                    (also "english only"/"french only" as accepted synonyms)
```

Resolution does not go through `resolveNavigationCommand()`'s `VerseReference`
machinery at all (there is no reference involved) — `AppCore` handles this kind
directly, calling `LocalizedVerseSource.setMode()` exactly like the existing
`set-display-mode` IPC handler does today (section 63.2), and persists the change to
`ConfigStore` the same way, so a voice-triggered switch survives a restart
identically to a dashboard-toggled one.

### 65.5 On-demand word/term definition lookup by voice

A small, fixed, bundled glossary (`apps/server/glossary/glossary.ts` — a plain
`Record<string, string>`, dozens of common theological terms, not hundreds; not a
Greek/Hebrew lexicon, which is a real, separate data-licensing undertaking flagged
as out of scope for this note) and a `GlossaryDetector` sibling to
`NavigationCommandDetector`, matching `"define <term>"` / `"what does <term> mean"`.
A found term broadcasts a new `definition:show { term, definition }` event,
displayed by the overlay similarly to (but visually distinct from) the announcement
card (section 64.4), auto-clearing after a fixed duration (defaulting 12 seconds — a
definition is a momentary aside, not a persistent scene the operator manages, unlike
every other content type in this app) rather than needing an explicit clear. A term
not found in the glossary logs an info-level "not found" event and displays nothing —
same "no-op is the safe failure direction" principle as every other detector.

### 65.6 Phone-based second-operator remote

**Confirmed explicitly with the user**: reuses the existing operator token/role — a
phone visiting the remote page authenticates exactly like the desktop dashboard does
today (same `Sec-WebSocket-Protocol` handshake, same `ChurchOverlayWsServer`, no new
`WsRole`). This is a deliberate trust-boundary decision, not an oversight: anyone who
can already reach the operator dashboard is already fully trusted (ARCHITECTURE.md
section 24 — the WS server binds to 127.0.0.1/LAN, not the public internet), so a
second client with the same token is not a larger attack surface than the existing
single-dashboard assumption, just a second window onto the same trust level.

A new, separate, mobile-first static page (`apps/remote/public/`, its own minimal
HTML/CSS/JS, no build step, matching every other renderer in this codebase) served by
a new `StaticServer` instance — scoped deliberately narrow: rundown scene navigation
(`scene:next/previous`, tap-to-goto) and media clear only. It does NOT expose mic
start/stop, media import, or manual verse override — not a security boundary (the
token already grants that), but a *usability* one: a phone screen is a poor fit for
typing a verse reference or managing file imports, so the remote's own UI simply
doesn't offer them, the same "least surprising, smallest useful surface" reasoning as
every other UI decision in this codebase. The desktop dashboard gains a "Remote"
panel showing the full link as selectable text with a copy button.

**Found necessary during implementation, confirmed via a follow-up question**: this
feature is only reachable at all once the local server binds to something other than
127.0.0.1 (a phone is a different device — loopback is by definition unreachable from
it). Confirmed explicitly: **opt-in, off by default** — a new `ConfigStore.allowPhoneRemote:
boolean` (default `false`, same backward-compatible-defaulting pattern as
`displayMode`/`uiLanguage`), set via a checkbox on the setup screen. When `true`,
`ChurchOverlayWsServer` and the remote page's `StaticServer` both bind to `0.0.0.0`
(reachable from the local network) instead of the existing 127.0.0.1-only default
(section 24); when `false` (the default for every existing and new install), nothing
about the network exposure changes at all. The dashboard's Remote panel reads the
machine's LAN IPv4 address (`os.networkInterfaces()`, first non-internal entry) to
build the link's full LAN-reachable URL; a machine with no such address (rare) still
runs with the feature "on" but has no reachable link to show, surfaced as its own
distinct message rather than silently showing nothing.

**Simplified from a QR code to a copyable text link, deliberately**: generating a
correct QR code requires either a new dependency (against this codebase's own
"no build step, minimal dependencies" convention for renderer files, AGENTS.md
section 40) or hand-vendoring a non-trivial encoding algorithm this session could not
actually verify scans correctly with a real phone camera. Shipping an unverified QR
implementation risked a link that LOOKS right but doesn't scan — worse than the
honest, simpler alternative. A future revisit can add a real QR code once it can
actually be verified against a physical device.

**Simplified to a setup-time-only setting, not a live dashboard toggle**: unlike
`displayMode`/`uiLanguage`, `allowPhoneRemote` is not exposed as a live toggle after
setup. Changing network binding for an already-running WS server would mean tearing
down and rebinding it mid-service, disconnecting every already-connected client
(dashboard, overlay, any existing remote) to do so — a real behavior change for a
setting that is rarely revisited, not worth the complexity it would add. Changing it
later means re-running setup (or editing the config file directly) and restarting the
app — a real, documented limitation, not a silent gap.

### 65.7 AI sermon-notes copilot (strictly separate side channel)

**Confirmed explicitly with the user**: uses Groq's chat-completion API (the same
provider/API-key relationship already established for ASR, not a second AI vendor)
to periodically summarize the rolling final-transcript text into short bullet-point
notes. This is the concrete scope decision section 59.4/61.5 left open for "AI
copilot" — sermon/topic assistance, specifically, not the broader "chat-style
assistant" or "reference-proposal" ideas also once floated; those remain unscoped.

**The hard boundary, non-negotiable**: this side channel NEVER feeds into, informs,
or is consulted by the verse-detection/hallucination-guard pipeline in either
direction. It is a read-only observer of the same final-transcript stream
`RegexDetector`/`NavigationCommandDetector` already see, producing its own
independent output (`sermonNotes:update { notes: string }`, a new WS event, dashboard-
only — never sent to the overlay/audience) on a fixed cadence (every ~60 seconds of
accumulated final-transcript text, not on every single transcript, both to bound the
API cost and because a summary of one sentence is not a useful summary). A
summarization failure (API error, rate limit) logs and skips that cycle silently
recoverable next cycle — never affects mic capture, ASR, or verse display in any way.
Explicitly labeled "AI-generated notes" in the UI, never presented as verified
content, matching the same hallucination-guard-adjacent honesty this app already
applies everywhere else that isn't the guarded pipeline itself.

**Implementation notes:** opt-in, off by default, via a new `enableSermonNotes`
ConfigStore field — the same "opt-in, off by default" shape as `allowPhoneRemote`
(section 65.6), but for real per-request Groq API cost rather than network exposure.
Unlike `allowPhoneRemote`, this is not a setup-screen control: like
`verseConfirmationMode` (section 65.3), it is a live dashboard toggle only
(`sermonNotes:update`'s own header segmented control, "Off"/"On"), since turning AI
notes on or off is an ongoing per-service choice, not a one-time install decision.
`AppCore` accepts an optional `SermonNotesGenerator`-shaped dependency (a minimal
`{ summarize(text): Promise<string> }` seam, not the concrete class — the same
"depend on the shape you use" pattern as `VerseSource`/`AsrProvider`) plus an
`enableSermonNotes` flag; when the generator is absent, none of this code path runs
at all. When present but disabled, the generator is held ready (constructed once,
reusing the same Groq API key as ASR) but never invoked, so the live toggle can turn
summarization on mid-service without reconstructing `AppCore`. Disabling the toggle
also discards whatever transcript text had already accumulated, so re-enabling later
never summarizes stale text spoken while it was off. The dashboard's own "Sermon
Notes (AI)" card is a standalone feed (newest first, same prepend/cap pattern as the
Activity log), with a persistent, always-visible disclaimer line rather than a
one-time tooltip — the same "never presented as verified content" requirement the
note above states, made durable in the UI rather than relying on a first impression.

### 65.8 Post-service content export

A new `SessionRecorder` (owned by `AppCore`, alongside `RundownController`) appends
`{ reference, text, translation, timestamp }` to an in-memory list every time
`broadcastVerse()` actually shows a verse — reusing already-verified data the
pipeline already produced, generating nothing new and carrying no hallucination risk
of its own. A new operator-only command (`session:export`) returns (via IPC, not WS —
this is a file-save action, the same reasoning `import-media-file` already uses) a
plain-text transcript (timestamped list of every verse shown) and simple PNG "quote
card" images (verse text + reference, reusing the overlay's own card visual styling
rendered to an offscreen canvas) saved to a user-chosen folder via `dialog.showSaveDialog`.
Deliberately excludes AI-picked "highlight moments" or video clip generation (the
research's own "poor fit, flag only" finding) — this only repackages what the
operator's own service already verified and displayed, nothing inferred.

**Implementation notes, two small deviations from the above:** recording happens in
`showVerse()` (the one function every trigger ultimately calls), not the detection-
specific `broadcastVerse()` described above — a complete post-service record should
include every verse actually shown, regardless of how it got there, which is a
strictly broader and more correct scope than the original wording. And export uses
`dialog.showOpenDialog` with `openDirectory` (a folder picker) rather than
`showSaveDialog`, since this produces multiple files (one transcript plus one PNG per
verse) into one chosen location, not a single file to name.

Quote cards are rendered by loading a small standalone HTML page into a hidden
`BrowserWindow` and screenshotting it via Electron's own `capturePage()` — no new
dependency (a hand-rolled image-encoding library would need one), and no custom
rendering algorithm of its own to get subtly wrong, unlike a hand-vendored QR encoder
(section 65.6's own reasoning for why that idea was simplified instead) — `capturePage()`
is a well-established, already-trusted Electron API, not a novel mechanism this
session needed to independently verify from scratch. The HTML template's visual
correctness WAS verified directly, via a real headless-Chrome screenshot, before
shipping. Typography is a simplified, system-font approximation of the overlay's own
card styling (Georgia serif, not the overlay's Google-Fonts Instrument Serif) — a
static export image loaded via a `data:` URL cannot reliably wait on a network font
fetch before `capturePage()` runs, so this avoids that race entirely rather than
risking an inconsistently-rendered card.

### 65.9 What this note does not decide

- **Exact glossary term list and definitions** (section 65.5) — implementation-time
  content work, not an architectural decision.
- **Remote page's exact visual design** (section 65.6) — a mobile-first layout
  decision made when built, following this codebase's existing design system.
- **Sermon-notes summarization prompt wording and exact cadence tuning** (section
  65.7) — implementation detail, tuned once real usage exists.
- **Quote-card visual template** (section 65.8) — reuses the overlay's existing verse
  card styling as a starting point, not a new design system.

### 65.10 Confirms this is approved scope

Confirmed explicitly with the user: auto-send stays the default for section 65.3;
the phone remote (section 65.6) reuses the existing operator token/role rather than a
new narrower one; the AI sermon-notes copilot (section 65.7) is approved to use
Groq's chat-completion API as a strictly separate, dashboard-only side channel that
never touches the verse-detection pipeline. Each subsection above proceeds as its own
implementation slice, verified and committed independently, not as one combined
change.

### 65.11 French voice-command and book-name support (found necessary mid-implementation)

**Confirmed explicitly with the user, restated for emphasis**: the app's primary
deployment target is a French-speaking church — French is not a secondary language
bolted onto an English-first design, a point already established for verse *display*
(section 63's bilingual/French work) but, until this subsection, never actually
carried through to voice *detection* and *navigation*.

**A real, pre-existing correctness gap, found and fixed here**: `RegexDetector`'s
`REFERENCE_PATTERN` (section 12) required the book-name capture group to consist of
plain ASCII letters (`[A-Z][A-Za-z]+`). A French book name that starts with an
accented capital — "Ésaïe", "Éphésiens" — was silently rejected outright, before
`normalizeBookName()` ever ran, because JS's `\b` word-boundary is defined in terms
of `\w` (`[A-Za-z0-9_]` only) and does not recognize an accented letter as a "word"
character at all. This meant a French sermon referencing any accented-book-name verse
would never be detected — a significant, silent gap for the app's actual primary
audience, not a cosmetic one. Fixed with Unicode letter properties (`\p{L}`/`\p{Lu}`,
requiring the `u` flag) and manual Unicode-aware boundary assertions
(`(?<![\p{L}\d])`/`(?![\p{L}\d])`) in place of `\b`, verified against both accented
and plain book names before shipping, not assumed correct from adding `u` alone.

**Separately, `normalizeBookName()` never translated a French book name to
`BOOK_CATALOG`'s canonical (English-based) id at all** — "Jean" normalized to "jean",
which matches nothing (`BOOK_CATALOG`'s id is "john"). Fixed with a
`FRENCH_BOOK_ALIASES` lookup table (all 66 books, accent-stripped keys) consulted
after normalization — no new dataset, `BOOK_CATALOG`'s ids/chapter-verse-counts are
completely unchanged, this only adds a second way to name the same 66 entries. Accent
handling uses Unicode NFD decomposition (`stripAccents()`), so ASR output that may or
may not preserve accents correctly still resolves to the same lookup key either way.

**`NavigationCommandDetector` (sections 61.3, 65.1, 65.4) gains French phrases
alongside every English one**, not as a separate follow-up: next/previous verse and
chapter, cancel/clear, the bare-continuation patterns, and the display-mode switch —
all in French, using the same fixed-synonym-list philosophy and the same
accent-tolerant normalization (utterance text is now accent-stripped before
whole-utterance/substring comparison, same reasoning as the book-name fix above).
`GOTO_CHAPTER_PATTERN`/`BARE_CHAPTER_VERSE_PATTERN`/`BARE_VERSE_PATTERN` all gained
the same Unicode-aware boundary fix as `REFERENCE_PATTERN`, plus "chapitre"/"verset"
as literal-word alternatives to "chapter"/"verse".

**A real French-language-specific bug caught and fixed before shipping**: the
first-drafted display-mode-switch phrases used a conjugated French verb ("passer à
l'anglais"), which only matches that exact infinitive form — a real spoken command
("passons en français", "mets en français", "passe en français") uses a *different*
conjugation each time and would never match a single hardcoded infinitive. Fixed by
choosing conjugation-independent phrasing ("en français"/"en anglais") that matches
regardless of which verb form is actually spoken — found via this feature's own test
suite (a test using a realistic imperative sentence failed against the
infinitive-only phrase), not assumed correct from writing plausible-looking French.

## 66. Phase 2 Feature Note — Canvas Scene Editor & Sidebar App Shell

A dedicated architecture note, following the same AGENTS.md section 56 checklist as
sections 60-65. Unlike every prior Phase 2 note, this one does not just add new scope
within previously-agreed boundaries — it explicitly **reverses** a boundary this
project stated twice before. That reversal is the whole reason this note exists as
its own section rather than an amendment tucked into section 64: AGENTS.md section 43
requires architecture changes to be explained and made deliberately, never silently.

### 66.1 What this feature is, and what it explicitly supersedes

Two paired but architecturally separate changes, both confirmed explicitly with the
user after being shown the real scope tradeoff (a thumbnail-reorder-grid mockup vs. a
full canvas-editor mockup):

1. **A sidebar-navigation app shell** for the operator dashboard
   (`apps/desktop/renderer/`) — Live / Rundown & Scenes / Media Library / Settings
   each become a full-screen view switched via a persistent sidebar, replacing
   today's single-page CSS grid where every card gets its own cramped internal
   scroll region. This part is presentation-only: no new contracts, no new server
   behavior, no new invariants — it introduces nothing this note needs to guard.
2. **A new `"canvas"` `RundownScene` kind** — a free-form scene an operator builds by
   positioning text, image, and background layers on a stage, with per-layer
   typography/color/size, additive to (never replacing) the existing four fixed-
   template kinds (`verse`, `media`, `announcement`, `blank`).

Part 2 directly reverses three explicit prior statements in this exact codebase, and
this note supersedes all three by name rather than quietly overwriting them:

- `packages/contracts/rundown.ts`'s own doc comment: *"Not a general slide/layout
  editor."*
- This document, section 64.1: *"not a general slide/layout editor; that would be a
  materially bigger feature nothing has asked for"* — and section 64.8's closing
  line: *"Scene kinds are verse, media, announcement (new, minimal), and blank — no
  general slide/layout editor."* (Section 64.1's own citation of "AGENTS.md section
  58" for this point was already a drifted reference by the time this note was
  written — AGENTS.md section 58 is "AI Agent Behavior"; the actual scope-discipline
  section is **AGENTS.md section 39**. Corrected here for the record.)
- AGENTS.md's original v1 scope lock (section 4), whose "Do NOT implement" list
  names `ProPresenter` explicitly. The later amendment to that list (recorded
  immediately below it) carved out `media library`, `songs`/`scenes`/`rundown`, and a
  broader `AI agent` copilot — it did **not** carve out ProPresenter-style editing.

These three statements are left in place in their original sections, not deleted —
they were correct decisions when written, for the scope that existed then. This
section records that the decision changed, and why, rather than erasing that a
different decision was ever made.

### 66.2 Resolved open questions

- **Canvas aspect ratio: one fixed 16:9 ratio, project-wide.** Not per-scene. Layer
  positions are stored as percentages of this one stage, so they mean the same thing
  in the dashboard editor, the live-preview, and the real overlay regardless of which
  scene is active. A per-scene ratio was considered and explicitly rejected for this
  phase — it would require the overlay to letterbox/pillarbox mismatched ratios
  against its actual OBS Browser Source window, a materially bigger rendering problem
  deferred, not solved, by this note.
- **Canvas layers are operator-authored only in this phase.** No layer's content is
  ever populated by live transcript detection or voice navigation — every layer's
  text/image/background is typed or picked directly in the editor. This is what lets
  this phase skip the hallucination-guard pipeline entirely for canvas content (see
  invariant 23) without inventing a new exception to it. Live-verse-bound text boxes
  are explicitly deferred (section 66.5).
- **Image and background assets reuse `MediaLibrary`** (`apps/server/media/`) — no
  new upload path, no new asset store. A canvas image/background layer references a
  `mediaCueId` exactly the way a `"media"` scene already does.
- **A canvas scene is paused/resumed by `RundownController` identically to every
  other kind.** `RundownController` (`apps/server/rundown/rundown-controller.ts`)
  never inspects `scene.kind` — it only tracks cursor position and a paused-cursor
  flag — so a 5th scene kind requires zero changes to it. The precedence rule from
  section 64.2 ("live detection always wins") applies to a canvas scene exactly as it
  does to a media or announcement scene today: an interrupting verse pauses it, and
  clearing that verse resumes exactly that canvas scene.
- **Text sizing is fixed at authoring time (`fontSizePx`), not auto-fit.** The
  overlay's existing verse card has a bespoke JS auto-shrink algorithm
  (`fitVerseText()` in `overlay.js`) because its content length is unpredictable
  (whatever the current verse's text happens to be). A canvas text layer's box size
  is chosen by the operator in the editor, so what they see there is exactly what
  ships — true WYSIWYG — rather than a second auto-fit algorithm silently resizing
  their layout at render time.
- **The editor is hand-written vanilla JS, not a canvas/interaction library.** The
  dashboard renderer has zero runtime dependencies today and a hand-authored CSP
  (`script-src 'self'`). The needed interactions — drag-move, resize via 8 handles,
  front/back z-order, snap-to-edge/center, keyboard nudge — are well within
  `PointerEvent` + CSS absolute positioning + `getBoundingClientRect()` for the small
  number of layers a scene actually has; this is not a general infinite-canvas,
  rotation, or vector-path editing problem. A third-party library would be the
  largest dependency surface in this renderer, several candidates render to
  `<canvas>` internally (which would break the "each layer is a real DOM node" the
  overlay renderer in section 66.4 depends on for its fonts/CSS to apply per layer),
  and most assume a bundler this project has deliberately never adopted (AGENTS.md
  sections 40-41). Consistent with `fitVerseText()`'s own precedent: hand-rolled,
  fully-understood UI logic over a library black box.

### 66.3 Data model

```ts
// packages/contracts/rundown.ts (extends the existing union — see section 66.1's
// note on why the file's original "not a general slide/layout editor" doc comment
// stays in place rather than being deleted)

export type CanvasLayerBase = {
  readonly id: string
  readonly x: number       // 0-100, left edge, % of the fixed 16:9 stage
  readonly y: number       // 0-100, top edge
  readonly width: number   // 0-100, % of stage width
  readonly height: number  // 0-100, % of stage height
  readonly zIndex: number
}

export type CanvasTextLayer = CanvasLayerBase & {
  readonly kind: "text"
  readonly text: string
  readonly fontFamily: "serif" | "sans" | "mono" // the 3 fonts already loaded overlay-wide
  readonly fontSizePx: number
  readonly color: string
  readonly align: "left" | "center" | "right"
}

export type CanvasImageLayer = CanvasLayerBase & {
  readonly kind: "image"
  readonly mediaCueId: string
  // Captured at authoring time (the editor already has the full MediaCue,
  // kind included, from the Media Library picker) so the overlay's
  // renderer knows whether to build an <img> or <video> element without a
  // second lookup or a fragile "try img, fall back to video" guess —
  // found necessary during Phase 3 implementation, not anticipated here
  // originally.
  readonly mediaKind: "image" | "video"
}

export type CanvasBackgroundLayer = CanvasLayerBase & {
  readonly kind: "background"
  readonly color: string | null
  readonly mediaCueId: string | null // mutually exclusive with color; validated at the WS boundary, section 66.4
  readonly mediaKind: "image" | "video" | null // null exactly when mediaCueId is null
}

export type CanvasLayer = CanvasTextLayer | CanvasImageLayer | CanvasBackgroundLayer

export type CanvasSceneData = { readonly layers: readonly CanvasLayer[] }

export type RundownScene =
  | { readonly kind: "verse"; readonly reference: VerseReference }
  | { readonly kind: "media"; readonly mediaCueId: string }
  | { readonly kind: "announcement"; readonly title: string; readonly body: string }
  | { readonly kind: "blank" }
  | { readonly kind: "canvas"; readonly canvas: CanvasSceneData } // new

/** Payload for the new "canvas:show" WS event. */
export type CanvasShowPayload = CanvasSceneData
```

No changes to `Verse`, `VerseShowPayload`, `MediaCue`, or `MediaShowPayload` — a
canvas layer references existing content types (a `mediaCueId`) rather than
duplicating their shape.

### 66.4 Server ownership and WS surface

- `RundownController`: **unchanged** (section 66.2).
- `apps/server/core/app-core.ts`'s `activateScene()` gains a `case "canvas":` that
  broadcasts the scene's `CanvasSceneData` directly via a new `broadcastCanvas()` —
  no `resolveVerse()`, no `KnownValidVerseIndex` involvement, per invariant 23. The
  existing `"blank"` branch gains a `canvas:clear` broadcast alongside its existing
  three, so a canvas scene never survives underneath a subsequent blank scene
  (invariant 24). `syncSceneContent()` (the late-join/reconnect-viewer path) gets the
  matching `case "canvas"` direct-send, and its own `"blank"` branch also sends
  `canvas:clear`.
- `apps/server/ws/action-registry.ts` gains two new server-only events,
  `canvas:show`/`canvas:clear`, registered with `allowedSenders: []` exactly like
  `announcement:show`/`announcement:clear` — no client role may ever send them
  inbound. A new `isCanvasShowPayload` validator checks every layer's `id` is a
  non-empty string, `x`/`y`/`width`/`height` are numbers in `[0, 100]`, `zIndex` is a
  number, and each layer's `kind`-specific required fields are present and correctly
  typed (mirroring `isAnnouncementShowPayload`'s existing structural-validation
  style).
- `apps/overlay/public/overlay.js` gains a generic layer renderer (`showCanvas()`) —
  the first content type in this app whose WS payload carries a whole list of
  positioned elements rather than one fixed-template's fields. It coexists with, and
  does not replace, the four existing fixed-position templates (`#verse`,
  `#media-layer`, `#announcement`, `#definition`).

### 66.5 What this note deliberately leaves open

Named explicitly here so their absence in the first implementation reads as a
decision, not an oversight:

- **Live-verse or voice-bound text boxes inside a canvas scene.** Would require a
  fourth `CanvasTextLayer` variant carrying a `VerseReference`, and a real decision on
  whether that reference must pass through `KnownValidVerseIndex` — the first time a
  canvas layer's content could originate from something other than direct operator
  authorship. Not decided here; invariant 23 explicitly scopes this note to
  operator-authored-only content.
- **Undo/redo** in the editor.
- **Advanced typography** — gradients, shadows, drop-shadow text, or any font beyond
  the three already loaded overlay-wide (Instrument Serif, Instrument Sans,
  JetBrains Mono). No custom font upload/loading.
- **An asset library beyond `MediaLibrary` reuse** — no new image/video upload path
  specific to the canvas editor.
- **Multi-select or grouping** of layers.
- **Alignment guides/snapping beyond snap-to-edge and snap-to-center** — no ruler
  overlay, no arbitrary-angle guides.
- **Canvas layer persistence across restarts.** Rundowns already do not persist
  across restarts (section 64.5's own open item) — unchanged by this note, but now
  applies to a larger, more effortful-to-recreate payload than a single
  `VerseReference` string.
- **A built-in "verse card" starting preset inside the canvas editor** (i.e., a
  button that drops in something styled like today's fixed verse card as a starting
  point, rather than authoring one from scratch with a text layer) — an
  implementation-time editor-UX decision, not an architectural one.

### 66.6 New correctness invariants this feature adds

Invariant 23
A canvas layer's content is operator-authored only in this phase — every layer's
text/image/background is typed or selected directly in the editor, never derived
from ASR transcript text or voice navigation. Any future feature that lets live
detection or voice commands populate a canvas layer's content must route that
content through the same `KnownValidVerseIndex`/`detectValidatedReferences` guard
every other transcript-derived reference already uses (invariant 5, invariant 17) —
never a third, unguarded path into the overlay.

Invariant 24
Ending a canvas scene — by moving to any other scene, including `"blank"` — always
broadcasts `canvas:clear` alongside whatever else that transition already clears,
mirroring invariant 22's "over-clearing is safe, under-clearing is not." A canvas
layer must never remain visible underneath a scene that replaced it.

### 66.7 Tests required

- `apps/server/ws/action-registry.test.ts`: `canvas:show`/`canvas:clear` accepted
  only as server-originated events (no client role may send either inbound);
  `isCanvasShowPayload` accepts a valid mixed-layer list and rejects out-of-range
  `x`/`y`/`width`/`height`, an unrecognized layer `kind`, and a layer missing its
  kind-specific required fields.
- `apps/server/core/app-core.test.ts`: activating a `"canvas"` scene broadcasts
  `rundown:state` followed by `canvas:show` with the exact layer list; activating a
  `"blank"` scene immediately after a canvas scene was active also broadcasts
  `canvas:clear` (the invariant 24 regression test); a viewer connecting while a
  canvas scene is active receives `canvas:show` via the direct-send resync path, not
  a broadcast.
- `apps/server/rundown/rundown-controller.test.ts`: a `"canvas"` scene round-trips
  through `load()`/`next()`/`previous()`/`goto()` exactly like every other kind — a
  cheap regression guard that widening the union to 5 members didn't silently break
  anything in a controller that is supposed to be completely content-agnostic.
- Headless-Chrome screenshot verification (this project's established method for
  every UI-facing change, used throughout sections 60-65): the sidebar app shell's
  four views at the new window size with no internal per-card scrollbars remaining;
  the overlay's generic layer renderer showing a mixed text/image/background layer
  set at correct positions and z-order, then correctly empty after both
  `canvas:clear` and a real Escape keypress; the dashboard canvas editor's drag,
  resize, z-order, and snap-to-edge behavior, plus a save-then-reopen round-trip of
  an authored scene.

**Implementation notes, found during Phase 4:**

A real, non-obvious bug caught by driving the editor with genuine CDP-level mouse
events (not synthetic `dispatchEvent()` calls, which don't establish a real active
pointer and so don't reliably exercise `setPointerCapture()`): `startLayerDrag()`/
`startLayerResize()` originally called `selectCanvasLayer()` unconditionally on
every pointerdown, including when the layer was already selected. `selectCanvasLayer()`
calls `renderCanvasStage()`, which clears and rebuilds the entire stage's DOM — so a
redundant re-selection destroyed the very `el`/`handleEl` the drag/resize handler was
about to call `setPointerCapture()` and attach `pointermove`/`pointerup` listeners to,
leaving them bound to an already-detached node that never receives the real browser
events sent to its freshly-created replacement. Fixed by only calling
`selectCanvasLayer()` when switching to a genuinely different layer (`startLayerDrag`),
and not calling it at all in `startLayerResize` (a resize handle only ever exists in
the DOM for the already-selected layer, so re-selecting there was always redundant).
This is the kind of bug that is invisible to synthetic-event-based testing and only
surfaces under real input — a caution for any future interactive-editor work in this
codebase.

Also found necessary during implementation: `CanvasImageLayer`/`CanvasBackgroundLayer`
needed a `mediaKind: "image" | "video"` field (section 66.3) so the overlay's renderer
knows which element type to build — not anticipated when the data model was first
drafted in Phase 2, surfaced only once Phase 3's renderer was actually written.

The editor's own stage renders image/background media layers as a labeled placeholder
box, not the real image/video pixels — `apps/desktop/renderer/` is loaded via `file://`
(`loadFile()`), not through the overlay's own StaticServer, so the same-origin
`/media/<id>` URL scheme the overlay uses to fetch real media doesn't resolve from the
dashboard's origin. Position, size, and z-order are still exactly WYSIWYG for every
layer kind (verified above); only the pixel content of image/background layers is a
placeholder in the editor's own preview. The real overlay renders the actual media
correctly (section 66.4/Phase 3). A future pass could add an IPC method to read a
media file as a `data:` URL for the editor's own preview, but that is a new capability
this note does not scope — recorded here as a known, deliberate simplification, not a
silent gap.

### 66.8 Confirms this is approved scope

Confirmed explicitly with the user, after being shown the real tradeoff directly (a
thumbnail-reorder-grid mockup vs. a full canvas-editor mockup, and a one-screen-but-
wider mockup vs. a sidebar-with-full-screen-views mockup): a sidebar-navigation app
shell (Live / Rundown & Scenes / Media Library / Settings) and a full WYSIWYG canvas
scene editor (drag-position, resize, z-order, per-layer typography/color) are both
approved scope, phased as independently shippable slices — app shell first, then the
canvas data model and server support, then the overlay's generic renderer, then the
editor UI itself. This explicitly supersedes `packages/contracts/rundown.ts`'s "not a
general slide/layout editor" doc comment, this document's own section 64.1 and
section 64.8 statements to the same effect, and AGENTS.md section 4's original
"Do NOT implement: ProPresenter" line — each is left in the record as the correct
decision for the scope that existed when written, not deleted, per section 66.1.
Live-verse-bound canvas content, undo/redo, and every other item in section 66.5
remain explicitly out of scope for this phase.

## 67. Phase 2 Feature Note — Principal Poster & Verse Auto-Clear

A dedicated architecture note, following the same AGENTS.md section 56 checklist as
sections 60-66. Sourced directly from a real described church workflow: a static
"Sunday service poster" image stays on screen for the whole service by default;
when a verse is spoken it briefly overlays, then automatically clears on its own
after a fixed delay, revealing the poster again — no operator action needed to
either show or hide it.

### 67.1 What this feature is

Two small, tightly-coupled additions:

1. **Principal poster** — one operator-designated image `MediaCue`, held as a new
   persistent background layer, always visible whenever nothing else is actively
   covering it. Restricted to `kind: "image"` — a poster is a static graphic, not a
   video or audio cue; `MediaCue.kind` already exists, so this is a validation rule,
   not a new type.
2. **Verse auto-clear** — while a principal poster is active, any verse that shows
   (regardless of trigger — detected, override, navigation, or a rundown verse
   scene) automatically clears itself after a fixed 2-minute delay, exactly as if
   the operator had sent `verse:clear` themselves. Without a principal poster
   configured, verse behavior is completely unchanged from today (stays until
   explicitly cleared) — this is additive, not a change to existing behavior for
   churches not using this feature.

**Amendment, confirmed with the user**: a poster is voice-triggerable by name, not
only settable from the dashboard — this reuses the exact mechanism `MediaCueDetector`
(section 60.3) already provides for every media cue: each `MediaCue.title` is already
a unique, operator-assigned voice-trigger phrase. Appointing a cue as a poster (via
`poster:set`, whether sent from the dashboard's picker or triggered internally the
same way) marks its id in a session-lifetime `posterCueIds` set; from then on, when
`MediaCueDetector.detect()` matches that cue's title in a transcript, `AppCore` routes
it to `broadcastPoster()` instead of the normal `media:show` path. A cue is either a
poster or a regular voice-triggered media cue for the rest of the session, never
both — this is the general design principle this whole app already follows (per the
user's own restated intent): **content reaches the overlay by voice command as the
default and expected path, not a special case; a manual dashboard action is the
exception, for when voice isn't practical or available.** This is not a new
mechanism bolted onto posters specifically — it is the poster feature correctly
plugging into infrastructure that already existed for exactly this reason.

### 67.2 Resolved decisions

- **Fits the existing z-index stack without changing it.** The overlay already
  layers content by z-index: media (1) below verse/announcement/definition (2)
  below canvas (3). The poster becomes a NEW base layer at z-index 0 — strictly
  below everything else — so it needs no pause/resume logic of its own (unlike a
  rundown scene): it is simply always rendered, and other content visually covers
  it (opaquely, for a full-frame media cue; partially, for a verse card, which
  reveals the poster around its edges exactly as the church's own described
  workflow wants). Clearing whatever was covering it doesn't need to "restore" the
  poster — it was never hidden, only obscured.
- **Auto-clear duration is a fixed 2 minutes for this phase, not a dashboard
  setting.** Matches the literal request; a configurable duration is a small,
  clearly-separable addition if asked for later (AGENTS.md section 39 — don't build
  what nothing has asked for yet).
- **Not persisted across restarts.** Held in-memory in `AppCore`, the same
  documented gap rundowns already have (section 64.5) — a fresh app launch starts
  with no principal poster until the operator picks one again. Cheap to add
  `ConfigStore` persistence later if this proves annoying in practice.
- **Auto-clear reuses `broadcastVerseClear()` exactly**, not a bespoke clear path —
  so a verse auto-clearing while a rundown scene is paused underneath it resumes
  that scene correctly, identically to a manual clear (section 64.2's existing
  precedence rules are completely unaffected).
- **The timer resets on every new verse**, the same "most recent wins" pattern
  `definitionClearTimer` (section 65.5) already established — showing a second
  verse 30 seconds after the first restarts the 2-minute countdown from the new
  verse, rather than clearing early on the first verse's original schedule.
- **Escape (the local emergency clear, section 35) does NOT clear the poster —
  reconsidered from an earlier draft of this note.** The poster's entire purpose is
  to be the stable, known-safe backdrop everything else temporarily overlays; Escape
  exists for "something wrong is on screen, make it stop now." Wiping the poster too
  would replace a known-safe image with plain black at exactly the moment a stable
  screen matters most. Escape clears verse/media/announcement/definition/canvas —
  every *temporary* content type — and leaves the poster exactly where section 67.1
  already says it belongs: always there unless something else is deliberately
  covering it.

### 67.3 Data model and WS surface

```ts
// packages/contracts/media.ts (new)
export type PosterShowPayload = { readonly cue: MediaCue } // cue.kind is always "image", enforced at the WS boundary, not re-typed here
```

New WS types (`packages/contracts/ws.ts`): commands `poster:set { mediaCueId: string }`
and `poster:clear` (also broadcast as an event — the same dual command/event reuse
`verse:clear`/`media:clear` already use); event `poster:show { cue: MediaCue }`.

`apps/server/ws/action-registry.ts`: `poster:set` (operator-only, validates a
non-empty `mediaCueId`), `poster:clear` (operator-sendable command, `null` payload,
also server-broadcast), `poster:show` (server-only event, reuses the existing
`isMediaCuePayload` validator for its `cue` field).

`apps/server/core/app-core.ts`: new in-memory `principalPosterCueId: string | null`
and `posterCueIds: Set<string>` (the amendment above — every cue ever appointed via
`poster:set` stays in this set for the rest of the session, making its title
voice-triggerable as a poster from then on). `poster:set` resolves the id via
`mediaLibrary`, rejects (logs, no broadcast) if not found or not `kind: "image"`; on
success, adds the id to `posterCueIds`, sets `principalPosterCueId`, and broadcasts
`poster:show`. The existing voice-triggered-media block (section 60.3, where
`mediaCueDetector.detect()` already runs per transcript) checks `posterCueIds.has(cue.id)`
first — a match routes to the same poster-show logic instead of the normal
`broadcastMedia()` call. `poster:clear` clears `principalPosterCueId` only (not
`posterCueIds` — the appointment persists so the poster can be voice-triggered back
later) and broadcasts `poster:clear`. `onViewerConnected` sends `poster:show`
to a newly-connecting viewer if a poster is currently active — the same late-join
sync every other persistent content type already gets. `showVerse()` — the one
function every verse trigger already funnels through (section 65.8's own reasoning
for why `SessionRecorder` hooks in there) — starts/resets a `verseAutoClearTimer`
whenever `principalPosterCueId` is non-null, firing `broadcastVerseClear()` after
120000ms (2 minutes). No principal poster configured means no timer is ever
started — zero behavior change for existing installs.

`apps/overlay/public/`: a new `#poster-layer` at z-index 0 (below `#media-layer`'s
z-index 1), a plain full-frame `<img>`, shown/cleared by `poster:show`/`poster:clear`.
Escape also calls `clearPoster()`.

`apps/desktop/renderer/`: a new "Principal Poster" card in the Settings view — a
dropdown of imported image cues (reusing the existing Media Library list, filtered
to `kind === "image"`, the same filtering `renderRundownMediaOptions()` already does
for canvas image/background layers) plus "Set" and "Clear" buttons.

### 67.4 New correctness invariants this feature adds

Invariant 25
A verse auto-clear timer only ever fires while a principal poster is configured,
and always resets (not queues) on every new verse shown — never clears a verse that
has already been replaced or cleared by any other means. A manual `verse:clear`,
navigation, or scene transition cancels any pending auto-clear timer, so it can
never fire against stale state.

Invariant 26
The principal poster layer never participates in the hallucination-guard pipeline
and never itself triggers a broadcast beyond `poster:show`/`poster:clear` — it is
purely a persistent visual backdrop, with no interaction with verse detection,
navigation, or the rundown state machine beyond the two both already rely on
(`MediaLibrary.resolve()`, `broadcastVerseClear()`).

### 67.5 Tests required

- `apps/server/ws/action-registry.test.ts`: `poster:set`/`poster:clear`/`poster:show`
  role boundaries and payload validation (a non-image `mediaCueId` is a business-
  logic rejection at the `AppCore` layer, not a schema-validation one — the schema
  only requires a non-empty string id).
- `apps/server/core/app-core.test.ts`: setting a poster broadcasts `poster:show`;
  setting an unknown or non-image id broadcasts nothing and logs; clearing broadcasts
  `poster:clear`; a viewer connecting while a poster is active is synced; showing a
  verse while a poster is active auto-clears after the configured delay (tests use a
  short override, the same pattern `definitionClearMs` already supports); a second
  verse shown before the first's timer fires resets the countdown rather than
  clearing early; a manual `verse:clear` before the timer fires prevents the
  scheduled auto-clear from firing at all (no double-broadcast); showing a verse with
  no poster configured never starts a timer (regression guard for existing
  installs).

### 67.6 Confirms this is approved scope

A principal poster (image-only, in-memory, one at a time) as a new base overlay
layer, and a 2-minute verse auto-clear tied exclusively to having one configured,
reusing the existing z-index stack and `broadcastVerseClear()` path rather than
inventing new precedence rules. A configurable auto-clear duration and cross-restart
persistence are both explicitly left open, not assumed here, per section 67.2.

## 68. Production Audit — Real Bugs Found and Fixed

Everything built through section 67 had been verified with real unit/integration
tests and headless-Chrome screenshots, but never run end-to-end as a real user would:
a real microphone, a real restart, a real OBS instance. The first real usage session
surfaced three genuine production bugs that no amount of mocked-input testing would
have caught — recorded here per this project's own "verify, don't assume" discipline,
so the record shows these were found and fixed deliberately, not silently patched.

### 68.1 MediaLibrary had no persistence at all

`apps/server/media/media-library.ts` held every imported cue's metadata in a plain
in-memory `Map` — `import()` correctly copied the actual file to disk, but the
`{id, kind, title}` record pointing to it lived only in RAM. Every app restart
silently lost every previously-imported media cue, even though the underlying files
were still sitting untouched in the media directory. A stale `media-library.json`
already existed in the userData folder from an entirely different, older prototype
schema (fields like `triggerPhrases`/`transitionStyle`/`isDefault` that match nothing
in the current `MediaCue` contract) — confusingly present on disk, but never read by
any current code, which made this bug easy to miss by inspection alone (it looks like
persistence exists, from a directory listing) and harder to reproduce without
actually restarting a real running instance.

**Fixed**: `MediaLibrary` now persists a `media-cues.json` file (deliberately a new,
distinct name from the stale prototype file, to avoid any future confusion between
the two) inside its own `mediaDir`, using the exact same atomic-write discipline
`ConfigStore` already established (temp file + fsync + rename). A new `load()`
method, called once at startup in `apps/desktop/main/index.ts` right after
construction — mirroring `ConfigStore.load()`'s own explicit call site — reads it
back in. A missing or corrupt metadata file is not a startup failure (same
recoverable-over-blocking philosophy as `ConfigStore`'s own corruption handling):
the operator can always re-import.

### 68.2 The silence gate's default threshold was untested against real hardware

`apps/server/audio/silence-gate.ts`'s own doc comment already admitted this: the
default RMS threshold (500) was "a conservative v1 placeholder... no real
microphone/hardware has been exercised yet." Measuring against a real microphone
confirmed the risk was real, not theoretical: ambient room noise alone (no one
speaking) averaged ~1100 RMS, but with enough variance that roughly half of
individual frames still measured under 500 — meaning normal speech from a quieter
speaker, a quieter room, or a less sensitive microphone could plausibly fall under
the threshold and be silently discarded before ever reaching Groq. From an operator's
seat, a silently-discarded frame is indistinguishable from "the microphone doesn't
work."

**Fixed**: lowered the default to 150, biasing toward forwarding borderline audio.
The cost of a false positive (an occasional wasted Groq call on genuine silence,
returning empty/irrelevant text `resolveTranscriptVerses` simply finds no verse in)
is negligible; the cost of a false negative (real speech silently discarded) is total
pipeline failure from the operator's point of view. Still not a scientifically final
value — see 68.3 below for what actually closes that gap.

### 68.3 No way to observe whether the microphone was actually registering anything

`apps/desktop/renderer/index.html`'s mic-visual bars (`#mic-visual .mic-bar`) played a
canned CSS `@keyframes` bounce animation whenever `.active` was set — unconditionally,
regardless of whether the silence gate was forwarding real audio or rejecting silence
every single frame. An operator had no way to visually distinguish "my voice is
registering, nobody's spoken a verse yet" from "the gate is silently rejecting
everything I say" — both looked identical.

**Fixed**: the bars are now a real, live level meter. `dashboard.js` computes the RMS
of each captured frame on the exact same Int16 scale `SilenceGate` evaluates against
(`computeRmsInt16()`, deliberately duplicating `silence-gate.ts`'s own `computeRms()`
formula — the established no-build-step duplication precedent, e.g.
`float32ToInt16()` elsewhere in this same file), and drives each bar's height directly
from it with peak-hold-and-decay smoothing. This doesn't just fix the mic — it makes
the *next* audio-related bug like 68.2 self-diagnosable from the dashboard alone,
without needing to read server logs or measure hardware externally.

### 68.4 No way to actually connect a real OBS instance to the app

The overlay's HTTP URL (`http://127.0.0.1:<port>/index.html?token=<viewerToken>&wsPort=<wsPort>`)
already existed and was already correct — `apps/desktop/main/index.ts`'s
`createOverlayWindow()` uses this exact URL for the in-app local preview window. It
was never surfaced anywhere in the dashboard for the operator to copy into a real
OBS Browser Source, though. Short of reading this project's own source code to find
the hardcoded port and manually reconstructing the token-bearing URL, there was no
way for an operator to connect real OBS to this app at all.

**Fixed**: a new "OBS Overlay" card in the Settings view (mirroring the existing
Phone Remote panel's exact copyable-URL-plus-Copy-button pattern) shows this URL with
a one-line instruction ("Sources → + → Browser Source → URL"). `startServices()`
returns it alongside the existing `remoteUrl`/`allowPhoneRemote` fields, and
`get-startup-status` exposes it the same way, so it's populated identically on first
launch and on every subsequent app start.

### 68.5 Tests added

- `apps/server/media/media-library.test.ts`: a cue imported by one `MediaLibrary`
  instance is visible to a fresh instance after `load()` (the restart-survival
  regression test); `load()` with no metadata file yet or a corrupt one does not
  throw; multiple imports across simulated restarts all survive, not just the most
  recent one.
- `apps/server/audio/silence-gate.test.ts`: the default threshold now forwards a
  moderate-volume frame that the old (500) default would have rejected — pins the
  lowered value so a future change can't silently re-tighten it.

No new test coverage was written for 68.3/68.4 (client-side visual/UX fixes verified
by direct interaction with a real running instance, not unit-testable in isolation)
— consistent with this project's existing convention of headless-Chrome/live-instance
verification for renderer-only changes.

## 69. Combined Overlay Preview — the In-App Preview Window Is Gone

Live-testing turned up a UX complaint the audit above didn't cover: `createOverlayWindow()`
(section 6.3) opened the overlay preview as a *second*, separate OS window alongside the
main dashboard. Live use showed this was simply unwanted — a second window to manage,
easy to close accidentally, and disconnected from the dashboard it's meant to accompany.
Separately, the Live view's own "LIVE PREVIEW" panel was never a real preview at all: it
was a hand-rolled re-implementation covering only verse and announcement text
(`showLiveVerse`/`showLiveAnnouncement` in `dashboard.js`), and had already silently
drifted out of sync with reality — it had no rendering at all for media, posters, or
canvas scenes, all added in later sections.

**Fixed**: `createOverlayWindow()` and the separate `overlayWindow` `BrowserWindow` are
removed entirely. The Live view's preview panel now embeds the real overlay page — the
exact same page StaticServer serves to OBS — in a sandboxed `<iframe>`
(`#overlay-preview-frame`), pointed at the same `overlayUrl` the OBS settings card
already showed (section 68.4). This is not a second implementation to keep in sync: the
iframe opens its own independent WS connection (as a `viewer`, via the URL's own
token/wsPort query params, exactly like a real OBS Browser Source would) and renders
through the actual `overlay.js`, so it can never drift from what the audience sees.
`dashboard.js`'s CSP gained `frame-src http://127.0.0.1:*` to allow it — loopback-only,
the same trust boundary the WS connection already uses.

The now-redundant mimic functions (`showLiveVerse`'s DOM manipulation, `clearLiveVerse`,
`showLiveAnnouncement`) were removed along with their backing `#live-verse-*` elements.
`showLiveVerse()` keeps exactly one real side effect — clearing a pending-confirmation
prompt a real `verse:show` always supersedes — everything else is now the iframe's job.
The pending-verse-confirmation banner (an operator *action* prompt, not a preview of
overlay state) is unaffected and stays in the Live view alongside the embedded frame.

## 70. Transcription Visibility & Latency Budget

A second live-testing finding, more serious than 69: the operator dashboard had **no
way to see what the ASR actually transcribed, ever**, for any real (non-partial)
transcript. `AppCore`'s `asr.onTranscript()` handler (wired in `startAppCore()`) fed
every transcript into verse detection, media/glossary/navigation matching, and sermon
notes — but never broadcast the transcript's own text to any client. The WS contract's
only transcript event, `transcript:partial`, was validated (`isTranscriptPartialPayload`
in `action-registry.ts`) to strictly require `state === "partial"` — and `GroqProvider`,
v1's only `AsrProvider`, documents that it **never** emits `state: "partial"` at all
(Groq's transcription API is a batch endpoint with no interim-result concept). The two
facts combined meant this channel was dead code by construction: nothing could ever
legally flow through it. From the operator's seat, the mic level meter (section 68.3)
moved with real speech, but the last-transcript field never updated for anything except
a verse actually being detected — no way to judge transcription accuracy, or how long
it was taking.

**Fixed**: added `transcript:final` as a proper, distinct WS event
(`isTranscriptFinalPayload`, mirroring `isTranscriptPartialPayload` but requiring
`state === "final"`) — the honest counterpart for what `GroqProvider` actually produces,
rather than relaxing `transcript:partial`'s validator to accept a mislabeled final
result. `asr.onTranscript()` now broadcasts every transcript (`transcript:partial` or
`transcript:final`, branching on `transcript.state`) as the *first* thing it does, before
any of the async verse-resolution work — the fastest possible signal back to the
operator, not something waiting behind it. `dashboard.js` merges both event types into
one handler updating the "Last transcript" field, and `verse:show` no longer overwrites
that field with verse text (a pre-existing conflation) — it now always reflects the raw
ASR output, matching what its own label says.

**Latency budget, confirmed with the user**: speech-to-overlay must stay under 5 seconds
end to end, ideally less. `GroqProvider` buffers audio and flushes a chunk to Groq's
batch endpoint once `chunkDurationMs` has accumulated (`groq-provider.ts`) — this
buffering delay is the single largest, most controllable component of the budget; Groq's
own inference on a short clip is typically well under a second, and everything after a
transcript arrives (verse resolution, WS broadcast, overlay render) is near-instant.
`DEFAULT_CHUNK_DURATION_MS` is lowered from 4000ms to 2000ms — worst-case buffering plus
a real API round trip now lands comfortably under the 5s ceiling with margin, while still
giving Whisper enough audio context to transcribe short phrases (a spoken verse
reference or cue title) accurately. Going shorter was considered and rejected: it
multiplies API call volume for no latency win once network/inference time dominates
anyway, and risks truncating words at chunk boundaries.

### 70.1 Tests added

`apps/server/ws/action-registry.test.ts`: `transcript:final`'s validator accepts a real
final transcript and rejects one mislabeled as partial (or otherwise malformed); the
fixed-set registry-keys test includes it; a role-boundary test confirms no inbound
sender (operator or viewer) may send it, matching every other server-only event.
`groq-provider.test.ts`'s existing tests were unaffected — they already pass
`chunkDurationMs` explicitly rather than relying on the default.

## 71. Sermon Notes Default Model — Account-Tier Access, Not a Wrong Model ID

Live testing with the transcription pipeline now visibly working (section 70) surfaced
a real, repeating failure once sermon notes tried to summarize: `sermon-notes.summarize-
failed` — `"The model llama-3.3-70b-versatile does not exist or you do not have access
to it."` Checked directly against Groq's own current model documentation before
concluding anything (this project's standing "verify, don't assume" discipline for
external APIs): `llama-3.3-70b-versatile` **is** still listed as a current production
model there. That rules out a stale/deprecated model id as the cause — the far more
likely explanation is Groq gating access to its larger models by API key/account tier,
which this specific key doesn't clear, while smaller production models are typically
available regardless of tier.

**Fixed**: `SermonNotesGenerator`'s default model changes from `llama-3.3-70b-versatile`
to `llama-3.1-8b-instant` — the smallest current production Llama model on Groq, so far
more likely to be usable on any key, and comfortably capable for a 3-5 bullet-point
summarization task that never needed a 70B model's capacity. `model` was already a
constructor option (`main/index.ts` was just never passing one, always taking the
default); no other wiring changes. This is an account-entitlement issue on Groq's side,
not something a code change can fully guarantee fixed for every possible key — if
`llama-3.1-8b-instant` also fails with the same "no access" error for a given key, that
points at the Groq account itself (billing/verification status), worth checking directly
on Groq's console, rather than at this app.

No test pinned the old default model string (`sermon-notes-generator.test.ts` only
asserts `typeof body.model === "string"`), so this change needed no test updates.

## 72. Detection Robustness & Bilingual Reference Display

Three more findings from the same live-testing session, all pointing at the same
theme: recognition was too brittle against how people actually speak and how ASR
actually transcribes, and the overlay's reference line didn't match its own bilingual
promise.

### 72.1 Real book names transcribed lowercase were silently missed

`RegexDetector`'s pattern required the book-name group to start with an uppercase
letter (`\p{Lu}`), relying entirely on Whisper capitalizing spoken book names
correctly. Several real books double as ordinary words in both languages ("Job",
"Acts", "Mark", "Numbers", "Actes") and are routinely transcribed lowercase
mid-sentence — the reference was lost silently, with no error, indistinguishable from
never having been detected.

**Fixed**: relaxed the book-name group to `\p{L}` (any letter, either case). This does
not reopen the "detector doesn't know which book names are real" boundary
(ARCHITECTURE.md sections 12.2/14/15) — existence validation stays entirely
`KnownValidVerseIndex`'s job downstream. A small, fixed `STOPWORDS` set (common short
English/French function words — "at", "the", "le", "de", ...) prevents this relaxation
from resurrecting the "the meeting starts at 3:16 today" false-candidate case the
capitalization requirement used to filter out as a side effect; this is a generic
function-word list, not book-catalog knowledge.

### 72.2 French "next verse"/"next chapter" only covered one word order

`NavigationCommandDetector`'s French phrases only covered "X suivant" (noun-first —
"verset suivant"). French equally naturally allows "prochain X" (adjective-first — "le
prochain verset"), which produced no command at all. **Fixed**: added "prochain
verset"/"prochain chapitre" alongside the existing "suivant" phrases.

### 72.3 The overlay's reference line ignored bilingual mode entirely

In bilingual display mode the verse text correctly shows French (primary) with English
underneath (secondary, via `LocalizedVerseSource`) — but the reference line
(`#verse-reference`) always showed only the canonical English book name regardless of
mode, e.g. a French primary verse under the label "John 3:5". A viewer confirmed this
reads as a mismatch/bug, not a deliberate choice.

**Fixed**: a new `FRENCH_BOOK_NAMES` table (canonical English id -> proper French name,
with accents/capitalization restored — deliberately separate from
`FRENCH_BOOK_ALIASES` in `regex-detector.ts`, which strips accents for matching and
isn't fit for display) is duplicated into `overlay.js` and `dashboard.js` (the
established no-build-step "duplicated, not shared" precedent). `verse.secondary`'s
presence is the same signal `LocalizedVerseSource` already uses for "bilingual mode is
active" — when present, the reference line shows both names ("Jean 3:5 · John 3:5",
French first to match the primary/secondary text hierarchy); otherwise unchanged.
Applied to both the overlay's `showVerse()` and the dashboard's pending-verse-
confirmation banner (`showPendingVerse()`), the same `Verse` shape in both places.

### 72.4 Tests added

`regex-detector.test.ts`: a lowercase real book name ("job 3:16", "acts 3:16") is now
detected; the existing "at 3:16" false-candidate test is retitled to reflect that
STOPWORDS, not capitalization, is now what excludes it.
`navigation-command-detector.test.ts`: "prochain verset"/"prochain chapitre" trigger
the same commands as their "suivant" counterparts.
No test coverage for 72.3 (client-side rendering, verified by reading the two
duplicated tables against each other and against `BOOK_CATALOG`'s id list directly) —
consistent with this project's convention for renderer-only display changes.

## 73. Hallucinated-Language Transcripts & Activity Log Layout

Two more live-testing findings once the transcript pipeline became visible (section 70)
made these two failure modes visible for the first time — neither is new, both were
simply invisible before.

### 73.1 Whisper occasionally hallucinates fluent text in an unspoken language

Confirmed directly: fed unclear or ambient audio, Groq's Whisper endpoint sometimes
returns fluent-looking text in a language nobody actually spoke (Chinese, in the
reported case) rather than empty or garbled output — a known category of Whisper
failure, not something specific to this app's audio pipeline. This app's confirmed
audience is French/English only. Whisper's `language` parameter can't express "either
of these two, never anything else" (it accepts exactly one hint per request), and
hard-coding either language would degrade accuracy for genuine speech in the other —
not an acceptable tradeoff for a bilingual church.

**Fixed**: French and English are both written entirely in Latin script, so any
non-Latin-script character in a returned transcript is unambiguous noise, never a
legitimate result in either supported language. `GroqProvider.flush()` now checks the
transcribed text against `NON_LATIN_SCRIPT_PATTERN` (CJK, Japanese kana, Hangul,
Cyrillic, Arabic, Hebrew, Thai, Devanagari) before emitting anything — a single matching
character drops the whole chunk. This is not treated as an ASR error (`onError` is not
called): from the operator's perspective it's indistinguishable from a quiet moment
producing nothing, which is the correct framing, not a failure to surface.

### 73.2 The Activity log had no bounded height, so it grew the whole page

`dashboard.js`'s `log()` already capped retained entries at 50 and `#log` already had
`overflow-y: auto` — but the Live view's grid rows below the embedded preview are
`auto`-height, so nothing was ever actually constraining `#log`'s height for that
`overflow` to apply against. A growing log just made its card, and the whole page,
taller — confirmed materially worse once every transcript started being echoed here too
(section 70's fix), which multiplied how often new lines arrived while speaking.

**Fixed**: `#log` gets an explicit `max-height` (~5 lines) independent of the
surrounding grid, so it scrolls internally regardless of the grid's own sizing. Nothing
about retention changed — all 50 entries are still there, a scroll away, not discarded.

### 73.3 Tests added

`groq-provider.test.ts`: a transcript that's entirely non-Latin script is dropped with
neither `onTranscript` nor `onError` firing; a transcript mixing real French/English
text with even one stray non-Latin character is also dropped whole (not partially
cleaned), confirming the deliberately conservative "any match rejects the chunk" rule.
No test coverage for 73.2 (CSS-only layout fix) — consistent with this project's
convention for renderer-only display changes.

### 73.4 Reported but not independently reproducible: a spoken reference that didn't show

Also reported in the same session: a spoken Bible reference that didn't appear on the
overlay. Without the exact transcript text, root cause couldn't be confirmed directly —
but two fixes landed in this same batch that directly address the two most likely
causes: 72.1 (a lowercase-transcribed book name being silently unmatched) and 73.1 (the
chunk containing that reference being entirely discarded as a hallucinated-language
false positive, if Whisper mis-transcribed part of it into another script). If a
reference is still missed after this, that points at a third, not-yet-identified cause
worth capturing with the exact transcript text next time.

## 74. Production Audit (commit dfb6261) — Media Library Findings

A follow-up audit against commit dfb6261 found the media grid itself hadn't been
exercised with real content — every prior test/screenshot used tiny placeholder files.

### 74.1 The media grid never showed the actual imported content

`renderMediaGrid()` in `dashboard.js` rendered `mediaIconSvg(cue.kind)` for every tile —
the same generic per-kind icon regardless of what was actually imported. Two identical-
looking image tiles were indistinguishable without opening them; an operator managing a
real library (product photos, slide variants, service posters) had no visual way to
tell them apart at a glance.

**Fixed**: image cues render a real `<img src="<origin>/media/<id>">`; video cues
render a real `<video preload="metadata">` (its first frame, no autoplay); audio keeps
the icon (no meaningful still frame exists for it). The dashboard is loaded via
`file://` (`main/index.ts`'s `loadFile()`) — a different origin from the static server
that actually serves `/media/<id>` — so a bare relative path would silently fail; the
origin is derived from the same `overlayUrl` the OBS settings panel and embedded
preview iframe already use (`setMediaOrigin()`), never a second guess at the port.

**A second, related bug found only by actually loading a real image**: the CSP's
`default-src 'none'` had no `img-src`/`media-src` override, so every thumbnail was
silently blocked — not a broken-image icon, a permanently blank tile that looked like a
dark placeholder rather than an error. Confirmed by checking `naturalWidth`/`naturalHeight`
directly (both 0 despite `img.complete === true`, the signature of a failed load) before
concluding the feature worked. Fixed by adding `img-src 'self' http://127.0.0.1:*;
media-src http://127.0.0.1:*` to the CSP, loopback-only like every other origin
allowance in this file.

Tile size (`.media-grid`'s `minmax(92px, 1fr)`) was also bumped to `minmax(180px, 1fr)`
— a real thumbnail is only worth showing if it's actually recognizable at a glance.

No new automated test: this is a renderer-only visual change, verified live (CDP
screenshot + `naturalWidth` check against a real imported image) rather than unit-
tested, consistent with this project's established convention for renderer-only
display changes (68.3/68.4/72.3/73.2).

### 74.2 No way to fix a media import mistake — title at import, or after the fact

Two related gaps, both centered on the same problem: a cue's title is also its voice-
trigger phrase (section 60.3), so getting it wrong is not cosmetic — it changes what
speaking that phrase does.

`deriveTitleFromFilename()` silently became a cue's permanent title with no
confirmation step at all — an operator importing "IMG_4821.jpg" got exactly that as
its voice trigger, with no chance to review or edit it before the file was copied in.
**Fixed**: `import-media-file` now only picks the file and returns a suggested title;
a new renderer-side confirm/edit dialog (no native alternative exists with an editable
text field) shows it, pre-filled but editable, before `confirm-media-import` completes
the actual copy. The operator's original filesystem path is still never sent to the
renderer at any point (section 60.4's boundary, unchanged) — the main process holds it
in `pendingMediaImport` between the two steps.

Separately, an operator who noticed a title mistake **after** import — or imported the
wrong file entirely — had no fix short of restarting the app and hoping the mistake
didn't survive in the persisted metadata. **Fixed**: `MediaLibrary` gained
`rename()`/`remove()` (same duplicate-title/empty-title rules as `import()` — a rename
is the same cue with a different title, not a weaker case); the dashboard exposes both
as always-visible per-tile buttons (a pencil and a trash icon, mirroring the existing
always-visible poster-pin convention rather than hiding them behind hover). Renaming
reuses the same confirm/edit dialog import uses, just pre-filled with the current title
instead of a filename-derived suggestion. Deleting asks for confirmation first (a real,
irreversible file removal) and — if the cue being deleted is the current principal
poster or the cue currently on screen — proactively sends `poster:clear`/`media:clear`
first, so removing a live cue can never leave a dangling reference on the overlay.

A confirmed, unrelated platform-dependence bug was fixed alongside this:
`media-import.ts` imported `basename`/`extname` from the platform-dependent `node:path`
rather than explicitly `node:path/win32`, even though this app only ever receives
Windows-shaped paths from Electron's native dialog (its only supported OS). Verified
directly rather than assumed: on this actual Windows runtime the existing full-path
test already passed, since Node's `node:path` auto-selects `win32` behavior when
`process.platform === "win32"` — so this was hardened for correctness independent of
the host platform, not a regression fix for an currently-observed failure.

Tests added: `media-library.test.ts` covers `rename()` (persists across a restart,
rejects an empty title or a collision with a *different* cue, allows a no-op rename to
the cue's own current title, throws for an unknown id) and `remove()` (deletes both the
metadata and the actual file from disk, persists across a restart, is a safe no-op for
an unknown id). `media-import.test.ts`'s existing full-Windows-path test needed no
changes — it already covered this exact scenario.

### 74.3 A verse resolution failure was silently invisible, and a verse-resync gap was found and fixed

Two related findings while investigating "a spoken reference sometimes doesn't appear
on the overlay."

**Diagnosability first**: `resolve-verse.ts`'s negative-cache short-circuit
(`if (cache.isNegativelyCached(...)) return null`) had no log at all, unlike the
`circuit-open` case immediately below it. A reference that failed once (a transient
network hiccup against the bilingual API, section 63) is silently suppressed for every
repeat within `DEFAULT_NEGATIVE_TTL_MS` (5 minutes) — even though the detection itself
was already logged upstream in `processTranscript`, making this indistinguishable from
"never detected at all" without a log at the exact point the suppression happens.
**Fixed**: logs `component: "verse-resolver", event: "suppressed-negative-cache"` with
the reference and remaining suppression time, at the same `warn` level as `circuit-open`.
Getting the remaining time required a small addition to the cache layers themselves:
`LruTtlCache.getRemainingTtlMs()` (read-only — does not touch LRU recency, unlike `get()`)
and `VerseCache.negativeCacheRemainingMs()`, both using the cache's own injected clock
so the value stays correct under a test-injected clock too.

**A real, structural resync gap, found while checking that hypothesis**: `onViewerConnected`
only ever resynced `lastShownVerse` to a reconnecting viewer inside the
`rundownState.interrupted` branch. If no rundown was loaded at all — the common case for
a live service using only voice-detected/manually-overridden verses, no rundown feature
in use — a verse currently showing was **never** resynced to a reconnecting viewer, full
stop. Combined with the bounded exponential-backoff WS reconnect (commit 362e51d,
section 48), a dropped OBS/overlay connection reconnecting while a verse was showing
would silently never see it again until the next detection — a concrete, previously-
unfixed explanation for an intermittently "missing" verse that genuinely had been
detected. **Fixed**: added an `else if (lastShownVerse)` branch alongside the existing
rundown-state check, firing only when no rundown is active (the rundown-verse-scene and
rundown-interrupt cases were already correctly handled and are unaffected — no duplicate
sync introduced for either).

Tests added: `lru-ttl-cache.test.ts` (`getRemainingTtlMs()` reports correctly against
an injected clock, returns undefined for a missing/expired key, and is confirmed
read-only with respect to LRU eviction order); `verse-cache.test.ts`
(`negativeCacheRemainingMs()` end to end, including that a fresh positive result clears
it); `resolve-verse.test.ts` (the suppression log fires with the right fields on a
second lookup, and — unchanged — the first, fresh "not found" still logs nothing);
`app-core.test.ts` (a viewer connecting while a verse is showing with **no rundown
loaded at all** is resynced with `verse:show` — the exact scenario that was previously
unhandled, alongside the pre-existing interrupt-case test).

### 74.4 The language-hallucination filter (section 73.1) had no way to confirm it was working

Section 73.1's fix (dropping any transcript containing non-Latin script) shipped with
no log at all — a deliberate choice at the time ("indistinguishable from a quiet moment
producing nothing"), but that same silence means there was no way to confirm, from logs
alone, whether a report of "the hallucinated-language bug is still happening" was
against this exact fix or an earlier build without it.

**Fixed**: `GroqProvider` takes an optional `logger` (same "absent by default, present
capability" pattern as `onError`/`getTranslationId` elsewhere — nothing downstream is
forced to handle a logger it doesn't have). When a chunk is dropped for non-Latin
script, it logs `component: "asr", event: "transcript.non-latin-script-dropped"` with
the rejected text truncated to 80 characters — `debug` level, deliberately not `warn`,
since this is expected routine filtering, not a fault; it stays silent at this app's
`minLevel: "info"` default and only appears if that's intentionally lowered to
investigate a specific report. `main/index.ts` now passes its existing `logger` through
to `GroqProvider`'s constructor (previously constructed with only `apiKey`).

Tests added: `groq-provider.test.ts` covers the debug log firing with a truncated
preview on a dropped chunk, confirms a normal accepted transcript logs nothing (the
trace is drop-only, not a log of everything), and confirms a dropped chunk still
doesn't throw when no logger is configured at all.

## 75. Proposed — Merging Media Library and Scene Editor into One "Studio" View

**Status: proposal only. No code has been written against this section. Per AGENTS.md
section 4, this note is meant to be read and approved before any of it is built** — the
data model already supports everything described below, but that is exactly why this
needs a deliberate decision rather than being treated as a natural next increment: it's
a real scope/workflow change (two dashboard views become one, with a new drag-and-drop
interaction), not a bug fix.

### 75.1 The problem this solves

Today, `#nav-media` and `#nav-rundown` (section 66, Phase 1's sidebar app shell) are two
separate full-screen views. Building a canvas scene that uses an imported image or video
(`CanvasImageLayer`, or a video/image `CanvasBackgroundLayer`) requires the operator to
already know the exact media cue exists, switch to the Rundown view's canvas editor,
open its media picker (a `<select>`, per section 66's Phase 4 build), and pick it by
title from a dropdown — never seeing the actual thumbnail (now real, per section 74.1)
at the moment of picking. Renaming that same cue (section 74.2) requires switching back
to the Media view entirely. The two views hold pieces of what is, in practice, one
workflow — "build a scene using my imported media" — with a screen switch in the middle
of it every time.

### 75.2 What already exists — nothing new to invent in the data model

`packages/contracts/rundown.ts`'s `CanvasLayer` union already covers everything this
proposes to make easier to reach:

- `CanvasImageLayer` (`mediaCueId` + `mediaKind: "image" | "video"`) — a media item
  placed as a foreground layer.
- `CanvasBackgroundLayer` (`color: string | null` OR `mediaCueId`/`mediaKind`, mutually
  exclusive) — a full-bleed background, which is already just "a background layer whose
  media happens to be a video" for an animated background. No new layer kind, no new
  field, no contract change.
- `CanvasTextLayer` is unaffected by this proposal entirely.

This note is about **reachability and workflow**, not data model — everything it
describes is already expressible today via the existing canvas editor's own
add-layer/media-picker flow (section 66, Phase 4). What changes is how directly an
operator gets from "I have this image" to "it's a layer on my scene."

### 75.3 The proposed design

One "Studio" view replaces the separate Media and Rundown sidebar entries
(`#nav-media`/`#nav-rundown` become a single `#nav-studio`, or `#nav-rundown` absorbs
`#nav-media`'s content — naming and exact sidebar structure is an implementation
decision, not part of what needs approval here). Inside it: a media library panel (the
real-thumbnail grid from section 74.1, including its rename/delete actions from 74.2)
docked to one side, and the existing canvas scene editor stage (section 66, Phase 4) on
the other — an OBS-style layout, library on the left, canvas on the right.

Dragging a tile from the library panel onto the canvas stage:

- Dropped onto empty canvas space → creates a new `CanvasImageLayer` at the drop
  position, sized to a sensible default, using that cue's `id`/`kind`.
- Dropped onto the stage's background region specifically (a distinct drop target, not
  just "anywhere with no layer under the cursor" — needs its own precise definition at
  build time) → sets/replaces the scene's `CanvasBackgroundLayer`.

This is additive to the existing add-layer flow, not a replacement for it: the
canvas editor's own "+ Image layer" button and its `<select>`-based media picker
(section 66 Phase 4) still work exactly as they do today, for an operator who prefers
that path or is on a device without convenient drag-and-drop. Renaming a cue happens
directly in the docked library panel, using the exact same dialog section 74.2 already
built — no separate "enter rename mode" step for Studio specifically.

### 75.4 Resolved open questions from a plain merge

- **The canvas editor's own "real pixels" gap** (section 66 Phase 4's documented
  limitation: layer previews inside the editor are labeled placeholder boxes, not real
  images, because the dashboard is `file://` and can't resolve `/media/<id>` on its
  own) is **already independently fixed** by section 74.1's `mediaOrigin` mechanism —
  the same absolute-origin technique the media grid's thumbnails now use applies
  identically to the canvas editor's own layer previews. Worth doing either as part of
  this merge or as its own small, separate fix beforehand; either way, it stops being a
  "known simplification" once `mediaOrigin` is in reach of the canvas editor's own
  render code too.
- **Drag source vs. drop target** — the library panel drag needs real `dragstart`/
  `dragover`/`drop` wiring (or an equivalent pointer-based implementation, matching the
  canvas editor's own existing hand-written pointer-capture approach rather than mixing
  the two interaction models); this is new interaction code, not a reuse of the
  editor's existing drag-to-move-a-layer logic (which drags an existing layer, not a
  library tile into a new one).

### 75.5 Explicitly out of scope for this note

- Any change to `CanvasLayer`'s shape, or to the WS/contracts layer at all.
- Multi-select drag (dragging several tiles onto the canvas at once).
- A different visual design for the library panel than section 74.1's existing grid —
  it's proposed to be reused as-is, docked, not redesigned.
- Deciding the exact sidebar/nav-item naming (`#nav-studio` vs. relabeling
  `#nav-rundown`) — a naming detail for build time, not an architectural question.

### 75.6 What approval means

Approving this section means: build one Studio view combining the existing media grid
and canvas editor with drag-to-place wiring between them, reusing every existing
component (thumbnails, rename/delete dialog, canvas editor, `CanvasLayer` contract)
as-is. It does not mean any specific button layout, drag-target hit-testing precision,
or sidebar copy is locked in — those remain implementation details for whoever builds
it. No code against this section should land before this note itself has been read and
explicitly approved, per AGENTS.md section 4 and this project's own established
practice of an architecture note preceding a real scope change (e.g. section 66.1's
explicit supersede-and-confirm before the canvas editor itself was built).

## 76. Silence Gate Auto-Calibration

Confirmed with the user (an "innovating ideas" follow-up to the section 68.2 fix, not
a bug report): the silence gate's threshold was, and until this section remained, one
fixed global constant (150) tuned from a single room's measurement. A quiet chapel and
a hall with HVAC noise genuinely need different thresholds — no single hardcoded number
is correct for both, and the section 68.2 fix could only ever pick a value that erred
toward one failure mode (discarding real speech) over the other (wasting API calls on
noise), never actually solve the underlying mismatch.

**What it does**: `mic:start` now begins a ~1.5-second calibration window before any
audio is actually screened for real. During that window, every incoming frame's RMS is
measured but nothing is forwarded to ASR — once enough audio has accumulated
(`calibrationDurationMs` worth, default 1500ms), the gate derives a new threshold from
the measured ambient average (`ambientAverage × 1.5`, clamped to `[80, 2000]`) and
resumes normal gating with it. `SilenceGate.startCalibration()` can be called again on
a later `mic:start` (a new service, a different day, possibly a different room) without
reconstructing the gate — each calibration is independent and overwrites the prior
threshold.

**Why the 1.5x multiplier, not something tighter to the ambient average**: half of
ambient frames are already below their own average by definition, so a threshold set
AT the average would still reject a coin-flip's worth of pure silence while very likely
still accepting real speech (reliably louder than ambient noise). This is a modest
margin, deliberately biased toward forwarding borderline audio — the same asymmetric-
cost reasoning section 68.2's lowered default used (a wasted ASR call on residual noise
is cheap; discarding real speech is not).

**Why a floor and ceiling on the calibrated value**: a calibration window is a single
sample of a few seconds, not a robust statistical estimate. A near-silent room could
calibrate to a near-zero threshold that then forwards electrical hum as "speech"; a
loud transient exactly during calibration (a door slam, a mic bump) could calibrate to
a threshold so high it then rejects real speech for the entire rest of the session. The
clamp (`[80, 2000]`) keeps a bad calibration window from producing a worse outcome than
the old fixed default ever did.

**Operator-visible, not a silent delay**: `status:update` gained two additive optional
fields, `micCalibrating`/`micThreshold` (same additive philosophy `Verse.secondary`
already established). The dashboard shows a "Calibrating to room noise…" line for the
duration of the window — without it, 1.5 seconds of the mic visibly doing nothing right
after pressing "Start listening" would read exactly like the original "the mic doesn't
work" complaint this whole feature exists to prevent a repeat of. The activity log also
records the resolved threshold once calibration finishes, for the same diagnosability
reasoning as section 74.4's ASR debug log — an operator (or a future debugging session)
can see what the gate actually calibrated to, not just that calibration happened.

`SilenceGate`'s constructor now accepts either a bare number (every existing call site,
tests included, needed zero changes) or an options object
(`{ threshold?, calibrationDurationMs? }`) for the new capability, matching the
"additive, no forced migration" pattern this codebase already uses for optional
capabilities elsewhere (`onError`, `getTranslationId`).

### 76.1 Tests added

`silence-gate.test.ts`: the bare-number constructor form still works; every frame is
rejected during calibration regardless of loudness; calibration finishes once enough
audio accumulates and derives the documented `1.5x` threshold; the floor and ceiling
clamps are exercised directly (a near-silent and a very-loud calibration window each
produce the clamped value, not the raw arithmetic one); calibration frames count in the
running metrics as rejected; normal gating resumes correctly with the new threshold
immediately after; a second `startCalibration()` call cleanly discards an in-progress
or completed prior calibration rather than being influenced by it.

`app-core.test.ts`: an end-to-end test confirms `mic:start` broadcasts the
`micCalibrating: true` status, forwards nothing to the injected `AsrProvider` while
calibrating (even a loud frame), broadcasts `micCalibrating: false` with a real
threshold once calibration finishes, and that normal forwarding resumes immediately
after.

`action-registry.test.ts`: `isStatusUpdatePayload` accepts the new optional fields and
rejects wrong-typed values for either, and — unchanged — still accepts a bare
`{ asrHealth }` payload with neither field present.

## 77. Offline Bible Fallback (French)

User-requested "innovating ideas" follow-up. This app's confirmed primary audience is
French-speaking churches, and its live French verse source (`GetBibleVerseSource`,
section 63.1) depends entirely on a network connection and an external API being
reachable — a venue's own internet dropping, or the API having an outage, previously
meant French verse resolution simply stopped working for as long as that lasted, with
no recovery until connectivity returned.

**What it does**: `apps/server/verse/data/fra_lsg.json` bundles the full Louis Segond
1910 text (the same public-domain translation `GetBibleVerseSource` fetches live —
verified directly against the file's own structure and a real spot-check, e.g. John
3:16, before building anything on top of it; same "verify, don't assume" discipline
`BOOK_CATALOG`'s own KJV source comment already documents). `OfflineVerseSource` reads
it (via `loadOfflineBibleData()`, called once at startup, mirroring
`MediaLibrary.load()`/`ConfigStore.load()`'s own explicit-load pattern) and resolves
references from it — a pure in-memory lookup, never a network call, so it can never
itself be the thing that fails. `OfflineFallbackVerseSource` wraps the live
`GetBibleVerseSource` with it: `main/index.ts` now constructs the French source as
`OfflineFallbackVerseSource({ primary: GetBibleVerseSource, offline: OfflineVerseSource })`
and hands that to `LocalizedVerseSource` exactly where a bare `GetBibleVerseSource`
used to go — `LocalizedVerseSource` needed zero changes, since it only ever calls
`getVerse()` on its wrapped sources.

**Why this wrapper holds its own `CircuitBreaker`, separate from `resolveVerse()`'s
own**: once wrapped, this source practically never throws upward — a primary failure
always resolves via offline instead. Without its own breaker, `resolveVerse()`'s outer
circuit-breaker check would see only successes and keep letting every single
detection re-attempt a live API that's confirmed down. The inner breaker keeps that
"stop hammering a known-down service" protection where it belongs, while still
guaranteeing the operator-facing outcome (a French verse still resolves) that section's
own point is about.

Bundled as a source-tree static asset, not compiled by `tsc` into `dist` — the exact
same pattern `apps/overlay/public` and `apps/desktop/renderer` already use for shipped
files that aren't TypeScript. `apps/server/verse/data/**/*` was added to
electron-builder's `files` list in `package.json` alongside them. Loading the bundled
file failing at all (a real packaging bug, not a legitimate runtime state) degrades to
the plain unwrapped `GetBibleVerseSource` rather than blocking app startup — logged
loudly, but the app still functions exactly as it did before this feature existed.

### 77.1 A real, pre-existing gap this surfaced: BOOK_CATALOG's KJV versification doesn't match Louis Segond's

Building a rigorous cross-check test (comparing the offline data's actual chapter/verse
structure against `BOOK_CATALOG`, rather than trusting the bundled file blindly) found
**106 chapters** — the overwhelming majority in Psalms, plus scattered others across
Exodus, Leviticus, Numbers, 1 Samuel, 1 Kings, 2 Chronicles, Job, Ecclesiastes, Song of
Solomon, Isaiah, Ezekiel, Hosea, Jonah, Micah, Nahum, Mark, Acts, 2 Corinthians, 3 John,
and Revelation — where the verse count per chapter differs between `BOOK_CATALOG`
(explicitly sourced from a KJV-based table, per its own comment) and Louis Segond's
actual French text. The Psalms cases follow one well-documented, single pattern: LSG
(following Hebrew-tradition versification) counts a Psalm's superscription ("Psaume de
David...") as verse 1, where KJV prints it as an unnumbered heading above verse 1 —
shifting every later verse in that Psalm by exactly one. The scattered non-Psalms cases
are individually smaller, similarly well-documented translation-to-translation
versification differences, not data corruption in either source.

**This is not a bug introduced by this feature** — `KnownValidVerseIndex` (the
hallucination guard) has always validated every detected reference, French or English,
against this same single KJV-based `BOOK_CATALOG`. This offline-fallback work is simply
the first thing to have directly, comprehensively compared it against a real
independently-sourced French text and made the mismatch concrete and countable, rather
than it staying an invisible characteristic of the existing catalog.

**Real consequence, left as a known limitation rather than fixed here**: a French
speaker legitimately citing a verse using LSG's own numbering — most commonly a Psalm's
final verse in one of the affected chapters (e.g. "Psaume 3:9", valid in LSG, where
`BOOK_CATALOG` says Psalm 3 has only 8 verses) — would have that reference rejected by
`KnownValidVerseIndex` as "nonexistent" before ever reaching a `VerseSource`, live or
offline. Fixing this properly means `KnownValidVerseIndex` becoming versification-aware
(a separate valid chapter/verse-count table per translation tradition, validated against
whichever language was actually detected) — a real, separate, and non-trivial
architecture change in its own right, deliberately not attempted as a side effect of
adding an offline fallback. Recorded here so it's a tracked, visible gap rather than a
silently-discovered-and-ignored one.

### 77.2 Tests added

`offline-verse-source.test.ts`: `OfflineVerseSource` resolves a known reference with the
correct shape (including the distinct `source: "offline-bundled"` provenance marker,
same `translation` as the live source), returns null (never throws) for an unmapped
book or a chapter/verse absent from the data; `loadOfflineBibleData()` reads/parses a
real file and rejects (rather than silently returning empty) for a missing one.

`offline-fallback-verse-source.test.ts`: a healthy primary is used directly (offline
never even called); a primary confirming "not found" (`null`) is trusted as-is (offline
not consulted — this must never override a definitive live "no"); a thrown primary
error falls back to offline and is logged; once the wrapper's own circuit breaker
opens, primary is skipped entirely on subsequent calls (confirming the whole point of
the inner breaker, not just that fallback works once); a later successful primary call
resets its own failure streak.

`offline-bible-book-keys.test.ts`: the hand-written 66-entry book-key mapping table
covers exactly `BOOK_CATALOG`'s ids (no more, no fewer), has no two ids colliding on
the same offline key, and — checked directly against the real bundled file, not
assumed — every mapped key actually exists in it, with the same chapter count per book
as `BOOK_CATALOG` (per-chapter verse counts are deliberately not asserted exactly equal,
per 77.1's finding).

## 78. Voice Commands Reference

User-requested "innovating ideas" follow-up. Several real bugs this project found
during live testing came down to an operator not knowing the exact phrase a voice
command needed — section 72.2's "prochain verset" gap being the clearest example: the
feature already worked, the operator just had no way to know "verset suivant" was the
only recognized phrasing until it silently didn't respond to a different, equally
natural one. There was no in-app answer to "what can I say?" at all.

**What it is**: a reference, not a settings screen — nothing in it is editable, it
only answers what's currently voice-triggerable. A "Voice Commands" button pinned to
the bottom of the sidebar (visible regardless of which view is active, since voice
commands are relevant during any of them) opens a modal with three sections:

- **Navigation** — a static table of every `NavigationCommandDetector` phrase
  (`SUBSTRING_RULES`/`WHOLE_UTTERANCE_RULES`, section 65/72.2), English and French
  together per action.
- **Media & posters** — populated live from `knownCues` (the same data the Media
  Library grid already has, section 74.1) — exactly the titles that are currently
  real voice triggers, not a stale or hypothetical list.
- **Glossary** — populated via a new `list-glossary-terms` IPC call returning each
  entry's own first trigger phrase, not a guessed universal template. This was a real
  mistake caught before shipping: an earlier draft's static heading assumed every
  glossary entry could be triggered with `"define [term]"`, but `glossary.ts`'s own
  design is per-entry, per-language trigger phrases (English entries use "define X",
  French ones use "definis X" / "que veut dire X") — verified directly against
  `glossary.ts`'s real data (confirmed live via the actual running modal, showing
  "Grace" → `"define grace"` alongside "Grâce" → `"definis la grace"`) before writing
  the final copy, rather than shipping the guessed template.

No new automated tests: this is a renderer-only reference display plus two trivial,
stateless IPC reads (`list-glossary-terms` returns a fixed compiled-in dataset;
`list-media-cues` already existed and is unit-untouched) — verified live via the actual
running app screenshot, consistent with this project's established convention for
renderer-only display changes.

## 79. Session History (Cross-Restart Verse Analytics)

User-requested "innovating ideas" follow-up. `SessionRecorder` (section 65.8) already
tracks every verse shown, but only in memory, cleared on every restart — it backs the
existing "export THIS session" feature and structurally cannot answer "what have I
shown across every service, ever." There was no way to see which verses come up most,
or even how many services had used the app at all, beyond memory.

**What it is**: `SessionHistoryStore` (`apps/server/core/session-history-store.ts`)
persists every verse shown to `session-history.json` in userData, using the exact same
atomic-write discipline `ConfigStore`/`MediaLibrary` already established (temp file,
fsync, rename). Deliberately a separate class from `SessionRecorder`, not a
replacement — they answer different questions and have different lifetimes (per-restart
vs. cross-restart), and `showVerse()` (the one function every trigger already funnels
through, per `SessionRecorder`'s own doc comment) now records to both. Bounded at 5000
entries (AGENTS.md section 36 — every store must be bounded; comfortably over a year of
real usage before the oldest entries roll off). Optional on `StartAppCoreOptions`
(absent by default, same "optional capability, gracefully absent" pattern as
`mediaLibrary`) — recording is fire-and-forget from `showVerse()`'s perspective
(logged, not thrown, on failure) so a disk write can never block or slow down live
verse display.

The dashboard's new "History" sidebar view fetches the raw entries (`get-session-history`
IPC, a thin passthrough — the same division of responsibility `list-media-cues` already
uses) and aggregates them client-side: total verses shown, distinct days with activity,
a "most-shown verses" ranking, and a per-day breakdown of the most recent two weeks.
Days are inferred by grouping timestamps on their local calendar date — there is no
explicit "start/end service" concept anywhere in this app, and a calendar-day grouping
is a reasonable, simple proxy for "one service" without inventing new state to track
service boundaries explicitly.

### 79.1 A real test-authoring bug found and fixed while writing this

The first version of `app-core.test.ts`'s integration test checked
`app.getSessionHistory()` (in-memory) immediately, then constructed a **second**
`SessionHistoryStore` instance pointed at the same directory and asserted it saw the
entry too — and hung. Root cause, confirmed by isolating it in a standalone script
before touching the test: `getSessionHistory()`'s in-memory array updates
*synchronously* the moment `record()` is called (before its `await`s even run), while
the actual disk write is fire-and-forget from `showVerse()`'s perspective by design —
so checking a second, independent instance's `load()` immediately after was a genuine
race against that write actually landing. When it lost the race, the test's own
assertion threw, which (a known failure shape from earlier in this project) skipped the
socket cleanup below it and left `app.stop()` hanging on a socket nothing ever closed.
Fixed by polling the reload with a short retry loop instead of checking once — the
actual feature was correct throughout; only the test's timing assumption was wrong.

### 79.2 Tests added

`session-history-store.test.ts`: `record()`/`getEntries()` round-trip exactly; a
recorded entry survives a restart (a fresh instance's `load()`); `load()` with no file
yet is a no-op; `getEntries()` returns a defensive copy; sequential recording preserves
order and count (the eviction *shape*, without pinning the exact 5000 cap as part of
the test's contract).

`app-core.test.ts`: every shown verse reaches the configured `SessionHistoryStore` (and
is independently visible via a fresh instance loading the same directory, polled per
79.1's finding); `getSessionHistory()` is an empty array (not an error) when no store is
configured at all.

No new tests for the dashboard's History view itself (renderer-only aggregation and
display) — verified live via the actual running app (three real verses shown through
the Manual Override UI, confirmed the summary count, per-verse ranking, and per-day
grouping all matched), consistent with this project's established convention for
renderer-only display changes.

## 80. Web Server Mode (`apps/web/index.ts`)

A second, non-Electron entry point that runs the same `AppCore` behind an Express HTTP
server instead of an Electron `BrowserWindow` pair, so ChurchOverlay can also run
headless on a machine with no display — reachable over the network from any browser,
rather than requiring the desktop app on the machine running OBS.

**What it is**: `apps/web/index.ts` (`npm run start:web`) builds the exact same
dependency graph the Electron main process builds — `LocalizedVerseSource` wrapping an
`OfflineFallbackVerseSource` (section 77), `MediaLibrary`, `SessionHistoryStore` (section
79), an optional `SermonNotesGenerator` — and drives them through the same
`startAppCore()` used everywhere else. `AppCore` itself required zero changes; this is
purely a new *host process* for it, per the provider-agnostic design section 57 already
committed to.

**ASR**: the desktop app only constructs `AppCore` once setup has already collected a
Groq key (`ConfigStore.completeSetup`), so it never needs an ASR provider that tolerates
"no key yet." The web server starts immediately at process boot, before any key is
necessarily known — `HybridAsrProvider` (`apps/server/asr/hybrid-provider.ts`) exists to
bridge that gap: it always offers `DryRunAsrProvider`'s synthetic-text injection (section
44), and layers real `GroqProvider` transcription on top the moment `setApiKey()` is
called (from `POST /api/setup`), routing both through one `onTranscript` callback so
`AppCore` never has to know which half produced a given transcript.

**Single-port HTTP + WebSocket**: the REST API, the static overlay/remote/dashboard
pages, and the WebSocket protocol all needed to live on one port (simpler hosting,
firewall, and reverse-proxy story than two). `ChurchOverlayWsServer` previously always
opened its own standalone TCP listener (`new WebSocketServer({host, port})`) — the
Electron app's own local-only use case never needed anything else. `ChurchOverlayWsServerOptions`
gained an optional `server?: http.Server`: when present, the underlying `WebSocketServer`
is constructed with `{server: options.server}` instead of `{host, port}`, which is `ws`'s
own documented way to attach WebSocket upgrade handling to an already-existing HTTP
server rather than binding a second listener. `apps/web/index.ts` creates one
`http.Server`, hands it to Express, calls `.listen()` on it itself, then passes that same
server into `startAppCore({..., server: httpServer, port: PORT})` — `port` stays required
on the type (the desktop app's standalone mode still needs it to bind its own listener)
but is unused for binding when `server` is present.

### 80.1 A real hang found and fixed while wiring this up

The first version hung indefinitely on startup: `httpServer.listen()` returned, the HTTP
server was reachable, but every route registered *after* `startAppCore()`'s call site —
`/api/status`, `/api/media`, the static overlay/dashboard mounts, all of it — 404'd,
because `await startAppCore(...)` itself never resolved. Root cause, found by tracing
`ChurchOverlayWsServer.ready` (`wss.once("listening", () => resolve())`): `ws`'s own
source (`websocket-server.js`) only *forwards* an externally-provided server's
`'listening'` event as it happens going forward — it does not check whether that server
is already listening. Since `apps/web/index.ts` calls `httpServer.listen()` and awaits
its own `'listening'` callback *before* constructing `ChurchOverlayWsServer`, the
external server's one and only `'listening'` event had already fired and was gone by the
time `ws` attached its forwarding listener — so `ready` wagered on an event that was
never coming again, and hung forever. Fixed by checking `options.server?.listening` at
construction time: if the external server is already listening, `ready` resolves
immediately instead of waiting for an event that has already happened. Caught live —
via `curl` against a running instance showing "Cannot GET" on routes that plainly exist
in the source — not by code inspection; the type system had no way to flag it, since
`ready` is a valid `Promise<void>` either way.

### 80.2 A known, deliberately-scoped gap: the served dashboard is Electron-shaped

`apps/desktop/renderer/`'s `dashboard.js` is built entirely around `window.churchOverlay.*`
(the Electron preload/contextBridge surface) for every non-trivial action — mic setup,
media import/rename/delete, settings, session export. Web Server Mode serves those same
static files at `/` for convenience (a live overlay/remote pair plus a REST API are
useful without any dashboard at all), but a plain browser tab has no `window.churchOverlay`
bridge, so dashboard interactions that depend on it will fail in that context. This is a
known, out-of-scope gap, not an oversight: building a browser-native operator dashboard
(calling the REST endpoints this section already added instead of IPC) is real,
separate-phase work, deliberately not bundled into "make the web server run" scope. The
overlay (`/overlay`) and phone remote (`/remote`) pages are unaffected — both were
already plain, IPC-free static pages before this section, and both are fully functional
in Web Server Mode.

### 80.3 Tests added

`hybrid-provider.test.ts`: no-`apiKey` construction leaves `sendAudio()`/`start()`/
`stop()` as safe no-ops and `hasRealProvider()` false; `emitText()` works identically
with or without a key configured; constructing with a key makes `hasRealProvider()` true
immediately; `setApiKey()` with a real key routes real transcription through the same
`onTranscript` callback `emitText()` uses; `setApiKey('')` clears back to the no-key
state; calling `setApiKey()` while the mic is already active starts the new provider
immediately, without a separate `start()` call; `onError` forwards once a real provider
is configured; `stop()` is safe whether or not a real provider exists.

No new automated test covers the `ready`-promise fix directly (it is an integration
behavior of two library internals — Express/http and `ws` — rather than a unit of this
codebase's own logic); it was verified live instead: built and ran the actual compiled
server, confirmed `/api/status`, `/api/glossary`, `/api/media`, and the overlay static
route all responded correctly (they 404'd before the fix and 200'd after), confirmed a
real `ws` client connects and completes the token handshake on the *same* port Express is
listening on, and exercised the full media lifecycle end to end — `POST /api/media/upload`,
`POST /api/media/rename`, `DELETE /api/media/:id` — against the running process.

## 81. Transcription Responsiveness & French-Priority Accuracy

Live-testing feedback, verbatim in substance: the operator had to speak loudly and
repeat themselves before the app "caught" what was said, and — since the app's primary
audience is French-speaking, with English usage already considered acceptable —
transcription/detection accuracy for French specifically needed to improve more than
English.

### 81.1 The silence-gate hangover fix (the actual cause of "speak loudly and repeat")

Root cause, confirmed by reading the real call chain rather than assumed: `handleAudioFrame()`
only calls `asr.sendAudio(frame)` when `SilenceGate.process(frame).forwarded` is true —
a frame the gate rejects never reaches `GroqProvider` at all. `GroqProvider`'s 2-second
buffering window (section 70) only accumulates samples from frames that actually arrive
via `sendAudio()`. Real speech has natural volume dips — unvoiced consonants, breaths, a
word trailing off — that briefly fall under any single fixed RMS threshold. Under the old
strict per-frame gate, a normal sentence got chopped frame-by-frame at each quiet dip:
the audio that reached Groq had silent gaps spliced out of it (fragmenting words and
hurting Whisper's accuracy), and because only "loud enough" frames counted toward the
2-second buffer, it took far longer in real time than the sentence itself took to speak
to accumulate a full buffered chunk — which is exactly what "have to speak loudly and
repeat" feels like from an operator's chair.

Fixed with a standard VAD hangover window (`SilenceGate`'s new `hangoverMs` option,
default 600ms): once the gate is "open" (any frame at or above threshold), it stays open
through brief dips for `hangoverMs` before actually closing, refilling to the full
budget on every fresh above-threshold frame. One continuous utterance is now forwarded
as one continuous stream instead of being chopped into whichever individual frames
happened to clear the bar. The gate's original purpose — not forwarding *obvious*,
sustained silence, to avoid wasted ASR calls (section 9) — is unaffected: hangover only
bridges brief dips within active speech, not long silent stretches between utterances.

### 81.2 A Whisper language hint, tied to display mode

`GroqProvider.transcribe()` never told Whisper what language to expect — every 2-second
chunk was auto-detected independently, which is a real, confirmed accuracy cost on short
clips (an ambiguous phoneme or accent can flip the detected language between chunks,
degrading both the transcript and, downstream, verse-reference detection). Whisper's API
accepts an explicit `language` hint for exactly this case.

`GroqProvider` and `HybridAsrProvider` both gained an optional `language`
(constructor option) and `setLanguage()` (live-updatable, since a display-mode switch
mid-service — voice, dashboard, or REST — should retarget Whisper immediately, not just
at the next restart). The hint is derived from the existing `DisplayMode` setting via a
small `whisperLanguageFor()` mapping (duplicated in `apps/desktop/main/index.ts` and
`apps/web/index.ts` — "duplicated, not shared," the same convention this codebase already
uses for small logic with no build step to share a module through): `"french"` → `"fr"`,
`"english"` → `"en"`, `"bilingual"` → `undefined` (no hint at all). Bilingual deliberately
stays unhinted — a genuinely mixed-language service has no single correct hint, and
Whisper's own per-chunk auto-detection is the least-wrong option there. Wired into every
place `DisplayMode` already changes: initial construction from the persisted/initial
mode, the voice-triggered `onDisplayModeChanged` callback, and the dashboard/REST
mode-change handlers (`set-display-mode` IPC, `/api/mode`, `/api/setup`) in both the
desktop app and the web server.

### 81.3 Tests added

`silence-gate.test.ts`: a brief below-threshold dip immediately after a loud frame is
still forwarded; forwarding stops once sustained silence actually exhausts the hangover
budget; a fresh above-threshold frame mid-stream refills the budget rather than leaving
it to decay from the first loud frame. Two pre-existing tests (`is inclusive at the
threshold boundary`, `accumulates accurate metrics across a mix of silent and loud
frames`) needed `hangoverMs: 0` added — their actual intent (per-frame boundary
correctness, metrics-accumulation correctness) is orthogonal to hangover, and hangover's
now-correct behavior of forwarding a following dip would otherwise break their
unrelated assertions.

No new automated test covers the Whisper `language` parameter reaching the real API
(that would require a live Groq call, out of scope for the unit suite — `groq-provider.live.test.ts`
already exists for that category and wasn't extended here); `hybrid-provider.ts`'s
`setLanguage()` plumbing itself is straightforward pass-through with no independent
logic worth a dedicated unit test beyond what `groq-provider.test.ts` already covers for
`GroqProvider.setLanguage()`'s effect on the request.

## 82. Verse Display Layout, Unconditional Verse Auto-Clear, and Configurable Poster/Media Duration

Live-testing feedback, three related requests about what actually renders on the OBS
overlay and for how long.

### 82.1 Verse auto-clear widened from poster-gated to unconditional, and bumped to 2:30

Section 67.2 originally armed a verse auto-clear timer only while a principal poster was
active (so the poster underneath would reappear on its own). Confirmed explicitly, firmly,
by the user: **every** shown verse must clear itself after a fixed ceiling — 2 minutes 30
seconds — regardless of whether a poster is configured at all. The `principalPosterCueId !== null`
gate around arming `verseAutoClearTimer` in `showVerse()` was removed; the timer now arms
unconditionally on every verse shown, any trigger. `verseAutoClearMs`'s default changed
from 120000 to 150000. The option remains overridable (tests use short delays), and
"most recent wins" (a new verse resets, never queues behind, a pending timer) is
unchanged from section 67.2's original design.

### 82.2 Verse display layout: fullscreen (default) vs. lower-third

Purely a presentation choice for the overlay — carries no effect on detection, lookup, or
caching. Until now the verse card only ever rendered as a lower-third card, by design
(section 67's own comment: "a verse card ... reveals the poster around its edges — the
whole point of this feature"). Confirmed with the user: **fullscreen** should be the
default (readable from across a room), with lower-third available for when video/media
shares the screen and a full-bleed verse would otherwise cover it.

**Data model**: `VerseLayout = "fullscreen" | "lower-third"` (`packages/contracts/verse.ts`).
A new WS command/event pair, `layout:set` (operator → server) / `layout:update`
(server → all clients, same payload shape `{layout}`) — validated in
`action-registry.ts` exactly like `poster:set`/`poster:show`. `AppCore` holds
`verseLayout` state (default `"fullscreen"`), broadcasts `layout:update` whenever
`layout:set` is handled, calls the new optional `onVerseLayoutChanged` hook (mirroring
`onDisplayModeChanged`'s pattern exactly, for persistence outside AppCore's own
concern), and — critically — sends `layout:update` to every new viewer connection via
`onViewerConnected`, unconditionally and first (before the poster/media/rundown resync
blocks), so a reconnecting OBS browser source or a fresh page load always applies the
correct layout before anything else renders.

**Persistence**: `ConfigStore` gained a `verseLayout` field (Electron only), following
the exact migration/validation pattern every other optional field there already uses
(absent-in-an-old-file defaults to `"fullscreen"`, present-but-invalid throws). The web
server (`apps/web/index.ts`) does not persist it across restarts, matching `displayMode`'s
own existing lack of persistence there.

**Overlay rendering**: `#verse.fullscreen` (new CSS) switches from bottom-anchored to
filling and centering the whole viewport, with an **opaque** full-bleed card background
— deliberately not the lower-third's translucent scrim, because the user's explicit
requirement is that a poster/media backdrop underneath is fully covered while a
fullscreen verse is showing, not just dimmed around a small card. This is a natural
consequence of z-index stacking already established in section 67 (`#verse` at z-index
2, above `#poster-layer`'s z-index 0) — no poster-specific code was needed; an opaque
`#verse.fullscreen` simply covers it, and clearing the verse naturally reveals the
poster again since it was never actually hidden, only covered.

A real bug found while wiring this: `overlay.js`'s `fitVerseText()` always sets an
inline `font-size` (an auto-shrink-to-fit algorithm, not a fixed size) — which
unconditionally overrides any font-size declared in the stylesheet, including a
`.fullscreen`-scoped override, regardless of CSS specificity. The sizing path now
measures the combined French/English card, recalculates after fonts load and viewport
resize, uses border-box sizing so fullscreen padding cannot add hidden overflow, and
scales the complete card as a final bounded fallback when an unusually long bilingual
passage reaches the minimum readable font size. It therefore never relies on CSS
clipping to hide verse content offscreen.

**Dashboard control**: a new "Verse Display" settings card (`apps/desktop/renderer/`)
with a fullscreen/lower-third toggle sending `layout:set` directly over the existing WS
connection (the same pattern `poster:set` already uses from the Media Library view) —
not an IPC round trip, since this is fundamentally a viewer-facing broadcast setting,
not a `ConfigStore`-only concern in itself (persistence happens via `onVerseLayoutChanged`,
triggered by the same command).

### 82.3 Configurable poster/media auto-clear duration

Confirmed with the user: a principal poster should be able to auto-clear on its own
after an operator-configured duration — off (manual `poster:clear` only) by default,
matching this codebase's established optional-capability, off-by-default convention
(`allowPhoneRemote`, `enableSermonNotes`, etc.) rather than a fixed built-in duration
like section 82.1's verse ceiling.

New WS command `poster:set-duration` (operator-only, payload `{durationMs: number | null}`,
`null` meaning "no auto-clear"), validated in `action-registry.ts`. `AppCore` holds
`posterAutoClearMs` (default `null`) and a `posterAutoClearTimer`, armed/reset on every
`poster:set` (mirroring `verseAutoClearTimer`'s "most recent wins" pattern) and
re-armed immediately if the duration itself changes while a poster is already showing
(an operator adjusting this mid-service shouldn't have to re-set the poster to apply
it). `poster:clear` — whether manual or timer-fired — cancels any pending timer.
Exposed as an initial `StartAppCoreOptions.posterAutoClearMs` for parity/testability,
same pattern as `verseAutoClearMs`. Not persisted across restarts (session-only,
defaulting to manual-only each run) — the user asked for it to be *settable*, not
necessarily remembered forever the way the verse layout preference is.

**Dashboard control**: a number input (minutes) in the same "Verse Display" settings
card, sending `poster:set-duration` on an explicit "Apply" click rather than on every
keystroke.

### 82.4 A real test-infrastructure bug found and fixed while wiring section 82.2

`layout:update` firing unconditionally on every viewer connection (section 82.2) broke
one existing test outright and put roughly a dozen more at risk: `waitForMessage`/
`waitForMessages` (the shared test helpers already filtering `transcript:partial`/`final`
echoes per section 70's own fix) needed the same filtering extended to `layout:update` —
renamed the underlying predicate from `isTranscriptEcho` to `isAutoSyncNoise`. Six raw
`.once("message")`-based tests asserting "nothing at all is broadcast" for a rejected
command needed individual narrowing to "no *specific* message type fires," the same
remediation section 70 already established for the identical class of bug — a boolean
"any message arrived" flag is fundamentally incompatible with an unconditional per-connection
sync message that has nothing to do with what the test is actually checking.

Separately, and more seriously: `AppCore.stop()` never cleared `verseAutoClearTimer` (a
pre-existing gap, true since section 67.2 first introduced it) or the new
`posterAutoClearTimer`. This was easy to never trigger before section 82.1 — the old
poster-gated verse timer was rarely armed in tests — but section 82.1's unconditional
arming turned it into an near-universal leaked `setTimeout` that kept the `node --test`
process alive past every individual test's own completion, surfacing as the entire test
*file* timing out well after all of its individual tests had already reported passing.
Both timers are now cleared in `stop()` alongside the pre-existing `definitionClearTimer`/
`sermonNotesTimer` cleanup.

### 82.5 Tests added

`action-registry.test.ts`: `layout:set`/`layout:update`/`poster:set-duration` role
boundaries and payload validation (valid layouts, invalid layout strings, positive vs.
non-positive/non-finite/missing `durationMs`, `null` accepted for "no auto-clear").

`app-core.test.ts`: a new connection is synced with the current verse layout via
`layout:update` before anything else; `layout:set` broadcasts `layout:update` and
invokes `onVerseLayoutChanged`; `poster:set-duration` auto-clears a poster after the
configured delay and a fresh `poster:set` resets the countdown; with no duration
configured, a poster never auto-clears; the verse-auto-clear test suite's own
"no principal poster configured" case was inverted from "never arms a timer" to "still
auto-clears" (section 82.1's behavior change).

`config-store.test.ts`: `verseLayout` round-trips through `AppConfig`; a config saved
before section 82 existed defaults it to `"fullscreen"`; a present-but-invalid value
throws (real corruption, not an old file) — the same three-test pattern every other
optional `ConfigStore` field already follows.

## 83. Current Implementation Baseline and Architecture Audit

This section closes the documentation gap between the original baseline and the
implemented Phase 2 work. It is an implementation inventory, not permission to
expand scope silently. A feature is marked implemented only when its owning code,
protocol validation, failure behavior, and relevant tests exist in the repository.

### 83.1 Implemented capabilities

| Capability | Owning implementation | Verification status |
|---|---|---|
| Groq ASR with bounded rate limiting | `apps/server/asr/groq-provider.ts` | Provider tests cover the 18-request window, bounded flush, retry parsing, and sustained `429` notification |
| Operator-visible ASR health | `apps/server/core/app-core.ts`, dashboard renderer | Integration tests distinguish `throttled`, `error`, and persistent `rate-limited` states |
| French source and bilingual composition | `GetBibleVerseSource`, `LocalizedVerseSource` | Source and composition tests cover malformed responses, versification mismatch, secondary-language degradation, and cache identity |
| Offline French fallback | `OfflineFallbackVerseSource`, bundled `fra_lsg.json` | Unit tests cover primary failure, fallback resolution, and circuit-breaker behavior |
| French/English operator UI | `apps/desktop/renderer/i18n.js`, `ConfigStore` | UI language is persisted and applied through the existing dependency-free renderer mechanism |
| Voice navigation and display-mode switching | `NavigationCommandDetector`, `resolveNavigationCommand`, `AppCore` | Detector, resolver, and AppCore integration tests cover final-transcript gating and catalog boundaries |
| Media, scenes, rundown, canvas, poster, and layout controls | `apps/server/media`, `rundown`, AppCore, dashboard | WS schema tests and end-to-end AppCore tests cover role boundaries and state transitions |
| Session history and headless Web Server Mode | `SessionHistoryStore`, `apps/web/index.ts` | Persistence and HTTP/WS integration tests cover the documented local deployment path |

### 83.2 Cross-cutting invariants confirmed by the audit

1. Only final transcripts enter verse, media, navigation, glossary, or rundown
   voice-trigger paths.
2. Every detected, overridden, navigated, or rundown verse passes through
   `KnownValidVerseIndex` and validated verse-source resolution before display.
3. Bilingual mode treats French as primary. A missing or failed French lookup
   does not silently display English as a substitute; a failed secondary English
   lookup degrades to French with a structured warning.
4. Translation mode is part of the verse cache identity, so a live mode switch
   cannot reuse a verse resolved for another display mode.
5. ASR throttling is not classified as an operator-facing error unless the
   provider reports a real failure. Sustained `429` responses are a separate,
   persistent health state.
6. Renderer processes receive no provider secrets or arbitrary filesystem access;
   all operator actions cross the existing preload/WS validation boundaries.
7. Local fallback data is read-only application data. It is not an operator-
   editable Bible database and does not introduce a new plugin or translation
   discovery system.

### 83.3 Remaining deliberate gaps

- NDI code is implemented as an optional transport with Browser Source fallback.
  SDK licensing, redistribution, platform binary coverage, and maintenance remain
  release gates before shipping packaged NDI support.
- Rundown persistence across restart remains deferred; the current rundown is
  intentionally in-memory only.
- The broader AI copilot remains unscoped. Sermon-note summarization is the only
  approved AI side channel and is isolated from verse detection.
- Additional translations, semantic detection, local/hybrid ASR, cloud sync,
  mobile, and automatic OBS control remain outside the locked scope.

### 83.4 Change discipline for the next feature

Future work must update this inventory in the same commit as the feature's
architecture note or implementation change. Any new external provider must first
document response validation, failure classification, cache identity, secret
handling, and deterministic tests. Any new operator-facing state must define its
wire payload, role permissions, reconnect behavior, and dashboard severity before
code is added.

## 84. Production Diagnostics Export

The operator dashboard now exposes an explicit diagnostics export action. It writes
`churchoverlay-diagnostics.json` to an operator-selected folder and contains only
operational state: generation time, current ASR health, SilenceGate metrics, and
session/history entry counts.

The export is intentionally **not** a general log or configuration dump. It never
includes Groq credentials, WebSocket tokens, raw microphone samples, transcript
content, filesystem paths from configuration, or decrypted secrets. The main process
owns the native folder picker and file write; the renderer receives only the result
path, preserving the existing Electron boundary.

`AppCore.getDiagnostics()` is the single source for the snapshot, so the dashboard
cannot invent health values or read internal server state directly. The snapshot is
safe to collect while ASR is throttled, in error, or recovering, and its shape is
covered by an AppCore integration test.

## 84. Per-Media Auto-Clear Timers

Each imported `MediaCue` may persist an optional `autoClearMs` duration. The
`MediaLibrary` owns this metadata and updates it atomically through the operator-only
`media:set-duration` command; `null` means manual-only playback. The action registry
rejects zero, negative, non-finite, or malformed durations before AppCore handles them.

AppCore is the timing authority. Activating a cue arms one timer, replacing a cue
cancels the previous timer, `media:clear` cancels the active timer, and changing the
active cue's duration re-arms it immediately. When the timer fires, the server clears
the cue only if it is still active and broadcasts `media:clear`. The overlay never
owns or infers this timer.

Per-media timing is deliberately separate from the principal-poster timer. Pinning
remains an image-only poster-layer feature; its existing `poster:set-duration`
behavior is unchanged.

## 85. Deepgram Streaming ASR Option

`DeepgramProvider` is an optional cloud ASR adapter using Deepgram's persistent
WebSocket streaming endpoint with canonical PCM16/16 kHz mono audio. It emits
honest `partial` and `final` transcript states, while AppCore continues to gate
all verse detection and media detection on final transcripts only.

Groq remains the primary provider. When both encrypted credentials are configured,
desktop startup creates a failover wrapper, but it opens the Deepgram connection
only after Groq reports sustained 429 responses. Buffered or in-flight Groq batch
audio is deliberately abandoned at that boundary rather than converted into a
stream. The operator must explicitly return to Groq; there is no automatic
oscillation loop. With no Deepgram key, the existing Groq-only path is unchanged.
Neither key is exposed to renderers or written in plaintext.

Successful failover is an informational operator state, distinct from the
critical sustained-rate-limit state. A real Deepgram/network failure remains an
ASR error and is surfaced as such.

The Deepgram adapter treats an unexpected WebSocket close as a terminal failure
of that connection: it clears its active state, reports the error once, and
allows the failover wrapper to retry a fresh connection when explicitly
started. A failed handshake also clears connection state; it never leaves the
secondary provider falsely marked as active.


This reduces local CPU/RAM/GPU usage compared with local inference, but it does
not provide unlimited free usage: Deepgram remains subject to account pricing,
credits, and service limits. Streaming reduces request overhead and latency; it
does not remove the provider's billing boundary.
