# Security Model

This document describes ChurchOverlay's actual, current security posture (ARCHITECTURE.md
section 49) and where each requirement is implemented. AGENTS.md section 42 requires this
file to be updated whenever a security-relevant change is made — treat a stale claim here
as a bug.

## Requirements and where they're enforced

1. **Local server binds to `127.0.0.1`.**
   `ChurchOverlayWsServer` and `StaticServer` both default to `127.0.0.1`
   (`apps/server/ws/server.ts`, `apps/server/http/static-server.ts`).

2. **External binding is disabled by default.**
   Same as above — no code path in the shipped app passes a different host.

3. **Tokens are not URL parameters** (for the WebSocket handshake itself).
   `ChurchOverlayWsServer` reads the token from `Sec-WebSocket-Protocol`
   (`apps/server/ws/server.ts`'s `resolveProtocol()`), never from the connection URL's
   query string. The one deliberate, documented exception is the *page* URL, not the
   socket URL: every served page — the OBS overlay, the Stage Display, the Live
   Companion, and the phone remote — receives its token as a query parameter, because
   OBS Browser Source and a plain browser tab have no other channel to receive
   credentials. The WS connection each page's JS opens still authenticates with
   `Sec-WebSocket-Protocol`, never with the page URL.

4. **Tokens are encrypted at rest.**
   `ConfigStore` (`apps/desktop/main/config-store.ts`) encrypts the Groq, Deepgram and
   Anthropic API keys (the latter two optional) and both WS tokens via Electron's
   `safeStorage` before writing `config.json`. The app
   refuses to start if `safeStorage.isEncryptionAvailable()` is false rather than
   falling back to plaintext.

5. **Renderer cannot access secrets.**
   The dashboard `BrowserWindow` runs with `nodeIntegration: false`, `contextIsolation:
   true`, `sandbox: true` (`apps/desktop/main/index.ts`). Its only bridge to the main
   process is `apps/desktop/preload/index.ts`'s narrow `contextBridge` API — it hands
   the renderer the one operator token needed for its own WS connection, and nothing
   else (see that file's doc comment for the exact threat model this token defends
   against).

6. **All WS messages are schema-validated.**
   `validateWsMessage()` (`apps/server/ws/action-registry.ts`) checks every inbound
   message against `ACTION_REGISTRY` before it reaches application logic, including a
   role check (an operator-only command from a viewer connection is rejected) and a
   `hasOwnProperty` guard against prototype-pollution-style type strings.

7. **Overlay is read-only.**
   The overlay `BrowserWindow`/page has no preload at all — it never receives
   `contextBridge` access to anything. `apps/overlay/public/overlay.js` only ever
   listens for `verse:show`/`verse:clear`; it has no code path that sends a command.
   The dev-only operator dashboard that *can* send commands
   (`apps/overlay/dev-preview/`) is deliberately excluded from
   `apps/overlay/public/` — the one directory the production `StaticServer` and
   electron-builder's packaging config actually serve/ship — so it never reaches a
   real build.

8. **External API responses are schema-validated.**
   `FreeApiSource` (`apps/server/verse/free-api-source.ts`) validates every field of
   bible-api.com's response before constructing a `Verse`, and throws (rather than
   returning a half-formed result) on a malformed 200 body.

9. **No secrets are logged.**
   `Logger` (`packages/shared/logger.ts`) redacts any metadata value whose key name
   matches a secret pattern (`key`, `token`, `secret`, `password`, `credential`,
   `authoriz`) or whose value looks like a credential (`gsk_...`, `sk-...`,
   `Bearer ...`), recursively through nested objects and arrays.

10. **No arbitrary code execution through messages.**
    WS message payloads are plain data validated against fixed shapes
    (`ACTION_REGISTRY`'s `validatePayload`) — nothing in the pipeline `eval`s,
    `Function()`-constructs, or otherwise executes payload content.

11. **No dynamic plugin loading.**
    There is no plugin/extension-loading mechanism anywhere in the codebase. The four
    extension seams (`AsrProvider`, `VerseDetector`, `VerseIndex`, `VerseSource`) are
    fixed TypeScript interfaces, wired via constructor injection in
    `apps/server/core/app-core.ts` — never discovered or loaded at runtime.

12. **No arbitrary filesystem paths from untrusted WS payloads.**
    No WS command payload is ever used to construct a filesystem path.
    `StaticServer`'s own request handling (a separate, unauthenticated-by-design HTTP
    surface for OBS) rejects any resolved path outside its fixed `rootDir` before
    reading a file.

13. **A WebSocket connection that presents no token at all is never admitted.**
    `ChurchOverlayWsServer` (`apps/server/ws/server.ts`) enforces the token twice:
    `resolveProtocol()` refuses a non-matching offered protocol during negotiation, and
    `handleConnection()` re-checks the *negotiated* `socket.protocol` and terminates the
    socket before any role is assigned. The second check is not redundant: `ws` only
    invokes `handleProtocols` when the client offers at least one protocol, and it still
    completes the 101 handshake (with no protocol selected) when that hook returns false
    — so a client offering nothing used to reach the connection handler with
    `protocol === ""` and was classified as a **viewer**, receiving `verse:show`
    broadcasts and the late-join layout/branding state without presenting any token.
    All five shipped pages that open a WebSocket
    (`apps/overlay/public/overlay.js`, `apps/remote/public/remote.js`,
    `apps/stage/public/stage.js`, `apps/live/public/live.js`,
    `apps/desktop/renderer/dashboard.js`) present their token via
    `Sec-WebSocket-Protocol` and never in the connection URL;
    `apps/server/ws/client-handshake.test.ts` fails if a shipped page regresses to
    either mistake. Web Server Mode publishes the matching token-bearing page URLs
    (`/api/status`, `/api/setup`, and the startup banner, all from
    `apps/web/status-payload.ts`): the read-only pages (overlay, Stage Display, Live
    Companion) get the viewer token, and only the phone remote gets the operator token.
    The dev-only overlay dashboard (`apps/overlay/dev-preview/`) is excluded from that
    test because it is never packaged or served (item 7).

14. **Web Server Mode's REST API requires the operator token, and binds to loopback
    by default.**
    Every `/api/*` route in `apps/web/index.ts` sits behind `installApiGuard()`
    (`apps/web/api-auth.ts`): the operator token must arrive as
    `Authorization: Bearer <token>` (never in the URL), is compared in constant time,
    and is checked *before* the JSON body is parsed, so an unauthenticated caller
    cannot make the server buffer a 50 MB upload. `/api/status` and `/api/setup`
    return the page URLs and tokens, so they are protected the same way — before
    this, any host that could reach the port could read the operator token from
    `/api/status` and take full operator control. The server listens on `127.0.0.1`
    unless `WEB_HOST` is set (ARCHITECTURE.md sections 24 and 49), and prints a
    warning when it is bound to a non-loopback address. The phone remote
    (`apps/remote/public/remote.js`) sends its own token for `/api/service-pack`.
    `/media/<id>` and the static pages stay open by design: media ids are
    unguessable ULIDs and the pages carry no secrets of their own.

15. **A single WebSocket message is capped at 1 MiB, and a socket error cannot crash
    the process.**
    `ChurchOverlayWsServer` sets `maxPayload` (`ws` defaults to 100 MiB, which any
    token holder, including the read-only viewer, could make the server buffer).
    `ws` reports an oversized or malformed frame as an `'error'` event on the
    socket; with no listener that became an uncaught exception that killed the whole
    server mid-service, so `handleConnection()` now listens for it and reports it
    through `onRejected` while `ws` closes the connection (code 1009 for size).

16. **A dead or stalled WebSocket client cannot hold the server's memory hostage.**
    `ChurchOverlayWsServer` pings every admitted client on a 30 s heartbeat
    (`heartbeatIntervalMs`, `0` disables) and terminates any that neither answered
    the previous ping nor sent a message since; browsers and `ws` clients pong
    automatically, and any inbound message counts as liveness so a busy operator
    streaming audio is never dropped for a late pong. Separately, `broadcast()`
    drops a client whose unsent queue passes `maxBufferedBytes` (4 MiB) instead of
    letting `ws` buffer for it without bound (AGENTS.md section 36). Both drops are
    reported through `onRejected`, never silent, and the heartbeat timer is
    `unref()`'d and cleared in `close()`. A dropped client reconnects through the
    clients' existing capped-backoff loop.

17. **The static/media server is read-only, strict about its input, and streams.**
    `StaticServer` answers only `GET` and `HEAD` (405 otherwise); a malformed
    `%`-escape or a NUL byte in the path is a 400 rather than a 500; every response
    carries `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`
    (the loopback URL can carry a token). Imported media is streamed from disk with
    HTTP Range support (206/416) instead of being read whole into memory: a 300 MB
    video previously cost ~346 MB of resident memory per request, whether the
    browser asked for the whole file or one kilobyte of it. Directory traversal
    handling is unchanged (403) and still covered by its original tests.

18. **SVG is served only as the app's own bundled artwork, never as imported media.**
    The logo files (`favicon.svg` in the remote/stage/live pages) are served as
    `image/svg+xml` from the bundled-files table. The operator-imported media table
    deliberately has no SVG entry, because an imported SVG can carry script and is
    served from the same loopback origin as the pages. The phone remote's CSP gained
    `img-src 'self'` (and nothing broader) so its icon is not blocked by
    `default-src 'none'`.

19. **Overlay style input is normalized, never trusted, and cannot inject CSS or markup.**
    `normalizeOverlayStyleSettings()` drops unknown keys, checks enums against closed lists,
    clamps numbers, caps and sanitizes text, and accepts colours only as `#rrggbb`. The overlay
    page writes text with `textContent` and values through CSS custom properties, never
    `innerHTML`. `overlay:style` is a server-only event no WebSocket client may send.
    (ARCHITECTURE.md section 110.5.)
20. **The church logo is validated and re-encoded, never served as uploaded.** At most 5 MB,
    format decided by magic bytes (PNG/JPEG/WebP; SVG is refused because it can carry script),
    decoded, bounded to 4096 px, re-encoded as a PNG under 1024 px wide and written
    atomically. `/brand/logo` serves only that stored file (no request data is used as a
    path), with `nosniff` and `no-referrer`. The overlay never receives a file path or bytes
    over the WebSocket. (Section 110.6.)

21. **The faster-whisper engine is downloaded, not trusted.** Embeddable Python, every wheel and every
    model file are pinned to an exact URL and SHA-256 in `faster-whisper-manifest.ts` and verified
    before any byte is written; pip is never run (no install-time code from sdists, no dependency
    resolution at the user's machine). Archive entry names are checked to stay inside the target folder.
    The sidecar binds `127.0.0.1` only, on a free port chosen per start, caps the request body
    (16 MiB), and accepts only 16 kHz mono PCM WAV. It receives audio only; no keys or tokens.
    Residual risk: the pinned packages themselves, and that localhost ports are reachable by other
    local users/processes on the same machine. (Section 113.)

22. **The optional Anthropic (Claude) helpers send transcript text only, are off by default,
    and never reach the screen on their own.** Nothing is sent unless an AI service has been chosen and has its key, and
    every helper (transcript cleanup, semantic suggestions, sermon copilot) has its own live
    toggle that defaults to OFF, and the AI service itself is an explicit choice (Anthropic, or the
    free Groq text models reusing the transcription key) that never switches silently
    (ARCHITECTURE.md section 128) (`DEFAULT_AI_FEATURES`, `apps/server/ai/ai-features.ts`).
    What leaves the machine is FINAL transcript text (a partial never reaches a helper, and
    no audio is ever sent) when a helper is on; a post-service extras export sends the session
    notes only on an explicit button press. The key stays in the main process (the renderer only
    learns whether one exists); errors and log lines go through `scrubSecrets`; every helper is
    rate-capped (`CallBudget`) and bounded in flight. The model is never trusted: a proposed
    reference goes through the detector, the known-valid index and the verse source and ends as
    a `verse:pending` suggestion, never `verse:show`; the copilot's output goes to operator
    clients only. Residual risk: caption and slide text written by the model is free text that is
    not grounded in the Bible (an operator who pastes it to the screen is responsible for it), and
    anyone audible to the microphone can influence the transcript the model reads. With the Groq
    option the final transcript text goes to Groq, which already receives the audio.
    (ARCHITECTURE.md sections 121, 123-126.)


## Known, deliberate trade-offs

- Every served page URL carries its token as a query parameter (see item 3 above). This
  is a documented compromise forced by OBS Browser Source and plain browser tabs having
  no credential channel of their own, not an oversight — the socket each page then opens
  authenticates with `Sec-WebSocket-Protocol`, so the token is never repeated there.
- Both WS clients (`apps/overlay/public/overlay.js`,
  `apps/desktop/renderer/dashboard.js`) reconnect indefinitely on disconnect, using
  capped exponential backoff (1s doubling up to a 30s ceiling) rather than ever giving
  up. For a live, always-on broadcast overlay, giving up permanently after N attempts
  would be worse than a bounded-but-endless retry.

- The CI dependency audit (`scripts/audit-gate.mjs`) allowlists two high-severity advisories
  with no patched release: `braces` (GHSA-vfj7-8cjw-p6xm, via the optional NDI module's
  build-time globbing) and `http-cache-semantics` (GHSA-ch52-4w7c-c8xp, via `got` downloads).
  Every other high/critical advisory still fails the build. Remove an entry when a fix ships.

## Reporting a problem

This is a small, single-operator application with no network-facing attack surface
beyond `127.0.0.1`. If you find a real vulnerability, open an issue describing it —
there is no separate disclosure process at this project's current size.
