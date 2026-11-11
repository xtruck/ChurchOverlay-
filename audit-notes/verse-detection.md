# Verse detection and display decisions: audit notes

Area: `apps/server/detector/**`, `apps/server/verse/**`, transcript -> detect -> display flow in `apps/server/core/app-core.ts`.

## Root causes found for "John 11 verse 12 displays John 11:1"

Both reproduced by failing tests first (`app-core.settle.test.ts`; with the fix disabled, 6 of the settle tests fail).

1. **Truncated trailing number (ASR cut between digits).** The ASR delivers a final "... John 11 verse 1" and then a final "2".
   `RegexDetector` correctly detects John 11:1 on the first final, and app-core resolved and showed it at once (auto mode).
   The "2" arrived alone and nothing ever combined it: `TranscriptAssembler` does not join onto a fragment that already carries a verse,
   and its short-window join ("John 11 verse 1 2") re-detects 11:1 because the compact pattern ignores the trailing "2".
   Result: John 11:1 on screen, the real verse lost. (`app-core.ts` final-transcript handler, formerly the direct `resolveTranscriptVerses` call.)
2. **Chapter-only navigation auto-showed verse 1.** `NavigationCommandDetector` emits `goto-chapter` for `<Book> chapter N` and for the bare `<Book> N`
   ("Turn to John 11", "In John 11 we read...", "Jean 3 on voit"). `resolveNavigationCommand` maps it to `<book> N:1` and `handleNavigationCommands`
   called `broadcastVerse(..., "navigation")`. So any final that merely MENTIONED a chapter, or a chunk boundary right after "John 11" before "verse 12",
   put verse 1 of that chapter on the overlay without it ever being called. This is also a major source of bug (b) "a verse that was never spoken".
3. Not causes (checked): partial transcripts (gated by `passesTranscriptGate`, final only), quote matcher / AI repair / AI cleanup / AI semantic / inferred volume
   (all only `broadcastPendingVerse`, never shown), interpreter echo guard (only suppresses), SuggestionArbiter cooldown (suggestions only).
   There is no reference "cooldown/dedupe" on the detection path, so no truncated re-fire from there.

## Fixes

- `detector/trailing-number.ts` (new, pure): `trailingVerseCouldGrow` (the text ends on the verse number AND `index.exists` says the number could still become 10x..10x+9 in that chapter),
  `joinSplitNumber` / `leadingNumberContinuation` (a following final that is only a number continuation, not a numbered book), `trailingNumberEquals`.
- `core/app-core.ts`:
  - Settle window (`referenceSettleMs`, default 1500 ms, 0 disables). A detected reference whose trailing verse number could still grow is HELD, not resolved.
    Next final: completes the number -> merged and the truncated verse is never shown; unrelated -> held verse flushed as-is; nothing -> timer flushes it.
    A reference that cannot grow (John 3:16, John 11:12: no 160+/120+) has zero added latency.
  - Same hold for navigation commands (`goto-bare-verse`, `goto-bare-chapter-verse`, `goto-chapter`) whose trailing number could grow ("Jean chapitre 11" | "verset 1" | "2").
  - A merge only counts if it yields a NEW valid reference (KnownValidVerseIndex), otherwise the held verse stands alone.
  - Operator actions cancel a held verse (`verse:clear`, override/navigate/rundown through `showVerse`), and `stop()` clears the timer.
  - `goto-chapter` (chapter named, no verse) is now only OFFERED as a pending suggestion (`verse:pending`, with `heard`), never auto-shown, in every confirmation mode.
    The chapter becomes the announced context, so a following "verse 12" resolves against it and shows John 11:12.
  - The assembler path and the primary path share one `submitDetection` (refactor of two duplicated blocks).
- `detector/regex-detector.ts`: the bare compact form ("word N M", no colon, no keyword) is rejected when followed by a unit/month/time word
  ("Marc 12 14 personnes", "Jean 3 16 septembre", "Job 1 5 times", "Romains 8 28 euros"). Explicit forms are untouched.

## Tests added

- `core/app-core.settle.test.ts` (18 tests, end to end through `startAppCore` with a fake ASR, French and English): split "verse 1" | "2", "verset 1" | "2.", "John 11:1" | "2",
  three-way split, unrelated flush, no-latency for non-growing verses, later fragment never replaces a correct display, invalid completion not merged,
  "2 Corinthians" not swallowed, partials never trigger, review mode, operator Clear cancels, "John 11" | "verse 12", chapter-only mention is pending only, French three-way, split chapter number.
- `detector/trailing-number.test.ts`, plus two tests in `detector/regex-detector.test.ts`.
- Verified: ran the whole core/detector/verse suites (compiled to a scratch dir): all pass except 4 tests that read bundled data files absent from that scratch dir (environmental).
  I did not run `npm test` itself (it compiles into the shared `dist/` that other agents are using).

## Table of every path that can put a verse on the overlay or into pending

| # | Path | Trigger value | Auto-shown? | Guards |
|---|------|---------------|-------------|--------|
| 1 | Live detection (RegexDetector over a FINAL transcript, incl. assembler-joined text) | `detected` | auto mode: yes; review mode: pending | final only; KnownValidVerseIndex; resolveVerse (cache, breaker, source); hallucination/off-language/echo filters upstream; interpreter echo guard; display-intent ticket (newer wins, Clear stays cleared); NEW: settle window for growing trailing numbers; NEW: compact "word N M" rejected before units/months |
| 2 | Elliptical `verse N` / `chapter C verse N` (goto-bare-verse, goto-bare-chapter-verse) | `navigation` | yes (when a position exists) | final only; skipped when the same text has an explicit valid reference; needs currentVersePosition or fresh announced chapter; index.exists; NEW: settle window. RESIDUAL RISK: "au verset 3 il dit" in prose jumps the screen |
| 3 | Explicit prose `Book chapter N verse M` (goto-book-chapter-verse) | `navigation` | yes | catalog book; index.exists; superseded when detector found it |
| 4 | `goto-chapter` ("Jean 11", "John chapter 11") | none | NEW: never; pending only | final only; index.exists; offered as pending; sets announced chapter |
| 5 | next/previous verse/chapter | `navigation` | yes | needs a current position; no-op at boundaries; index.exists. Whole-utterance short words only for bare "next/previous/suivant" |
| 6 | Quote match (verse read without reference) | none | no, pending (`origin: quote`) | window match thresholds, cooldown, not already on screen, no explicit reference in the final |
| 7 | AI near-miss repair, AI cleanup, AI semantic | none | no, pending (`origin: ai`) | detector+index re-validation, arbiter cooldown, held while a detected verse awaits approval |
| 8 | Inferred volume ("Corinthiens 5 verset 2") | none | no, pending (`origin: inferred`) | volume hints, index; alternatives listed |
| 9 | Near-miss nearest references | none | no (diagnostic suggestion list only) | index |
| 10 | `verse:confirm-pending` | `detected` | yes, operator click | operator only; pendingVerse cleared by any newer show/clear |
| 11 | `verse:override`, `verse:navigate` (remote) | `override` / `navigation` | yes, operator | operator-only sender; index; resolveVerse |
| 12 | Rundown verse scene | `rundown` | yes, operator | operator action |
| 13 | Echo/interpreter second detection | n/a | suppressed (never displays) | InterpreterEchoGuard; in review mode only annotates the pending prompt (`corroboratedBy`) |
| 14 | Partial transcripts | n/a | never | `passesTranscriptGate` (final only) on detection, navigation, media, quote, glossary; partials also never complete a held reference |

## Residual false-positive risks (not changed, need an owner decision)

- Bare compact references with no keyword/colon and a book that is also a common word ("Mark 3 16", "Job 1 5", "Acts 2 4", "Numbers 12 14") still auto-show when no unit/month word follows.
  Proposal: make that form pending-only for common-word books, or require the keyword in auto mode. Needs an `origin` label in the dashboard (`apps/desktop/renderer/dashboard.js` maps
  `quote`, `inferred`, `ai`; an unknown origin currently renders as a plain detected-pending prompt, which is what the new chapter-only offer uses).
- Elliptical bare "verset N" (row 2) inside ordinary prose. Proposal: config `ellipticalNavigation: "auto" | "pending"`.
- A number split where the NEXT fragment starts with a spoken number word ("verset un" | "deux") is not merged (digits only).
- A range spoken across a cut ("verset 1" | "à 12") shows verse 1 after 1.5 s (there is no range concept in the detector; start verse is correct).
- Latency: references like John 11:1, Psalm 119:1, Genesis 1:1 (the verse can still grow) now show after the settle window (1.5 s) when the number is the last word. Set `referenceSettleMs` to tune.
- Pre-existing, outside my area: `app-core.ts` currently has an unused-import lint error (`TranscriptionPolicy`, `isNoiseMode`) and a tsc error on `"asr:noise-mode"` from another agent's in-progress ASR wiring.

## Proposed ARCHITECTURE.md text (new section: "Reference settle window and chapter-only offers")

> **Settle window.** A final transcript whose last token is the verse number of a validated reference, and whose number could still grow into another valid verse of the same chapter
> (`index.exists` for 10n..10n+9), is not resolved immediately. It is held for `referenceSettleMs` (default 1500 ms). A following final that is only a number continuation ("2") is merged into it
> ("verse 1" + "2" = "verse 12") before any lookup or display; any other final flushes the held reference unchanged; the timer flushes it otherwise. References that cannot grow are never delayed.
> The same hold applies to navigation commands (`goto-bare-verse`, `goto-bare-chapter-verse`, `goto-chapter`). An operator clear, override, navigation or rundown action cancels a held reference.
> The hold never bypasses KnownValidVerseIndex and never applies to partials (invariant 1).
>
> **Chapter-only mentions.** `goto-chapter` ("Jean 11") names no verse; verse 1 is only offered as a pending suggestion and the chapter becomes the announced context for a following bare "verse N".
> A verse reaches the overlay without the operator only when a complete reference (book, chapter, verse) was spoken, or an elliptical verse resolved against an established context.
>
> **Compact references.** The bare "word N M" form is not a reference when a unit, month or time word follows it.
