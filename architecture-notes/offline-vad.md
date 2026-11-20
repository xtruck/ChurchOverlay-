# Silero VAD inside the offline whisper.cpp engine

Status: implemented and opt-in (default OFF). Not yet tested on real hardware. This note is
for the integrator to fold into ARCHITECTURE.md (it belongs next to sections 99, 113 and 139).

## Why

When the offline engine (ARCHITECTURE.md section 99) handles an utterance, the request still
contains silence, music and room noise around the speech. On weak hardware Whisper spends a full
encode on every 30 s window, and non-speech audio is the classic trigger for hallucinated text
("Merci d'avoir regardé", section 73.1). whisper.cpp ships Silero VAD (a model of about 0.9 MB that
takes under 1 ms per chunk on one thread). With VAD on, the engine drops non-speech before decoding.
The expected result is less CPU and fewer invented transcripts. Neither has been measured yet.

## Is the flag supported? Yes, confirmed from source, and checked again at runtime

- The pinned engine is whisper.cpp **v1.8.0** (`WHISPER_RELEASE`). In that tag,
  `examples/server/server.cpp` parses `--vad` and `-vm/--vad-model` and prints both under
  "Voice Activity Detection (VAD) options" in `--help`. I read this from the v1.8.0 source on
  GitHub. I did not run the real binary.
- As a defence against a different build, the app also runs `whisper-server.exe --help` once at
  service start, but only when VAD is enabled and the model is verified. The probe is bounded:
  10 s timeout, child killed on timeout, 64 KB output cap. It requires both `--vad` and
  `--vad-model` to appear as whole options. A spawn error, timeout, empty output or missing flag
  each produce an explicit `binary-unsupported` status with the reason. The probe never throws.

## What changes

- `apps/server/asr/whisper-vad.ts` (new, no Electron):
  - `buildWhisperCppServerArgs()` builds the old whisper.cpp command line, moved out of
    `WhisperServerProcess`. Without VAD the output is unchanged byte for byte. With VAD it appends
    `--vad --vad-model <path>`.
  - `parseVadCapability()` and `probeWhisperVadSupport()` do the runtime capability check.
  - `resolveLocalVad()` makes the decision. It returns `off`, `active(modelPath)` or
    `unavailable(reason, detail?)`, where reason is one of `engine-unsupported` (faster-whisper),
    `local-engine-not-ready`, `model-missing`, `model-corrupt`, `checksum-unpinned` or
    `binary-unsupported`. The cheap checks run first, and the probe runs only when it can still
    change the answer.
- `WhisperServerProcess` gains an optional `vadModelPath`. It is ignored when `buildArgs` is set,
  so no whisper.cpp flags reach the faster-whisper sidecar.
- `LocalAsrInstaller` (desktop main):
  - `SILERO_VAD_MODEL` holds the file, a URL pinned to Hugging Face revision
    `9ffd54a1e1ee413ddf265af9913beaf518d1639b` of `ggml-org/whisper-vad` (not `main`), the
    SHA-256 and the exact size (885,098 bytes).
  - `installVadModel()` reuses `downloadToFile()`. `maxBytes` is set to the exact pinned size, so
    a larger body is refused mid-stream. It then checks size and SHA-256 over the whole file,
    deletes a bad `.partial`, and moves the file into place with `rename`. Concurrent calls share
    one download, and a model that is already verified is not downloaded again.
  - `vadModelStatus()` hashes the file again at every service start. The file is under 1 MB, so
    this is cheap, and a corrupt file never reaches the engine.
- Config: optional `localAsrVad` boolean, following the `localAsrEnabled` pattern. Absent means
  off. A bad value falls back field by field with a warning (B6). Writes go through the existing
  atomic `ConfigStore` (temp file, sync, rename). It is also part of the restart comparison in
  `apps/desktop/main/index.ts`.
- `startServices()` resolves the VAD status before building the engine. It logs
  `local-whisper.vad-active` when active and `local-whisper.vad-unavailable` (warn, with the
  reason) when enabled but not applied.
- IPC `set-local-vad`: turning VAD on first downloads and verifies the model. A failed download
  returns the install error and the setting is NOT saved. Turning it on or off restarts the
  services so the engine's command line matches. `currentAsrStatus()` exposes `localVadEnabled`
  and `localVad`.
- Dashboard: a switch in the Offline backup card and a status line (EN and FR). The status line
  shows "Turned on, but NOT applied: <reason>" whenever the switch is on but VAD does not apply.

## Explicit behaviour, not a silent fallback

If VAD is enabled but unavailable, the offline engine still starts, without VAD, exactly as
before this change. This is reported in three places: a warning log with the reason, the
`localVad` status field, and the dashboard text. I chose this over refusing to start the engine
because the engine is the last link of the failover chain, and VAD is an optimisation.
Disabling the backup because an optional optimisation failed would be worse.

## Checksum situation

The SHA-256 `29940d98d42b91fbd05ce489f3ecf7c72f0a42f027e4875919a28fb4c04ea2cf` is the Git LFS
object id that Hugging Face's API reports for `ggml-silero-v5.1.2.bin`. An LFS oid is by
definition the SHA-256 of the content. I read it on 2026-11-19 from
`https://huggingface.co/api/models/ggml-org/whisper-vad/tree/main`. The repo was at commit
`9ffd54a1…`, and the URL is pinned to that commit. **I did not download or hash the model
file itself.** The first real download is the first end-to-end check of the pair. If the hash
does not match, the download is refused and deleted (fail closed). If the constant were ever
emptied or malformed, `isPinnedSha256()` fails closed: there is no network request, and
`checksum-unpinned` is reported even for a file already on disk.

v5.1.2 was chosen over v6.2.0 (same repo) because it is the model whisper.cpp documented around
v1.8.0. I have not checked whether v6.2.0 works with the v1.8.0 binary.

## Risks

- VAD may cut speech: soft speakers, a preacher over music, or a first word clipped. The
  defaults from whisper.cpp apply (threshold 0.5, minimum speech 250 ms, padding 30 ms), and none
  are tunable here on purpose. Default OFF limits the impact.
- In v1.8.0's server.cpp, `--vad-min-silence-duration-ms` writes to the wrong field (an upstream
  bug). We do not pass that flag.
- The probe adds one short process spawn at service start, and only when VAD is enabled.

## Tests (deterministic, no network, no real binary)

- `apps/server/asr/whisper-vad.test.ts`: argument building with and without VAD; flag parsing
  from v1.8.0 and older help text; the probe with stderr help, spawn error, a spawn that throws,
  and a hang killed on timeout; every `resolveLocalVad` outcome, including OFF doing no work and
  a missing or corrupt model never reaching the probe; `WhisperServerProcess` passing the flags
  only with a model path, and never into the sidecar.
- `apps/desktop/main/local-vad-model.test.ts`: the pinned constant's shape; missing, download,
  verify and atomic move with progress; idempotence; wrong content refused and deleted; an
  oversized body refused; an unpinned checksum failing closed with no request; a corrupt file on
  disk (wrong size, then flipped bit) detected and then replaced; unsupported platform; HTTP 503.
- `config-store.test.ts`: `localAsrVad` round-trips, is absent (off) by default, and a bad value
  falls back.

## Not verified on real hardware

- That the downloaded v1.8.0 `whisper-server.exe` really prints the VAD flags. This was read
  from source; the runtime probe covers the gap.
- That the real model download matches the pinned SHA-256.
- The CPU saving and the hallucination reduction (AGENTS.md section 34). Both need a before and
  after measurement on the target laptop, with a sermon recording that contains music and silence.
- That VAD does not clip French or English speech in a real room.
