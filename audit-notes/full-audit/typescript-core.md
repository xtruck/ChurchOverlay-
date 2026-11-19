# TypeScript core audit (read-only)

Repro scripts: scratchpad t1.js..t5.js against compiled output. No repo files edited.

## Findings

### TS-01 HIGH, reproduced. Ordinary speech switches the live display mode and persists it
navigation-command-detector.ts:73-78 (substring phrases "en francais", "en anglais", "french only"), used at app-core.ts:2538-2554, persisted at desktop/main/index.ts:574.
Repro: detect("il parle en francais"), ("ce mot se traduit en francais par amour"), ("the bible in english only") all return goto-display-mode; "Dieu parle en francais et en anglais" returns english then french. A French preacher saying "en anglais on dit grace" flips the congregation display to English-only, persistently, and changes the ASR language.
Fix: require a command cue (whole utterance is the phrase, or prefixed by passe/passons/mets/switch to), or make voice mode switches pending/confirm only; do not persist them.

### TS-02 HIGH, reproduced. Failover retry storm when the secondary cannot start
failover-provider.ts:184-198, 320-353. After a primary-error failover where secondary.start() rejects, activeProvider is reset to the stopped primary, so EVERY audio frame re-runs sendAudio -> activateFailover -> primary.stop + secondary.start + errorCallback.
Repro (t5.js): 100 frames -> 101 secondary.start, 101 primary.stop, 101 onError callbacks (each a status:update broadcast). No backoff (AGENTS 37).
Fix: remember the failed activation time, refuse new attempts until a backoff elapses, rate-limit errorCallback.

### TS-03 HIGH, confirmed by reading. GetBibleVerseSource (French source) has no fetch timeout
get-bible-verse-source.ts fetchChapterBody awaits this.fetchImpl(url); desktop passes undefined fetch (index.ts:288-302) = global fetch, no AbortSignal. FreeApiSource has 5 s. A stalled connection: resolveVerse never settles, no breaker failure is recorded, and in half-open state probeInFlight stays true forever (circuit-breaker.ts canProceed) so later lookups return null "circuit-open". French verses silently stop appearing in the primary language. The offline fallback only reacts to throws, not hangs.
Fix: AbortSignal.timeout(5000) in fetchChapterBody; defensive timeout in resolveVerse.

### TS-04 MEDIUM, confirmed by reading. Late-joining viewer re-shows a cleared verse
app-core.ts:764-783: with a rundown loaded, not interrupted, scene.kind "verse", syncSceneContent re-resolves and sends verse:show, ignoring lastShownVerse (null after verse:clear or the 150 s auto-clear). An OBS source refresh after a clear puts the old verse back on air.
Fix: send lastShownVerse (null = nothing) for verse scenes.

### TS-05 MEDIUM, confirmed by reading. Operator override can be dropped by an unrelated newer detection
app-core.ts:1166 markIntentApplied runs for any detection returning verses, even when echo-suppressed (1182-1209) or only pending (review mode). A slower older verse:override is then dropped at 2061 with only an info log; nothing appears and the operator is not told.
Fix: mark applied only when something is really shown; tell operators when an override is dropped.

### TS-06 MEDIUM, reproduced. "constructor 3:16" throws inside the transcript handler
regex-detector.ts:548 FRENCH_BOOK_ALIASES[normalized] hits Object.prototype.constructor; KnownValidVerseIndex.normalizeBookId throws "rawBookId.trim is not a function" (t1.js). It happens at app-core.ts:2851 inside asr.onTranscript, which has no try/catch, so it propagates into the provider callback. No process uncaughtException/unhandledRejection handler exists in apps/desktop/main (only apps/web/index.ts:548): Electron shows its blocking error dialog mid-service.
Fix: Object.hasOwn/Map lookups; try/catch the onTranscript body; add main-process handlers that log and continue.

### TS-07 MEDIUM, confirmed by reading (race suspected). startServices() is not serialised
desktop/main/index.ts:318-350, callers 921-985, 1267, 1388. Two quick IPC restarts both pass the early check, both run shutdown() (double core.stop) and both start AppCore on port 8787; one gets EADDRINUSE, globals are overwritten and line 427 stops the engine the other call just built. Also shutdown() starts with an unguarded await overlayStyleController.flush() (1980): a rejection aborts shutdown before core stops and every later startServices() rejects.
Fix: promise-chain mutex around startServices/shutdown; try/catch the flush.

### TS-08 MEDIUM, reproduced. Bare "Name N M" detections show wrong verses automatically
regex-detector.ts COMPACT_REFERENCE_PATTERN. detect("il y avait Jean 5 6 qui") -> john 5:6; also "Daniel 3 4", "Amos 3 4", "Ruth 2 3 and". The denylist (line 165) only covers units/dates. In auto mode this reaches the overlay.
Fix: compact form for first-name books (jean, marc, luc, jacques, daniel, jonas, joel, amos, ruth, job, esther, jude, tite) -> pending only, or require a cue word.

### TS-09 MEDIUM, confirmed by reading. Rundown verse scenes skip the known-valid index
app-core.ts:2317-2323, 1591-1600, 1662: rundown:load verse scenes are only shape-checked (action-registry.ts:474) and go straight to resolveVerse with no index.exists and no book normalisation (override does both at 2043-2058). Capitalised "John" fails silently in French mode; chapter 99 reaches the Bible API. Conflicts with AGENTS 13/50.
Fix: normalise and index.exists each verse scene at rundown:load and warn the operator.

### TS-10 MEDIUM, confirmed by reading. Config: one bad field quarantines everything; .bak never read
config-store.ts:232-237, 388-462: any enum mismatch (file from another build) or decrypt failure moves the whole config (keys, tokens) aside and the app falls to first-run setup; new tokens change the OBS URL. The .bak copy is written at 329 but never read (grep). noiseMode is lenient, others strict.
Fix: lenient defaults for unknown optional enums; try .bak before quarantine.

### TS-11 LOW-MEDIUM, suspected. mic:start failure leaves dashboard "calibrating"
app-core.ts:1979-1985: micCalibrating:true broadcast before asr.start(); on throw only command.failed is logged (702). asr.start has no timeout and runs on the serial mic chain (1943), so a hung start also blocks mic:stop.
Fix: on failure broadcast asrHealth error and micCalibrating:false; add a start timeout.

### Lower
- TS-12: in-flight lookups after stop() can still arm verseAutoClearTimer (app-core.ts:890, not unref'd); if wsServer.ready rejects (EADDRINUSE) startAppCore leaks sermonNotesTimer and AI subscriptions.
- TS-13: setTimeout with durations above 2^31-1 (poster:set-duration action-registry.ts:370, media autoClearMs) fires after 1 ms and clears instantly.
- TS-14: pendingVerse has no TTL; review-mode Confirm can show a minutes-old suggestion (app-core.ts:2145).
- TS-15: before-quit (index.ts:2161) runs shutdown() without preventDefault/await; engine child may not be killed on quit paths skipping window-all-closed.
- TS-16: assembler 25 s open-reference window (transcript-assembler.ts) can join "Genese 5" with a "verset 2" said 20 s later and show it in auto mode; by design, a wrong-verse risk.
- TS-17: ranges ("Jean 3:16-18") display only the first verse silently.
- TS-18 (god object): app-core.ts is 3125 lines. Bounded seams: (a) display-intent tickets + auto-clear timers, (b) settle-hold, (c) transcript intake (language guard, correction, screen), (d) media/poster/rundown command handlers. Extract one at a time behind the existing app-core tests.
- TS-19: scene:goto shadows index (VerseIndex) with payload.index (app-core.ts:2350).
- Tests: none cover ordinary-speech negatives for TS-01, TS-02, a hanging source (TS-03), or TS-04.

## Ranked top 10
1 TS-01, 2 TS-03, 3 TS-02, 4 TS-04, 5 TS-05, 6 TS-08, 7 TS-07, 8 TS-06, 9 TS-09, 10 TS-10 (TS-11 next).

## Checked and found sound
- Partial transcripts never reach detection: processTranscript gates on final; navigation, glossary, media, quote paths use passesTranscriptGate; volume inference re-checks final.
- WS server: token via Sec-WebSocket-Protocol with constant-time compare and post-handshake re-check; maxPayload 1 MiB; socket error listener; guarded() around every callback; per-connection command rate limit; slow-consumer drop; heartbeat terminate; close() terminates clients and clears timers; hasOwnProperty type lookup; server-only events have empty allowedSenders.
- Verse cache bounded LRU+TTL, negative cache separate and shorter, translation id in key; response validated (answersRequest) before display; mode read synchronously with the call so no cross-mode cache poisoning.
- verse:override and verse:navigate use index.exists + resolveVerse; supersession tickets keep emergency clear and cancel cleared.
- mic:start/stop serialised; audio in-flight bounded at 64 with logged drops; settle-hold timers unref'd and cleared on stop; stop() clears the timers it owns.
- Config writes: temp + fsync + rename, serial save chain, unique temp names, corrupt file quarantined not deleted.
- French/English numerals and book names (cent dix-neuf, septante, nonante, premier/deuxieme, 1 Jean 4 8, Isaie/Esaie, Psaume/Psalms) detect and validate correctly (t2.js); unit/date denylist works.
- Dashboard re-sends mic:start on WS reconnect, so a services restart does not strand the mic.
- Renderer window uses contextIsolation, sandbox, no nodeIntegration; navigation and window.open locked down.

Not reviewed in depth: hybrid-provider.ts, quote-matcher, announced-context, apps/web/index.ts, packages/**, desktop IPC handlers 1060-1980.
