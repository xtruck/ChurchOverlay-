# ChurchOverlay — Architecture Specification

Version: 1.0
Status: Architecture Baseline
Scope: v1
Last Updated: 2026-09-16

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
- Media library (**approved for Phase 2 — see section 59; not yet implemented**).
- Songs/lyrics (**approved for Phase 2 — see section 59; not yet implemented**).
- Scenes (**approved for Phase 2 — see section 59; not yet implemented**).
- Rundown/service planning (**approved for Phase 2 — see section 59; not yet implemented**).
- Cameras.
- Branding engine.
- AI agent (**approved for Phase 2 as a broader AI copilot — see section 59; not yet implemented**).
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
retroactively into section 59's original approval. This is design only — nothing in
this section is implemented yet.

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
Phase 2 items in section 59 or media library/voice navigation above — approved for
Phase 2 (confirmed explicitly: "add it to ROADMAP.md, scope it properly first," not
build it immediately) but with real open questions this note surfaces rather than
resolves, because they require verification this note cannot do on its own (SDK
licensing terms, platform prebuild availability). This is design only — nothing in
this section is implemented yet, and it must not be implemented until those open
questions are actually answered.

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

Each captured frame is handed to the new native dependency (section 62.3) for NDI
transmission. This keeps `apps/overlay/public/` completely unaware that NDI exists —
it has no idea whether it's being viewed by OBS's Browser Source, the overlay preview
window, or this offscreen NDI renderer, matching section 57's "the overlay can be
changed without modifying [transport]" success criterion extended to a new transport.

### 62.3 The new dependency — evaluated, not assumed (AGENTS.md section 40)

NDI is a proprietary protocol (Vizrt/NewTek) with no standard-library or pure-JS
implementation possible — a native dependency is unavoidable, unlike most of this
codebase's deliberate zero-dependency stance. The candidate is `grandiose`, a Node
native addon wrapping the official NDI SDK. Before this is implemented, three things
must actually be verified against grandiose's and NDI's current real terms — not
assumed or fabricated here:

1. **Licensing and redistribution.** What NDI's SDK license actually requires of an
   app that bundles/uses it (branding requirements, redistribution terms, whether the
   free tier is sufficient or "NDI Advanced" licensing is needed for this use case).
2. **Platform/prebuild coverage.** Whether `grandiose` ships prebuilt binaries for
   every platform this app targets (Windows/macOS/Linux), or whether some platforms
   would require a native build toolchain at install time — a real
   "might not install cleanly on every machine" risk to know about upfront, not
   discover from a user's failed install.
3. **Maintenance status.** Whether the specific package is actively maintained against
   current Node/Electron ABI versions, given Electron's own Node version can be newer
   than what a native addon's prebuilds were built against.

### 62.4 Fail-safe behavior (ARCHITECTURE.md section 4.5)

NDI output must be strictly additive and non-blocking: if the native module fails to
load (missing prebuild, unsupported platform, NDI runtime not installed on the
machine), the application logs the failure and simply does not offer NDI output —
Browser Source and the overlay preview window continue working exactly as they do
today, unaffected. NDI is never a required dependency for the app to start; it is an
optional capability that degrades to "unavailable," never a startup failure.

### 62.5 Open questions this note does not resolve

- **Section 62.3's three verification items** — this note explicitly does not answer
  them; they must be checked against grandiose's real, current documentation and the
  real, current NDI SDK license before any code is written, not assumed favorable.
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
section, scoped via this note before any code, per the same process already applied
to media library and voice navigation. Unlike those two, this note does not clear
NDI for implementation yet — section 62.3's three verification items are a real
precondition, not a formality, given the licensing and native-dependency questions a
purely architectural note cannot answer on its own.

## 63. Phase 2 Feature Note — Bilingual Display & French Localization

A dedicated architecture note, following the same AGENTS.md section 56 checklist as
sections 60-62. Raised mid-session: the app's real target audience is a French-
speaking church, not an English-speaking one. This is two related but distinct
changes, both confirmed explicitly rather than assumed:

1. **Verse content** can display in English only, French only, or both at once
   (bilingual, French prioritized/larger).
2. **The app's own interface** (dashboard, setup screen) is translated to French,
   with a language switch — not just the verse content.

This is design only — nothing in this section is implemented yet.

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
  attribute and sets its text content — the same "plain browser JS, no build step"
  convention `dashboard.js`/`overlay.js` already use.
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
sections 60-63. This is design only — nothing in this section is implemented yet. It
settles the one open question section 59.4 explicitly deferred: rundown/live-detection
precedence.

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
