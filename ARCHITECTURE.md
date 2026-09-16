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
- Media library.
- Songs/lyrics.
- Scenes.
- Rundown/service planning.
- Cameras.
- Branding engine.
- AI agent.
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
Jean trois seize
```

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
