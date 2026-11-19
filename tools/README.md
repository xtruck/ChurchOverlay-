# ChurchOverlay offline tools (Python)

Development-time utilities. **They are not part of the app and add nothing to the download:**
electron-builder ships a whitelist of files (`package.json` → `build.files`) and `tools/` is not on it.
Everything runs on the **standard library**; the libraries in `requirements-optional.txt` only make
things nicer. Python 3.10+.

They all work from what a real service leaves behind: the app's JSONL log (the app writes it to stdout;
redirect it, e.g. `ChurchOverlay.exe > service.jsonl`) and recorded audio.

| Tool | Question it answers | Needs |
|---|---|---|
| `alias_miner.py` | Which mis-heard book names should become `PHONETIC_BOOK_ALIASES`? | a log with `correction.candidate` events |
| `log_to_replay.py` | Which real transcripts should become regression tests? | a log (+ `npm run build` for `--with-detector`) |
| `asr_bakeoff.py` | Which ASR provider is more accurate, and are its *numbers* right? | a reference transcript + provider outputs |
| `vad_eval.py` | Does the silence gate drop real speech? Would another threshold or Silero VAD be better? | a 16-bit mono WAV + speech labels |
| `quote_tuner.py` | Are the verse-quotation matcher's thresholds right? | `npm run build` |
| `service_report.py` | How did the service go (latency, near-misses, AI trouble, gate)? | a log |

```text
python tools/alias_miner.py service.jsonl --format ts
python tools/log_to_replay.py service.jsonl --with-detector --only-interesting
python tools/asr_bakeoff.py --reference said.txt --hyp groq=groq.txt --from-log deepgram=service.jsonl
python tools/vad_eval.py room.wav --labels speech.csv --sweep 50,100,150,250,400
python tools/quote_tuner.py --quick            # or the full grid: ~30 s
python tools/service_report.py service.jsonl --csv latency.csv --chart report.png > report.md
```

## Rules these tools follow

- **Output is evidence, never an automatic change.** Nothing here edits the app. `alias_miner` and
  `log_to_replay` print TypeScript rows for a human to review; `quote_tuner` and `vad_eval` print tables.
- **They read the app's own source of truth.** `churchtools/appdata.py` parses the alias tables and book
  catalog straight from the TypeScript files, so the tools cannot drift from the detector.
- **They run the real code where it matters.** `log_to_replay` and `quote_tuner` call the *built* detector and
  matcher (`dist/`) through small Node helpers in `node_helpers/`; `vad_eval` is a line-by-line port of
  `silence-gate.ts` (threshold 150, 600 ms hangover), covered by tests.
- **Bad input is counted, not fatal.** Pasted or truncated logs are normal; skipped lines are reported.

## Tests

```text
python -m unittest discover -s tools/tests
```

Standard library only. Tests that need the compiled app (`npm run build`) or Node are skipped when those are
missing. The fixture `tests/fixtures/sample.jsonl` is a trimmed real service log (2026-10-12); its three
`correction.candidate` lines are shaped examples, because that event only appears when an operator corrects a
near-miss by hand.

## Reading `quote_tuner` honestly

Positives are real LSG verses read exactly and with simulated ASR damage; negatives are Bible-flavoured text that
is **not** a quotation (3-word chunks from four unrelated verses) plus ordinary sermon sentences. Half a verse read
aloud *is* a quotation, so it is deliberately not used as a negative. The noise model is synthetic: before changing
a default, add real sermon sentences with `--negatives file.txt` (for example finals from a past service).
