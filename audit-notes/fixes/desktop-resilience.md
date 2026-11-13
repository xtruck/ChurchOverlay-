# Desktop resilience (B1 + B2)

## B1: logging, process guards, window recovery, startup
- `apps/desktop/main/log-file.ts`: `RotatingLogFile` (userData/logs/churchoverlay.log, 5 files x 5 MB, async bounded queue of 2000 lines, write failures counted not thrown, `flushSync` for the crash path), `LogRing` (last 500 lines), `createLogSink` (stdout + ring + file; broken stdout counted). All lines pass `redactInlineSecrets` (new non-truncating export in `packages/shared/logger.ts`, `scrubSecrets` now uses it).
- `apps/desktop/main/resilience.ts` (Electron-free, tested): `installProcessGuards`, `NoticeBoard`, `ReloadBudget`, `awaitWithTimeout`, EN/FR startup dialog text.
- `index.ts`: Logger now writes through the sink; `uncaughtException`/`unhandledRejection` handlers (log with stack, notice to dashboard, never exit, rate limited, re-entrancy guarded; fatal + native dialog only while no window exists yet); dashboard `render-process-gone` / `did-fail-load` (bounded reload: 3 per 2 min, 1/2/4 s backoff) / `unresponsive` / `responsive`; `backgroundThrottling:false` (SF-15); safeStorage failure shows `dialog.showErrorBox` (EN/FR by `app.getLocale()`) then quits; `startup.services-failed` also raises a dashboard notice; whenReady `.catch`; `before-quit` prevents default, awaits `shutdown()` max 5 s + log flush max 1 s, then quits; `export-diagnostics` now works even when services never started and includes `desktopLog` stats (+ `churchoverlay-recent-log.jsonl` from the ring).
- IPC/preload: `open-logs-folder`, `get-main-notices`, event `main-notice` (`openLogsFolder`, `getMainNotices`, `onMainNotice`). Dashboard: "Open logs folder" button next to Export diagnostics; notices land in the Activity log + toast. Main sends codes, the renderer owns the EN/FR text (`notice.main.*`).
- Mic after a renderer crash: main marks the `renderer-recovered` notice `resumeMic` (handed out once). The renderer remembers "operator wants mic" in localStorage (read and cleared at load); only with that one-shot flag does it wait (max 20 s) for the WS, then call `startMic()` (one `mic:start`, no duplicate with the WS-open resend). If it cannot restart it sends `mic:stop` so the server agrees and tells the operator it was NOT restored.

## B2: mic capture honesty (`apps/desktop/renderer/mic-capture-guard.js`)
- `classifyMicError`: permission-denied / not-found / in-use / overconstrained / other, each with its own EN/FR message (`mic.error.*`).
- `createMicWatchdog` state machine: idle, starting, live, muted, suspended, no-frames, ended, silent. `live` only while frames flow (no frame for 3 s = no-frames; no first frame after 5 s = no-frames; digital-zero frames for 20 s = silent, warn only).
- `createRecoveryPolicy`: 5 re-acquire attempts, 1 s doubling to 15 s, budget refilled after 30 s stable live; non-retryable errors (permission, overconstrained) give up at once.
- `dashboard.js`: track `ended`/`mute`/`unmute`, AudioContext `statechange` (auto `resume()`, escalates to re-acquire after 8 s), `devicechange` (enumerates inputs, ends capture if ours is gone), 1 s watchdog tick, visible `#mic-capture-status` line (red when lost), mic bars "active" only in `live` (and red when lost), audio sequence numbers continue across a re-acquire (no false server gap), Stop always available while lost.
- Renderer-side state for the server agent to display: `micCaptureState` values above in `#mic-capture-status[data-state]`; no WS protocol change.

## Tests
`log-file.test.ts` (10), `resilience.test.ts` (13), `mic-capture-guard.test.ts` (12, includes wiring/i18n/preload source checks). Run from a private build with `i18n.test`, `audio-stream.test`, `logger.test`: all pass. `npx tsc --noEmit` and `npm run lint` clean (lint now also covers mic-capture-guard.js).

## Not verified
- Nothing was run in a real Electron window: real unplug / sleep-wake / `kill` of the renderer, the dialogs, `shell.openPath`, and the getUserMedia error names on Windows were not exercised.
- Whether the "silent" threshold (20 s of exact zeros) false-positives on some drivers with aggressive noise gating (it only warns).
- A French-language race: notices fetched at load may be logged before `setLanguage` runs.
