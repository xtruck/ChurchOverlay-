# P1 quality pass — 2026-11-16

The P1 lot of the audit plan (after the `npm ci` lockfile repair: the lock was npm-11-deduped while CI runs npm 10 — regenerated with npm 10 and validated by both, commit "fix(deps): resync package-lock.json under npm 10"). Full narrative in ARCHITECTURE.md section 149. Commits, in order:

## P1-1 — Coverage gate + CodeQL (commit 1ca6c10)
- Coverage measured first (97.44% statements / 89.98% branches / 97.27% functions), so the c8 gate is set at 95/85/95/95 — above the plan's 40% floor to actually mean something. `npm run test:coverage`; CI step "Coverage gate".
- CodeQL workflow (javascript-typescript, security-extended, push/PR main + weekly) — every action pinned by full SHA per the S-02 policy (codeql-action v3.39.3 verified via `git ls-remote refs/tags/v3.39.3^{}`).

## P1-4 — Electron fuses (S-07) + anti-framing (S-08) (commit e7b1902)
- `scripts/apply-fuses.cjs` (electron-builder afterPack): RunAsNode=false, EnableCookieEncryption=true, EnableNodeOptionsEnvironmentVariable=false, EnableNodeCliInspectArguments=false. OnlyLoadAppFromAsar + EnableEmbeddedAsarIntegrityValidation deliberately deferred to P2-1 (no packaged-run smoke test; integrity fuse wants signing) — deferral pinned by a source-guard test.
- `StaticServer.frameDeny`: X-Frame-Options: DENY + CSP frame-ancestors 'none' on HTML only. Enabled on the phone remote (desktop 0.0.0.0 instance + web-mode `/remote`); overlay/display pages stay framable ON PURPOSE (dashboard Live view embeds overlay from file:// null origin — frame-ancestors cannot express that; OBS loads top-level). 3 server tests.

## P1-2 — Frontend lint + first module split (commits ee93e3b, c6552ca)
- ESLint extended to all 14 no-build-step JS files (~11k lines) as classic scripts with the 28 non-language globals found by probe. 4 real scories fixed (dead const, unused drag arg, unused caught error, expression-statement guard rewritten as an explicit `if`).
- `reference-format.js` extracted from dashboard.js (globalThis.ChurchOverlayReferenceFormat): capitalize, FRENCH_BOOK_NAMES, FRENCH_TRANSLATIONS, rangeSuffix, formatReference, formatBilingualReference — unit-tested directly for the first time (4 tests). dashboard.js keeps only formatDisplayedReference (reads the mode toggle). reference-parity.test.ts follows the dashboard tables into the module. dashboard.js: 5 020 → 4 974 lines.

## Remaining from the P1 lot (next passes)
- **P1-3**: split app-core.ts (3 380 lines) into modules under 1 500 lines each.
- **P1-2 continuation**: the rest of the dashboard.js split toward the plan's sub-800 target — next candidates: sermon-prep import block (~200 lines, must be extracted with an explicit context object because it bleeds into the AI-features state), drag-and-drop import (~125 lines).
- Not verified here: a real packaged Windows run (fuses), CodeQL's first findings on the Security tab.
