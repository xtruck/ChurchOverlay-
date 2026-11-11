# ASR / microphone audit notes (audio, language, noise, tongues, performance)

Scope: `apps/server/asr/**`, `apps/server/audio/**`, wiring in `apps/desktop/main`. Nothing was measured on real
audio of the church (no recording, no engine installed, no API key). Every threshold below is reasoned and every
drop is logged with its scores so it can be tuned from a real service.

## Findings (before the change)

| # | Finding | Where |
|---|---------|-------|
| 1 | Groq asked for `response_format=json`: no detected language and no segment scores came back, so nothing could be verified. In bilingual mode (`language` undefined) Whisper auto-detected on every 2 s chunk and could decode Spanish, Hindi, etc. | `groq-provider.ts` transcribe() |
| 2 | Deepgram `language=multi` code-switches ten languages (es, hi, ru, de, pt, ja, it, nl besides fr/en); the per-word/transcript language fields were ignored. | `deepgram-provider.ts` handleMessage() |
| 3 | Local engines: language lock already restricted fr/en, but a detection clip decoded in a third language with no fr/en probabilities was kept (a test even asserted it). | `local-whisper-provider.ts`, `local-whisper-bilingual.test.ts` |
| 4 | Silence gate: one fixed threshold on full-band RMS. In a loud room (band, crowd, bass) every frame is "speech" for minutes, so the paid cloud ASR receives continuous noise. Bass/rumble alone opened it. | `silence-gate.ts` |
| 5 | AdaptiveGain: after quiet speech the gain sits near +21 dB; loud music arriving at once is amplified into the soft limiter for about 1 s (smoothing 800 ms) = distortion and pumping. | `adaptive-gain.ts` |
| 6 | Hallucination guard only matched exact outro strings and pure loops; credits inside a longer text, music symbols, bracket labels, syllable loops and non-dictionary text passed. | `transcription-corrector.ts` detectHallucination |
| 7 | `isSpeech` in AppCore was recomputed with the fixed threshold (would disagree with any smarter gate). | `app-core.ts` processAudioFrame |
| 8 | `SanctuaryDsp` is not wired anywhere (dead code). Left alone: enabling a +2.5 dB presence boost without listening tests is not a clearly safe change. | `sanctuary-dsp.ts` |
| 9 | Capture uses `autoGainControl: true`, `noiseSuppression: true` in `getUserMedia` (dashboard.js, not my file). In a loud worship room browser AGC pumps and browser noise suppression can chew speech; the server already has its own adaptive gain. Recommendation only, not changed (needs listening test). | `dashboard.js` ~l.2931 |

## What changed

Layered defence, cheapest first:

1. **Audio gate** (`silence-gate.ts`, `robust: true`, enabled by the desktop host): judges 300-3400 Hz energy (4th-order
   high-pass + 2nd-order low-pass, allocation-free) against an adaptive threshold = max(calibrated base, noise floor x
   ratio), ratio 2.0 / 2.6 / 3.0 for normal / noisy / tongues. The floor falls in 0.4 s (pauses between words) and rises
   with a 12 s time constant (sustained music/crowd), capped at 4000 so extreme loudness cannot shut the gate for good.
   Result now carries `speech` (this frame itself, not hangover) and AppCore uses it. Default (no option) behaves exactly as before.
2. **Gain** (`adaptive-gain.ts`): gain applied to a frame is capped by that frame's own peak (never past the limiter knee),
   stored gain follows a cap downward with 120 ms. Never amplifies already-hot audio.
3. **Request level** (Groq): `verbose_json`; explicit `language` when configured; bilingual uses the existing sticky
   `LanguageLock` (detect on the first clip and every 2 clips, otherwise send the locked language). A detection that
   reports a non-fr/en language is retried once with the lock, or dropped when nothing is locked yet.
   Local engines: same drop rule for a third language with no fr/en probabilities.
   Deepgram: drops a transcript whose reported languages (per word, else per transcript) are off-language above 50 % (normal),
   40 % (noisy), 25 % (tongues). **Unverified against live Deepgram traffic** (field names from Deepgram docs, never seen live).
4. **Segment scores** (`segment-quality.ts`): thresholds now depend on the mode, plus a solo `avg_logprob` floor
   (`low-confidence`) in noisy (-1.5) and tongues (-1.2). Applied to Groq (new) and both local engines.
5. **Text screen** (`transcript-screen.ts`, called from AppCore for every engine, partial and final): wraps
   `detectHallucination` and adds credits/outros anywhere in the text, music symbols, bracketed labels
   (`[Music]`), non-Latin script, repetition (distinct-word share), repeated-syllable tokens ("lalala"), and the share of
   words that are French/English function words, numbers or Bible books (BOOK_CATALOG + French aliases).
   Statistical rules apply to finals only and only from a minimum word count (8 normal, 6 noisy, 4 tongues), so
   a bare "Jean 3 16" always passes.
6. **Operator mode**: `NoiseMode = normal | noisy | tongues` (`noise-mode.ts`), WS command `asr:noise-mode` (operator
   only), reported in `mic:health.noiseMode`, persisted in config (`noiseMode`, lenient on bad values), shared by the gate,
   the three providers and AppCore through one `TranscriptionPolicy` instance created in `desktop/main/index.ts`.

Diagnostics: Groq `groq.chunk-dropped` (reason, total, scores, mode), `groq.language-locked`,
`local-whisper.language-dropped`, `deepgram.language-dropped`, AppCore `transcript.hallucination-dropped` (reason,
mode, running total, 40-char preview) and `asr.noise-mode`. `GroqProvider.getDropCounts()` exposes counters. No keys or
URLs are logged.

## Not changed on purpose

- Tongues cannot be separated from speech by audio level; the defence is text/score based and prefers a missed sentence
  over a gibberish one. Tongues that Whisper happens to render as real French/English words cannot be detected by any
  deterministic rule here.
- `SanctuaryDsp` stays unwired. Browser AGC/NS constraints stay as they are (see finding 9).
- WAV encoding via `DataView.setInt16` costs 1.06 ms per 8 s clip vs 0.23 ms with a typed-array copy: not worth a change.

## Performance (micro-benchmark, `node dist/apps/server/audio/audio-path.bench.js`)

128-sample frames (the AudioWorklet block, 125 frames/s), 20 s synthetic speech+noise, best of 5, this dev machine:

| Stage | us/frame | % of one core at live rate |
|-------|---------:|---------------------------:|
| SilenceGate fixed | 1.10 | 0.014 |
| SilenceGate robust (band + floor) | 4.88 | 0.061 |
| AdaptiveGain | 9.02 | 0.113 |
| MicHealth.observe | 1.06 | 0.013 |
| SanctuaryDsp (unwired) | 4.66 | 0.058 |
| WS audio frame encode+decode | 16.5 | 0.207 |

The whole per-frame audio path is well under 1 % of one core; the robust gate adds ~0.05 %. The real CPU cost is the local
whisper engine and network, which cannot be measured here. `screenTranscript` is a few regexes and a set lookup per transcript.

## Proposed ARCHITECTURE.md text

### 141. French/English Only, Loud Rooms and Speaking in Tongues (audio/ASR, owner request)

**Why.** The owner saw transcripts in other languages and odd tokens, and the room is very loud during worship, where
people also speak in tongues. Whisper cannot be limited to two languages, loud music keeps a fixed-threshold gate open, and
glossolalia decodes into fluent-looking invented words.

**Layers.** (1) `SilenceGate` robust mode: speech-band (300-3400 Hz) level against max(calibrated base, adaptive noise floor x ratio);
the floor falls in 0.4 s and rises with a 12 s time constant, the effective threshold is capped at 4000; `speech` is reported
per frame. (2) `AdaptiveGain` caps the gain by the frame's own peak. (3) Request level: explicit language when configured; in
bilingual mode Groq uses the sticky `LanguageLock` and `verbose_json`'s `language`, a non-fr/en detection is retried once
with the lock or dropped; local engines drop a third-language detection with no fr/en probabilities; Deepgram `multi`
transcripts reported mostly off-language are dropped. (4) Segment scores per mode (`segment-quality.ts`). (5) `screenTranscript`
(`transcript-screen.ts`) on every engine's output in AppCore. (6) `NoiseMode` normal/noisy/tongues, WS `asr:noise-mode`,
`mic:health.noiseMode`, persisted `noiseMode`.

**Invariants.** A bare verse reference is never rejected by the statistical rules (word floors, books and numbers count as
known). Default behaviour without the option is unchanged. Every drop is logged with a reason and never silent.

**Limits.** Thresholds are reasoned, not measured on this church's audio. Deepgram language fields are unverified live.
Tongues rendered as real French/English words are not detectable. Groq `verbose_json` field names follow Groq's docs, not a
live call (no key available).

## Operator-facing strings (for i18n.js, not edited by me)

Label: EN "Noisy room / tongues" - FR "Salle bruyante / langues"

Option normal: EN "Normal" - FR "Normal"
Option noisy: EN "Loud room (band, crowd)" - FR "Salle bruyante (musique, foule)"
Option tongues: EN "Speaking in tongues" - FR "Prière en langues"

Hint EN: "Only French and English are transcribed. Loud room: ignores constant music and crowd noise and drops unsure text.
Speaking in tongues: the strictest setting, it also drops text that does not look like real French or English words.
A sentence may be missed rather than a wrong one shown. Switch back to Normal when the sermon resumes."

Hint FR: "Seuls le français et l'anglais sont transcrits. Salle bruyante : ignore la musique et la foule continues et écarte le texte
peu sûr. Prière en langues : réglage le plus strict, il écarte aussi le texte qui ne ressemble pas à de vrais mots français ou
anglais. Une phrase peut être manquée plutôt qu'une phrase fausse affichée. Repassez sur Normal quand la prédication reprend."

Dashboard wiring still to do (not in my area): a `<select>` with values normal/noisy/tongues; on change send
`{ id, type: "asr:noise-mode", timestamp, payload: { mode } }` (same helper as `mic:auto-gain`); on `mic:health` set the
select from `payload.noiseMode`.

## Fix round (reviewer findings A-F)

- A: mic:health now carries gateThreshold, noiseFloor, dropsPerMinute {screen, segment, language, offLanguage} and warnings
  (no-transcripts after 30 s of forwarded audio with no provider transcript; gate-closed-loud after 20 s of loud rejected input;
  language-guard-bypassed). Shared DropLedger (asr/drop-ledger.ts) lives on TranscriptionPolicy; drop logs are info and rate limited
  (one per category+reason per 5 s, with a suppressed count). Dashboard mic panel shows them (EN+FR).
- B: Deepgram: primary-subtag language normalisation, alphabetic words only, Bible book words and numbers ignored, minimum 4 judged
  words, valve after 5 consecutive drops (warn, ledger, resets when a transcript passes).
- C: Groq/local: a third-language LABEL no longer drops text; only text that reads as Spanish/Portuguese is retried once (lock or fr)
  and dropped if still so; same valve. LanguageLock may re-detect on 1-2 s clips when the lock is in doubt (uncertain flag); under 1 s it
  still reuses the lock because detection on <1 s of audio is unreliable.
- D: screenTranscript strips music symbols and credit clauses and keeps the rest (`cleaned`); names (capitalised non-initial words)
  are neutral in normal/noisy mode; number words added. Tongues mode still counts names (trade-off).
- E: low-confidence floor spares segments with digits, a book word or a navigation word; counted and logged at info.
- F: calibrated base relaxes to 3 x tracked floor; floor only climbs while the level is steady (short-minimum/mean >= 0.7; synthetic
  speech 0.53, white noise 0.97); bad sample rate/NaN guarded; loudClosedMs tracked.
