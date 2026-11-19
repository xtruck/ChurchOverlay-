# ChurchOverlay full security audit (read-only)

Branch audit/production-fixes HEAD 26b8391. Placeholder written early; full content follows in appended parts.
Confidence: CONFIRMED = read in code; SUSPECTED = inferred. Nothing reproduced dynamically. Not re-reported (already in SECURITY.md): missing WS Origin check, IPC senderFrame checks, tokens in page URLs.

## Findings

### S-01 Medium (CONFIRMED) Viewer-token clients receive the raw mic transcript
- apps/server/core/app-core.ts:2776 (transcript:final/partial), :2465 (translation:final), :1348 (detector:near-miss), :1231 (verse:pending) use wsServer.broadcast(), which reaches the viewer role too. Only copilot/navigate results use broadcastToOperators().
- Scenario: anyone with a viewer token opens a raw WebSocket (subprotocol = token) and reads everything said into the mic. Desktop mode: viewer token is local unless phone remote (WS on 0.0.0.0) is on. Web Server Mode: viewer URLs (overlay/stage/Live Companion) are meant for the congregation, so every device gets the live transcript. No shipped viewer page consumes these events (grep found none).
- Fix: broadcastToOperators for these events and status:update error text; per-role event allow-list in the server; test that a viewer socket never receives them.

### S-02 Medium (CONFIRMED) Release pipeline runs unverified downloads with a write token
- .github/workflows/release.yml:26 contents: write for the whole job; :60 npm ci runs install scripts. node_modules/@stagetimerio/grandiose/scripts/ndi.js downloads innoextract-1.9-windows.zip (constexpr.org) and the NDI SDK exe (downloads.ndi.tv) with no hash check, executes innoextract.exe; the extracted NDI DLL ships in the installer.
- Also: actions pinned by mutable tag (checkout@v4, setup-node@v4, cache@v6, upload-artifact@v4, third-party softprops/action-gh-release@v2 receives the token); checkout persists credentials; workflow_dispatch runs the write job from any branch; cache restore-keys fallback allows cache poisoning; installer not Authenticode-signed (no cert config), no checksum published.
- Fix: separate build (read-only) and publish (write) jobs; persist-credentials false; SHA-pin actions; pre-fetch and SHA-256-verify NDI SDK/innoextract or vendor the DLL with a recorded hash; publish checksums; sign.

### S-03 Medium (CONFIRMED) Viewer-token holder can lock the operator out
- apps/server/ws/server.ts:474: the 64-connection cap applies after auth, equally to both roles. A viewer holder opens 64 sockets; the dashboard (reconnects after every service restart) and phone remote are refused. No per-IP cap, no failed-handshake throttling.
- Fix: reserve slots for operator or evict a viewer when an operator connects; per-address cap.

### S-04 Medium (CONFIRMED) Phone remote is cleartext on the LAN; operator token never rotates
- apps/desktop/main/index.ts:393 (WS binds 0.0.0.0), :620-631 (http remote page), apps/remote/public/remote.js:525 (ws:// with token in subprotocol header). Anyone on the Wi-Fi segment can sniff the operator token and fully control the overlay.
- Tokens are generated once (index.ts:1341,1373) and reused forever; no rotate/revoke IPC. Token is in the URL fragment (better than SECURITY.md says) but legacy ?token= is still accepted (overlay.js:20, remote.js:5) and then reaches logs/history.
- Fix: Regenerate-tokens action; rotate when phone remote is disabled; UI warning to use trusted networks; drop ?token= support.

### S-05 Low (CONFIRMED) Downloaded engines not re-verified; weak model pin
- faster-whisper-installer.ts:128 and local-asr-installer.ts:112: status() checks existence only; python.exe, site-packages (.pth/.pyd) and whisper-server.exe/DLLs run from a user-writable folder every start (index.ts:431-443). Same-user persistence only, not a privilege boundary.
- ggml models use SHA-1 and resolve/main, a mutable ref (local-asr-installer.ts:39-52). downloadWithProgress (:314) buffers unbounded in memory; redirect follow without host allow-list (the hash is the only control). Python ._pth adds the cwd (faster-whisper-installer.ts:193); spawn args lack -I.
- Fix: record and re-check file hashes before spawn; SHA-256 + pinned revision for ggml; cap downloads; python -I.

### S-06 Low (CONFIRMED) Custom Bible API: redirect bypass, unbounded text
- custom-bible-url.ts validates only the literal host; FreeApiSource uses default fetch (follows redirects) so an https host can 302 to loopback/LAN (blind). free-api-source.ts:151-160 only checks text/translation non-empty: no length cap or content check, so a compromised API pushes arbitrary or huge text to the stream and all WS clients.
- Fix: redirect error; cap body (~64 KB) and verse text (~2 KB).

### S-07 Low (CONFIRMED) Electron hardening gaps
- No setPermissionRequestHandler/CheckHandler (Electron default grants all); allow only media for the dashboard file URL.
- No Electron fuses/ASAR integrity (RunAsNode, NODE_OPTIONS, --inspect, onlyLoadAppFromAsar at defaults).
- No auto-update and no version check (no electron-updater): small attack surface but stale installs; installer unsigned.
- Dashboard CSP frame-src/connect-src allow any 127.0.0.1 port; served pages use meta CSP only (no frame-ancestors/X-Frame-Options), so they can be framed (token is in the fragment, so low).

### S-08 Low (CONFIRMED) Log scrubber gaps
- packages/shared/logger.ts: metadata string values are matched only by an anchored gsk_/sk-/Bearer prefix; a prefixless Deepgram key under an innocuous key name passes (inline/hex patterns only run on the error field). stderrTail metadata (local-whisper-server.ts:224) is unscrubbed (holds no keys today).
- index.ts:1853-1855 generate-service-summary returns the raw upstream error to the renderer (the extras handler scrubs).

### S-09 Low (CONFIRMED) Web Server Mode hygiene
- apps/web/index.ts:185-188 prints all token-bearing URLs incl. the operator token to stdout (persists in journald/Docker logs). x-powered-by on; no Host validation; upload written to data/temp before signature check (operator-token only, cleaned in finally).

### S-10 Low (SUSPECTED) allowScripts may be inert
- package.json:97 allowScripts is not a documented npm key as far as I know. Install scripts in lockfile: @stagetimerio/grandiose (optional) and electron-winstaller (dev). Prefer ignore-scripts in .npmrc plus explicit electron-rebuild.

### S-11 Info (CONFIRMED) Dependencies (npm audit run today)
- --omit=dev: 1 moderate, qs 6.16.0 GHSA-6pq8-jhm2-2vcw (qs.stringify; Express uses parse; unreachable). All: 13 moderate, 0 high/critical (minimatch via electron-builder and typescript-eslint, build-time only). The suggested --force downgrade is wrong.
- scripts/audit-gate.mjs allowlists only braces GHSA-vfj7-8cjw-p6xm, which npm audit no longer reports: dead entry, remove. SECURITY.md claims two entries and a braces chain in the prod audit: stale.
- electron 44.9.3, express 4.22.3, ws 8.22.0, dotenv 18; lockfile v3, all registry + integrity. Python wheels (numpy, onnxruntime, huggingface_hub, protobuf, pyyaml, av) are hash-pinned but never scanned; add pip-audit.

### S-12 Info SECURITY.md drift
- Says query token (actually fragment, legacy query still accepted), two audit allowlist entries, prod braces chain. Update after S-01/S-03.

## Verified fine (no issue found)
- webPreferences: dashboard nodeIntegration false, contextIsolation true, sandbox true; preload is an explicit flat API; NDI and quote-card windows sandboxed, quote-card has javascript:false and escaped content. No webviewTag, no custom protocols; openExternal only for https from window-open; window.open denied; will-navigate pinned for every webContents; single-instance lock.
- All ipcMain handlers validate or enumerate input; only import-media-drop takes a renderer path (local drive-letter only, UNC refused, extension + magic bytes + size checked); exports use main-side dialogs and fixed filenames; keys are write-only from the renderer.
- Secrets: all three API keys and both tokens via safeStorage (app refuses to start otherwise), atomic writes, .bak also encrypted; keys only in headers over TLS to Groq/Deepgram/Anthropic; sidecars get audio only, no keys. Session history, diagnostics and exports hold verse text/counts only; no audio persisted, no crash reporter.
- Zip-slip: whisper.cpp extraction writes only a fixed filename list, flattened; wheel/Python extraction uses writeInside with a resolved-prefix check after backslash normalisation. Python, wheels, faster-whisper models, whisper.cpp zip are exact-URL + SHA-256 pinned and verified before write; pip never run; https only, no rejectUnauthorized overrides.
- Static/media serving: GET/HEAD only, bad escape/NUL gives 400, prefix check against traversal, nosniff + no-referrer, media by ULID lookup only (stored names re-validated), no SVG media, Range bounded and streamed. Logo re-encoded. Media: extension + magic bytes + size caps.
- WS: constant-time token compare, double check, 1 MiB maxPayload, 100 msg/s, heartbeat, 4 MiB slow-consumer drop, error handler, guarded callbacks, role-based registry with hasOwnProperty guard, server-only events unsendable, binary audio operator-only and bounds-checked.
- Web API: Bearer operator token before body parse, constant-time, min token length, distinct tokens, loopback default.
- XSS: all pages have CSP default-src none + script-src self; innerHTML only with constants/ULIDs; untrusted text via textContent; overlay style normalised; quote cards escaped.
- Prompt injection: speech reaches only detector, known-valid index, verse source; AI gets final text only, off by default, rate-capped; outputs strictly parsed; semantic result is verse:pending only; copilot operator-only and length-bounded. Markdown export carries AI text unescaped (Info).
- No eval/Function; only two fixed array-arg spawns, no shell. No secrets tracked; .env* ignored. ci.yml is read-only, --ignore-scripts, no pull_request_target.

## Ranked top 10
1. S-01 viewer tokens read the live mic transcript.
2. S-02 release job executes unverified downloads with a write token; unsigned installer; unpinned actions.
3. S-03 viewer can exhaust connection slots and lock out the operator.
4. S-04 cleartext phone remote with permanent operator token.
5. S-05 engine binaries unverified after install; SHA-1/mutable model pin; unbounded downloads.
6. S-06 custom Bible URL redirect and unbounded verse text.
7. S-07 no permission handler, fuses, update check; framable pages.
8. S-08 scrubber misses metadata values; unscrubbed IPC error.
9. S-10 allowScripts possibly inert.
10. S-11/S-12 stale audit allowlist and docs; qs moderate unreachable; wheels unscanned.
