# ASR failover and mic fixes (SF-05..SF-09, SF-13, SF-19, SF-21/22, TS-02, TS-11)

## Changes
- TS-02 / SF-07 / SF-11 / SF-21 (failover-provider.ts): one in-flight activation; a failed secondary start records an outage
  (exponential backoff 2 s -> 60 s cap, `activationRetry` options with injectable clock), is reported ONCE
  (errorCallback + `onSecondaryUnavailable`, state via `secondaryUnavailable()`), frames are dropped and counted meanwhile, the
  primary is stopped once per outage, and on each retry a recovered primary is also restarted. `void activateFailover()` now goes
  through `failOverQuietly()` (no unhandled rejection). start() while on the secondary stops the secondary first and clears the
  outage state. A failed returnToPrimary where the secondary also cannot restart enters the outage state instead of pointing at a
  stopped provider.
- SF-13 (local-whisper-server.ts): child `error` listener (logged, detached, restart schedule applies). SF-22: `onRestartAbandoned`
  option; desktop main sets `localEngineAbandoned` so `localActive` stops advertising a dead backup (pull-based, plus an error log
  `local-whisper.backup-lost`).
- SF-05 (groq-provider.ts): `GroqHttpError` (kind key-refused for 401/403, server for 5xx). 401/403: clear French/English "key refused"
  error, one-shot `onKeyRefused` signal (failover wrapper with the sustained-rate-limit trigger fails over at once), chunk discarded
  through the DropLedger ("segment:groq-key-refused") and logged `asr.audio-discarded`. 5xx: chunk requeued behind a bounded
  backoff (2 s doubling, cap 30 s) via the existing throttle, joins the network failure streak (sustained => failover); the
  sustained signal now repeats every 3rd failure so a failed failover is retried (the wrapper rate-limits it). Every discard path
  now goes through one `discardAudio()` helper (ledger + rate-limited log). 429 behaviour untouched.
- SF-08: new `apps/server/audio/mic-audio-watchdog.ts` (pure, injected clock). app-core runs a 1 s timer while the mic is running;
  no frame for 4 s -> `mic:health` state `no-audio` (additive; validated in action-registry; contract type; dashboard text EN+FR and
  CSS) and a dropout in the service-health report (`observeMicState` counts `no-audio`). Resumed frames reset the health window and
  close the dropout. New `timers` option on startAppCore for tests.
- SF-06 / TS-11: `asr.start()` is bounded (20 s, `asrLifecycleTimeoutMs`, injectable timers); on failure/timeout the server reverts to not
  running, stops the watchdog, releases the provider, broadcasts status error plus the new operator-only event `mic:start-failed {reason}`
  (scrubbed, validated, not in the viewer allow-list). Dashboard shows "listening did not start: reason" and stops capture. `asr.stop()` in mic:stop is bounded too.
- SF-09: `mic:start` while already running is a no-op (no recalibration, no ASR restart) that re-broadcasts calibration/threshold state.
- SF-19: DeepgramProvider `reconnectOnClose` (opt-in; desktop enables it when Deepgram is the last provider in the chain): audio-driven
  reconnect with exponential backoff (1 s -> 30 s), one attempt at a time, failures reported.
- Perf: `localEngineThreads(cpus)` is now floor(cores/2) clamped 2..8 for every use (was cores-1 by default); `WhisperServerOptions.threads` still overrides.

## Tests added (all deterministic, injected clocks/fakes)
failover-provider.test.ts (TS-02 x6, SF-07, SF-21 x2), groq-provider.test.ts (SF-05 x7), local-whisper-server.test.ts (threads, SF-13, SF-22),
deepgram-provider.test.ts (SF-19 x3), mic-audio-watchdog.test.ts (new), action-registry.test.ts (2 + list), app-core.test.ts (SF-08 x2, SF-06, TS-11, SF-09).

## Unverified / notes
- Not exercised against real Groq/Deepgram, a real unplugged mic, or the Electron UI (dashboard hunks only syntax-checked and covered via i18n keys).
- app-core.test "broadcasts mic:health ... auto-gain" listens on the VIEWER socket; it fails since the S-01 viewer allow-list (another
  agent's change) hides mic:health from viewers. Needs to listen on the operator socket.
- action-registry "contains all registered actions" list lacks `verse:lookup-failed` (another agent's event).
- i18n.test reports missing English keys from the renderer-mic agent's in-flight work (not from this change).
- SF-22 is pull-based (`localActive`); no live push to the dashboard when the engine is abandoned.
- Sustained-rate-limit trigger: a failed first failover is retried only when Groq reports another sustained signal (every 3rd failure), not frame-driven.