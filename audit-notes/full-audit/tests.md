# Whole-app test-quality and coverage audit

Branch audit/production-fixes. Read-only audit; built into the scratchpad, never into the repo dist.
Method: `tsc --outDir <scratchpad>/root/dist`, non-TS assets copied to `<scratchpad>/root`
(the tests resolve the repo root as `dist/..`, so a bare out dir fails 18 tests on ENOENT; this
is an environment artefact, not a product bug), then
`node --experimental-test-coverage --test` (Node v24.19; CI/release use Node 22).
Result of the clean run: 1569 tests, 1565 pass, 1 fail, 3 skipped, 77.6 s wall, 266 s summed test time
(files run in parallel, which is why CPU contention causes the flakes below).

## 1. Coverage (node built-in, only files that a test loads)

All files: 97.04 % line, 90.78 % branch, 94.36 % function. CAVEAT: node's report lists only modules
that some test imports. Never-imported code is invisible and is the real gap:

| Not measured (never loaded by any test) | Lines | Risk |
|---|---|---|
| apps/desktop/main/index.ts (IPC handlers, shutdown(), services restart, single-instance, powerMonitor, safeStorage wiring) | 2163 | high |
| apps/web/index.ts (Web Server Mode bootstrap) | 564 | medium |
| apps/desktop/renderer/dashboard.js | 4484 | high (operator UI) |
| apps/overlay/public/overlay.js + index.html | 1047 + 1746 | high (what the audience sees) |
| apps/remote/public/remote.js, live.js, stage.js, bible-browser.js, overlay-settings.js | 661, 242, 166, 879, 397 | medium |
| apps/server/verse/bible-browser-service.ts is loaded (91 %); glossary.ts, language-lock.ts (92 % branch), claude-client.ts loaded | | |
| files with no `.test.ts` sibling: language-lock.ts, drop-ledger.ts, noise-mode.ts, reference-repairer.ts, live-translator.ts, glossary.ts, ndi-window.ts | small | covered indirectly (all >=92 % line) except ndi-window.ts (manual probe only) |

Per module (line % / branch %), lowest first, from the report:

| Module | Line | Branch | Uncovered |
|---|---|---|---|
| asr/failover-provider.js | 92.8 | 81.4 | funcs 64.9 %: lines 47-52, 64-65, 78-79, 89-92, 111-113, 257-258, 276, 310-314 |
| asr/local-whisper-server.js | 89.6 | 70.9 | 34-38, 118-121, 154-159, 182, 237-243, 266-282 (restart / wake paths) |
| ws/action-registry.js | 89.7 | 91.6 | funcs 79.3 %: 15-30, 47-53, 90-107, 117-124, 230-243, 276-284, 385-395 |
| desktop/main/ndi-output.js | 92.8 | 82.0 | 34-45 (addon load), 148-153, 277-291 |
| desktop/main/config-store.js | 92.7 | 84.0 | funcs 73.3 %: 62-63, 91-92, 168-237 (every pair is an error/recovery branch) |
| core/app-core.js | 92.8 | 86.3 | 354-357, 427-431, 474-517, 547-548, 646-701 ... |
| asr/hybrid-provider.js | 91.4 | 87.1 | 63-70, 88, 98-100 |
| audio/audio-chunker.js | 90.7 | 64.3 | 17-21 (argument validation) |
| ai/service-summary.js | 89.8 | 85.0 | 27-29, 47-56 |
| verse/bible-browser-service.js | 91.1 | 80.5 | 84-86, 95-101 |
| asr/benchmark/wer.js | 84.6 | 77.8 | 36-47 (tooling only) |
| overlay/palettes.js | 100 | 72.2 | |
| verse/offline-fallback-verse-source.js | 98.2 | 76.0 | 51-52 |
| desktop/main/local-asr-installer.js | 95.3 | 78.0 | 191-253, 371-379 |
| media/media-library.js | 95.2 | 90.0 | 86-87, 176-198, 228-230, 288-289, 343-345 |
| ws/server.js | 95.6 | 85.1 | 105-108, 145-146, 180-182, 311-313, 450-457 |
| asr/deepgram-provider.js | 97.5 | 90.1 | 93-103, 178-179, 257-259 |
| asr/groq-provider.js | 98.1 | 93.3 | 182-184, 451-454, 669-671, 823-830 |
| audio/silence-gate.js | 98.5 | 96.5 | 302-308 |
| detector/regex-detector.js | 100 | 97.6 | none |
| verse/known-valid-verse-index.js, resolve-verse.js, verse-cache.js, process-transcript.js, transcript-gate.js | 100 | 100 | none |

Everything else is >=95 % line. Line coverage is high; the weakness is not "untested code" in
the server core but (a) the Electron main process and browser pages, (b) error/recovery
branches, and (c) test determinism.

## 2. Flaky / timing-dependent tests (release workflow runs `npm test` on windows-latest, .github/workflows/release.yml:69)

Observed in this audit: the clean run failed 1 of 1569 tests (heartbeat healthy-client test, item 1).
A second run, made while another process was copying files, failed
`settle: compact colon form 'John 11:1' | '2'` (app-core.settle.test.ts:104-111, actual `['john 11:1']`).
Both reproduce the owner reports. Common root cause: `node --test` runs files in parallel and each
test asserts on real wall-clock gaps of 10-100 ms, far smaller than a Windows scheduler, GC or
antivirus stall (100-500 ms is routine on a shared runner).

Inventory (grep of setTimeout/sleep in *.test.ts): about 100 raw sleeps in app-core.test.ts, 51 in
app-core.settle.test.ts, 26 in ws/server.test.ts, 18 in local-whisper-provider.test.ts, 11 in
app-core.bible-browser.test.ts, plus local-whisper-bilingual, local-whisper-server, deepgram-provider,
ai-suggestion-coordinator, localized-verse-source, transcript-cleaner. Only ndi-output.test.ts uses
`mock.timers` (9 uses). failover-provider, suggestion-arbiter and local-whisper-provider already
accept an injected clock (`now`) but the sleeping tests do not use it.

### Ranked by flake risk, with deterministic fixes

1. CRITICAL, observed: ws/server.test.ts:402-414 "heartbeat leaves a healthy client connected"
   (heartbeatIntervalMs 30, sleep 350). The cause is partly in the product:
   `sweepDeadConnections()` (apps/server/ws/server.ts:367-381) terminates a client when no pong arrived
   between two consecutive sweeps. Timers run before the poll phase, so after a stall longer than the
   interval two sweeps can fire back to back before the already-received pong is processed, and a healthy
   client is dropped (this run: 3 "connection timed out" rejections). Same pattern in :381-400 (40 ms),
   :416-434 (40 ms, chatter every 10 ms) and :436-448 (200 ms). A real 30 s heartbeat is immune in
   practice; the 30-40 ms interval is what makes it fragile.
   Fix: add an injectable scheduler option, or use `mock.timers.enable({ apis: ["setInterval"] })`
   (real sockets keep working, only the interval is fake) and drive sweeps with `mock.timers.tick(n)`.
   Synchronise on I/O by ordering, not time: after a tick await the client `ping` event, then call
   `client.ping()` and await its `pong`; frames are ordered on one TCP stream, so when the server reply
   arrives it has already processed the earlier auto-pong. For the silent-client case tick twice and await
   `whenClosed`. All of the 350/200 ms waits disappear.
2. CRITICAL, observed: app-core.settle.test.ts (all 24 tests, 51 sleeps). SETTLE_MS = 300 (:16);
   correctness needs the second `asr.say("2")` within 300 ms of the first, but the gap is `sleep(30)` of
   wall time, so a stall over 270 ms yields the truncated verse (exactly the failure seen). Each test then
   waits SETTLE_MS*3 = 900 ms (suite total about 25 s). `referenceSettleMs` is already an option
   (app-core.ts:232; timers at :1113 and :1146).
   Fix: inject the timer (`settleTimer?: { set, clear }` defaulting to setTimeout/clearTimeout) or use
   `mock.timers` for setTimeout only; replace `sleep(30)` with a few `setImmediate` flushes and
   `sleep(SETTLE_MS*3)` with `mock.timers.tick(SETTLE_MS)` plus a flush, and wait for shown verses with the
   existing `waitFor(predicate)` (app-core.test.ts:193). Suite goes from about 25 s to under 2 s and becomes
   immune to stalls.
3. HIGH, observed: local-whisper-provider.test.ts:139-156 "a fast engine never reports an overload".
   Six utterances 40 ms apart against a real local HTTP server; overload is raised when the queue exceeds
   MAX_BACKLOG (local-whisper-provider.ts:286-291), and under load a real round trip exceeds 40 ms several
   times in a row. The mirror tests (:102-137, delayMs 120, sleep 600, assert `<= 3`) need the engine to be
   slower than the speaker and are load-dependent too.
   Fix: use the injected `fetchImpl` (already used from line 207 on and in local-whisper-bilingual.test.ts)
   with one deferred per request. Fast engine: resolve at once and await `results.length === i + 1`
   before sending the next utterance. Slow engine: keep requests unresolved, push 6 utterances, assert one
   overload error and at most 3 requests, then release. No timing at all.
4. HIGH: negative assertions after a short sleep pass vacuously on a slow machine:
   local-whisper-provider.test.ts:75-87 (sleep 50 then "nothing sent"), :158-180 (80 ms), :197 (3000 ms,
   skipped unless WHISPER_SERVER_BIN). Check the fake counter after the awaitable
   `provider.onUtteranceEnd()` and a microtask drain instead.
5. HIGH: app-core.test.ts, about 100 raw sleeps (e.g. :292 30 ms, :528, :565, :605, :667-669 80/150,
   :712-715, :820 settle=80, :5053-5086, :5968 400, :6096 300). Two classes: (a) positive waits
   (sleep 100 then assert it happened): replace with the existing `waitFor(pred)` (:193).
   (b) negative waits (sleep 400 then assert nothing was shown, e.g. :5960-5972 Isaiah 4:8, John 3:8):
   a sleep cannot make these reliable; make the pipeline observable, e.g. await the logger event the
   pipeline emits when it finishes (`verse.settle-dropped`, lookup dropped) through the injected Logger sink,
   or expose an `idle()` promise from startAppCore, then assert. Auto-clear tests (media, poster, the 2:30
   ceiling; :1855-1869 take 1.8 s each) should use `mock.timers`. TESTING.md:193 admits the 20 s detection
   hold and 60 s cooldown use `Date.now()` directly so their exact boundaries are untested.
6. MEDIUM: asr/local-whisper-server.test.ts:87,128,143-152 (30-50 ms sleeps around fake-child restarts, a
   `Date.now()` deadline poll at :128) and "a restart whose launch throws is retried" (3.4 s). The module
   injects fetchImpl and powerMonitor but its readiness poll uses a hard `setTimeout(resolve, 250)`
   (local-whisper-server.ts, compiled :277); inject a `sleep` option.
7. MEDIUM: deepgram-provider.test.ts:249-264 (75/50/10 ms); groq-provider.test.ts:1153 uses
   `call === 1 ? 40 : 5` ms to force response reordering, i.e. ordering by timing; use deferreds.
8. MEDIUM: ai-suggestion-coordinator.test.ts:59 (settle 60 ms) and :202-211 (80 ms);
   transcript-cleaner.test.ts:47 (20 ms); localized-verse-source.test.ts:105-113 (20/5 ms);
   app-core.bible-browser.test.ts (11 sleeps of 60-100 ms; its `waitFor` at :310 is fine);
   bible-word-search.test.ts:127 (poll 50 x 10 ms = 500 ms cap for a lazy index load; await the load).
9. MEDIUM, race tests that may not test the race: "SessionHistoryStore: concurrent record() calls in the same
   millisecond" and "ConfigStore: concurrent saves in the same millisecond" depend on Date.now() equality
   (config-store.ts:318 builds temp names from Date.now()). With the counter fix they pass regardless, so
   they cannot fail on a regression unless the clock is frozen: inject `now` or mock Date.
10. LOW: real-port tests (server.test.ts, app-core*.test.ts, static-server.test.ts, installers with a local
   HTTP server) all use ephemeral port 0, so no collision risk; their risk is only the sleeps above.

Interim mitigation (one line, in package.json test script and release.yml): `node --test --test-concurrency=2`
until the sleeps are gone. Do not add test retries: they would hide the real heartbeat double-sweep behaviour.

## 3. The 15 riskiest uncovered or weakly covered behaviours (production risk order)

1. Electron main process is entirely untested: apps/desktop/main/index.ts (2163 lines): `shutdown()`
   (:1980-2012; each step has its own catch, none is verified), the shutdown-then-startServices restart cycle
   (:1254-1272, :1392), `window-all-closed`/`before-quit` (:2156-2162, `shutdown().catch(() => {})`),
   single-instance lock (:2037), safeStorage-unavailable branch (:2059), 15+ IPC handlers (set-ai-provider,
   set-ai-feature, key save/clear). TESTING.md:192 admits it. Risk: a regression leaves the mic, NDI or ports
   held on quit, or services not restarted after a key change, and nothing fails.
2. Config recovery is only half there: ConfigStore writes `config.json.bak` on every save
   (config-store.ts:329) but nothing ever reads it (grep for .bak in non-test code finds only that line), and
   a corrupt file is quarantined then `load()` throws (:225-241), sending the operator to first-run setup with
   the encrypted keys in `config.json.corrupt-<ts>`. config-store.test.ts:193 only checks that the .bak
   exists. Untested: quarantine rename failing (:249 empty catch), compiled lines 168-237 (73 % function
   coverage). Add: corrupt falls back to .bak; rename failure; decrypt failure of one key; tmp-file cleanup.
3. Outbound WS payload validators are untested: action-registry.js uncovered 15-30 (mic health), 97-107
   (transcript:partial), 117-124, 230-243 (media:show / playback), 276-284, 385-395 (rundown state); function
   coverage 79 %. A server bug emitting a malformed rundown:state or media:show is not caught before the
   overlay receives it.
4. Local engine restart/abandon logic: local-whisper-server.ts branch coverage 70.9 %: restart abandoned
   after N attempts (compiled :237-243), engine exiting during startup (:266), health-poll timeout kill
   (:277-282), resume with the engine not running (:118-121). These decide whether the offline fallback
   recovers after laptop sleep.
5. Failover state machine: failover-provider.ts function coverage 64.9 %, uncovered 47-52, 64-65, 78-79,
   89-92, 111-113, 257-258, 276, 310-314. The 28 tests (injected clock) cover the main transitions well, but
   no test drives the full cycle primary fails, secondary, auto-return attempt fails, backoff grows, capped at
   300 s (DEFAULT_AUTO_RETURN_MAX_MS), success; none for stop() or a mic restart during an auto-return
   attempt (`returning` promise, failover-provider.ts:75).
6. Verse display decisions under concurrency: app-core.ts uncovered 646-648 (`dropStaleLookup
   ("volume-inference")`), 498-517 (session-history record failure), 354-357 (command.failed). There is no
   test where two lookups resolve in reverse order using deferreds (all ordering tests use sleeps), which is
   the guard that stops an old lookup replacing a newer verse.
7. Detection hold and suggestion cooldown boundaries (20 s, 60 s) use Date.now() (TESTING.md:193), so the exact
   edges are untested; changing 20 s to 2 s or 200 s would pass.
8. Browser pages have no executed test: overlay.js (1047 lines, runs on the stream), dashboard.js (4484),
   remote.js, live.js, stage.js. The existing page tests read source text (section 4). Escape emergency clear
   (AGENTS.md section 51), late-join transitions and fit-to-card sizing are verified only manually.
9. Audio path: silence-gate.js uncovered 302-308, audio-chunker.js branch coverage 64 %, and no test of the
   canonical chain capture, normalize, gate, ASR end to end (audio-path.bench.ts is a benchmark, not a test).
10. ASR provider reconnect: deepgram-provider.js uncovered 93-103, 178-179, 257-259; groq-provider 823-830;
   hybrid-provider 63-70 and 98-100 (key cleared live while streaming). Reconnect backoff is not asserted
   with numbers (only that it recovers after a WebSocket failure, TESTING.md:85).
11. NDI: ndi-output.ts 34-45 (addon load) and 148-153, 277-291 (teardown races); ndi-window.ts is verified only
   by a manual Electron probe (TESTING.md:52), so a frame size or alpha regression is not caught.
12. Media library: media-library.ts uncovered 176-198 (load/recovery of a corrupt or partly missing library),
   228-230, 288-289, 343-345; no test of the media directory vanishing mid-run or a failed atomic write.
13. static-server.ts uncovered 156-158, 170-171, 240-242, 265-267, 307-309 (stream error mid-Range response,
   listen error). apps/web/index.ts (564 lines) wiring (which page gets which token, LAN binding) is untested
   although its helpers (api-auth, health, status-payload) are.
14. Rundown: rundown-controller.ts is 100 % line, but a viewer reconnecting mid-scene is only reached via
   app-core, and rundown.viewer-sync-failed (app-core compiled :427-431) is uncovered.
15. AI helpers run only against fakes; prompts never run live (TESTING.md:191), so a wrong prompt fails soft
   and silently. service-summary.ts uncovered 27-29, 47-56; claude-client function coverage 90.9 %.
   Low blast radius (suggestion-only) but silent.

## 4. Assertion quality

Tests that assert source text rather than behaviour (brittle; they pass while the page is broken):
- apps/overlay/overlay-reconnect.test.ts:12-22: regex over overlay.js for the open-handler body; breaks on
  reformatting and cannot detect clearVerse() being a no-op.
- apps/overlay/card-designs.test.ts:24-65: `overlayHtml.includes("#verse-card.tpl-...")` and an
  `assert.match` on the nature-background-video tag (attribute-order dependent).
- apps/desktop/renderer/bible-browser.test.ts:124 (doesNotMatch of innerHTML etc.) is a legitimate lint-style
  guard; remote-i18n.test.ts:47 evals a regex taken from source via `new Function`; stage-overflow.test.ts,
  landing-page.test.ts, page-assets.test.ts and ws/client-handshake.test.ts also read HTML/JS source. About 10
  files, roughly 40 tests, give a false sense that the UI is tested. Keep client-handshake (cheap invariant);
  replace the rest by the smoke tests in section 5.
- Positive: verse-motion.test.ts (16 tests) loads the real script and calls its pure functions; the i18n parity
  tests are real behaviour checks.

Tests that cannot fail, or barely can:
- Negative-after-sleep assertions (section 2 items 4 and 5), e.g. app-core.test.ts:5968-5972.
- doesNotReject/doesNotThrow with no state assertion: groq-provider.test.ts:228 and :667 (Chinese transcript,
  only no-throw); dry-run-provider.test.ts:55-59; hybrid-provider.test.ts:30-32 and :142;
  deepgram-provider.test.ts:278 (loop of malformed frames). Add assertions on callback counts or errors.
  (silence-gate.test.ts:39 and free-api-source.test.ts:82 are fine: they assert the result on the next line.)
- Duplicates: config-store.test.ts has 8 near-identical "load() throws on a present but invalid X" tests
  (:80, :252, :297, :339, :410, :450, :489, :505); fold into one table-driven test. The three settle split
  variants (English, French, colon form) share one code path with different text.
- Coupling to internals: tests naming log event strings (verse.settle-dropped, local-whisper.backlog-dropped)
  are acceptable as an observability contract; keep them going through the Logger sink.
- 3 skipped tests are the self-skipping live or real-binary ones; fine.
- No mutation testing exists beyond the one check noted in TESTING.md:175. Cheap manual check for the top five
  modules: mutate thresholds (gate RMS, 2:30 ceiling, settle window, hold times) and confirm a test fails.

## 5. Missing categories

1. End-to-end transcript-to-overlay replay. Only partly present: apps/server/detector/sermon-replay.test.ts has
   26 French cases (live log 2026-10-12) through RegexDetector + KnownValidVerseIndex only (no assembler,
   rolling window, settle, arbiter, language guard, WS). app-core.test.ts runs the pipeline with hand-written
   lines. Missing: a corpus of multi-final sermon transcripts in French AND English with noisy ASR (dropped
   plurals, "un/une Corinthiens", spoken numbers, chunk splits, repeats, interpreter echo) replayed through
   startAppCore with a fake ASR and a viewer socket, asserting the exact sequence of verse:show /
   verse:pending / nothing, with settle driven by mock timers. One JSON per sermon
   { finals: [{ text, atMs }], expect: [...] }; tools/ already has a replay builder (TESTING.md:177) to
   generate them from real logs. Highest-value missing test.
2. Property/fuzz: none for RegexDetector, spoken-reference-normalizer, trailing-number or transcript-assembler
   (no fuzz or random generation in those tests). Add with node:test and a seeded PRNG (no dependency):
   (a) detector never throws and stays under a time budget on random 10 kB strings with long digit runs and
   unicode (ReDoS guard); (b) every returned reference is either valid in the index or rejected downstream;
   (c) normalizer idempotence, never dropping digits that were not a spoken number; (d) generate
   "Book N verse M" from the index, perturb (case, accents, filler words, split points), assert the same
   reference is recovered; (e) assembler never joins across more than 25 s and stays within its bound.
3. Soak/leak: nothing runs for minutes. Caps are unit-tested one by one (LRU, queues, session history, latency
   windows, drop ledger). Add one opt-in soak (behind an env var): 10,000 synthetic finals plus audio frames
   through AppCore with viewer connect/disconnect churn; assert heapUsed after gc within a bound,
   process.getActiveResourcesInfo() back to baseline, WS client count back to 0.
4. Real-browser smoke tests inside the scope lock. Electron is already a devDependency and has a precedent
   (scripts/ndi-window-probe.ts, TESTING.md:52); no Playwright or jsdom needed. A script scripts/ui-smoke.ts
   run as `xvfb-run -a electron --no-sandbox dist/scripts/ui-smoke.js` that (a) starts the real startAppCore
   with a fake ASR and stub verse source plus the real StaticServer, (b) opens a hidden
   BrowserWindow({ show: false }) on the overlay URL, (c) reads the DOM with webContents.executeJavaScript and
   drives it through the fake ASR over the real WS path. Assertions: verse text appears for a spoken reference;
   verse:clear and Escape empty the card; restarting the WS server triggers reconnect and the clear-on-open
   reset (replaces overlay-reconnect.test.ts); the dashboard loads with zero console errors and Start Mic sends
   mic:start; the remote page shows operator controls only with the operator token. Run it as a separate job:
   ci.yml installs with `npm ci --ignore-scripts` on purpose (no Electron binary), so the job needs a normal
   npm ci; on windows-latest in release.yml no xvfb is needed. Save capturePage() screenshots as artifacts,
   not golden-image assertions.
5. Config/persistence crash tests: injected fs that throws after writeFile, after sync, after copyFile;
   corrupt .bak (section 3.2).
6. Contract tests for outbound WS messages: pass every message the server emits during the app-core
   integration run through the same registry validators (section 3.3).
7. Platform matrix: release runs on windows-latest (release.yml:31) but ci.yml runs only ubuntu on Node 22
   (development is on Node 24). EBUSY on rename/unlink, path separators and timer resolution differ, so a
   Windows-only failure first appears at release time. Add windows-latest and Node 24 to the ci.yml matrix.

## 6. Speed

Wall time 77.6 s for the full suite on this machine (2 m 56 s on the first run, when the machine was busy).
Summed test time is 266 s over 1566 timed tests; 148 exceed 500 ms and 69 exceed 1 s. Slowest (ms):
QuoteMatcher.buildAsync 11,875; SessionHistoryStore bounded 10,039; QuoteMatcher real LSG 7,044;
FasterWhisperInstaller download 5,242; BibleWordSearch real LSG 5,194; MediaLibrary concurrent imports
4,863; SessionHistoryStore concurrent 4,076; robust silence gate 3,869; LocalAsrInstaller 3,837;
WhisperServerProcess restart-launch-throws 3,437. The settle/nav tests sum to 25.3 s.
Not a CI cost problem (ci.yml timeout is 15 min), but the CPU-heavy parallel files (QuoteMatcher builds the
real LSG index, SessionHistoryStore writes many files) stall the event loop and trigger the timing flakes of
section 2. node:test does not print per-file wall time for passing files; the figures above are per test from
the spec reporter.

## 7. Prioritised plan

1. Stabilise the release gate (hours): fix the three observed flakes (section 2.1 to 2.3) with mock.timers, an
   injected scheduler and deferred fetch. Interim: --test-concurrency=2 in the test script and release.yml.
   Consider letting the heartbeat tolerate one missed sweep so a loaded laptop never drops its own dashboard.
2. Replace the app-core.test.ts raw sleeps with waitFor and an observable idle signal (section 2.5); add
   windows-latest and Node 24 to the ci.yml matrix.
3. Config recovery: implement and test the .bak fallback (or stop promising it) plus quarantine failure
   branches (section 3.2).
4. Transcript-to-overlay replay corpus through startAppCore, French and English, noisy ASR (section 5.1): it
   protects the core promise, never a wrong or truncated verse.
5. Property/fuzz tests for detector, normalizer and assembler, including a ReDoS time budget (section 5.2).
6. Electron hidden-window smoke script for overlay, dashboard and remote as a separate CI job (section 5.4);
   delete the regex-over-source UI tests it supersedes.
7. Extract shutdown() and the services restart from index.ts into a module with injected dependencies and test
   ordering and error isolation (section 3.1).
8. Outbound WS payload contract test; local-whisper-server restart-abandon and startup-exit tests; failover
   full-cycle auto-return test (sections 3.3 to 3.5).
9. Opt-in soak test; media library corruption tests; NDI window probe in the Windows release job.
10. Tidy: table-drive duplicate config-store tests, add state assertions to no-throw-only tests, shrink the
    10 s SessionHistoryStore test.
