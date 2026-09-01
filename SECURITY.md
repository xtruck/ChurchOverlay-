# Security Policy

ChurchOverlay is an Electron desktop app for running a live church
service (speech transcription → Bible verse detection → overlay
broadcast) plus an operator dashboard. This document describes the
project's actual security posture, not a generic template.

## Supported versions

This project does not maintain parallel supported release branches —
security fixes land on `main` and ship in the next release. There is no
LTS/backport policy at this stage.

## Threat model

The realistic attacker for this app is **not** a remote internet
adversary by default: the WebSocket pipeline binds to `127.0.0.1` unless
an operator explicitly changes `WS_HOST` to expose it on a church's local
network (documented use case: a second operator station, a stage
monitor, a phone-as-camera). The threats actually worth defending
against:

- A device on the same LAN (once `WS_HOST` is opened up) attempting to
  connect without authorization, or a browser-based cross-site WebSocket
  connection attempt from a page the operator happens to have open.
- A leaked/observed **viewer** credential (the URL pasted into an OBS
  Browser Source is inherently more exposed — visible in OBS scene
  settings, shareable by accident) being used to gain more than read-only
  overlay access.
- Malformed or malicious WebSocket payloads from any connected client
  (operator mistake, compromised extension, or a genuine attacker who
  obtained a valid token) crashing the pipeline mid-service or corrupting
  persisted data.
- A compromised/malicious npm dependency or renderer-side script trying
  to reach the filesystem or shell via Electron's IPC surface.

Out of scope for this policy: physical access to the operator's machine,
a compromised Groq/Deepgram/Gemini API account, or a fully malicious
operator with legitimate credentials.

## Electron security controls

- **`contextIsolation: true`, `nodeIntegration: false`** on every
  `BrowserWindow` (dashboard, overlay, stage display, announcement loop,
  branding overlay, phone-camera pairing). The renderer never has direct
  access to `require`, `fs`, or `child_process`.
- **`sandbox: true`** on every window, plus an explicit
  Content-Security-Policy meta tag on every HTML page served — see the
  `<meta http-equiv="Content-Security-Policy">` at the top of each
  `*.html` file. `setup.html` is the one page allowing `'unsafe-inline'`
  script (a real inline `<script>` with the setup-wizard logic);
  `object-src`/`base-uri`/`form-action` stay `'none'` everywhere
  regardless.
- **`preload.js`** is the only bridge to native functionality, via
  `contextBridge.exposeInMainWorld('churchOverlay', {...})`. It exposes a
  fixed, narrow set of functions (settings, media picker, WS token
  retrieval, IPC event subscriptions) — never a generic `invoke(channel,
...args)` passthrough that would let the renderer call arbitrary main
  process code.
- **Renderer navigation is restricted**: `will-navigate` and
  `setWindowOpenHandler` are wired on every `BrowserWindow` to reject
  navigation to unexpected origins and block `window.open()` from
  spawning unmanaged windows.
- **API keys and WebSocket tokens are stored encrypted** via Electron's
  `safeStorage` (OS-level credential encryption — DPAPI on Windows), not
  in plaintext JSON. If `safeStorage` is unavailable on a given machine,
  the app falls back to plaintext storage and logs a warning — this is a
  known, accepted degradation for that edge case, not silent.

## WebSocket authentication and origin checks

- Two independent, randomly generated (32-byte) tokens: `WS_AUTH_TOKEN`
  (operator, full control) and `WS_VIEWER_TOKEN` (read-only — used by the
  overlay/OBS and other display-only screens). Generated on first launch
  of the installed app and persisted encrypted; an advanced user who sets
  either explicitly in their environment is never overridden.
- The token travels via the `Sec-WebSocket-Protocol` handshake header,
  not a `?token=` query parameter — a reverse proxy or CDN placed in
  front of an exposed server would otherwise log the token in its request
  URI logs by default.
- **Role is determined by which token was presented**, never by the
  connection path (`/` vs `/overlay`) — a client presenting the viewer
  token gets the viewer role even if it connects to `/`.
- **Origin validation** (`validateOrigin()` in `server.js`) is
  **defense-in-depth, not the primary access control**: a non-browser
  client can set or omit any `Origin` header it likes. On a local bind
  (`WS_HOST` = `127.0.0.1`/`localhost`, the default) origin is not
  checked at all — a single-machine bind is inherently safe from
  cross-origin browser attacks. On a non-local bind, origin must match
  `ALLOWED_ORIGINS` **exactly** (not by prefix — a `startsWith()`
  comparison was found and fixed during a security review, since it
  would have accepted a forged origin like
  `http://localhost:<port>.attacker.example`).
- **A non-local `WS_HOST` requires `WS_AUTH_TOKEN` to be configured** —
  the server refuses to start otherwise. There is no way to expose the
  pipeline on a network without authentication enabled.
- **WebSocket backpressure**: `broadcast()` checks each client's
  `ws.bufferedAmount` before sending and terminates a connection whose
  send buffer isn't draining at all (see `websocket-backpressure.js`) —
  a stalled/malicious client can't accumulate unbounded server-side
  memory by simply never reading its socket.

## Authorization (operator vs. viewer)

`action-registry.js` (`CLIENT_ACTIONS`, field `operatorOnly`) is the
single source of truth for which of the 103 client actions require the
operator role; `server.js` builds `OPERATOR_ACTIONS` from it once at
startup and gates every incoming message against `ws.clientRole` before
any handler runs. There is no per-handler ad hoc authorization check to
audit separately.

## Input validation

Every client action has a schema in `validation.js` (`SCHEMAS`,
required/optional fields, typed/bounded validators, unknown fields
rejected). This is enforced centrally in `server.js`'s message handler,
before any handler in `*-ws-handlers.js` runs. `applyTheme`'s `css`
payload specifically restricts allowed CSS custom-property names and
rejects control characters / stylesheet-breakout sequences, since it
reaches `root.style.setProperty()` on the live overlay.

`test/test-validation.js` asserts (Test 38) that every action in
`CLIENT_ACTIONS` has a corresponding schema — a missing schema for a new
action is a test failure, not a silent gap.

## Persistence safety

All local JSON stores (media library, scenes, songs, rundown, sermon
archive, branding) write atomically via `persistence/atomic-json-store.js`
(temp file, `fsync`, atomic rename, cleanup on any failure) rather than a
direct `fs.writeFileSync` on the live file — a crash mid-write can no
longer leave a half-written, corrupted store. Every read tolerates a
corrupted or missing file by falling back to an empty index rather than
throwing.

## Secret handling

- API keys (Groq, Deepgram, Gemini) and WebSocket tokens are encrypted at
  rest via `safeStorage`; never committed, never logged in full.
- `.env` is git-ignored; `.env.example` documents required variables
  without real values.
- Never paste a real API key or WebSocket token into an issue, PR, or
  commit message when reporting a bug.

## Reporting a vulnerability

Please report security issues privately rather than opening a public
GitHub issue. Open a private security advisory on this repository
(GitHub → Security → Advisories → "Report a vulnerability") or contact
the maintainer directly. Include enough detail to reproduce (which
component, expected vs. actual behavior); a fix timeline depends on
severity but will be communicated once triaged.

## Known risks that remain

- **`operatorOnly` broadcast filtering exists but isn't applied yet.**
  `broadcast()` supports skipping viewer-role clients for a given
  message, but no existing broadcast call site uses it — every message
  still reaches every connected client regardless of role. Restricting
  this requires auditing exactly what each viewer-capable page
  (`overlay.js`, `stage-display.html`, `branding-overlay.html`,
  `announcement-loop.html`) actually consumes first, to avoid silently
  breaking a live public display.
- **Dashboard inline `onclick=` handlers.** `dashboard.html` still wires
  most interactions via inline `onclick="fn(...)"` rather than
  `addEventListener`, which is why ~34 `dashboard/features/*.js` files
  re-export their functions on `window`. This is not a live injection
  vector today (no user-controlled value is interpolated into these
  attributes), but it's a larger attack surface than necessary and a
  known cleanup item, not yet done.
- **No formal dependency-audit gate in CI beyond `npm audit`.** Run
  `npm run security:audit` locally before a release; there is no
  automated blocking check yet.
- **`WS_VIEWER_TOKEN` is optional.** If an operator sets `WS_AUTH_TOKEN`
  manually without also setting `WS_VIEWER_TOKEN`, the overlay/OBS
  connection falls back to using the operator token, over-privileging a
  connection meant to be read-only. The app warns about this
  (`config-validator.js`) but does not block startup over it.

This project does not claim any compliance certification (SOC2, ISO
27001, or similar) — none has been pursued or audited.
