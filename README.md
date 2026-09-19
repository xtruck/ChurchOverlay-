# ChurchOverlay

A small, deterministic desktop app that listens to a church service's
microphone feed, detects spoken Bible-verse references in real time, and
pushes the matching verse text to an on-screen overlay for OBS — plus an
operator dashboard for manual control.

Pipeline, end to end:

```text
microphone -> normalization -> silence gate -> cloud ASR (Groq Whisper)
   -> final-transcript handling -> regex verse detection
   -> known-valid-verse index (rejects hallucinated references)
   -> verse lookup (cached, with an offline fallback)
   -> WebSocket -> OBS browser-source overlay + operator dashboard
```

It is intentionally small — see [AGENTS.md](AGENTS.md) for the v1 scope
lock (what's in, what's explicitly out) and [ARCHITECTURE.md](ARCHITECTURE.md)
for the full design, module boundaries, and numbered decision log.

## Requirements

- Node.js >= 20.12
- A [Groq](https://console.groq.com/) API key (real-time transcription runs
  through Groq's Whisper endpoint)

## Getting started

```bash
npm install
npm run build
npm start
```

`npm start` builds and launches the Electron desktop app. On first run it
walks you through a short setup screen (Groq API key, church name, language)
before opening the operator dashboard.

There is also a headless Web Server Mode (`npm run start:web`,
ARCHITECTURE.md section 80) for running on a machine with no display —
it serves the same overlay and phone-remote pages plus a REST API over a
single port, reachable from any browser on the network.

## Scripts

| Command | What it does |
|---|---|
| `npm run build` | Compiles TypeScript to `dist/` |
| `npm run typecheck` | Type-checks without emitting |
| `npm start` | Builds and launches the Electron app |
| `npm run start:web` | Builds and launches the headless web server (Express + WebSocket on one port) |
| `npm test` | Builds and runs the full test suite (`node --test`) |
| `npm run test:live-groq` | Runs the live Groq integration test against a real API key (loads `.env`) |
| `npm run dry-run` | Runs the pipeline against synthetic transcript text, no microphone or ASR key required |
| `npm run dev:preview` | Headless dev preview harness (loads `.env`) |
| `npm run package` | Builds an unpacked Electron distributable (`electron-builder --dir`) |
| `npm run dist` | Builds installable Electron distributables for the current platform |

## Configuration

For the desktop app, configuration (Groq API key, church name, display
language, etc.) is entered through the app's own setup screen and stored
locally via the app's config store — no `.env` file is required. A `.env`
file is only read by the live-test/dev-preview scripts above and by Web
Server Mode. See [.env.example](.env.example) for the variables each of
those reads.

## Project layout

```text
apps/desktop/    Electron main process, preload bridge, operator dashboard renderer
apps/server/     Application core: ASR providers, verse detection/lookup, WebSocket server
apps/web/        Headless Express entry point (Web Server Mode)
apps/overlay/    The plain static page loaded as an OBS browser source
apps/remote/     The plain static phone-remote page
packages/        Shared contracts and utilities used across apps/
scripts/         Dev/dry-run/live-test entry points
```

## Documentation

- [ARCHITECTURE.md](ARCHITECTURE.md) — authoritative design doc: module
  boundaries, security model, WebSocket protocol, and a numbered log of
  every architectural decision made in this project
- [AGENTS.md](AGENTS.md) — scope lock and working rules for anyone (human
  or AI) making changes here
- [ROADMAP.md](ROADMAP.md) — planned/phased work
- [SECURITY.md](SECURITY.md) — security model and reporting
- [TESTING.md](TESTING.md) — how the test suite is organized and run

## License

Private project — no license granted for reuse.
