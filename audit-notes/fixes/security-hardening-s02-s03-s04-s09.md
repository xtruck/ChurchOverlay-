# Security hardening pass (S-02, S-03, S-04, S-09) — 2026-11-16

Four audit findings closed in one owner-requested pass. The full narrative, thresholds and behavior handoffs are recorded in ARCHITECTURE.md section 147. Commits, in order:

## S-04 — Phone remote cleartext / operator token never rotates (commit b0276ec)
- `ChurchOverlayWsServer.setTokens()` (apps/server/ws/server.ts): live token swap; each CHANGED token terminates exactly the sessions authenticated with the old one (reported via onRejected); unchanged tokens keep their sessions; no-op rotation revokes nothing.
- `rotate-token` IPC (apps/desktop/main/index.ts): persists the new token + generation date via ConfigStore.update, swaps the running server, rebuilds the OBS and phone-remote URLs without restarting a listener, reloads the NDI window on viewer rotation.
- New config fields: `allowPhoneRemoteWarningAck`, `operatorTokenGeneratedAt`, `viewerTokenGeneratedAt` (optional, tolerant decode, never defaulted silently).
- Dashboard: per-token Rotate buttons (OBS = viewer, Phone Remote = operator), token-age lines with a 7-day stale alert (EN/FR), and the WS reconnect re-reads the live connection info so a rotation can no longer brick the dashboard's own session.
- Trusted-network warning: the FIRST allowPhoneRemote activation shows an explicit warning whose acknowledgment persists; both entry points (setup checkbox, dashboard toggle) record it.
- Residuals: remote stays cleartext HTTP (TLS local / PIN pairing remain future work); tokens cannot yet be rotated from the dashboard in apps/web mode (env constants); installer still unsigned (S-07/P2).

## S-03 — Viewer-token holder can lock the operator out (commit fe0a639-era, "rate-limit the WS handshake and /api")
- `HandshakeRateLimiter` (apps/server/ws/handshake-rate-limiter.ts) + `packages/shared/ip-utils.ts`: sliding window per client address (10 attempts/min default), 60 s self-inflicted ban after 3 refusals, bounded map (4 096, insertion-order eviction), loopback exempt, IPv4-mapped IPv6 bucketed with its IPv4 self.
- `verifyClient` on the WS server: unwanted upgrades get a real HTTP 429/503 + Retry-After instead of a hanging socket; role classification pre-handshake through the server's constant-time comparator (never `===` on attacker-controlled input).
- `reservedOperatorSlots` (default 1): viewers stop at maxConnections - reserved; an operator arriving at the FULL cap evicts the OLDEST viewer (bounded `connectedAt` map, deleted on close); the handleConnection backstop counts OPEN clients so an evicted socket cannot block its replacement. `reservedOperatorSlots: 0` restores the old first-come behavior.
- `/api` (apps/web/api-auth.ts): `createApiRateLimiter` (60 req/min per address, 429 + Retry-After, loopback exempt) installed BEFORE the token check and body parser.
- Thresholds (all overridable, all unit-tested): handshake 10/min, ban 60 s/3 refusals, /api 60/min, reserved slots 1.

## S-09 — Token-bearing URLs printed to stdout (commit "mask tokens in every printed URL")
- `apps/web/redact-url.ts`: `redactUrl()` masks the token (4-char fingerprint) in both the `#token=` fragment and the legacy `?token=` query form; anything else in the URL passes through byte for byte.
- apps/web/index.ts startup console: masked URLs by default, with a self-explaining notice; `CHURCHOVERLAY_PRINT_FULL_URLS=1` opts back in for a trusted console; real links remain available to the authenticated /api/status caller.
- scripts/dry-run.ts and scripts/dev-preview.ts: same masking (dev-preview printed the OPERATOR token in full).

## S-02 — Release pipeline runs unverified downloads with a write token (commit f3efbc9)
- Both workflows pin every external action to a FULL COMMIT SHA verified with `git ls-remote <repo> refs/tags/<tag>{}` at write time (checkout 11d5960a…, setup-node 49933ea5…, cache 55cc8345…, upload-artifact ea165f8d…, download-artifact d3f86a10…, softprops/action-gh-release 3bb12739…), each with its version in a comment.
- release.yml: build job (contents: read) builds, tests on Windows, generates SHA256SUMS.txt (GNU sha256sum -c compatible via Get-FileHash) and uploads the artifact; release job — the only contents: write holder, runs solely on a version tag — downloads the artifact and attaches installer + checksums to the GitHub Release, checksums also inline in the notes.
- Still open from the S-02 description (next passes): NDI SDK/innoextract download hash verification, `persist-credentials: false`, cache restore-keys narrowing, Authenticode signing (S-07/P2), the npm-install-scripts download path itself.
