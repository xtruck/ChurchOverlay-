# Dashboard audit notes

Harness (not in repo): scratchpad/harness/server.js serves apps/desktop/renderer on :4321 with a mock window.churchOverlay and a FakeWebSocket (synthetic events via window.__ws.emit(type,payload)). The dashboard cannot run in `start:web` (ARCHITECTURE 80.2).

## Root causes
- dashboard.css `.view-live-grid`: row `minmax(0,1fr)` + `min-height:0` let the program row collapse to ~0 with the Activity drawer open at 1366x768; the 16:9 iframe (min-height 240) painted over Heard strip and Activity log. Fixed: `minmax(320px,1fr)` + `min-height:min-content` (view scrolls instead).
- `.drawer-body` max-height 320 / card max-height 300 clipped the Activity card header+4 export buttons, leaving ~3 log lines. Fixed: fixed 300px card height, log min-height 120.
- Activity log (dashboard.js log/ws message handler): logged every status:update and verse:preview-result (per keystroke) as "received <type>" in a 50-line window; no content ("received transcript:final"). Fixed: quiet types, detail (transcript text / verse ref), 200 lines, title tooltip for long lines, content-visibility.
- Manual entry: invalid format only produced a toast + red border; preview text was faint grey and clipped at 3 lines. Fixed: inline format hint (EN/FR, mentions French names), muted-contrast scrollable preview.

## Proposed ARCHITECTURE.md text (section 131 addendum)
The Live grid reserves a minimum program-monitor height (320px) and scrolls the view rather than shrinking it; the Activity log ignores high-frequency types (mic:health, transcript:partial, status:update, verse:preview-result, rundown:state), shows a one-line detail, keeps 200 lines. Pressing Show on unparsable text shows a format hint in the preview slot (key reference.formatHint).

## Left alone
- Client regex `parseReference` sends "1ère jean" as book -> server null (shows "No such verse"); French ordinal prefix not handled (server quick-book owns resolution).
- Preview silently does nothing if WS is closed.
- No Bible-browser seam built; grid area names (command/program/heard/side/drawer) are stable for the other agent.
- renderClocks (1s) and refreshLatency (5s) timers run while views are hidden (cheap).
