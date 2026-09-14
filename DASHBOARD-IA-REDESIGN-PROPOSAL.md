# Dashboard information-architecture redesign — proposal (Part E)

Status: **proposal only, as requested — no code written for this.** Nothing is
removed or hidden by this document. Wait for sign-off before any
implementation, per the brief.

## The ask, restated

The dashboard has grown into 45 files under `dashboard/features/*.js` on top
of the core live-detection controls, spread across a 4-space sidebar. The
operator wants an OBS-Studio-like paradigm: the visible surface reduced to
two primary views — **Operator** (everything needed to run a live service,
consolidated) and **Parameters** (settings, configured occasionally) — with
everything else reachable through a small collapsible panel, not deleted.

This required a real inventory before proposing anything — guessing from
filenames would have been worthless. All 45 files were read (header comments

- the DOM they wire up), cross-referenced against `dashboard.html`'s actual
  sidebar markup.

## What's actually there today (verified, not assumed)

**The sidebar has 4 spaces**, not 3 — a stale HTML comment at `dashboard.html`
line 159 still describes a 3-space model ("DIRECT/PRÉPARATION/RÉGIE") that
predates a later split of "DIRECT" into two:

| Label            | `data-sections`                | Live during a service?                                                    |
| ---------------- | ------------------------------ | ------------------------------------------------------------------------- |
| Studio Pro       | `propresenter-live`            | Yes — the broadcast console (slide grid, F-key shortcuts, PGM/Stage sync) |
| Direct Classique | `overview,transcript,controls` | Yes — the original live view (verse display, mic, triggers)               |
| Préparation      | `analysis,studio,media-wall`   | Mostly no — but see below                                                 |
| Régie            | `settings,overlay`             | Mostly no — but see below                                                 |

Plus a **global chrome layer** outside all 4 sections, always visible:
status-strip, confidence-rail, pipeline-health alert banners, command-palette
trigger, trust-mode buttons, focus-mode toggle, the Direct/Config density
toggle, perf-pill.

**Two pieces of prior art already exist that are effectively rough drafts of
what's being asked for** — the proposal below builds on these rather than
inventing a parallel mechanism:

- `focus-mode.js` — a full-screen kiosk overlay already showing _only_: live
  preview, next cue, Go Live, emergency clear/black-screen, clock, connection
  status. This is already a minimal "Operator view."
- `dashboard-cleanup.js` — an app-wide "Direct" vs "Configuration" density
  toggle (persisted per-machine) that already hides secondary panels. This is
  already an Operator/Parameters _density_ switch, just not an _information
  architecture_ — it hides things in place rather than reorganizing them.

**Three genuinely live controls are currently misplaced** under "Préparation"
or "Régie," which is very likely part of why the dashboard feels cluttered
relative to what's actually needed live:

- The Mur Média trigger grid (`media-library.js`) — for firing photos/video
  _during_ the service — lives under Préparation.
- The scene gallery's Cut/Hide-now buttons (`scene-studio.js`) — literal
  "cut to program" actions — live under Préparation, right next to the
  drag-and-drop scene _composer_ (a genuine prep tool).
- OBS scene-switching (`obs-scenes.js`) — switching the broadcast scene is a
  director action — lives under Régie.

**A few files legitimately serve two purposes and split cleanly**:

- `media-library.js`: CRUD/upload (parameters) vs. the trigger grid (live).
- `scene-studio.js`: the composer (parameters) vs. the gallery's live
  cut/hide buttons (live).
- `preservice-ai.js`: a grab-bag — pre/post-service tools (recap, stats,
  clip export, sermon Q&A — genuinely "before/after," not live) bundled with
  `sendStageMessage`/caption/high-contrast toggles, which _are_ live controls.

**`settings-subnav.js` is stale** — it still filters by the old pre-split
section grouping (`#controls`/`#analysis`/`#studio` shown together), which no
longer reflects the real 4-space layout. It's a casualty of the incomplete
3→4 space migration, not something worth porting forward as-is.

## Full classification

**Operator-essential** (used live, in the moment): propresenter-studio,
rundown, airlock-preview, verse-session-display, trust-mode, confidence-pip,
confidence-rail, status-strip, pipeline-health, command-palette, focus-mode,
audio-capture, audio-vumeter, reading-mode, translation-picker, verse-queue,
song-library, next-cue-confidence, _plus_ the live-only slices of
media-library (trigger grid), scene-studio (cut/hide gallery), obs-scenes,
and preservice-ai (stage messaging, caption/high-contrast toggles).

**Parameters/config** (occasional, not during a service): api-settings,
network-settings, branding, dashboard-branding, companion-link,
offline-bible, propresenter-planning-center, service-export, startup-wizard,
camera-panel, _plus_ the config-only slices of media-library (upload/CRUD)
and scene-studio (composer).

**Secondary/occasional tool** (real, but not core to running a live
service): confidence-mode, mood-theme, social-share, poster-principal-card,
bible-search, agent.js, ip-cameras (pairing setup; its live feed grid is a
judgment call — see open questions), overlay-theme-selector, training-mode,
perf-pill, ui-effects (invisible, no UI), _plus_ the prep/review slices of
preservice-ai (sermon summary, recap, stats, clip export, Q&A/archive
search).

**Stale, candidate for retirement rather than migration**: settings-subnav.js.

## Proposed information architecture

### Operator view

Everything above tagged **Operator-essential**, consolidated into one view —
deliberately broad, not trimmed to a token subset, per the brief's explicit
warning against under-scoping this into uselessness. Concretely, that means
the operator should be able to, without leaving this view:

- See the live verse/transcript display, confidence gauge, and connection/
  pipeline health at a glance (verse-session-display, confidence-pip,
  confidence-rail, status-strip, pipeline-health).
- Run the rundown: arm/Go Live, reorder cues, see the next-cue readiness
  check (rundown, airlock-preview, next-cue-confidence).
- Fire prepared content: verse-queue, song-library section triggers, the
  Mur Média trigger grid, the scene gallery's Cut/Hide buttons, reading-mode.
- Control mic and OBS scene, switch translation, use the command palette
  (audio-capture, audio-vumeter, obs-scenes, translation-picker,
  command-palette).
- Send stage-display messages and toggle captions/high-contrast, since these
  are live-facing despite currently sitting inside preservice-ai.js.

This is essentially "Studio Pro + Direct Classique, merged and cleaned up,"
since the inventory shows both are already operator-essential today — they
read more like two competing live-view paradigms (a newer broadcast-console
style vs. the original layout) than a real Operator/Parameters split. Merging
them is real work (see migration plan) and is the biggest open question in
this proposal — see below.

### Parameters view

Everything tagged **Parameters/config**: credentials and device selection
(api-settings, camera-panel), network/companion setup (network-settings,
companion-link), branding (branding, dashboard-branding), integrations
(propresenter-planning-center), backup/restore (service-export), offline
Bible cache status, first-run onboarding (startup-wizard), and the
config-only halves of media-library (upload/organize) and scene-studio
(the composer).

### Secondary tools — collapsible side panel

Everything tagged **secondary/occasional**, reachable from a small
collapsible drawer/side-panel available from both primary views rather than
a nav-level destination: bible-search, agent.js, social-share,
poster-principal-card, confidence-mode, mood-theme, overlay-theme-selector,
training-mode, perf-pill, ip-cameras, and preservice-ai's prep/review tools
(sermon summary, recap, session stats, clip export, Q&A/archive search).

**Drawer vs. full docking system** — the brief asked me to evaluate
dockview.dev specifically if a dock-based approach is chosen, so here's that
evaluation, but my recommendation is to start simpler:

- Verified directly against dockview's docs/repo: MIT-licensed core, zero
  dependencies, vanilla JS/TS support (no framework required — relevant
  since this dashboard isn't React/Vue/Angular), built-in layout
  serialization, actively maintained (3.3k+ stars, 540k+ monthly downloads,
  recent v8 release). One thing to verify before adopting: the project also
  ships a separate `dockview-enterprise` package under a commercial license
  — confirm which specific features (if any the operator would want, e.g.
  popout windows) are enterprise-gated before committing to it, so the free
  MIT core is actually sufficient.
- But: only ~12-15 of the 45 files are genuinely secondary/occasional, and
  most are simple forms or single-purpose panels — not workflows that need
  freely-resizable, floating, or multi-monitor arrangement. A full IDE-style
  docking system is more machinery than that set of tools currently needs.
- Recommendation: ship a simple collapsible slide-out drawer first (each
  secondary tool opens in the drawer, one at a time, or as a lightweight
  modal) — lower risk, faster to build, and it directly satisfies "not
  cluttering the main view." Treat dockview as the upgrade path if it later
  turns out operators want several secondary tools open and rearranged
  side-by-side at once (e.g. bible-search next to agent.js while still
  watching the live view) — that's the point where a real docking system
  starts paying for its complexity. Don't build both.

## Migration plan (incremental, not a big-bang rewrite)

The goal is to never put all ~50 features at risk at once. Proposed order:

1. **Relocate the 3 clearly-misplaced live controls** (Mur Média trigger
   grid, scene gallery Cut/Hide, OBS scene-switching) into the existing live
   tabs (Studio Pro / Direct Classique) where they already belong. Lowest
   risk, highest immediate value, and doesn't require deciding the bigger
   Operator/Parameters question yet.
2. **Split the 3 dual-purpose files** (media-library, scene-studio,
   preservice-ai) at the code level into their live vs. config halves, now
   that step 1 has already relocated the live halves. This is refactor-only
   — no behavior change, just untangling what's already been proven to be
   two different concerns living in one file.
3. **Decide and execute the Studio Pro / Direct Classique merge** into a
   single Operator view. This is the biggest open question (see below) and
   the riskiest step — do it once steps 1-2 have already reduced clutter and
   proven the relocation pattern works.
4. **Merge Préparation + Régie into Parameters**, moving the
   secondary/occasional tools out into the new collapsible drawer rather than
   a nav destination.
5. **Build the drawer** (plain collapsible panel, not dockview — see above)
   and wire the secondary tools into it.
6. **Retire dashboard-cleanup.js's density toggle** (superseded by the
   explicit Operator/Parameters split) and prune settings-subnav.js's stale
   cross-section references.

Each step ships independently and is revertible on its own; nothing later
blocks on a big-bang cutover.

## Open questions for sign-off

1. **Studio Pro vs. Direct Classique**: these look like two competing live
   paradigms that both currently qualify as "operator-essential." Should the
   merged Operator view be built on Studio Pro's broadcast-console layout
   (the newer of the two) with Direct Classique's exclusive tools folded in
   as additional panels, or the reverse, or genuinely both kept as tabs
   _within_ the one Operator view? This needs an operator's call, not a
   guess — it's the single biggest design decision in this whole proposal.
2. **ip-cameras' live feed grid**: pairing setup is clearly config, but if
   the MJPEG thumbnail grid is actually watched during a service (e.g. to
   monitor a second camera angle), it belongs in Operator, not the drawer.
   Worth confirming actual usage before deciding.
3. **Drawer vs. dockview**: recommendation above is drawer-first, but if
   there's already a concrete case for multi-panel arrangement (e.g. wanting
   bible-search and the AI agent open side-by-side while running a service),
   that changes the calculus toward starting with dockview instead.

Stopping here per the brief — no UI code until this is signed off.
