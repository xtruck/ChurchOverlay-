# ChurchOverlay full audit (ECC production-audit method) — 2026-11-12

Branch `audit/production-fixes` @ `26b8391` (1.0.8). Seven read-only specialist audits plus a local operations check.
Detail files in this folder: `security.md`, `typescript-core.md`, `silent-failures.md`, `performance.md`,
`accessibility-ux.md`, `tests.md` (the architecture/docs audit was delivered in chat; its content is summarised below).

## Verdict

**Production audit: 62/100, Risky — fine for a supervised live test with the operator watching, not yet for an unattended service.**

Score caps applied (ECC): capped at 69 because there is no documented rollback path (no auto-update, unsigned installer,
no downgrade-safe config) and at 84 because the launch-critical path (real mic -> real ASR -> overlay in OBS) was never
tested end to end. Points lost mainly for operational blindness: the app cannot tell the operator it is deaf, dropping
verses, or crashing, and leaves no log file to diagnose afterwards.

What is genuinely strong: no Critical/High security finding, no secret reaches logs/exports/renderer, Electron isolation and
IPC validation are solid, downloads are hash-pinned, config writes are atomic, no memory growth in a simulated 3-hour
service, the audio hot path costs ~0.2% of one core, partial transcripts never reach detection, no boundary violations or
import cycles, no scope-lock breach. Verse-display core is ~100% covered.

## Blockers for an unattended service (fix before relying on it live)

| # | Finding | Evidence |
|---|---|---|
| B1 | **No log file, no crash handling in the desktop app.** Logs go to console only (comment says "rotating" but it is not implemented). Desktop main has no `uncaughtException`/`unhandledRejection` handler; the dashboard window (mic owner) has no `render-process-gone` handler; startup failures just quit. | SF-01, arch audit, TS-06 |
| B2 | **A dead mic looks alive.** Unplug / sleep-wake / renderer crash leaves "mic active" with no audio; no track-ended, devicechange or silence watchdog; failures all labelled "permission denied"; a failed `mic:start` is log-only. | SF-02, SF-06, SF-08 |
| B3 | **Spoken verses can be dropped silently.** A failed lookup is only logged; the French source has no fetch timeout (breaker probe can stick forever => French verses stop). | SF-03, SF-04, TS-03 |
| B4 | **Ordinary speech changes the display language.** "il parle en français" flips display mode and persists it (reproduced). | TS-01 |
| B5 | **Language/translation toggles stop working after saving a custom Bible URL** (orphaned verse source instance). | arch audit |
| B6 | **Config quarantine loses the keys.** One bad enum field or one decrypt failure moves the whole `config.json` aside (keys included) and shows first-run setup; `.bak` is written but never read; downgrade triggers it. | SF-10, TS-10, arch |

## High-value fixes (small effort, do before the first live test)

1. TS-06 `"constructor 3:16"` throws inside the transcript handler (prototype property as book): use own-property lookup. Tiny.
2. TS-02 failover retry storm (101 start attempts for 100 frames): add backoff/guard.
3. SF-05 Groq 401/403/5xx never fails over and drops audio silently.
4. TS-08 bare compact references ("Jean 5 6 qui", "Daniel 3 4") still auto-show: make that form pending-only.
5. S-01 viewer-token clients receive raw mic transcript / pending verses: send to operators only (matters if web mode is exposed to the congregation).
6. SF-29 overlay never clears on disconnect: add a local fail-safe clear (~20 s).
7. SF-09 every dashboard reconnect re-sends `mic:start` => gate recalibrates on live speech.
8. UX-01 announcement/definition/outline text is hard-coded white (invisible on 6 light palettes); UX-02 same text far too small for the back of a church; UX-04 no reject/age for a pending verse and Ctrl+Enter confirms from any text field; UX-06 pending verse below the fold at 150% scaling on 1366x768; UX-11 stray `</div>` (index.html ~1163, verify in DevTools); UX-03 auto-fit can shrink a long passage to ~18 px with no warning.
9. Performance: build the word-search index lazily (saves ~2.5 s CPU / 19 MB at launch); local fallback engine threads cores-1 -> cores/2.
10. Tests: fix the 3 observed flakes (heartbeat, settle, local-whisper overload) and add `--test-concurrency=2` to `npm test` and `release.yml` (the release workflow runs the suite). The heartbeat flake is partly a product bug (client dropped after two consecutive sweeps even if its pong is already queued).

## Later

- WS protocol/app-version handshake so stale OBS/phone pages reload after an upgrade; state snapshot on operator reconnect.
- Release pipeline hardening (S-02): split build/publish, SHA-pin actions, hash-verify the NDI download, sign the installer, publish checksums, add lint to `release.yml`.
- Phone remote is cleartext on the LAN, operator token never rotates (S-04); per-IP/role connection caps (S-03).
- README rewrite (still says Groq is the ASR; stale layout/scripts), supersession index at the top of ARCHITECTURE.md, SECURITY.md refresh.
- Make the AsrProvider seam explicit (core reaches into provider internals by name); pull state out of the 3125-line `app-core.ts` and 2163-line desktop `index.ts`.
- Tests: `.bak` fallback test, replay corpus (noisy FR/EN through a real AppCore), seeded fuzz tests for the detector, Electron smoke job (hidden BrowserWindow), Windows + Node 24 in the CI matrix.
- Packaging: exclude ~51 MB of NDI build leftovers and duplicate DLL copies (verify NDI afterwards); NDI per-frame copy cost and `backdrop-filter`/infinite animations only if OBS stutters.

## Evidence checked
Seven read-only specialist audits (security, TypeScript correctness [partial: not hybrid-provider, quote-matcher, announced-context,
web mode, packages, desktop IPC 1060-1980], silent failures, performance [measured on an i5-8365U under load], accessibility/UX,
tests/coverage, architecture/docs); local checks: GitHub CI and the Windows installer build both green on `26b8391`;
installer built locally (116.5 MB, unsigned); `npm audit` (0 high/critical; 13 moderate, all build tooling);
1566 tests passing, 3 skipped.

## Evidence missing (would change confidence)
Real church audio / a service recording; live Groq, Deepgram and Anthropic keys; the app running in real Electron (the dashboard
was only checked against a mock bridge); OBS/NDI frame rate and CPU; a packaged install on a second machine; dashboard minimized
with mic on for 10 minutes; most findings above are from reading code and were not reproduced (reproduced: TS-01, TS-02, TS-06, TS-08,
the three flakes, and all performance numbers).

## Next action
Fix B1-B6 plus items 1-4 of the high-value list as one bounded round (about a day of agent work), then do the supervised live test
and use the new mic-panel counters and the persistent log to tune from real data.
