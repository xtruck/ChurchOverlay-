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
   query string. The one deliberate, documented exception: the *page* URL that OBS's
   Browser Source loads (`apps/overlay/public/index.html?token=...`) does carry the
   viewer token as a query parameter, because Browser Source has no other channel to
   receive credentials. The WS connection that page's JS opens still uses
   `Sec-WebSocket-Protocol`, not the page URL, to authenticate.

4. **Tokens are encrypted at rest.**
   `ConfigStore` (`apps/desktop/main/config-store.ts`) encrypts the Groq API key and
   both WS tokens via Electron's `safeStorage` before writing `config.json`. The app
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

## Known, deliberate trade-offs

- The overlay page URL carries a viewer token as a query parameter (see item 3 above).
  This is a documented compromise forced by OBS Browser Source's lack of a credential
  channel, not an oversight.
- Both WS clients (`apps/overlay/public/overlay.js`,
  `apps/desktop/renderer/dashboard.js`) reconnect indefinitely on disconnect, using
  capped exponential backoff (1s doubling up to a 30s ceiling) rather than ever giving
  up. For a live, always-on broadcast overlay, giving up permanently after N attempts
  would be worse than a bounded-but-endless retry.

## Reporting a problem

This is a small, single-operator application with no network-facing attack surface
beyond `127.0.0.1`. If you find a real vulnerability, open an issue describing it —
there is no separate disclosure process at this project's current size.
