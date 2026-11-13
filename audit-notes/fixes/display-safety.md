# Display-safety fixes (TS-01, TS-06, TS-08, SF-03, S-01, TS-04, TS-05)

Branch audit/production-fixes. Nothing committed.

## TS-01 display-mode / command phrases
- `apps/server/detector/navigation-command-detector.ts`: the substring rules "en francais", "en anglais",
  "switch to english", "english only", ... are gone. Display-mode switches now come from `MODE_COMMAND_RULES`
  (small anchored regexes, utterance <= 48 chars after trailing punctuation is stripped, optional "ok / please /
  s'il vous plait / svp / maintenant / now" around it): "passe|passons|passez|mets|mettez|affichage ... en
  francais|anglais|bilingue", "mode francais", "francais seulement", "switch|change|go|set|display|show (to|in)
  english|french|bilingual (mode)", "english only", "bilingual mode".
  "il parle en francais", "ce mot se traduit en francais", "en anglais on dit grace", "Let's switch to French for
  this next part", "English only from here" no longer change the mode. Four existing assertions that expected the
  old substring behaviour were rewritten to the new contract.
- Next/previous verse/chapter phrases keep substring matching (existing, tested behaviour) but are skipped when
  they are narrative: preceded by in/of/from/dans/du ("in the next verse he says") and "go back" followed by
  to/in/and/... ("let's go back to the beginning").
- Reviewed and left unchanged: whole-utterance short words (next, previous, cancel, clear), "clear the screen" /
  "effacer l'ecran" (long, specific), glossary "define X" / "que veut dire X" (deliberate request phrases, show
  a definition only), media cue titles (operator-chosen titles, by design).

## TS-06 prototype keys
- `nullProto()` helper in `packages/shared/type-guards.ts`; every table keyed by transcribed text is now a
  null-prototype table: FRENCH_BOOK_ALIASES, PHONETIC_BOOK_ALIASES, PHONETIC_CORRECTIONS (corrector), UNITS/TENS/
  CARDINAL_VOLUMES (normalizer; `in` checks were also prototype-sensitive), quick-book ABBREVIATIONS,
  BOOK_ID_ALIASES, BIBLE_TERM_ALIASES, FAMILY_WORDS, THEMATIC_CROSS_REFERENCES, OFFLINE_BIBLE_BOOK_KEYS.
- `KnownValidVerseIndex.normalizeBookId` returns "" for a non-string instead of throwing.
- `asr.onTranscript` callback in app-core now wraps `handleAsrTranscript()` in try/catch and logs
  `transcript.handler-failed`.
- NOT done (belongs to the desktop-resilience agent): process-level uncaughtException/unhandledRejection handlers.

## TS-08 bare "Name N M"
- `RegexDetector.detectExplicit()` + exported `compactOnlyReferenceKeys(text)`. app-core `runDetection` computes
  the keys; `deliverDetectedVerses` forces delivery "pending" for them in auto AND review mode (same pending path,
  `heard` text included, confirm via verse:confirm-pending). Explicit forms are unchanged.

## SF-03 lookup failure notice
- `resolveVerseDetailed()` (resolve-verse.ts) returns `{verse, failure: unavailable|not-found|null}`;
  `resolveVerse()` is a wrapper, so no other caller changed. `resolveTranscriptVerses` takes an optional `onLookup`.
- New operator-only event `verse:lookup-failed` {reference, reason: unavailable|not-found|invalid|superseded,
  origin: detected|override|navigate}: contracts/ws.ts, ACTION_REGISTRY (server-only, validated + bounded),
  sent with broadcastToOperators from `reportLookup()` in app-core; throttled (same key 10 s, max 5 per 10 s,
  key map bounded at 50).
- Dashboard: error toast per notice, persistent "Bible source degraded" indicator (`#bible-source-indicator`)
  set on reason "unavailable", cleared on the next verse:show / verse:pending. EN + FR strings
  `verse.lookupFailed.*`, `verse.source.degraded`.
- Paths covered: detected, verse:override (incl. rejected-by-index = invalid), verse:navigate, voice navigation.
  Not covered: rundown scenes, AI/quote suggestions, preview (preview already answers the operator).

## S-01 viewer outbound allow-list
- `VIEWER_OUTBOUND_EVENTS` in `apps/server/ws/server.ts`, enforced in the single send point (`broadcastWhere`)
  and in the `onViewerConnected` send. Consumers checked in apps/overlay, apps/stage, apps/live: verse:show/clear,
  media, announcement, definition, canvas, poster, layout:update, branding:update, overlay:style, outline,
  timer:state, stage:alert, status:update. Everything else (transcripts, translation, near-miss, pending,
  lookup-failed, mic:health, rundown:state, sermonNotes, copilot, previews) never reaches a viewer.
- app-core now uses broadcastToOperators for transcript:partial/final, translation:final, detector:near-miss,
  verse:pending (both sites). The phone remote and dashboard hold the operator token and still get them.
- Side effect: viewers no longer receive `rundown:state` (no viewer page renders it). Existing tests that
  listened for rundown/pending/transcript events on a viewer socket were moved to the operator socket.

## TS-04 / TS-05
- TS-04: `syncSceneContent` verse scenes resync `lastShownVerse` (null after clear/auto-clear => nothing sent).
- TS-05: `deliverDetectedVerses` returns whether something was really put on screen; only then
  `markIntentApplied`. A superseded override/navigate now reports `verse:lookup-failed` reason "superseded".

## Tests (private build)
- apps/server/detector/navigation-command-detector.test.ts (updated + new), apps/server/detector/display-safety.test.ts,
  apps/server/core/app-core.display-safety.test.ts, apps/server/ws/server.viewer-allowlist.test.ts.

## Existing tests changed (S-01 / TS-01 contract changes)
- app-core.test.ts: ~30 tests whose listener waited for operator-only events (rundown:state, verse:pending,
  transcript echo, near-miss, translation, mic:health, sermon notes) now connect with the operator token; the two
  viewer-resync tests no longer expect rundown:state; AI helper `startAiApp` returns a real viewer-role `overlay`
  that the copilot test asserts never sees copilot:suggestions; one display-mode test uses "Switch to French.".
- app-core.settle.test.ts: pending verses observed on an operator socket. action-registry.test.ts: new event listed.
- Gotchas found: (1) display-intent supersession between the detection and navigation paths depends on which
  lookup settles first, so SF-03 reporting is inlined at the call sites instead of a wrapper that adds microtask
  hops; (2) i18n.test.ts requires 6-space-indented entries; (3) a hanging test (waiting on an event that never
  comes) keeps its test file alive: run with --test-timeout and --test-force-exit.

## Not verified
- Dashboard hook (toast, #bible-source-indicator) only checked by the i18n/wiring tests and tsc/lint, not clicked in
  the running app. Phone remote still receives verse:pending (operator token) but was not exercised live.
- Failing-first was reasoned, not executed, for the new tests (no stash of the shared tree).
- Unrelated failures in the private build: local-asr-installer, app icon sizes, nature backdrop (other areas).
