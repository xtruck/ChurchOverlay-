# ChurchOverlay front end: accessibility, legibility and operator-UX audit

Branch audit/production-fixes. Read-only audit from code and CSS: no app was run, nothing was edited.
Scope: operator dashboard (apps/desktop/renderer), OBS overlay (apps/overlay/public), phone remote (apps/remote/public), stage and live pages (apps/stage/public, apps/live/public).
Ranked by operator impact in a live service. WCAG references are WCAG 2.2.
Confidence tags: [code] = read directly in the file; [calc] = contrast computed from the actual color values; [verify] = inferred, confirm in DevTools or on a real device.

Working assumption: a 1366x768 laptop at Windows scaling 125% gives about 1093x614 CSS px; at 150% it gives about 911x512 CSS px.

---

## 1. Findings (ranked)

### CRITICAL / HIGH (could cost the operator or the congregation during a service)

**UX-01 HIGH - Announcement, glossary-definition and outline text is hard-coded white and ignores the palette, so it disappears on the 6 light palettes.**
- Where: apps/overlay/public/index.html:1531 (`#announcement-body {color:#ffffff}`), :1585 (`#definition-body`), :1615 (`.canvas-layer-text`, canvas has its own black bg so OK), :1679 and :1688 (`#outline-title`, `#outline-text`). The cards use `background: linear-gradient(180deg, var(--scrim), rgba(6,7,10,.46))` (:1512, :1565, :1654) and `--scrim` is the palette's card colour at its opacity.
- Palettes affected: parchment, ivory, morning-sky, soft-rose, easter, hc-black-on-white (apps/server/overlay/palettes.ts:35-38, 43, 54). The card colour is near white at 0.9 to 0.95 alpha.
- [calc] white (#fff) on the top of the announcement scrim (cream #fffaf0 at .9) is about 1.05:1 and fades toward the dark half of the gradient. The verse card is fine in these palettes because it uses `--ov-text`; these three layers never read `--ov-text`/`--ov-text2` (only :167, :266, :1341 do).
- Who: the whole congregation. The pastor's announcement or a definition shows as an empty pale card.
- Fix: in those 3 rules use `color: var(--ov-text)` / `var(--ov-text2)`, drop the hard-coded `rgba(6,7,10,.46)` second stop in favour of `rgba(var(--ov-card-rgb), calc(var(--ov-card-a)*.8))` (same as `#verse-card`), and make `#definition-term`/`#outline-badge` use `--accent` only on the dark palettes (or add a text-shadow ring).

**UX-02 HIGH - Text on announcement/definition/outline is too small for the back of a church.**
- Where: `#definition-term` 13px (index.html:1579), `#definition-body` 15px (:1588), `#outline-text` clamp(14px,1.6vw,20px) (:1690), `#outline-badge` clamp(11px,1.2vw,15px) (:1672), `#announcement-body` clamp(18px,2.4vw,30px) (:1534), `#announcement-title` max 34px (:1526). At a 1080p frame that is 1.4% to 2.8% of frame height; the verse auto-fit starts at 11% (verse-motion.js:232).
- Who: anyone beyond the first rows. The definition card is the worst case (15px on a 1080p frame is roughly a phone label).
- Fix: switch to vh units with a floor, for example announcement body `clamp(32px,4.2vh,60px)`, title `clamp(40px,5.4vh,72px)`, definition body `clamp(28px,3.4vh,44px)`, outline text `clamp(28px,3.4vh,44px)`, and a `max-width` that follows.

**UX-03 HIGH - Verse auto-fit floor is 1.67vh (18px at 1080p) and last-resort `--fit-scale` can shrink the card further.**
- Where: apps/overlay/public/verse-motion.js:231-232 (`minFontVh: 0.0167`), :246 (`minFontPx = max(8, ...)`); overlay.js:299-323 (binary search then scale-down).
- Who: congregation, whenever a long passage (Psalm 119, a 6-verse reading) is sent. The code deliberately keeps the whole passage on one screen, so the text can silently become unreadable at the back (18px at 1080p is about 1.7% of screen height). No operator warning exists.
- Fix: raise the floor to about 3vh (32px at 1080p). When the passage does not fit above that, do not scale: send only the first N verses and show a "1/3" marker, or surface a dashboard warning "too long to read from the back" on `verse:show` (the stage page already has `stage-overflow-warning`; reuse the idea).

**UX-04 HIGH - Pending (review-mode) verse has no reject/dismiss, no age, and Ctrl+Enter fires from any field.**
- Where: apps/desktop/renderer/dashboard.js:570-596 (showPendingVerse), :627-633 (clearPendingVerse), :3689-3692 (Ctrl+Enter handler); apps/server/ws/action-registry.ts has `verse:confirm-pending` (:624) but no reject action. [code]
- Problems:
  1. The only ways to get rid of a wrong suggestion are to replace it, or press Clear (which also wipes whatever is actually on air). A bad AI/semantic suggestion stays amber-lit in the queue and the header chip indefinitely.
  2. No timestamp or "waiting 2 min" label, so an operator can confirm a stale suggestion that no longer matches what the preacher is saying.
  3. Ctrl+Enter is handled on `document` for every focus target, including the sermon-notes textarea (index.html:536) and the Activity/notes inputs. Someone pasting or typing there and pressing Ctrl+Enter puts a verse on the congregation screen.
- Who: the operator, in Review mode, which is the mode the AI features force.
- Fix: add a secondary "Dismiss" button plus Esc (while pending is focused) that sends a dismiss (client-side hide is acceptable only if the server also clears it, per AGENTS.md section 49); show "waiting 0:42" from the existing `onAirSince` style timer; in the Ctrl+Enter branch add `&& !(isTypingTarget(event.target) && event.target !== referenceInput)`.

**UX-05 HIGH - A French-speaking congregation sees English on the live and stage pages, and the stage page has no language handling at all.**
- Where: apps/live/public/live.js:101 (`"Remove " + reference`), :128 (`'Tap "Save to My Notes"...'`), :224 (`"Welcome to Service"`), index.html static labels; apps/stage/public/stage.js:99,105,109,133,135 ("CONNECTED", "DISCONNECTED", "No verse displayed", "Awaiting scripture detection from pulpit speech..."), stage.css:130,135 (`content: "Wrap up"`, `content: "Overtime"`); both pages declare `<html lang="en">`. Neither page has a string table (remote.js does, line 8 and 76). [code]
- Who: French congregation phones (live page), French-speaking preacher at the stage monitor, screen readers (wrong voice because `lang="en"`).
- Fix: copy the `STRINGS`/`t()` pattern from remote/public/remote.js:8-150 into both pages; set `document.documentElement.lang`. For stage.css pseudo-element text use `data-` attributes set by JS.

**UX-06 HIGH - At 150% scaling (about 911x512 CSS px) the pending verse card is below the fold.**
- Where: dashboard.css:1733-1747 (`max-width:960px` single column; order "command, program, heard, side, drawer"); `.program-screen` keeps 16:9 (about 450px tall at 800px wide).
- Effect [calc]: header 52-80px + command bar about 60px + recent strip 32px + program monitor about 480px puts the Verse queue (the only place a pending verse and its Confirm button live) at roughly y = 650+ in a 512px window. The header "Verse waiting" chip (index.html:158) then needs a click that scrolls (dashboard.js:601-604 focuses the button). Heard text is below the monitor too.
- Who: the operator on a small laptop with Windows scaling, exactly the stated case.
- Fix: below 960px put the queue card directly under the command bar (grid-area order "command" "side-queue" "program"), cap `.program-screen` at about 30vh, or make the program monitor a collapsible 16:9 thumbnail. A smaller monitor is fine; confirming a verse is the time-critical path.

**UX-07 HIGH (screen reader) - Audio transport live region announces every 500 ms.**
- Where: index.html:399 (`#audio-transport-status role="status" aria-live="polite"`), dashboard.js:3156-3158 (render every 500 ms) and :75-113 (text contains a running frame count: "Audio link sending · N frames").
- Effect: the text changes at 2 Hz for the whole time the mic is on. A screen-reader operator hears a continuous number stream, which also drowns the pending-verse announcement (`#pending-announce`, index.html:327). `#mic-health` (index.html:352, polite) may also flap between ok / too-quiet.
- Fix: make `#audio-transport-status` `aria-live="off"` and only update an `sr-only` live region on state transitions (sending to degraded/disconnected), not on counts.

**UX-08 HIGH - Replacing or removing an API key restarts the services mid-service without confirmation, and replaces the working key irreversibly.**
- Where: dashboard.js:1328-1375 (`saveAiKey`, Groq key save, Anthropic remove), index.html:1076, :1087 ("Saving restarts the services for a moment"). The Groq key is also the transcription key; validation is only the `gsk_` prefix (i18n "ai.groqKey.invalid"). [code]
- Contrast: enabling the remote and changing overlay template DO ask `window.confirm` (dashboard.js:4016, i18n "overlayTemplate.confirmChange").
- Who: operator who pastes a key into the wrong field or clicks Remove next to Save at the wrong moment.
- Fix: `confirm` for Remove and for Groq replace ("This restarts transcription"); disable while the mic is listening or require the confirm; keep the old key until the Test connection succeeds.

### MEDIUM

**UX-09 MEDIUM - Branded accent color has no contrast floor; accent-ink threshold is wrong.**
- Where: dashboard.js:762-767 (`applyBranding`). `--accent` is set to any church colour; `--accent-ink` flips to white at luminance <= 0.35.
- [calc] Crossover between dark ink (#1c1405) and white ink is L about 0.197, not 0.35. A mid-tone accent, for example #e07b00 (L about 0.30), gets white ink at about 3.0:1 where dark ink would give about 6:1: primary buttons ("Show on overlay", "Show on screen") fail 4.5:1 (1.4.3). The default #e3ad45 (L about 0.47) is fine.
- A dark accent (navy, deep red) is also used for `:focus-visible` outlines (dashboard.css:158-166), the active-nav icon, `.log-line.event-sent` text (:1046) and `.suggestion-chip` borders on a #0b0e13 background: a navy like #1f3a8a gives about 1.9:1 (fails 2.4.11/1.4.11). A red accent also collides with the on-air state color.
- Fix: choose ink by max-contrast (`L > 0.18`), and clamp the accent used for *foreground* roles to L >= 0.25 (derive `--accent-fg` separately from `--accent`); reject or warn for hues within ~15 degrees of the on-air red.

**UX-10 MEDIUM - French sidebar labels overflow the 80px rail.**
- Where: dashboard.css:597-608 (`.sidebar{width:80px; overflow-y:auto}`, buttons with 4px horizontal padding, 12px text, no `hyphens`/`overflow-wrap`); fr strings "Bibliothèque multimédia" (i18n.js:1252), "Incrustation" (:1253), "Historique", "Paramètres", "Commandes vocales" (:1388). [verify]
- Estimated at about 6.2px/char: "Bibliothèque" (12 chars) about 72px and "Incrustation" about 68px against about 64px of usable width. A word that cannot break overflows its button; with `overflow-y:auto` the browser also creates a horizontal scrollbar on the rail.
- Fix: widen the rail to 96px, or `hyphens:auto; overflow-wrap:anywhere` with `lang="fr"` honoured, or shorten the labels ("Médias", "Overlay", "Réglages"). Same risk on the 60px icon rail (<=860px) for the visually-hidden labels is not an issue.

**UX-11 MEDIUM - Settings view has an extra `</div>` that likely breaks the shell.**
- Where: apps/desktop/renderer/index.html:1163-1164 (the Bible API card closes with `</div>` on 1163 and a second `</div>` on 1164), versus the balance at :1185-1188. [verify in DevTools]
- Effect: the stray closing tag ends `.settings-grid` early (the Phone Remote card at :1166 lands outside the grid, full-width), and the closers at :1185-1187 then end view-settings, shell-content and `#app-shell`; `<footer class="statusbar">` (:1194, connection pill, mic and ASR status) ends up outside `#app-shell` (`height:100%`), probably below the fold or visible during setup. If that is what happens, the operator's persistent connection/mic status bar is off-screen.
- Fix: delete one `</div>` at :1164, then check that `.statusbar` is inside `#app-shell`.

**UX-12 MEDIUM - Bible Browser listbox does not expose the current verse to assistive tech.**
- Where: bible-browser.js:425-429 (`role="listbox"`, `tabindex=0`), :464-467 (`role="option"` rows, no id), :497 (`aria-selected`), :797-815 (global arrow keys step the cursor).
- Effect: focus stays on the listbox container, and there is no `aria-activedescendant`, so a screen reader never announces the verse moved to by arrow keys (aria-selected on a non-focused option is not announced). Sighted keyboard operation works (arrows, Page keys, Enter), and Browse mode is the safe default.
- Fix: give rows ids, set `aria-activedescendant` on `.bb-verses` in `updateSelection()`.
- Related risk: in Live mode (bible-browser.js:612-628) any stray arrow key that reaches the document handler puts a new verse on the congregation screen. The handler ignores typing targets and modals but not focused buttons (a focused book button plus ArrowRight steps a verse). Add `event.target.closest("button,[role=button]")` exclusion, and show a persistent red "LIVE: keys change the screen" badge on the mode toggle.

**UX-13 MEDIUM - Overlay clear-text palettes have no guaranteed contrast.**
- Where: apps/server/overlay/palettes.ts:56-58 (opacity 0, white or pale text), overlay index.html:60 (`--ov-shadow: 0 .03em .1em .85, 0 0 .4em .4`), and `#verse-card.no-card` rules at :1402-1409.
- [calc] White text over a white or sky video has a theoretical 1:1; legibility depends on a thin black halo. The dashboard hint (i18n "overlay.paletteHint": "Every built-in palette is checked for readability over any video") is therefore not true for the clear-text group. The minimal design (index.html:467) adds a stronger halo, the others do not.
- Fix: strengthen `--ov-shadow` for `.no-card` (3-layer shadow as at :467 or `-webkit-text-stroke` plus `paint-order: stroke`), and word the hint "except Clear text, which relies on a shadow".

**UX-14 MEDIUM - Instrument Serif at weight 400 as the default verse face.**
- Where: overlay index.html:268 (`font-family: "Instrument Serif"`, `font-weight:400`), also the announcement body (:1533), outline title (:1681), classic/elegant/glass etc. (only the sans designs, banner, minimal, bold, signal, use Instrument Sans 500-700).
- Instrument Serif is a condensed display face with thin hairlines and a single weight. At the back of a room, over compressed H.264 video, the thin strokes shimmer and lose contrast (stroke width about 8% of cap height). This does not fail a numeric WCAG test but is the classic legibility risk. The reveal (blur filter at :228-232 on exit) does not touch it.
- Fix: for the default designs add `-webkit-text-stroke: 0.01em currentColor` or switch the default body face to a sturdier serif (Source Serif 4 or Georgia at 500); keep Instrument Serif for the reference line only.

**UX-15 MEDIUM - No keyboard path to reorder rundown scenes (2.5.7 Dragging Movements) and no undo for loading a rundown.**
- Where: dashboard.js:1997-2040 (`row.draggable = true`; draft actions are Duplicate/Remove only), index.html:678 ("Drag scenes to reorder them."). i18n already has "rundown.builder.moveUp"/"moveDown" (fr :1154-1155) but check whether the buttons exist in the draft actions; the grep shows only the remove button wired next to the duplicate action. [verify]
- Also "Load rundown" (index.html:679) replaces the running rundown without confirmation or undo.
- Fix: wire Move up / Move down (and Alt+Up/Down on the row), confirm "Replace the current rundown (scene 3 of 7)?" only when a rundown is already loaded.

**UX-16 MEDIUM - Inconsistent French vocabulary for the same concept.** [code]
| Concept | Strings | Problem |
|---|---|---|
| Review mode | toggle "Vérifier" (i18n.js:932) vs `queue.emptyHint` "En mode Révision" | Operator is told about a mode that does not exist by that name |
| Live view | nav "En direct" (:1250) vs `tally.pendingHint` "Aller à la vue Direct" (:712) | two names |
| Settings | nav "Paramètres" (:1324) vs view title "Réglages" (:775) and copilot hint "dans les Réglages" (:1207) vs "dans les Paramètres" (:926) | two names, same page |
| On air / on screen | "À l'antenne" (tally, bible badge :1357), "À l'écran" (preview chip, media), "À L'ÉCRAN" (:898) | "antenne" is broadcast jargon for volunteers |
| Sermon | "Notes de sermon" (:1230, :1246) vs "Notes de prédication" (:1214, :1216) | |
| Mic stop / media stop | both "Arrêter" (:1011, :1030) | two different effects, same label |
- Fix: pick one term for each; apply it in one pass.

**UX-17 MEDIUM - Machine-translated or raw-protocol French.**
- "Lien audio envoi · {sent} trames" (:847, ungrammatical; use "Liaison audio : envoi en cours, {sent} trames"). "Diffusion continue d'abord" / "Par lots d'abord" (:800-801; "batch" is jargon, "lots" is unclear; say "Transcription continue d'abord / par segments d'abord"). "Salle bruyante / langues" (:811 label; "langues" alone reads as "languages", should read "Prière en langues"). "Latence Réseau & OBS" (:829) uses English title case. `micHealth.diagStats` (:816) is a wall of text with four counters.
- Log lines show the wire protocol to the operator in both languages: "envoi de verse:override {...JSON...}", "envoi de scene:goto 3" (:1007, :1055, :1080-1081, :1157-1160). In the Activity log (hidden drawer) these are harmless, but they are what an operator sees in the exported session.
- Typography: normal spaces before `:`, `?`, `%`, `»` (for example "Entendu : « {text} »", "{percent} %") allow a line break before the mark; use U+00A0 / U+202F. Mixed apostrophes (' and U+2019) across keys.
- Fix: one cleanup pass on these 12 strings; replace the log protocol names with human text ("verset demandé : Jean 3:16") while keeping the raw form in the exported diagnostic.

**UX-18 MEDIUM - Hard-coded English in the dashboard markup (never goes through i18n).**
- index.html:72 (`placeholder="Deepgram key"`), :74 (`"sk-ant-… (optional)"`), :392 (button text; JS overwrites it at dashboard.js:713 so only a flash), :284 / :282 (`PGM` badge), :601-604 (`aria-label="X"`, "Y", "W", "H" are acceptable), :609 (`placeholder="Welcome"`), :956 (anchor buttons `aria-label="6,8"` etc. say nothing to a screen reader; the group has a translated label but each of 9 buttons reads as "6,8"), :1202 / :1197 initial fallbacks (replaced on load). `type="url"` input :1159 is also not styled: dashboard.css:235 lists text/password/number/search/select/textarea only, so `#custom-bible-api-url` gets the browser's default white field on the dark theme (also `color-scheme: dark` will give it a dark default, but no `--field-border`, radius, or focus color).
- Fix: `data-i18n-placeholder` for the first three, named anchors ("Top left", "Top center"... as i18n keys), add `input[type="url"]` to the form-control selector list.

**UX-19 MEDIUM - Toast region misses `aria-live` assertiveness policy for a repeated message.**
- dashboard.js:431-468 handles this well (error toasts are `role="alert"`, 9 s lifetime, dismiss button, hover/focus pause); but identical text is removed and recreated (`existing.remove()`), which is correct for re-announcing. No defect found here; kept in the "good" list. See instead `#pending-announce` (dashboard.js:593-594): if two pending verses have the same reference the text is identical and a live region does not re-announce. Clear `textContent` and set it in `requestAnimationFrame`.

**UX-20 MEDIUM - Phone remote: hard-coded English presets and mismatched outline text.**
- apps/remote/public/index.html:675-690 (the 4 preset verses and their English subtitles "God so loved the world"...), :708-723 (outline presets): the visible label "Unconditional Love" (:714) but `data-title="God's Unfailing Love"` and `data-text="Point 2: Unconditional Grace"` (:712) are what goes on the congregation screen; the "Conclusion" button sends "Conclusion & Ministry" / "Final Exhortation & Prayer" while showing "Call to Prayer". Timer presets "15 min"... (:626-629) are not translated. These are also church-specific sermon content baked in a generic product (AGENTS.md section 4 amendment: no church-specific defaults).
- Who: the person on the phone, and the congregation (the on-screen title differs from the button that was pressed).
- Fix: make the visible label and the payload one source; move presets to config or remove them; translate the units.

**UX-21 MEDIUM - Remote: single-tap actions with a large blast radius and no safeguard.**
- remote/public/index.html:578 (Clear the screen, 56px, good), :595 (Next scene puts the next scene live with no preview; the transport is two equal-weight `btn-secondary` buttons side by side), :635 (Timer reset), :611/:725 (Stop media, Clear outline are `btn-danger` and full width directly below the preset grid, easy mis-tap while scrolling).
- Fix: make Next the visually primary button (as the desktop does: `transport-go`), add 8px+ spacing between the danger button and the grid, keep a short "Undo" toast for Clear on phone (re-send the previous verse) since phones mis-tap more than desks.

### LOW

**UX-22 LOW - `Esc` on the overlay clears only the local view.** overlay.js:1034-1043. The server and dashboard still think the verse is live (tally stays red, recent chip stays "live"), and the next `verse:show` works normally. Rare in practice because an OBS browser source needs focus, but worth a log line to the dashboard when it happens (the overlay must not send commands, so this is only a note in docs, not code).

**UX-23 LOW - Overlay motion delays the first readable word by 120-240 ms and full legibility by up to about 1.2 s.** verse-motion.js:106-147 (`textStart` 120-240, `wordDur` 560-680, `settleFloor` up to 1260; swap out 220-380 ms before the next verse starts). Reasonable for a lower third and capped by `maxSpread`, so it is not a blocker. Reduced-motion is handled correctly (index.html:1417-1433: opacity-only, 200 ms, no transform, no looping animation, nature video disabled at :109 and overlay.js:207-216). Consider a "Cut" default for operators who read each verse aloud immediately (the `vc-cut` transition exists, :227).

**UX-24 LOW - Several 12px caption styles in `--text-faint` (#8893a6).** Passes 4.5:1 [calc: about 5.85:1 on surface-1, about 4.84:1 on surface-3, about 5.4:1 on bg] but is the lowest tier used for: the "Recent" empty hint, "Verses shown this session...", header group labels, the keyboard-shortcut hint in the status bar, latency/room stat labels. At 12px in a dim booth these are marginal. They carry no critical information.

**UX-25 LOW - Touch/pointer target sizes.** Dashboard controls are 32px (`--control-h`), small buttons 32px, scene action buttons 28x28 (dashboard.css:1193-1198), recent chips 28px high, switch 36x20 inside a 32px row. All pass 2.5.8 (24px) but not the 44px guideline; on a touch laptop with 150% scaling the 28px ones are tight. Phone remote: buttons 48px, nav tabs 52px, prepared-remove 52px, Clear 56px: good.

**UX-26 LOW - `.header-controls` at <=960px.** Three segmented groups plus two icon buttons wrap onto two rows in French ("Révision"/"Vérifier", "EN+FR") and push the layout down a few dozen pixels; `.header-group-label` is hidden at <=1280px (dashboard.css:1724), so at normal laptop sizes the "Verses / Detection / Interface" captions that the comment in index.html:165 says were added to disambiguate the two EN/FR toggles are gone, leaving only `title` tooltips and aria-labels. Consider keeping a 1-word caption (the group label already is `text-faint` 12px) and drop the divider instead.

**UX-27 LOW - Dashboard `window.confirm` for media delete / remote toggle.** dashboard.js:2908, :4016. Native dialogs are keyboard- and SR-accessible, but they block the renderer and ignore the app's dark theme; the in-app modal infrastructure (modal-overlay with focus trap, dashboard.js:3471-3520) could be reused for a consistent look. No Undo for deletion is stated honestly ("cannot be undone").

---

## 2. Keyboard-only operation of critical live flows

| Flow | Path | Verdict |
|---|---|---|
| Show a verse | Ctrl+K or `/` focuses the reference field; Enter calls `showBtn.click()` (dashboard.js:3063-3068, :3683-3688). Live preview under the field (250 ms debounce) shows the verse text and "not on screen". | Good. |
| Recall a recent verse | Alt+1..9 via `event.code` (AZERTY safe), Alt+Left/Right step (:3700-3705). | Good. |
| Clear | Shift+Esc from anywhere including while typing (:3693-3695). Button has `aria-keyshortcuts`. No confirmation (correct for an emergency clear); recall chips act as the undo. | Good; Esc alone still only blurs the reference field (:3723). |
| Approve a pending suggestion | Ctrl+Enter (any focus), or header chip then Enter. | Works; see UX-04 for the missing reject/age and the over-broad shortcut. |
| Reject a pending suggestion | none | Gap (UX-04). |
| Switch verse language (EN / FR / EN+FR) | Header segmented buttons (Tab, Enter) or command palette Ctrl+Shift+P ("Versets en français", i18n "palette.modeFrench"). No dedicated shortcut. | OK via the palette; consider Alt+Shift+E/F/B. |
| Switch UI language | Header segmented group or palette. | OK. |
| Mic start/stop | Ctrl+Shift+M toggles (:3696-3699); also palette; buttons. | Good. No audible/visible toast on toggle other than the mic card, fine. |
| Bible browser | Ctrl+7 opens; arrows/Page keys/Enter in Browse or Live; search field Esc clears. | Works; see UX-12. |
| Views | Ctrl+1..7 (code-based). | Good. |
| Rundown | PageDown/PageUp while the Rundown view is active (:3711-3719), so a clicker does not misfire in other views. | Good design. |
| Modals | Focus moves in, is restored, Tab trapped, Esc closes via the dialog's own cancel button (dashboard.js:3471-3520, `MutationObserver`). Palette is a proper combobox with `aria-activedescendant`. | Good. |

Keyboard traps found: none. Skip link: none (the sidebar has 8 buttons before the content; Ctrl+K and `/` mostly compensate).

---

## 3. Screen-reader semantics (summary)

Good: `lang` follows the UI language (i18n.js:1441), landmarks (`header`, `nav aria-label`, `main`, `footer`), `h1`/`h2` hierarchy, `aria-pressed` on every segmented group through the shared `setActiveOption` (dashboard.js:4380-4386), `aria-current` on nav/scene/recent chips, tally `role=status` with words (never colour only), live preview `aria-labelledby`, decorative SVGs `aria-hidden`, icon-only buttons labelled, `#pending-announce` pattern (always-present live region), toast `role=alert` for errors, remote tabs with arrow-key roving (remote.js:261-276), remote `#on-screen-announce`.
Gaps: UX-07 (chatty polite region), UX-12 (listbox activedescendant), UX-18 (9 anchor buttons named "6,8"), `.stage` page `aria-live="polite"` on the whole verse card re-reads the reference and the verse on each change (acceptable), canvas editor stage `tabindex=0` has keyboard handling (:2327) but the layers are not exposed as a list.

---

## 4. Contrast numbers

### Dashboard dark theme [calc, WCAG relative luminance]
| Pair | Ratio | Result |
|---|---|---|
| --text #ece7dc on --bg #0b0e13 | about 15.5:1 | pass |
| --text-muted #a7b0bf on --surface-1 #12161d | about 8.3:1 | pass |
| --text-faint #8893a6 on --bg / surface-1 / surface-3 | about 5.4 / 5.85 / 4.84:1 | pass (AA small), thin margin on surface-3 |
| --accent-ink #1a1304 on --accent #e3ad45 (default) | about 9:1 | pass |
| white on --on-air-fill #d93636 (tally, danger hover) | about 4.6:1 | pass (just) |
| --on-air-text #ff8a8a on --surface-1 | about 7.9:1 | pass |
| --field-border #5a6b86 on --bg / surface-2 | about 3.4 / 3.0:1 | pass 1.4.11 (just on surface-2) |
| --pending #e3ad45 on --surface-1 | about 8.8:1 | pass |
| branded accents | see UX-09 | can fail |
`prefers-contrast: more`, `forced-colors`, and `prefers-reduced-motion` blocks exist (dashboard.css:1781-1818).

### Overlay card on bright / dark video (card composited over white and black, text vs worst case)
Verse card, default `classic` design, lower third uses a stronger scrim (`0.42 + 0.52a`) than the fullscreen-less base, fullscreen paints an opaque backdrop. Numbers below are the base card (worst case):
| Palette | Primary text | Secondary text | Reference (accent) | Note |
|---|---|---|---|---|
| gilt-night (default, a=.62) | about 5.8:1 over white video, about 20:1 over black | about 5.3:1 | about 3.4:1 | ref is large italic: passes 3:1 |
| midnight-blue, charcoal, deep-forest, advent, lent, ordinary-time, bold group (a=.74) | about 8-10:1 over white | about 6.5-8:1 | about 3.2-5:1 (christmas #ff8a8a about 3.2:1) | pass |
| parchment, ivory, morning-sky, soft-rose (a=.9) | about 11-15:1 | about 6-9:1 | about 4.5-6:1 | verse pass; announcement fails (UX-01) |
| easter (a=.74 white card over black video) | about 8.5:1 | about 5.2:1 | about 3.3:1 | pass; the card turns grey over dark video |
| high-contrast (3) | 21:1 | about 15:1 | high | pass |
| clear-white / gold / mint (a=0) | 1:1 over white, 21:1 over black; shadow only | | | no guarantee (UX-13) |
Hard-coded `#fff` text on `var(--scrim)` for announcement/definition/outline: fails on light palettes (UX-01).
Designs with their own color logic worth a visual check on real video: tpl-bold (`.reference` uses `rgb(var(--ov-card-rgb))` text on `--accent`, index.html:1138-1139: for dark-accent palettes such as hc-black-on-white (#0036a3 accent, card #fff) this is white on blue about 9:1 fine; for parchment (accent #8a5a12, card #fffaf0) about 5.5:1 fine; for hc-yellow-on-black (accent #fff, card #000) about 21:1 fine); the other designs (stained, manuscript, halo, signal, folio) draw their surface layers from card/accent/border variables, so they inherit the palette numbers above.

---

## 5. Motion
- Overlay verse: reduced-motion handled thoroughly (opacity-only 200 ms, no transform/filter/animation, nature video suppressed). Never uses infinite animations on the verse. Non-reduced reveal is capped (`maxSpread` 240-320 ms), whole reveal about 1 s. OK (UX-23).
- Overlay announcement/definition/outline/status: transitions disabled under reduced-motion (index.html:1418-1421). Good.
- Dashboard: global `prefers-reduced-motion` kill-switch (dashboard.css:1781-1791); `field-shake` on an invalid reference and `tally-pulse` also stop. `.view` switch is instant by design.
- Stage: `@media (prefers-reduced-motion)` present. Remote: present. Live: present (live.css:433).

---

## 6. Error / empty / loading states
Good: skeleton tiles for the media grid with `aria-busy`, queue empty state, Bible loading/unavailable/retry/not-found, preview hint when the reference does not parse (`reference.formatHint`), explicit "preview.unavailable" when the Bible source does not answer, mic permission denied toast, ASR failover warning with action button, near-miss indicator, offline badge on disconnect.
Gaps: no "mic running but nothing heard for N seconds" banner except the diagnostic `micHealth.warn.*` hidden inside `#mic-diag` (display:none until needed, role=alert, fine); `media-grid` `aria-busy="true"` is set in markup (index.html:727), confirm `renderMediaGrid` clears it [verify].

## 7. Information hierarchy during a service
At 1440x900 the Live view is well ordered: command bar, then the program monitor with the red tally frame, then Heard, with the queue and the mic card in the right column. What the operator needs at a glance (what is on air, is something waiting, is the mic hearing) is all present and non-colour-only. Weaknesses: (1) on small viewports the queue drops below the fold (UX-06); (2) the mic card carries 9 statistics and 2 toggles in a 340px column, burying the one thing a stressed operator needs (is it listening?); the header status bar duplicates it, but may be off-screen (UX-11); (3) Review-mode "To confirm" amber state is subtle on the global header chip (small 12px pill).

---

## 8. Top 10 (by live-service impact)

1. UX-01 Announcement/definition/outline text invisible on light palettes (overlay, whole congregation).
2. UX-06 Pending verse and confirm button below the fold at 150% scaling on a 1366x768 laptop.
3. UX-04 No reject/age for pending suggestions; Ctrl+Enter confirms from any text field.
4. UX-03 Auto-fit can shrink long passages to 18px at 1080p with no warning to the operator.
5. UX-02 Announcement/definition/outline text far too small for the back of the church.
6. UX-08 Key replace/remove restarts services mid-service with no confirmation.
7. UX-05 Stage and live pages are English-only for a French/bilingual congregation (and declare `lang="en"`).
8. UX-11 Stray `</div>` in Settings likely pushes the status bar out of the app shell (verify).
9. UX-09 Branded accent colors can break primary-button contrast and the focus ring; accent-ink threshold is wrong.
10. UX-07 Polite live region updates every 500 ms with a frame counter, flooding screen-reader users and masking the pending-verse announcement.

Next tier: UX-10 (French nav labels overflow), UX-16/17 (French vocabulary), UX-12 (Bible listbox), UX-13/14 (no-card palettes and thin serif), UX-20/21 (remote presets and tap safety).

## 9. What is already good
- A real design system with documented contrast, a 12px floor, a 2px accent focus ring with offset on every control, `prefers-reduced-motion`, `prefers-contrast`, and `forced-colors` support in the dashboard.
- Tally is never colour only (red + "On air" + timer, amber + "To confirm"), in dashboard, header, remote and rundown.
- Modal focus management (restore, trap, Esc) and a keyboard command palette make every live action reachable without a mouse; shortcuts use `event.code` for AZERTY.
- i18n is tested: key parity, placeholder parity, every `data-i18n` key and every `t("literal")` in dashboard.js (i18n.test.ts). French is mostly natural, uses real typographic quotes, and avoids literal translation in most sentences.
- Safe defaults: typed-reference preview marked "not on screen"; review mode; Browse mode in the Bible browser; confirm before exposing the app to the network; a delete confirmation that is honest about irreversibility; recent-verse chips as a de facto undo for Clear.
- Overlay: single local Escape clear, reduced-motion fallback that keeps the verse readable, palette contrast helper (`worstCaseCardContrast`, palettes.ts:100) and bilingual same-size typography with language-driven italics, `lang` set per verse block.
- Phone remote: 48-56px targets, 16px inputs (no iOS zoom), safe-area insets, sticky on-air tally with words, roving-tabindex tabs, toast acknowledging success/failure of each send, `navigator.vibrate` feedback, bottom tab bar in the thumb zone.

## 9b. Not verified (needs a browser or device)
- Whether the stray `</div>` (UX-11) really moves `.statusbar` out of `#app-shell`.
- Real rendered width of French rail labels (UX-10).
- Visual appearance of each of the 15 card designs over real video; only the shared palette/scrim math was computed here.
- Whether the Move up/down buttons for draft scenes exist (UX-15); only the i18n keys were found.
