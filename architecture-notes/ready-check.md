# Ready check (pre-service checklist)

Status: implemented on branch `worktree-agent-a1ca6accdc990fc56`. This note is the input for the
integrator's ARCHITECTURE.md / TESTING.md / SECURITY.md entries. Those files are not edited here.

## Why

Before a service, an operator has to look at about ten separate places to know whether the app will
work: the mic panel, the ASR line, the AI status, the OBS link, the logs. A failure found 30 seconds into
the sermon is too late. The Ready check is one button that runs those checks and shows a green / amber /
red list, with a fix hint for each line that is not green. The last result also goes into the existing
diagnostics export, so a support request carries it.

## What changes

| Layer | Change |
|---|---|
| `apps/server/core/ready-check.ts` (new) | Pure `runReadyCheck(snapshot, probes, options)`. Input: a plain snapshot plus injected probe functions. Output: `{ startedAt, durationMs, overall, lines[] }`, where each line is `{ id, status: ok\|warn\|fail\|unknown, detail, params?, fixHint }`. `detail` and `fixHint` are fixed codes; `params` are numbers or fixed enum values only. |
| `AppCoreHandle.getMicReadiness()` (new, additive) | Mic running flag, ms since the last frame (from the existing `MicAudioWatchdog`), calibrating flag, `MicHealthMonitor` state, SilenceGate frames received / forwarded and loud-but-closed ms. Plain numbers, IPC only. |
| Desktop main | New `ipcMain.handle("run-ready-check")`. Builds the snapshot from state main already owns and injects the probes. Concurrent clicks share one run. The result is kept in `lastReadyCheck` and written as `readyCheck` into `churchoverlay-diagnostics.json` by the existing `export-diagnostics` handler (`null` when it has not been run). Logs one `ready-check.completed` line with the status of each check (no details). |
| Preload | One allow-listed method, `runReadyCheck()`. It takes no arguments. |
| Renderer | New `ready-check.js` (classic script, no inline JS, CSP unchanged), a block at the bottom of the Microphone card in `index.html`, and CSS that uses the existing tokens (`--success`, `--warning`, `--danger`, `--border`, `--text-faint`). Each line shows an icon glyph (aria-hidden), the check name, a status word (OK / Attention / Problem / Not verified), the detail and the fix hint. State is never shown by colour alone. 88 EN + 88 FR strings, all under `readyCheck.*`. |

No WebSocket action, event or payload was added or changed. The action registry is untouched.

## The checks (fixed order)

1. **mic**: frames arriving (no frame for 4 s or more, the existing `MIC_NO_AUDIO_MS`, is fail), not
   calibrating, not `no-signal`, the gate not stuck closed on loud input (20 s or more, the existing
   `GATE_CLOSED_LOUD_WARN_MS`, is warn), and the gate opened at least once this session
   (`framesForwarded > 0`, otherwise warn "say a few words"). Mic off is warn ("start listening and run
   again").
2. **asr**: a current `asrHealth` of error or rate-limited is fail; throttled or failover is warn. When
   the health is ok, the round trip is checked:
   - **Groq primary**: the existing `GroqTextClient.checkAvailability()` (GET `/openai/v1/models`) with the
     same Groq key the transcription uses. No completion, no audio, no transcription quota spent. Any
     answer other than a 401/403 counts as reachable; 401/403 is fail; a network error is unknown.
     This proves the network path and the key. It does **not** prove that the Whisper endpoint
     transcribes, and the UI text says so.
   - **Deepgram or local engine primary**: there is no safe probe, so the line is `unknown`
     ("cannot be verified before speaking"). It is never shown green (AGENTS.md section 45).
3. **ai** (only when one of the AI helper features is on): `ready` false or no completer is fail ("no
   key"). Otherwise the existing `GuardedTextCompleter.checkAvailability()` runs (a model lookup, no
   completion). That call already has a side effect: a definitive auth or model failure marks the
   helpers unavailable, exactly like the startup check does.
4. **verse-source**: one `getVerse(John 3:16)` through the live `LocalizedVerseSource` in the current
   display mode. The verse is never displayed and does not go through the WS or the cache. If the answer
   has provenance `offline-bundled`, the live API did not answer and the line is warn.
5. **french-fallback**: John 3:16 from the bundled LSG data (local, no network). The data is cached in
   memory and the file is parsed only once per process. With Darby selected, the line is warn: there is
   no offline backup for Darby (ARCHITECTURE.md section 107).
6. **offline-model** (only when offline ASR is enabled): the existing installer `status()` is `ready`.
7. **viewers**: viewer-role WS connections. 0 is fail. A count at or below the connections the app opens
   itself (the dashboard Live preview, plus the NDI window when it exists) is warn. Anything above that is ok.
8. **remote** (only when the phone remote is enabled): more than one operator connection (the dashboard
   is one).
9. **logs**: `access(LOG_DIR, W_OK)` plus the rotating log file's `writeFailures` counter.
10. **clock**: wall clock between 2025-01-01 and 2100-01-01.

Overall status is the worst line, in this order: fail > warn > unknown > ok.

## Bounds and safety

- Every probe has a 6 s timeout (the existing `withTimeout`). The probes run concurrently, so a full run
  is bounded at about 6 s. A timeout is `unknown` ("no answer within N s"). A probe that throws is `fail`
  for verse, fallback, offline model and logs, and `unknown` for ASR and AI.
- A probe's error is never copied into the result. Details and fix hints are codes. Params are clamped
  numbers or values from fixed enums (an unknown translation id becomes `other`). Tests cover this: a
  probe throwing a key-shaped string and a user path leaves neither in the JSON.
- The renderer sends nothing. It renders with `textContent` only and maps unknown status values to
  `unknown`.

## What breaks

Nothing existing. `AppCoreHandle` gained one method; there is only one implementation, and no test
double needed to change. The diagnostics JSON gained one top-level key, `readyCheck`, which is `null`
until the check has been run.

## Tests

- `apps/server/core/ready-check.test.ts` (12 tests): all green with fixed order; checks that do not
  apply are omitted and their probes are not called; every mic failure mode; ASR health overriding the
  probe (and no request while it is failing); missing probe reported as "cannot verify"; auth rejected;
  AI failure modes; verse, fallback and offline model failure modes; viewers, remote, logs and clock;
  a hanging probe with fake timers (all six time out to `unknown`, six timers); a real 30 ms timeout;
  no secrets or error text in the output; every emitted code in the published lists; ordering for the
  overall status.
- `apps/server/core/app-core.test.ts`: `getMicReadiness` with the mic stopped, then running with
  forwarded frames.
- `apps/desktop/renderer/ready-check.test.ts`: every code, check id, status and provider has EN and FR
  strings; the script tag, element ids, preload method, IPC handler and export wiring are all present;
  the renderer uses no `innerHTML` and shows a status word.
- The existing i18n parity and page-asset tests pass. Full run: 1830 pass, 0 fail, 3 skipped (baseline
  1814). `npm run typecheck` is clean.

## Limits (known, documented)

- **ASR round trip**: real only for Groq, and only to the level of key + network. Deepgram and the local
  engine report `unknown`. A Deepgram probe (for example the projects endpoint) would be a new network
  call, so it was left out of scope.
- **Viewers**: the WS server only knows roles, not pages. Overlay, stage, live and NDI all share the
  viewer role, so the check cannot say which page is missing. The internal-preview estimate is
  approximate: while the Overlay view's design preview is open it adds one viewer, which can turn a
  missing OBS source into a false "ok".
- **Mic check** reflects the last few seconds. It cannot tell whether the right person's microphone
  is the one connected.
- **Verse lookup** spends one live Bible API request per run (two in bilingual mode).
- **Clock** check only catches a clearly wrong date. It does not detect drift.

## Not verified live

Not run in the packaged Electron app: the button, the IPC round trip, the Groq models call with a real
key, the live Bible lookup, the NDI and viewer counting with real OBS and stage pages, and the
diagnostics export file. ESLint could not be run in this worktree (the shared `node_modules` has no
`typescript-eslint`). Everything above is covered only by the unit and source-wiring tests.
