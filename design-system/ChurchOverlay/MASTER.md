# ChurchOverlay design system — "Vespers 2" (source of truth for the frontend redesign)

Direction (user-approved): **dark, cinematic, restrained**. One operator in a dim booth, a stream/OBS
output, a phone remote, a stage monitor, a congregation phone. Premium = calm, precise, confident —
not decorative. Colour is information, never ornament.

Built with the ui-ux-pro-max rules: accessibility first (WCAG AA), 44px touch targets, visible focus,
reduced motion, SVG icons (no emoji), semantic tokens (no raw hex in components), 4/8 spacing rhythm.

## Hard constraints (do not break)
- Vanilla HTML/CSS/JS only. **No new dependencies, no CDN, no external requests** (offline church Wi-Fi).
  Fonts stay self-hosted in `apps/desktop/renderer/fonts/` (Instrument Sans, Instrument Serif, JetBrains Mono).
- Dashboard CSP: `script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'` — no inline `<script>`.
- Keep every DOM `id`, `data-*` hook and class that JS/tests read. Add, don't rename, unless you update all users.
- Keep i18n: every visible string stays in `i18n.js` (EN + FR); new strings need both languages.
- WebSocket protocol, auth (token via subprotocol, never URL-only secrets for new work), and server code: untouched.
- The OBS overlay is **on air**: no layout shift, no flash on connect, transparent background preserved,
  operator-chosen palettes/card templates (`overlay:style`) must keep working. Escape still clears locally.
- Tests that read these files as text (`page-assets`, `landing-page`, `client-handshake`, `overlay-reconnect`)
  must keep passing; `npm test` and `npm run typecheck` must stay green.

## Semantic colour tokens (dark; AA verified pairs)
| Token | Value | Use |
|---|---|---|
| `--bg` | `#0b0e13` | app background (near-black, faint cool) |
| `--surface-1` | `#12161d` | panels |
| `--surface-2` | `#181d26` | raised / inputs |
| `--surface-3` | `#202734` | hover / selected |
| `--border` | `#262e3b` | hairline (1px) |
| `--field-border` | `#5a6b86` | input/control boundary (>=3:1 on surfaces) |
| `--text` | `#ece7dc` | primary (warm vellum) |
| `--text-muted` | `#a7b0bf` | secondary (>=4.5:1 on every surface) |
| `--text-faint` | `#8893a6` | tertiary, never below 4.5:1 |
| `--accent` | `#e3ad45` | brand/action gold (church-brandable) |
| `--accent-ink` | `#1a1304` | text on accent |
| `--on-air` | `#ef4a4a` (fill `#d93636`) | something is on the congregation screen — FIXED meaning |
| `--pending` | `#e3ad45` | verse waiting for operator |
| `--live-ok` | `#3fcf8e` | healthy / connected / mic ok |
| `--warn` | `#f08a3c` | degraded |
State colours never double as decoration, and are never church-branded.

## Type
- UI: **Instrument Sans** 400/500/600. Display/verses: **Instrument Serif**. Data/ids/timers: **JetBrains Mono** (tabular).
- Scale (px): 12 / 13 / 14 (base UI) / 16 / 20 / 28 / 40. Body line-height 1.5, headings 1.2. Min 12px, never below.
- Numbers that change (timers, levels, counts): `font-variant-numeric: tabular-nums`.

## Shape, depth, space
- Radius: control 8, panel 14, pill 999. Spacing: 4/8/12/16/24/32. Density: dashboard compact (operator console),
  remote/live comfortable (touch).
- Depth by surface tone + 1px hairline, not heavy shadows. One soft shadow for overlays/menus only.
- Optional glass only on floating layers (command palette, toasts): `backdrop-filter` with a solid fallback.

## Motion
- 120ms (hover/press), 200ms (panel/state), 320ms max (enter). Easing `cubic-bezier(0.2,0,0,1)`.
  Exit faster than enter. Animate `transform`/`opacity` only. The ON AIR tally may pulse slowly (2.4s).
- `@media (prefers-reduced-motion: reduce)` removes all non-essential motion (state still visible without it).

## Interaction
- Focus: 2px `--accent` ring + 2px offset on every interactive element, never removed.
- Touch targets >= 44x44 on remote/live; >= 32px height on dense dashboard controls with 8px gaps.
- Every icon-only button has `aria-label`; icons are inline SVG (`currentColor`, 1.75 stroke, 20px grid).
- Loading/disabled/error states are explicit; errors sit next to the field; destructive actions are visually distinct.
- State is never colour-only: pair with icon or text (on-air = red + "ON AIR" label).

## Surfaces
1. **Dashboard** (`apps/desktop/renderer`): operator console. Clear regions: live preview with tally, verse/queue,
   rundown, media, status bar (mic/ASR health), command palette. Compact, keyboard-first, instantly scannable.
2. **Remote** (`apps/remote/public`): phone, one thumb, large targets, glanceable on-air state.
3. **Overlay** (`apps/overlay/public`): broadcast-grade verse card; refined default card designs; operator palettes kept.
4. **Stage** (`apps/stage/public`): high-contrast confidence monitor for the preacher; huge verse, quiet chrome.
5. **Live companion** (`apps/live/public`): congregation phone; reading-first, large type, calm, saved-notes list.

## Done means
Consistent tokens across all five surfaces, responsive (375/768/1024/1440 where relevant), AA contrast,
keyboard + reduced-motion verified, no console errors, tests green, and a before/after note per surface.
