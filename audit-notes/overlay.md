# Overlay audit notes (verse card auto-fit, language typography, legibility)

Area: apps/overlay/public/**, apps/server/overlay/** (unchanged), tests in apps/overlay/.
Screenshots: audit-notes/screenshots/overlay/ (before-* / after-*).

## Root causes

1. Lower-third looked small: `fitLimits(false)` capped type at 64px (6% of a 1080p frame) and the band at 46% height, and
   `#verse-text` had a 32em measure. A short verse was 14% of the frame high, 49% wide
   (index.html `#verse-text { max-width: 32em }`, verse-motion.js `maxFontPx: 64`).
2. Fullscreen was close to filling for `classic` but not for the other designs: each design set its own
   `max-width` on the card (halo/folio 1340-1400px, stained 1500px, manuscript 1560px, glass/ribbon/bold 88-92%),
   so halo/folio sat at 60% width. The fullscreen cap was a fixed 200px, the lower-third cap a fixed 64px
   (not relative to the frame, so 720p and portrait behaved differently).
3. The fit measured `card.scrollHeight`, which includes absolutely positioned decorative pseudo-elements that overflow
   the card (stained `::before` inset -10%, halo `::before` inset -16%): those designs picked needlessly small type
   (stained: 152px / 49% text height).
4. The reference line was capped at 28-48px whatever the verse size (1.5vw to 2.5vw), tiny from the back of a room.
5. English italic was tied to the slot, not the language: `#verse-secondary-text { font-style: italic }` always
   (a French second block was italic), a single English verse was upright, `#verse.bilingual #verse-text[data-language=en]`
   only applied in bilingual mode. Sans designs (banner, minimal, split, bold, signal, halo, cinema ref...) set their
   family/weight/leading/letter-spacing only on `#verse-text`, so the second language fell back to the serif.
   The second block also animated differently (one block fade) than the first (per word).
6. Two `resize` listeners (one with an 80 ms debounce); no refit when the web fonts finished loading.

## Changes (all in apps/overlay)

- verse-motion.js: `fitLimits(isFullscreen, card, {height})` now returns a frame-relative box
  (fullscreen 95% x 92%, lower-third 100% x 50%, cinema 74% / 50% for the letterbox) and a font range relative to the
  frame height (fullscreen 30% of the height = 324px at 1080p, lower-third 11%, manuscript 24%, poster/bold 32%; floor 1.67%
  = 18px at 1080p, never below 8px). New pure `largestFit(min, max, fits)` binary search.
- overlay.js: `measureFit()` = binary search (about 9 probes, one synchronous pass, no paint between probes, so no flicker)
  + a bounded confirm/step-down loop + the old last-resort `--fit-scale` (now only when really overflowing, < 0.995).
  Height is `cardContentHeight()` (bottom of last in-flow child + bottom padding/border), not `scrollHeight`.
  One rAF-coalesced `scheduleRefit` for resize, `document.fonts.ready` and `fonts loadingdone`; the existing
  "defer while a reveal animation is in flight, refit on settle" guard is kept.
- overlay.js: language helper `languageOf(translation)`; both verse blocks get `lang` + `data-language`, are split into
  `.vc-w` words and revealed with the same word animation (the secondary block no longer has its own fade);
  the reference is built from `<span class="vc-ref-part" data-language>` parts, primary language first, identical parts
  shown once. Still textContent/spans only, no innerHTML.
- index.html: `#verse-text, #verse-secondary-text` share one base rule; every design's typographic rule now names both
  blocks (`:is(#verse-text, #verse-secondary-text)`, split mirrors its own); the secondary block's own rule keeps only
  spacing + hairline. Final "Language-driven typography" block (last in the file, wins ties):
  `[data-language="en"] { font-style: italic }`, `[data-language="fr"] { font-style: normal }`, same for reference parts.
  `#verse.fullscreen #verse-card[class] { max-width: 100% }`; lower-third `max-width: 100%` on the text blocks and
  card `max-height: 52vh` (was 48vh, below the new 50% fit box). Reference size `--ref-size = clamp(3.2vh, --vc-font * --ref-k, 11vh)`
  (k 0.34 classic, 0.22-0.24 for letter-spaced label designs, 0.38 split). Text shadow in em (grows with the type) incl.
  the no-card (clear-text palettes) halo. Cinema fullscreen side padding 6vw -> 3vw.
- Tests: verse-motion.test.ts (fitLimits box/scale, largestFit), card-designs.test.ts (language-driven italic rules,
  both blocks share typography, per-language reference, binary search fit, fullscreen width override).

## Verification

Harness: scripts/card-gallery.mjs output (the real overlay page with a fake in-page WebSocket) + a scratch page with
iframes at exact sizes, measuring text bounding boxes and clipping (scratchpad only, nothing added to the repo).
After, fullscreen, all 15 designs, 1920x1080, bilingual FR+EN: text 82-89% wide (poster 74% by design, quote mark gutter),
card 95% x 74-92% (cinema 74% = letterbox), nothing clipped, no scale fallback. 1280x720, 1080x1920 portrait and 480x270
also fit with no overflow. A 3000-character bilingual passage fits at 33px (1080p) with no scale fallback.
Lower-third 1080p: short verse 119px (was 64px), 93% wide; long FR 42-56px; bilingual 55-71px; band height <= 50%.
Reveal: with the cinematic transition (all 12 designs tested incl. a mid-reveal frame resize) the classes were removed after the
reveal, and no word/block/reference was left at opacity < 1, with a filter or a transform.

NOT verified: real OBS CEF / NDI window (only Chromium in the Browser pane); real server WebSocket path (fake socket),
operator dashboard preview iframe, and the remaining `npm test` failures are in other agents' areas
(detector/zz-probe, action-registry) and 2 lint errors (app-core.bible-browser.test.ts, bible-word-search.ts).

## Proposed ARCHITECTURE.md text (new subsection, e.g. 133.x "Auto-fit and language-driven type")

> **Auto-fit.** The overlay page chooses the verse type size itself. `VerseMotion.fitLimits(isFullscreen, card, {height})`
> (pure, unit tested) gives a target box as a fraction of the frame (fullscreen 95% x 92%, lower-third 100% x 50%, cinema
> clear of its letterbox bars) and a font range relative to the frame height. `overlay.js measureFit()` finds the largest
> integer size whose whole card (both language blocks, the reference and the design's padding/chrome) fits the box, with a
> binary search (`VerseMotion.largestFit`) over the live layout in one synchronous pass, then (only if the floor still
> overflows) scales the card (`--fit-scale`). It re-runs on text change, layout/style change, window resize and web-font
> load, deferred while a reveal animation is in flight. Height is measured from the in-flow content, never `scrollHeight`
> (decorative pseudo-elements overflow). Every design's fullscreen card may use the whole safe area.
>
> **Language-driven type.** French and English share family, weight, size, leading, spacing, shadow and reveal. The only
> difference is style: English is italic, French is upright. It is keyed off `data-language` (set from the translation id)
> on each block and on each reference part, never off the primary/secondary slot or bilingual mode. The rule sits last in
> the stylesheet; a design that styles `#verse-text` typographically must style `#verse-secondary-text` too
> (guarded by card-designs.test.ts).

## Open questions / not done

- Instrument Sans has no italic face: English in sans designs (banner, minimal, split, bold, signal) is the browser's
  synthetic slant. Shipping an italic woff2 (OFL, apps/overlay/public/fonts) would be cleaner; not added (new binary asset).
- `tpl-minimal` is transparent in fullscreen but gets the lower-third card background in lower-third mode
  (existing specificity quirk: `#verse:not(.fullscreen) #verse-card` beats `#verse-card.tpl-minimal`). Left as is (it helps contrast).
- apps/desktop/renderer/dashboard.js keeps its own copy of the reference formatter (French first always); the live
  preview of the operator is unaffected visually but still ordered French-first if a verse ever arrived English-primary.
- apps/stage and apps/live do not share the verse card (own single-language displays); no language italic there.
- Poster fullscreen leaves a wide gutter (quote mark scaled by the verse font): 65-75% text width by design.
- Operator-facing choice: lower-third cap (11% of frame height) and fullscreen cap (30%) are constants in verse-motion.js.
