# Phase 7 spike: native (Rust/N-API) audio capture/buffering/VAD module

Status: **investigation only, as requested — no code written for this.** This
document is the "report expected effort and risk" deliverable from the
performance pass; it is not an implementation plan to execute. Do not start
this without a separate, explicit go-ahead — see the recommendation at the
end.

## The question being investigated

Would moving the latency-critical slice of the pipeline — audio capture,
buffering, VAD — out of Electron/Node and into a small native module (Rust
via N-API, or similar), while leaving Electron for the UI, measurably reduce
end-to-end latency (mic → verse displayed)?

## What the pipeline actually does today (verified against the code)

- **Capture**: `getUserMedia` + `AudioWorklet` in a hidden Electron renderer
  window (`audio-capture-worklet.js`). This runs on Chromium's own native
  audio stack (WASAPI on Windows, Core Audio on macOS, ALSA/PulseAudio on
  Linux) — it is already a native, OS-level audio path; Electron/Chromium
  does not do this in JavaScript.
- **Buffering**: the worklet batches into ~4096-sample chunks (~85–93ms at
  typical mic sample rates), downsamples to 16kHz mono PCM16, and transfers
  the `ArrayBuffer` (zero-copy, via `postMessage`'s transfer list) to the
  renderer main thread, which forwards it over `ipcRenderer.send` to the
  main process, which forwards it again (zero-copy transfer) to the
  `worker_threads` worker that runs `server.js`. Net: ~11–12 IPC messages/sec,
  ~3KB each. One of the three hops (renderer → main process) necessarily
  copies the bytes, because it crosses a real OS process boundary — no
  language choice avoids that copy, only different architectures that avoid
  the hop entirely (see below).
- **VAD**: `silero-vad.js` runs the Silero VAD ONNX model via
  `onnxruntime-node` — **already a native N-API addon**, not JavaScript. It
  processes one 512-sample (32ms) window per call, with a small energy-based
  JS fallback (`hybrid-vad.js`) for when the model is unavailable.

## Measurements taken for this proposal

**Silero VAD inference cost**, measured against the real shipped model
(`models/silero_vad.onnx`) on this machine, 200 runs:

```
min=0.22ms  p50=0.31ms  p95=0.68ms  max=10.11ms (single outlier)  mean=0.41ms
```

against a **32ms real-time budget per window** (the model must keep up with
one window arriving every 32ms of audio). At p50 this consumes ~1% of its
budget; even the p95 and the one 10ms outlier stay well under it. There is no
headroom problem here to solve — the neural VAD is already native and already
fast relative to what it needs to do.

**IPC hop cost**: not independently microbenchmarked (would require
instrumenting a full Electron harness, disproportionate for this report), but
bounded by the traffic shape already measured in Phase 2/3 of this pass:
~11–12 messages/sec, ~3KB each, with transferable-buffer (zero-copy) semantics
at two of the three hops. Electron IPC dispatch overhead for messages this
small and this infrequent is reported in the tens-of-microseconds-to-low-
single-digit-milliseconds range in general Electron performance work — i.e.
noise next to the ~85–93ms buffering window and the hundreds-of-milliseconds
Groq/Deepgram network round-trip that dominate this pipeline's actual latency
budget (see `latency-tracker.js` marks: `vad → asrFirstPartial/asrFinal` is
where the real time goes).

## What a native rewrite would and would not change

| Piece                | Today                                                                          | Native rewrite                                                                                                                 | Expected latency delta                                                                                                                                                                                                         |
| -------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Capture              | Chromium's native audio stack via `getUserMedia`/`AudioWorklet`                | A Rust crate (e.g. `cpal`) doing the same OS-level capture, called from a Node native addon in the main/worker process instead | None — you'd be replacing one native audio backend with another; Chromium's is mature, cross-platform, and already handles device enumeration/permissions/hot-swap that a bespoke `cpal` integration would need to reimplement |
| IPC hops             | 2 zero-copy transfers + 1 unavoidable OS-process-boundary copy of ~3KB @ ~11Hz | Eliminated (capture happens in the same process as the pipeline)                                                               | Real but almost certainly sub-millisecond-per-chunk — not enough to be perceptible against an ~85–93ms buffering window and a multi-hundred-ms STT round-trip                                                                  |
| Buffering/resampling | Plain JS (int16 conversion, ring buffer) at 16kHz mono (32KB/s)                | Rust                                                                                                                           | None measurable — this is trivial arithmetic on a small, low data rate; not CPU-bound in JS at this volume                                                                                                                     |
| VAD                  | Already native (`onnxruntime-node`)                                            | Still native, just a different native runtime/binding                                                                          | None — already measured at ~1% of its time budget; nothing to reclaim                                                                                                                                                          |

The honest conclusion: **the pipeline is not latency-bound in the slice this
spike targets.** The dominant costs are (a) the deliberate ~85–93ms
audio-buffering window (a tunable already inside JS, not something requiring
Rust to change) and (b) the cloud STT network round-trip (hundreds of ms to
Groq/Deepgram) — a native audio module changes neither.

## Effort estimate (if pursued anyway)

- **Cross-platform native build matrix**: Windows (WASAPI via `cpal` or raw
  `wasapi`-rs), macOS (Core Audio), Linux (ALSA/PulseAudio) — each needs its
  own testing, and this project currently only ships/builds for Windows
  (`package.json`'s `build.win` config; no `mac`/`linux` targets configured
  today). Supporting only Windows narrows the work but also narrows who
  benefits.
- **N-API/`neon`-based Rust addon**: build tooling (`cargo` + `neon`/`napi-rs`)
  added to the existing `@electron/rebuild` + `better-sqlite3`/
  `onnxruntime-node` native-module pipeline that `postinstall`/`prestart`
  already juggle (see the multiple `try/catch` "rebuild ignoré" fallbacks in
  `package.json` — this area is already fragile).
  CI (`ci.yml`, currently `ubuntu-latest` only, Node 20/22) would need a Rust
  toolchain and, to be meaningful, a Windows runner (the actual shipping
  target), since none exists today.
- **Rewriting device enumeration/permission handling** that `getUserMedia`
  currently gives for free (mic picker UI, permission prompts, device
  hot-swap) — real, non-trivial platform-specific work.
- **Re-deriving/re-validating VAD correctness**: `silero-vad.js`'s own header
  comment documents a real, previously-hit bug (wrong context framing
  froze the model's output at ~0.001 for all input) that took careful,
  empirical verification against the Python reference implementation to
  fix. Any change to how audio reaches the model risks reintroducing a
  class of bug like this.
- Rough order of magnitude: **multiple weeks** for a Windows-only first cut
  (capture + IPC-hop elimination, keeping the ONNX inference call itself
  unchanged since it's already native and already fast), before matching
  today's device-handling robustness — not a "small module," despite the
  phrasing in the original ask.

## Risk assessment

- **Regression risk to a currently-working, non-trivial subsystem.** Audio
  capture/VAD has already been hardened through real incidents (see
  `silero-vad.js`'s header, `hybrid-vad.js`'s multi-tier fallback design).
  Replacing the capture layer risks reopening solved problems for a change
  whose latency benefit is, per the measurements above, not there.
- **New toolchain in the build/release pipeline** (Rust + `cargo` + a
  Node/Rust bridge) alongside the existing native-module fragility already
  visible in `package.json` (`better-sqlite3`, `onnxruntime-node`,
  `sqlite-vec`, all requiring `@electron/rebuild` and asar-unpacking special
  cases). Each additional native dependency is another thing that can break
  across Electron/Node version bumps.
- **Debugging difficulty**: native crashes inside a Node addon are harder to
  diagnose than JS exceptions (no stack trace, platform-specific crash
  dumps) — directly relevant given this session's own experience with an
  intermittent native-module-adjacent crash in the test suite
  (`test-checkin-endpoint.js`'s documented Windows libuv assertion).
- **No CI coverage today for what this would need**: `ci.yml` runs on
  `ubuntu-latest` only; the app ships Windows-only
  (`build-windows.yml`/`package.json`'s `build.win`). A native audio module
  would need Windows CI to be tested at all, which doesn't exist yet.

## Recommendation

**Do not pursue this as scoped.** The measurements taken for this pass show
the audio capture/buffering/VAD slice is not where this pipeline's latency
goes — it's already native (VAD) or already fast (buffering) or already
using the OS's own audio stack (capture). Multiple weeks of cross-platform
native-module work and new build/CI risk for a change with no measured
latency upside is a bad trade.

If the actual goal driving this idea is something _other_ than latency —
e.g. reducing Electron's baseline memory/disk footprint by eventually
replacing the whole UI shell, or a specific platform limitation not yet
hit — that's a different, larger conversation than "Phase 7 spike" and
deserves its own proposal grounded in that actual goal.

If lower latency specifically is still the target, the higher-leverage,
lower-risk levers are already identified elsewhere in this pass and don't
require native code:

- Tune the ~85–93ms AudioWorklet batch size down (pure JS constant, already
  confirmed within the 20–100ms target range, but could go lower if the
  STT provider handles smaller/more frequent chunks well).
- The STT network round-trip is the largest real contributor
  (`latency-tracker.js`'s own marks confirm this) — anything that reduces
  Groq/Deepgram round-trip time (already-instrumented in Phase 1/2 of this
  pass) has far more leverage than anything in this native-module spike.
