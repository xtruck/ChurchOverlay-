# ChurchOverlay performance audit (read-only, in progress)

Machine: i5-8365U 1.6 GHz (4c/8t), Node 24.19, shared/loaded (100% CPU from other processes during runs; numbers are noisy, CPU-time reported where possible). Compiled with tsc to scratchpad out dir.

## 1. Startup / eager loads (MEASURED)
- fra_lsg.json: 4.32 MB on disk; read+JSON.parse = 170-200 ms CPU (240-300 ms wall); parsed heap +16.6 MB.
- QuoteMatcher index build (31,170 verses): ~3.0 s CPU (3.8-4.7 s wall); heap +38 MB. (Source comment claims ~0.65 s: true only on a fast dev box.)
- BibleWordSearch index build: ~2.5 s CPU (3.5-4.3 s wall); heap +19 MB.
- Both run async in 15 ms slices after startup (apps/desktop/main/index.ts lazyQuoteMatcher, bible-word-search.ts createLazyBibleWordSearch), so the dashboard is not blocked, but ~6-8 s of background CPU on the main process; max event-loop gap observed 200 ms during async build.
- Total RSS of a bare node with both indexes: ~198 MB vs 55 MB baseline (+57 MB heap from indexes alone).
- Both tokenisers do NFD+regex per verse (full tokenise of all verses alone ~1.6 s here): the same text is tokenised twice.
- Electron startup (process start -> dashboard ready): NOT measured (cannot launch Electron GUI read-only/headless here).
- match() cost, QuoteMatcher per final: 20 words 77 us; 60 words 0.6 ms; 200 words 0.9 ms; 600 words 2.1 ms; 2000 words 7.2 ms (loaded box). Negligible per final.
- BibleWordSearch.search: 1.2 ms (single common term) to 45 ms (8-word query), operator-triggered only.

## 5. Packaging (MEASURED from release/win-unpacked)
- Installer 122 MB; ChurchOverlay.exe 236 MB (Electron base, not avoidable), resources 104 MB, locales already limited to en-US+fr.
- app.asar = 10.3 MB (fra_lsg.json 4.4 MB of it, fonts x5 copies ~350 KB, mp4 129 KB: negligible).
- app.asar.unpacked = 94 MB, all @stagetimerio/grandiose (NDI): build/Release 51 MB (obj/*.obj, .pdb, .lib, .exp, .iobj/.ipdb build artefacts), ndi/ 35 MB (x64 + x86 DLL + headers), dist/ 29 MB. Processing.NDI.Lib.x64.dll (29.8 MB) exists 3 times, x86 DLL (6 MB) once. Gzip of one DLL = 3.6 MB, so installer saving is probably 5-15 MB (not measured, needs a build); on-disk saving ~60 MB.
- Caveat: grandiose uses `bindings`, which looks in build/Release first, so keep build/Release/grandiose.node (+ one DLL); exclude obj/, *.pdb, *.lib, *.exp, *.iobj, *.ipdb, ndi/lib/win-x86, src/ via files/asarUnpack filters, then verify NDI loads in a packaged build.

## 2. Memory over a simulated 3 h service (MEASURED)
Script (scratchpad sim.js) against compiled startAppCore: fake ASR, real RegexDetector, real KnownValidVerseIndex, stub verse source, 1 operator + 4 viewer WS clients, real silence gate and adaptive gain. 108,000 audio frames of 1600 samples, 1,440 finals + 10,080 partials (1 reference mention per 8 finals), 180 simulated minutes, forced GC at checkpoints.
- Heap: 8.6 MB start, 10.4 (30 min), 10.5 (60), 10.6 (90), 10.6 (120), 9.3 (150), 9.4 (180 min). Flat, no growth trend. After stop: 9.3 MB.
- RSS 68 -> 85 -> 110 MB, plateaued from minute 120 (allocator, not heap). Electron renderer/GPU memory: not measured.
- Log lines: 11,704 (4.7 MB if written; test logger only counted). Production sink file growth: not measured.
- WS fan-out: 112k messages / 39 MB total to 5 clients in 3 h; broadcast stringifies once (ws/server.ts:297) and terminates slow consumers past 4 MB buffered. Fine.
- Bounded by design (read in code): SessionRecorder 5000, SessionHistoryStore 5000, ServiceHealth 50/200, latency tracker capacity, drop ledger 300, near-misses limit, rolling window, dashboard log 200 lines, toasts 3, sermon feed 20.
- Only unbounded set found: posterCueIds (app-core.ts:491), bounded in practice by media library size; negligible.
- Limits: real-time timers (verse auto-clear 150 s, settle holds) not run on a 3 h clock; verse:show count not asserted; real providers (Groq/Deepgram, local whisper) and Electron not included.

## 3. Hot paths (MEASURED)
- Per audio frame (128 samples, 125/s; audio-path.bench): silence gate robust 2.8 us, adaptive gain 4.0 us, mic health 0.6 us, WS encode+decode 9.3 us = about 0.2% of one core. Nothing to optimise.
- Full AppCore over WS (sim): 82-130 ms CPU per 600 frames (60 s of audio, includes the test sender) = ~0.2%; transcripts (8 finals + 56 partials per minute, 5 clients) 275-450 ms CPU per minute = under 1% of a core.
- Per final (loaded i5-8365U), 20/100/400/1500 words: detector.detect 0.22/0.85/4.2/11.7 ms; normalizeSpokenReferences 0.09/0.31/1.1/4.4 ms; correctTranscription 0.03/0.15/0.35/1.2 ms; screenTranscript 0.2/1.2/2.0/7.1 ms; QuoteMatcher.match 0.08 (20 words), 0.6 (60), 0.9 (200), 2.1 (600), 7.2 ms (2000). A typical final costs ~1-3 ms every ~8 s. Not a problem; keep the assembler window bounded (it is).
- Renderer audio path (read, not measured): AudioContext at 16 kHz, worklet posts every 128-sample block = 125 postMessage + 125 WS binary sends/s, each allocating Float32 + Int16 + encoded buffers (dashboard.js:3140). Works; batching is a later optional win and changes frame size seen by silence gate, so not before first live test.

## 4. Renderer / overlay / NDI (read + partly measured; no GPU/FPS measurement possible here)
- dashboard.js (204 KB): only 3 timers (NDI status poll 2 s only while NDI is on, latency refresh 5 s, clock 1 s); trivial. Activity log capped at 200 DOM nodes with content-visibility:auto; transcript pane is one textContent write per message; partials, mic:health and status:update skip the log. One JSON.parse per message. Lists (media grid, rundown) rebuild with innerHTML="" only on state changes. No growth or jank issue found.
- bible-browser.js: a chapter (max ~176 verses) rendered via textContent resets; search results capped at 20 server side. Fine.
- Overlay fit (overlay.js measureFit): binary search over font size, each probe = setFontSize + offsetTop/offsetHeight (forced layout), ~8-10 layouts per verse change, deferred until the animation settles. A few ms per verse, never per frame. OK.
- Overlay CSS risk (not measured): backdrop-filter blur 14-28 px on the verse card (12 occurrences in index.html), blur() filter keyframes, and `infinite alternate` decorative animations (vc-breathe 9 s, vc-drift 28 s) on some designs repaint continuously while visible, in OBS CEF and in the NDI offscreen window. Whether 60 fps holds in OBS on this iGPU: NOT measured (needs OBS). Mitigation: choose designs without backdrop blur / drop the infinite animations (CSS only, low risk).
- Fonts: 4 local woff2 (font-display: swap), duplicated 5x across apps (~350 KB): negligible; overlay refits on fonts loadingdone.
- NDI (ndi-output.ts, read): 1920x1080 BGRA, 30 fps when changing / 10 fps keep-alive. Each painted frame: toBitmap() allocates an 8.3 MB copy (~250 MB/s garbage at 30 fps while animating) + in-place unpremultiply ~5 ms (author's figure, not re-measured). Frames are superseded when the sender is busy (no queue). NDI CPU on the church laptop: NOT measured (needs NDI runtime).
- Electron: no backgroundThrottling setting found in main; mic capture lives in the dashboard renderer. Behaviour with the dashboard minimized/covered by OBS: NOT measured, verify in first live test.

## 6. Local whisper / faster-whisper CPU policy (read from code; not measured, no model installed)
- Both engines use WhisperServerProcess: threads = cpus-1 as fallback (7 on 8 logical CPUs) or floor(cpus/2) in offline-first (4 here), clamped 2..8; priority BELOW_NORMAL (local-whisper-server.ts:91,241). faster-whisper: int8 on CPU, beam_size 1, one inference at a time.
- Author's measurement (ARCHITECTURE.md 139): 7 threads ~72% of machine while decoding, 4 threads ~28-37%. Risk: a cloud failure triggers the fallback mid-service next to OBS+NDI and takes ~72% CPU per decode. Suggest cores/2 in the fallback case too (1-line change; only slower decode).

## Other packaging notes
Unavoidable: ChurchOverlay.exe 236 MB, dxcompiler.dll 25 MB, LICENSES.chromium.html 20 MB (legal, keep), resources.pak 12 MB, icudtl 11 MB, vk_swiftshader 5 MB. asar cold-start: not measured (10 MB archive; expected tens of ms). node_modules in asar carries execa/got/keyv/mime-db (~700 KB): negligible.

## RECOMMENDATIONS (biggest wins first)

### Before the first live test
1. Startup background CPU: the two Bible indexes cost ~5.5 s CPU (3.0 + 2.5 s) right after launch and +57 MB heap in the main process that also serves audio/WS (sliced at 15 ms, max loop gap 200 ms observed). Cheapest safe fix: build the word-search index on first Bible Browser search instead of at startup (lazy handle + "indexing" state already exist, apps/desktop/main/index.ts:510). Saves ~2.5 s CPU and 19 MB at launch. Effort ~10 lines + test. Risk low (first search waits a few seconds). Sharing one tokenisation pass between the two builds is a further ~1.5 s, moderate effort, low risk.
2. Make the first live test the measurement: dashboard minimized 10 min with mic on (watch captureGaps), OBS fps with the chosen card design, NDI on with Task Manager CPU, local fallback forced once.
3. Fallback whisper threads: cores/2 instead of cores-1 (section 6). Effort 1 line + test. Risk: slower fallback decode.
4. Packaging: exclude grandiose build artefacts (build/Release/obj, *.pdb, *.lib, *.exp, *.iobj/*.ipdb, ndi/lib/win-x86, src/): ~60 MB on disk, est. 5-15 MB of the 122 MB installer (not measured). Risk medium for NDI (bindings resolves build/Release first): only with `npm run package` + NDI start verified; otherwise defer.

### Later
5. Batch audio blocks (128 -> ~1600 samples per WS frame): ~0.2% CPU today, needs silence-gate retuning tests. Low priority.
6. NDI: lower active FPS (30 -> 25) or avoid the 8.3 MB per-paint copy only if NDI CPU proves high.
7. Overlay: remove backdrop-filter and infinite animations in chosen designs if OBS stutters.
8. Precompute or worker-thread the Bible indexes (removes the remaining ~3 s startup CPU) only if item 1 is not enough; adds a build step or thread.
9. Dedupe the 5 font copies (350 KB): not worth it.

### Measured, not an issue
Memory growth over 3 h, per-frame audio cost, per-final detection cost, WS fan-out, renderer DOM growth, timers.

### Not measured at all
Electron process start to dashboard-ready; Electron renderer/GPU memory; OBS fps; NDI CPU; asar cold start; installer effect of exclusions; whisper decode CPU/latency. All timings are from a loaded (100% background CPU) i5-8365U, so treat as upper bounds; builds quoted as CPU time where possible. The source comment claiming ~0.65 s per index build was not reproduced here (3 s CPU).
