# Autonomous improvement loop — ChurchOverlay

Any Claude session (including a scheduled resume) reads THIS file first, does the next unchecked
item, and updates this file before stopping. The owner delegated the project to Claude on
2026-11-19/20 with full autonomy, within the limits below.

## Hard limits (never cross, even with autonomy)
- AGENTS.md absolute rules stay in force (never display an unverified verse; partials never trigger
  detection; no secrets in renderers; overlay is never a control client; schema-validate everything).
- Work ONLY on branch `feat/innovation-pack` (or short-lived `fix/*` / `feat/*` branches cut from it).
- NEVER push to `main`, NEVER merge a pull request, NEVER force-push, NEVER rewrite published history.
  The owner merges PRs. Pushing `feat/innovation-pack` and opening/updating its PR is allowed.
- No new npm dependencies without a written justification in the architecture note.
- No downloads of unverified files; no secrets in commits; do not commit `ChurchOverlay-/` (stray nested copy),
  `.env`, logs, raw audio.
- Identity for commits: `git -c user.name=anare -c user.email=anarekaci@gmail.com commit`, message ends with
  `Co-Authored-By: Claude <noreply@anthropic.com>`.
- Be quota-light: at most 2 subagents at once, prefer small focused tasks. If a rate-limit error appears,
  commit what is done, update this file, and stop cleanly — the next scheduled run resumes.
- `npm ci` fails locally (lockfile vs local npm); use the existing `node_modules` (junction to
  `E:\ChurchOverlay-\node_modules` in worktrees). `npm test` = tsc + node --test (baseline on main: 1817 tests,
  1814 pass, 3 skipped). Lint is not installed locally; CI runs it.
- Report honestly: say what is verified vs not (no live audio / no live ASR / no real OBS available).

## Cycle (repeat)
1. `git status`, `git log -5`, read this file. Skip if a heartbeat below is < 90 min old (another session is active).
2. Pick the first unchecked item in "Backlog". Reproduce -> failing test -> smallest fix -> `npm test` + typecheck.
3. Commit (focused), update checkboxes + heartbeat here, commit this file.
4. Every few items: `git push origin feat/innovation-pack` and keep the PR description current.
5. When the backlog is empty: run the ECC audit pass again (see "Audit pass"), add new findings to the backlog.

## Audit pass (use the ecc plugin skills/agents; findings go to Backlog with severity)
ecc:code-review, ecc:security-review, ecc:security-scan, ecc:quality-gate, ecc:test-coverage,
ecc:production-audit, ecc:verification-loop, ecc:click-path-audit, ecc:frontend-a11y / ecc:accessibility,
ecc:performance-optimizer agent, ecc:silent-failure-hunter agent, ecc:typescript-reviewer agent,
ecc:security-reviewer agent, ecc:code-simplifier (only on recently changed code), ecc:e2e-testing / ecc:browser-qa
(the web pages /overlay /remote /stage /live can be served and checked in a browser).

## Done so far (branch feat/innovation-pack)
- [x] Landing page redesign (hero kept) — 90ab99e
- [x] F5 handshake limiter no longer locks out OBS; stage reconnect backoff — b22ecdf
- [x] Offline Silero VAD (default off, checksum-pinned) — merged from worktree-agent-a32d7dc34823b4367

## In flight
- none (agent worktrees under .claude/worktrees/ are merged; remove with `git worktree remove --force <path>` when no agent uses them)
- NOTE: each new feature agent MUST be started one at a time with isolation=worktree; unmerged notes live in `architecture-notes/`.

## Backlog (ordered)
Audit findings F1-F13 (from the 2026-11-19 backend audit):
- [ ] F1 HIGH Psalm numbering LSG vs KJV: bilingual mode can pair different verses (localized-verse-source.ts)
- [ ] F2 MED-HIGH verse:confirm-pending must carry the pending reference/id; ignore if superseded (action-registry.ts, app-core.ts)
- [ ] F3 MED degraded bilingual result (French only) must not be cached 24 h
- [ ] F4 MED failover auto-return drops live audio; switch without a gap (failover-provider.ts)
- [x] F5 handshake limiter lockout (done)
- [ ] F6 MED transcripts have no age limit; add audioEndAt, old finals become pending-only (groq-provider.ts, app-core.ts)
- [ ] F7 MED half-open Deepgram socket never detected; liveness watchdog + bufferedAmount cap (deepgram-provider.ts)
- [ ] F8 LOW-MED web mode `allowPhoneRemote` does nothing; enforce or remove (apps/web/index.ts)
- [ ] F9 LOW GetBible response not checked against requested book/chapter
- [ ] F10 LOW near-miss block runs on partials; gate on finals (app-core.ts ~3100)
- [ ] F11 LOW WS latency sampler pings everyone at 10 Hz; seq numbers, 1 Hz, operators only (ws/server.ts)
- [ ] F12 LOW session history rewrites whole file per verse; coalesce/debounce
- [ ] F13 LOW web endpoints /api/verse/lookup skip cache + breaker; route via resolveVerse or delete
- [ ] Still open from earlier audits: TS-09 rundown verse scenes skip index.exists; TS-14 pending verse has no TTL;
      S-06 FreeApiSource redirect/size cap; S-07 Electron setPermissionRequestHandler; circuit-breaker probe can hang;
      Windows rename EPERM/EBUSY retry for config saves.
Features approved by the owner (each needs an architecture note in `architecture-notes/`, default-off where risky):
- [ ] Listed verses ("versets 16, 17 et 18"): contiguous -> range; non-contiguous -> pending suggestions, max 4
- [ ] Rehearsal from a WAV file (sandboxed, never reaches OBS/viewers; WAV PCM only)
- [ ] Undo last verse + on-air confirmation from viewers (needs architecture note on viewer telemetry; overlay stays non-control)
- [ ] Correction memory (operator-approved aliases; wire alias-proposal.ts / learned-aliases.ts)
- [ ] Stage display: operator message to preacher, next-up verse, service clock
- [ ] Stream Deck / Bitfocus Companion action set (operator-token HTTP/WS, no new deps)
- [ ] Scope-change items, last and default OFF: phone captions page, OBS closed captions (send-only), Deepgram Flux provider
- [ ] Fold `architecture-notes/*.md` into ARCHITECTURE.md / ROADMAP.md / SECURITY.md / TESTING.md (new numbered sections)
- [ ] Operational check: build + `npm run dry-run`, serve web mode and click through /overlay /remote /stage /live in a browser

## Heartbeat
last_session_update: 2026-11-20T00:16Z (main session; keyterms, ready-check, VAD, F5 merged; next: F1 psalm numbering)
