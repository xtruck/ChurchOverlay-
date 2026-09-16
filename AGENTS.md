# AGENTS.md — ChurchOverlay

## 1. Mission

You are an AI coding agent working on ChurchOverlay.
Your job is to implement requested features while preserving the architectural boundaries defined in `ARCHITECTURE.md`.
The project is intentionally small.
Do not turn it into a generalized church presentation platform.

## 2. Source of Truth

Before making architectural or cross-cutting changes, read:

```text
ARCHITECTURE.md
ROADMAP.md
```

Relevant feature-specific documentation should also be consulted.

The architecture document is authoritative for:

- module boundaries
- security
- communication
- interfaces
- correctness invariants
- v1 scope

If an implementation request conflicts with the architecture, stop and identify the conflict before making a structural change.

## 3. Prime Directive

Implement the smallest correct change that satisfies the requirement without weakening existing guarantees.

Do not optimize for:

```text
fewer files
fewer lines
clever abstractions
generic frameworks
future features
```

Optimize for:

```text
correctness
testability
observability
security
maintainability
scope discipline
```

## 4. v1 Scope Lock

v1 includes:

```text
microphone
audio normalization
silence gate
cloud ASR
ASR abstraction
final transcript handling
verse detection
reference validation
known-valid verse index
Bible source
LRU cache
negative cache
WebSocket
operator dashboard
OBS overlay
manual override
manual clear
logging
diagnostics
testing
secure configuration
```

Do NOT implement:

```text
local ASR
hybrid ASR
semantic detection
paraphrase detection
vector search
offline Bible database
multiple translations
media library
songs
scenes
rundown
cameras
branding engine
AI agent
MCP
ProPresenter
Planning Center
automatic OBS control
remote server
cloud synchronization
mobile app
dynamic plugins
```

If a user request requires one of these, identify it as a scope change instead of quietly implementing it.

## 5. Never Bypass Architectural Boundaries

The following boundaries are mandatory.

```text
ASR
does not detect verses.

Detector
does not call Bible APIs.

Detector
does not send WebSocket messages.

Verse Source
does not render UI.

Overlay
does not send application commands.

Renderer
does not access secrets.

UI
does not directly depend on provider SDKs.
```

## 6. Provider Interfaces

Provider interfaces exist to isolate external implementations.
They do NOT justify creating a plugin framework.

Do not introduce:

```text
dynamic plugin loading
plugin discovery
runtime module installation
plugin manifests
config-driven provider resolution
```

unless explicitly approved through an architecture change.

## 7. ASR Rules

The ASR boundary must remain provider-independent.
Use the `AsrProvider` interface.

Do not import a provider SDK directly into:

```text
application core
detector
UI
overlay
```

Only the provider adapter may know provider-specific details.

## 8. Transcript Rules

Transcript state must be explicit.

Valid states:

```text
partial
final
```

Critical rule:
Partial transcripts MUST NEVER trigger verse detection.

Partial transcripts may be:

```text
displayed
logged
used for operator feedback
```

but never:

```text
Bible lookup
verse display
```

Only final transcripts enter the detection pipeline.

## 9. Confidence Rules

Do not assume all ASR providers expose equivalent confidence values.
Provider confidence is optional.
Never invent a confidence score.
If confidence is unavailable, rely on deterministic validation rather than fabricating one.

## 10. Audio Rules

The ASR boundary must receive a canonical audio format.
Do not allow individual providers to define arbitrary audio formats inside the core.

The audio pipeline must remain:

```text
capture
↓
normalize
↓
silence gate
↓
ASR
```

Do not move provider-specific audio transformations into unrelated modules.

## 11. Silence Gate Rules

The silence gate is an optimization, not a speech-recognition authority.
It should reject obvious silence.
It must not silently discard speech without diagnostics.

Maintain useful metrics such as:

```text
frames received
frames rejected
frames forwarded
RMS statistics
```

Do not replace the silence gate with an unrelated algorithm without evidence and testing.

## 12. Verse Detector Rules

The v1 detector is:

```text
RegexDetector
```

It must:

```text
accept transcript text
return structured references
```

It must not:

```text
call APIs
access cache
access filesystem
send WS messages
render UI
```

Keep it deterministic and easily unit-testable.

## 13. Verse Validation Rules

No detected reference is trusted automatically.

The sequence must remain:

```text
detected reference
↓
normalize
↓
validate
↓
known-valid index
↓
Bible source
↓
response validation
↓
display
```

Never bypass the known-valid reference validation.

## 14. Hallucination Guard

This is a critical correctness guarantee.
A wrong ASR result or regex match must never directly produce displayed Bible content.

The following is forbidden:

```ts
detector.detect(text)
  → overlay.show(reference)
```

The correct path is:

```text
detector
↓
validated reference
↓
verse source
↓
validated verse
↓
verse:show
```

## 15. External API Rules

Never trust external API responses.
HTTP 200 does not mean valid data.
Every external response must be schema-validated.

Reject:

```text
missing fields
wrong types
unexpected structures
empty required values
invalid verse data
```

Do not pass raw external API responses through to the UI.

## 16. Cache Rules

The Bible cache must be bounded.
Use an LRU strategy.
Cache keys must be normalized.
Include translation identity in the cache key even if v1 has only one translation.
Successful and failed lookups may be cached separately.
Negative cache entries must have a shorter lifetime.

## 17. WebSocket Rules

All inbound WebSocket messages must be schema-validated.

Never trust:

```text
message.type
message.payload
message.id
```

until validated.
Malformed messages must not crash the server.

## 18. WebSocket Authentication

Authentication tokens must not be placed in URL query parameters.

Use:

```text
Sec-WebSocket-Protocol
```

as defined by the architecture.
Never log tokens.
Never expose decrypted tokens to renderers.

## 19. WS Commands vs Events

Commands:

```text
mic:start
mic:stop
verse:clear
verse:override
```

Events:

```text
status:update
transcript:partial
verse:show
```

Do not turn every internal event into a public WebSocket action.
Keep the public action registry small.

## 20. Overlay Rules

The overlay is a viewer.
It is read-only.

It must not:

```text
start microphone
stop microphone
override verse
clear server state
access API keys
access filesystem
access Node.js APIs
```

The overlay may perform a local visual emergency clear through Escape.
That local clear must not become an application-control channel.

## 21. Message IDs

Messages should use ULIDs where IDs are required.

Do not use:

```text
1
2
3
4
```

as globally meaningful message IDs.

## 22. Sequence Numbers

Streaming messages should have sequence numbers where ordering matters.
Consumers must safely handle stale or out-of-order messages.
Never assume network delivery order is perfect.

## 23. Correlation IDs

Every significant processing chain should have a correlation ID.

Example:

```text
audio
↓
ASR
↓
detector
↓
lookup
↓
WS
↓
overlay
```

must be traceable through one correlation ID.

When debugging a problem, prefer tracing the correlation ID rather than guessing from timestamps.

## 24. Logging Rules

Use structured logging.

Include where appropriate:

```text
timestamp
level
component
event
correlationId
messageId
sequence
durationMs
error
```

Never log:

```text
API keys
WS tokens
decrypted secrets
raw microphone data
unnecessary private data
```

## 25. Error Handling

Errors must be handled at subsystem boundaries.

Do not use:

```ts
catch (error) {
  // ignore
}
```

unless there is a documented reason.

Errors should either:

```text
recover
propagate to an appropriate boundary
be reported
```

Never silently swallow errors that affect correctness.

## 26. No God Objects

Do not create a giant:

```text
server.ts
app.ts
manager.ts
controller.ts
```

that knows everything.

If a component begins controlling:

```text
audio
ASR
Bible
WebSocket
UI
configuration
logging
```

stop and reassess the architecture.

## 27. Electron Security

Never enable:

```text
nodeIntegration: true
```

merely to simplify implementation.

Prefer:

```text
contextIsolation: true
nodeIntegration: false
```

Use preload APIs for controlled renderer/main communication.
Do not expose arbitrary IPC.

## 28. Secrets

Secrets belong outside renderer processes.

Never put API keys into:

```text
React state
HTML
localStorage
sessionStorage
URL
WebSocket query parameters
```

Do not commit secrets to Git.
Do not place secrets in test fixtures.
Use secure storage.

## 29. Configuration

Configuration writes must be atomic.

Use:

```text
temporary file
↓
write
↓
flush/close
↓
rename
```

Do not overwrite the only valid configuration file directly.
If configuration parsing fails, preserve recoverable state whenever possible.

## 30. Testing Before Refactoring

Before changing a core subsystem:

1. Locate existing tests.
2. Understand current behavior.
3. Add a regression test if behavior is not covered.
4. Make the smallest change.
5. Run targeted tests.
6. Run integration tests.
7. Run the broader test suite when appropriate.

Never make a large refactor first and attempt to reconstruct behavior afterward.

## 31. Dry-Run Mode

Use dry-run mode whenever possible to test downstream behavior without:

```text
microphone
cloud ASR
live speech
```

A synthetic transcript should be capable of exercising:

```text
detector
validation
lookup
WS
overlay
```

## 32. Deterministic Tests

Prefer deterministic fixtures.

Do not make unit tests depend on:

```text
internet
real microphone
real ASR
external Bible API
OBS
```

unless the test is explicitly an integration/E2E test.

## 33. External Services in Tests

For unit and most integration tests:

```text
mock/stub external providers
```

Use real external services only in dedicated integration tests.
Tests must not depend on unstable third-party availability.

## 34. Performance

Do not optimize based on intuition.
Measure first.

When performance work is requested:

1. establish baseline
2. identify bottleneck
3. change one thing
4. measure again
5. verify correctness
6. document meaningful improvement

Do not introduce complexity merely because something might be faster.

## 35. Real-Time Code

Avoid blocking the event loop.

Do not introduce:

```text
synchronous heavy computation
large synchronous filesystem operations
unbounded loops
unbounded queues
```

into latency-sensitive paths.

## 36. Resource Limits

Queues, caches and retry systems must be bounded.

Never create an unbounded:

```text
audio queue
transcript queue
retry queue
cache
log buffer
```

## 37. Retry Rules

Retries must be:

```text
bounded
observable
backoff-aware
```

Do not create infinite retry loops.
External API failures must not cause request storms.

## 38. Circuit Breakers

If a future external service repeatedly fails, use a bounded failure strategy.
Do not continuously hammer an unavailable service.

## 39. Scope Discipline

If a task says:
"Fix the verse detector"
do not simultaneously:

```text
rewrite WebSocket
replace React
change database strategy
introduce plugins
rewrite Electron
```

unless the requested fix genuinely requires it.

## 40. Dependency Discipline

Before adding a dependency ask:

1. Is it actually necessary?
2. Can the standard library solve it?
3. Is an existing dependency already capable?
4. Does it increase security or maintenance risk?
5. Does it introduce a new architectural commitment?

Do not add dependencies for convenience alone.

## 41. No Premature Frameworks

Do not introduce:

```text
dependency injection frameworks
event frameworks
plugin systems
enterprise architecture frameworks
microservices
message brokers
```

unless the architecture explicitly evolves to require them.
An internal event mechanism can remain simple.

## 42. Documentation

When behavior changes, update the relevant documentation.

Architectural changes require updating:

```text
ARCHITECTURE.md
```

Scope changes require updating:

```text
ROADMAP.md
```

Security changes require updating:

```text
SECURITY.md
```

Testing strategy changes require updating:

```text
TESTING.md
```

## 43. Architecture Changes

Do not silently change:

- public interfaces
- WS protocol
- security boundaries
- provider contracts
- data models
- process boundaries
- scope

If a change is necessary, explain:

```text
why
what changes
what breaks
what tests are required
```

Then make the change deliberately.

## 44. Generated Code

AI-generated code must be reviewed like human-written code.

Do not blindly accept generated:

```text
authentication
crypto
IPC
WebSocket
audio processing
provider integrations
```

These areas require particular scrutiny.

## 45. No Fake Implementations

Do not claim a feature works when it is:

```text
mocked
stubbed
hard-coded
simulated
partially implemented
```

Use explicit names such as:

```text
MockAsrProvider
FakeVerseSource
TestTranscriptProvider
```

for test implementations.

## 46. No Silent Fallbacks

Do not silently change:

```text
provider
audio format
Bible source
language
security mode
```

when the primary implementation fails.
Failures should be explicit and observable.

## 47. Code Quality

Prefer:

```text
small functions
explicit types
clear names
single responsibility
deterministic behavior
early validation
```

Avoid:

```text
clever metaprogramming
deep inheritance
implicit global state
magic strings
hidden side effects
```

## 48. State Management

State transitions should be explicit.
Avoid scattered mutable globals.

If a state machine is required, define its states and transitions explicitly.

Example:

```text
DISCONNECTED
      ↓
CONNECTING
      ↓
CONNECTED
      ↓
RECONNECTING
      ↓
CONNECTED
```

Invalid transitions should be handled safely.

## 49. UI Rules

The UI must reflect application state.
Do not make UI state the authoritative source of business state.

For example:

```text
React state
```

must not be the only record of whether the microphone is actually running.
The application core/server state is authoritative.

## 50. Manual Override

Manual override is still subject to validation.
Do not create an "admin bypass" that can display arbitrary unsafe/unverified data.

If an operator enters:

```text
John 3:16
```

the same reference validation and verse lookup path should be used.

## 51. Emergency Clear

Emergency clear must be fast.
The overlay should not depend on a remote request to clear its local visual state.

## 52. Git Rules

Before committing:

```text
check git diff
check git status
inspect changed files
run relevant tests
```

Never commit:

```text
.env
API keys
tokens
credentials
large generated files
temporary logs
raw audio
```

## 53. Commit Discipline

Prefer focused commits.

Good:

```text
feat(asr): add Groq provider
test(detector): add French reference fixtures
fix(ws): reject invalid operator messages
fix(verse): validate API response
```

Avoid:

```text
update everything
massive refactor
misc fixes
```

## 54. Pull Request Discipline

A PR should explain:

```text
What changed?
Why?
Which architecture boundary is affected?
What tests were added?
What tests were run?
```

If no architecture boundary changed, say so.

## 55. Before Editing

Before editing an unfamiliar subsystem:

1. Read its interface.
2. Find its tests.
3. Find its callers.
4. Find its dependencies.
5. Understand its failure behavior.
6. Identify its architectural boundary.

Do not edit based only on the filename.

## 56. Before Adding a Feature

Ask:

```text
Which module owns this behavior?
Which interface does it use?
Which existing invariant could it affect?
What failure modes exist?
How will it be tested?
Does it belong to v1?
```

If those questions cannot be answered, investigate before coding.

## 57. Before Refactoring

Ask:

```text
Why is the refactor necessary?
What problem does it solve?
Can the same result be achieved with a smaller change?
What behavior must remain identical?
Which regression tests protect it?
```

Do not refactor solely because the code "could be cleaner."

## 58. AI Agent Behavior

AI agents must not:

- invent requirements
- expand scope
- remove safety checks
- bypass validation
- weaken authentication
- expose secrets
- silently change protocols
- replace providers without approval
- delete tests to make the build pass
- disable linting/type checking to hide errors
- suppress errors without understanding them
- modify unrelated modules

## 59. When Something Fails

Do not immediately rewrite the subsystem.

Use:

```text
1. Reproduce
2. Observe
3. Locate boundary
4. Inspect logs
5. Add instrumentation if necessary
6. Create regression test
7. Fix smallest root cause
8. Re-run tests
```

Prefer root-cause fixes over symptom suppression.

## 60. When Tests Fail

Do not:

```text
delete the test
weaken the assertion
skip the test
mock everything
```

without understanding the failure.

Determine whether:

```text
implementation is wrong
test is wrong
requirement changed
architecture changed
environment is broken
```

Then address the actual cause.

## 61. When Requirements Are Ambiguous

Do not invent important behavior.
For architectural questions, stop and identify the ambiguity.
For small implementation details, choose the least surprising behavior and document it.

## 62. Production Readiness

Before calling a feature complete, verify:

```text
happy path
invalid input
network failure
provider failure
timeout
reconnection
malformed response
duplicate message
out-of-order message
restart
configuration corruption
```

where applicable.

## 63. Final Pre-Commit Checklist

Before considering work complete:

```text
[ ] Scope respected
[ ] Architecture respected
[ ] Security boundaries respected
[ ] No secrets committed
[ ] Types compile
[ ] Lint passes
[ ] Relevant unit tests pass
[ ] Integration tests pass where applicable
[ ] No unrelated changes
[ ] Error handling reviewed
[ ] Logs reviewed
[ ] Documentation updated if needed
[ ] Git diff reviewed
```

## 64. Absolute Rules

The following rules override convenience:

```text
1. Never display an unverified verse.

2. Never let partial ASR trigger verse detection.

3. Never expose secrets to renderers.

4. Never let the overlay become a control client.

5. Never bypass schema validation.

6. Never silently expand v1 scope.

7. Never replace an architectural boundary with a shortcut.

8. Never hide failures that affect correctness.

9. Never remove a test simply because it is inconvenient.

10. Never introduce a framework when a small interface is sufficient.

11. Never claim a feature is complete when it is only mocked.

12. Never modify architecture silently.
```

## 65. Agent Operating Principle

When uncertain, prefer:

```text
small change
↓
test
↓
observe
↓
iterate
```

over:

```text
large rewrite
↓
hope
↓
debug everything
```

The purpose of AI assistance is to accelerate development without sacrificing architectural integrity.

## 66. Final Rule

The AI agent is an implementer, not the architect.
The architecture defines the boundaries.
The requirements define the behavior.
Tests define verified behavior.
The agent implements within those constraints.
Any architectural change must be explicit, documented, reviewed, and tested.
