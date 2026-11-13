# Silent-failure audit, whole app (read-only), branch audit/production-fixes

Method: read AGENTS.md, traced mic to overlay, config, history, logging, lifecycle. Nothing edited. confirmed = read in source; suspected = inferred.

## Crash handlers (confirmed)
- Only apps/web/index.ts:548-558 has process.on unhandledRejection/uncaughtException. apps/desktop/main has none.
- render-process-gone: only apps/desktop/main/ndi-window.ts:37. The dashboard window (index.ts:731-759) has no render-process-gone, unresponsive or did-fail-load handler. Mic capture lives in that renderer.

## TOP 10 (ranked); the three that hurt most live: SF-01, SF-02, SF-03
1. SF-01 Critical: logs go only to console.log (no file, no rotation); packaged app = no trace of any crash or error.
2. SF-02 Critical: mic capture has no device-loss, sleep-wake or renderer-crash recovery; UI keeps saying mic active.
3. SF-03 Critical: a detected verse whose lookup fails is only logged; operator never told.
4. SF-04 High: French source fetch has no timeout; offline fallback only after a throw.
5. SF-05 High: Groq 401/403/5xx never trigger failover and drop audio with no discard log.
6. SF-06 High: mic:start failure only logged; dashboard shows running.
7. SF-07 High: unhandled rejection in failover ctor, no main-process handler (SF-11).
8. SF-08 High: mic health and dropout detection are frame-driven; no frames = stale ok.
9. SF-09 Medium-High: WS reconnect re-sends mic:start -> recalibration on live speech; no operator state resync.
10. SF-10 Medium-High: one bad config field quarantines the whole config.json incl. keys.

## Findings: logging, crash, capture
SF-01 packages/shared/logger.ts:78 default sink is console.log; apps/desktop/main/index.ts:88 passes no write sink. app-core.ts:2702 comment claims rotating logs: not implemented. Fix: file sink under the Electron logs path, daily, 14-30 day retention, plus an in-memory ring for the dashboard and export-diagnostics.
SF-11 desktop main has no uncaughtException/unhandledRejection handler (Node 22 turns rejections into uncaught, Electron shows a modal dialog, nothing logged). Fix: handlers that log with stack, broadcast status, no dialog.
SF-02 renderer/dashboard.js:3106-3176: no track ended/mute, devicechange, AudioContext statechange or visibility handling; every failure after getUserMedia is labelled micPermissionDenied (3116, 3136). Unplug or sleep: track ends, micRunning stays true, UI says active. Renderer crash: white window, mic dead, server keeps the last verse. Fix: ended/mute/statechange listeners with resume or red banner, worklet-silence watchdog, main-side render-process-gone/unresponsive -> reload and re-send mic:start.
SF-15 (suspected) dashboard BrowserWindow lacks backgroundThrottling:false (index.ts:744-751); a minimised or occluded capture window may throttle reconnect timers.
SF-16 renderer/audio-stream.js:44-48 send failures are counted only, no log or escalation; a WS outage loses speech with only a grey status line.
SF-17 app-core.ts:1747 frames are ignored silently when no session is active (after a failed start or server restart); the renderer VU meter still moves.
SF-18 malformed audio frames: one warn per frame (ws/server.ts:589, app-core.ts:714), flood risk.
SF-08 app-core.ts:1795,1804: mic:health is clocked by processed audio; mic-health.ts:89 keeps the last window; serviceHealth.observeMicState is fed only by it. No frames = stale ok and 0 dropouts. Fix: wall-clock watchdog (2 s) while micRunning: no frame for 3 s -> no-signal + dropout + warn.
SF-37 powerMonitor is used only for local whisper (index.ts:2134); renderer, Deepgram, WS and NDI are not handled on resume.
SF-36 index.ts:2156-2163 closing the window quits everything with no confirm; before-quit and window-all-closed both call shutdown.

## Findings: ASR and failover
SF-05 groq-provider.ts:849-880: a non-OK response sets consecutiveNetworkErrors=0 and throws a plain Error; only 429 is requeued (647); only GroqNetworkError logs asr.audio-discarded (649). The sustained-rate-limit trigger (index.ts:479) never fires for 5xx/401/403. A red banner shows but the app never self-heals. Fix: count 5xx/401/403 toward sustained, log every discarded chunk.
SF-19 deepgram-provider.ts:199-206: close sets active=false, no reconnect; Deepgram-only or last link = dead until the mic is cycled. No stalled-socket watchdog except the 30 s no-transcripts warning (frame-driven).
SF-06 app-core.ts:1980-1985 rethrows, 702-709 logs command.failed only; dashboard.js:3163 already set micRunning=true. Fix: broadcast error status and mic:start-failed; dashboard reverts.
SF-07 failover-provider.ts:115 void this.activateFailover(); openSecondary rethrows (349): unhandled rejection. The network-sustained signal fires only at exactly the threshold (groq-provider.ts:838) so a failed first failover is never retried. Fix: catch plus bounded retry.
SF-20 batch-first failover never auto-returns (by design, section 86); the banner must be persistent.
SF-21 (suspected) failover start() while on the secondary (WS-reconnect mic:start) resets activeProvider to primary without stopping the secondary (leaked Deepgram socket, asrIsFailedOver stale). doReturnToPrimary: if both primary and secondary restart fail, activeProvider is a stopped provider and every frame throws.
SF-22 local-whisper-server.ts:262-268 restart-abandoned is log-only; index.ts:852 localActive = localAsr !== null is static, so the dashboard advertises a dead backup.
SF-13 local-whisper-server.ts:205-227 has only an exit listener; a spawn error event with no listener = uncaught exception in main.
SF-14 index.ts:426 getLocalEngineStatus is unguarded (faster-whisper refreshSidecar can throw) and 657-658 createNdiWindow/ndi start are unguarded: optional features abort the whole startServices; at launch only startup.services-failed is logged (2141) and the dashboard drops to setup.
SF-23 installers: fetch without timeout or stall detection (local-asr-installer.ts:257, 314); downloadWithProgress buffers the whole download in RAM; can run during a live service.
SF-24 app-core.ts:2640-2960 transcript handler has no try/catch: a sync throw is reported by Groq as an ASR error and makes Deepgram fail over quietly.
SF-25 groq-provider.ts:612,619 empty and non-Latin drops are logged at debug (minLevel info = invisible).

## Findings: verse lookup, overlay
SF-03 resolve-transcript-verses.ts:50-53 drops nulls; resolve-verse.ts:84-127 only logs; a rejected verse:override is logged at info (app-core.ts:2070). Only preview and navigation report unavailable. Fix: verse:lookup-failed to operators plus a persistent Bible-source-degraded chip.
SF-04 get-bible-verse-source.ts:92 has no AbortSignal (free-api-source.ts has 5 s). offline-fallback-verse-source.ts:94-111 falls back only after a throw; its breaker needs 5 failures. circuit-breaker.ts:61-76 probeInFlight never expires if a probe hangs. Fix: AbortSignal.timeout(4000) and probe expiry.
SF-26 404 = confirmed not-found, negative cached 5 min and counted as breaker success (free-api-source.ts:92, get-bible-verse-source.ts:99, verse-cache.ts:13); a CDN/proxy/custom-URL 404 poisons a valid indexed reference. Fix: no or short negative cache for index-valid references, error log.
SF-27 offline fallback is French-only and not operator-visible after one warn.
SF-29 overlay.js:977-981 close does not clear content; the server auto-clear dies with the server, so a stale verse can stay indefinitely after crash or sleep. Reconnect (957-969) clears verse/media/poster only, not announcement/definition/canvas/outline. Fix: local fail-safe clear after about 20 s disconnected; clear all channels on open.
SF-09 dashboard.js:3234-3238 re-sends mic:start on every WS open; app-core.ts:1959-1988 recalibrates (1.5 s speech lost, threshold up to 2000), resets gain and health, calls asr.start() (Groq discards its buffer silently, groq-provider.ts:419). onViewerConnected is viewer-only (app-core.ts:721): a reconnecting dashboard or remote gets no verse state, tally goes stale (dashboard.js:3292, remote.js:550-555). Fix: idempotent mic:start, state snapshot to every connection.
SF-30 static-server.ts has zero logging; overlay media has no error handler; a missing media file = blank layer while the tally says on screen.
SF-31 index.ts:921-985,1267,1388: strategy/key/local/phone-remote changes restart AppCore mid-service: overlay blanks, SessionRecorder/ServiceHealthLog/rundown are lost, mic recalibrates, no confirmation.

## Findings: config, persistence, reports, uptime
SF-10 config-store.ts:215-238, 337-518: any invalid optional field or one decrypt failure -> whole file quarantined and load throws; launch shows setup (keys gone from the operator view). .bak (329) is never read. update() calls load(), so a mid-run problem quarantines the live config; persist handlers then only log. Fix: lenient decode for non-secret fields, try .bak first, never rename on a decrypt error.
SF-33 persist failures are log-only (index.ts:525,537,578,591; app-core.ts:867); the setting silently reverts on restart.
SF-34 session-history-store.ts:62-84: a non-ENOENT read error leaves entries empty and the first record() overwrites the file.
SF-35 service-health.ts records only script/language drops, no-signal dropouts, echo and latency; not ASR errors, failovers, WS drops, breaker state, frame stalls or lookup failures. export-session refuses when no verse was shown (index.ts:1718).
SF-38 Date.now is used for breaker, throttle and auto-return intervals; a backward clock step keeps the breaker open or Groq throttled. Use monotonic time.
SF-39 Long uptime: no leak found. Bounded: SessionRecorder 5000, history 5000, ServiceHealthLog 50/200, LRU caches, dashboard log 200, toasts 3, in-flight frames 64, notes buffer 12k, per-client maps cleaned on close. Watch: installer RAM buffering; transcript.received per partial if a file sink is added.
SF-40 no auto-updater or relaunch (info); single-instance lock present.
SF-41 ndi-window.ts:36-46 reload budget is lifetime and give-up is log-only; ndi-output send recovery is bounded and visible (good).

## Verified handled well
Renderer sender backpressure and drop counters; server in-flight cap 64 with warn; sequence-gap tracker; silence gate floors/ceilings and gate-closed-loud warning; WS server (socket error handler, guarded callbacks, payload cap, heartbeat, slow-consumer drop, schema validation); Groq timeout, 429 requeue, Retry-After, ordering; Deepgram connect timeout, keepalive, stop-during-connect; failover rollback, stop waits for activation, auto-return with backoff and anti-flap; local whisper bounded backlog, timeouts, bounded restart, post-resume probe; verse index validation, answersRequest check, half-open single probe, display-intent tickets so stale lookups and emergency clear are respected, auto-clear on every verse; overlay capped-backoff reconnect and Escape clear; atomic config/history/media writes with quarantine instead of overwrite; safeStorage required; secret scrubbing on viewer-visible errors; NDI bounded recovery with status.
