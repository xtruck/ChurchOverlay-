# AI features audit (owner report: "the AI features are also not working")

Scope: apps/server/ai/**, ai-suggestion-coordinator, and the settings/wiring/status that make AI usable.
Nothing here was tested against a live key (none available). All verification is mocked HTTP.

## Root causes found

1. **Anthropic key could not be added after first-run setup** (apps/desktop/renderer/dashboard.js setup flow; main/index.ts `complete-setup`).
   The key field existed ONLY on the setup screen, which is shown only when services are not yet running.
   A church that left the optional field blank (or set up with Groq only) had no way to enter it later; the
   Settings hint literally said "Add it in setup", a dead end. With no key the three feature toggles are
   disabled, so every AI feature was unreachable. FIX: Settings -> AI card now has an Anthropic key field
   (Save / Remove), IPC `set-ai-key` (shape-validated by `apps/server/ai/ai-key.ts`, stored encrypted by the
   existing ConfigStore, services restart like `set-ai-provider`; saving a key explicitly selects Anthropic).
2. **Free (Groq) provider returned EMPTY answers for every helper** (apps/server/ai/groq-text-client.ts:~99).
   Default model `openai/gpt-oss-20b` is a reasoning model; hidden reasoning tokens count against
   `max_completion_tokens`. Helpers ask for 60 (repair), 80 (semantic), 160 (cleanup), 200 (translate), 400
   (copilot) tokens, so the budget was spent reasoning and `content` came back "" with
   `finish_reason:"length"`; the client returned "" which every parser treats as "no suggestion". Net effect:
   "toggles on, nothing ever happens, no error anywhere". FIX: `reasoning_effort:"low"`, cap = requested + 700
   headroom, and an empty answer truncated by the limit is now a thrown error (so the circuit/status/log show
   it). Same for SermonNotesGenerator (Groq notes + service summary): reasoning_effort low, 2000-token cap, and
   it had NO timeout (a hung request left the "Generate summary" button spinning forever): added 30 s abort.
   Reproduced by a fake reasoning-model server in groq-text-client.test.ts.
   UNVERIFIED LIVE: that Groq accepts `reasoning_effort` on this model today (documented for gpt-oss; if it
   400s, the status line / test button shows it immediately).
3. **No operator-visible status** beyond a red banner after 3 failures. A bad/expired key, a rate limit and "never
   verified" looked identical (nothing). FIX: Settings status line (AI off: no service / needs key; Ready but
   not verified; Working (tested at hh:mm); key refused; model not available; rate limited / overloaded;
   paused; timeout; network; empty) plus an operator-triggered **Test connection** button (IPC
   `test-ai-connection` -> `GuardedTextCompleter.testConnection()`: one 16-token request, text "ping", bypasses
   the circuit, closes it on success, returns a FIXED code never provider text).
4. **429 / 529 classified as generic "repeated-failures"** (guarded-text-completer.ts reasonFor). Now a distinct
   `rate-limited` reason (contract `status:update.aiHelpers.reason`, action-registry validator, i18n EN+FR).
5. `complete-setup` rebuilt the config without `aiProvider`, silently resetting the operator's explicit provider
   choice. Now preserved.

## Checked and found OK
- Toggles default OFF; persisted via ConfigStore keys aiTranscriptCleanup/aiSemanticDetection/aiSermonCopilot;
  `set-ai-feature` IPC -> `AppCore.setAiFeature` -> coordinator. Coordinator is created whenever a completer exists.
- WS event names match: `copilot:suggestions` (server, contract, action-registry, dashboard), `sermonNotes:update`.
- Provider selection is explicit (no silent fallback). With no Anthropic key and only a Groq key the operator
  must click "Free (Groq)" once; the hint says so. This is by design (AGENTS.md s46), not changed.
- Anthropic request: POST /v1/messages, `x-api-key`, `anthropic-version: 2023-06-01`, `max_tokens`, `system`,
  text-block parsing, AbortController timeouts, key scrubbed from errors. Availability probe GET /v1/models/{id}.
- Guard rails intact: every proposal goes through `validateProposal`/`detectValidated` (detector + KnownValidVerseIndex),
  `resolve`, arbiter, then `offerPending` (origin "ai") or operators-only copilot message. Nothing auto-shown.
  Budgets: cleanup 20/min (2 in flight), semantic 4/min + 10 s gap + 1 in flight, copilot 3/min + 45 s timer,
  repair 6/min, translate 20/min, extras 3/min + busy flag. Text-only (no audio) sent. Keys: `sk-`/`gsk_` scrubbed by
  `scrubSecrets`; ConfigStore encrypts keys at rest; IPC never returns a key (status only exposes booleans).
- Service summary (s93) uses SermonNotesGenerator with the Groq key independent of the AI-provider choice;
  post-service extras (s126) build their own completer from the chosen provider and return scrubbed errors.

## Model IDs (claude-api skill check)
- Anthropic default `claude-haiku-4-5-20251001`: the published Haiku 4.5 snapshot id; the skill's table lists the
  alias `claude-haiku-4-5` and a newer, cheaper `claude-haiku-5-5`. NOT changed (needs a live check); the startup
  `checkAvailability` (GET /v1/models/{id}) and the new Test button will surface a retired id as "model not available".
  Recommended follow-up with a key: try `claude-haiku-5-5` (note: Haiku 5.5 rejects non-default sampling params; this
  client sends none).
- Groq `openai/gpt-oss-20b`: not deprecated as far as can be checked offline; availability probe lists /models.
- No retry/backoff on 429/529 inside the live path on purpose (budgets + circuit + 60 s cooldown bound it; a retry
  would blow the 3-8 s helper deadlines). Anthropic 400 "credit balance too low" is shown as generic "paused".

## Verified under mocks (apps/server/ai/*.test.ts, all passing)
All seven helpers (reference repair, semantic, cleanup, copilot, bilingual notes, translator, service extras) through the real
ClaudeClient and real GroqTextClient (incl. a reasoning model burning 400 tokens), request URL/headers/body shape, key never in
body or error, 429/529 -> rate-limited, 401 -> auth, test-connection recovery, circuit behaviour, key-shape validation.
Existing coordinator tests (cleanup/semantic/copilot -> pending only, stop-in-flight) still pass.

## Needs a live-key smoke test (owner steps)
1. Settings -> AI assistants. Anthropic: paste key, Save key (services restart ~seconds), press Test connection:
   expect "Working (tested at ...)". Free: click "Free (Groq)", press Test connection (uses the Groq key from setup).
2. Turn on "Verse suggestions from meaning"; say (or play) a paraphrase of John 3:16 with no reference; expect a PENDING suggestion
   card, never a shown verse. Turn on "Smarter transcript cleanup"; say "Corentin 13 verset 4"; expect a pending suggestion.
3. Turn on Live sermon copilot; after ~45-90 s of speech (>200 chars) the Activity drawer shows related verses + caption.
4. Enable sermon notes; after ~60 s notes appear (bilingual with Anthropic).
5. After a service: "Generate summary" and the recap/quote cards/export buttons.
6. Wrong key test: paste `sk-ant-` + garbage, Test connection -> "key refused".
Check logs for `ai.connection-test`, `ai.circuit-*`, `ai.cleanup-fallback-raw`.

## Proposed ARCHITECTURE.md text (do not apply; lead decides)
> ### AI setup, status and testing (addendum to sections 93, 123-128)
> The Anthropic key can be added, replaced or removed at any time from Settings -> AI assistants (IPC `set-ai-key`);
> it is shape-checked (`sk-ant-` prefix, printable ASCII), stored encrypted like every key, never logged or sent back
> to the renderer, and saving it selects Anthropic as the AI service and restarts the services. The dashboard shows a
> single AI status line derived from fixed codes only (no service chosen, needs key, ready/unverified, working, key
> refused, model unavailable, rate limited/overloaded, paused, timeout, network, empty). "Test connection" is
> operator-triggered only: one 16-token request with fixed text, never transcript content, bypassing the circuit and
> closing it on success. `status:update.aiHelpers.reason` gained `rate-limited` (HTTP 429/529).
> The Groq text client targets a reasoning model: it requests `reasoning_effort: low` and adds 700 tokens of headroom
> to `max_completion_tokens`; an empty completion truncated by the limit is an error, never a silent "no suggestion".

## Open questions / not done
- Groq key can still only be entered at setup (outside AI card scope; the Free option depends on it).
- Switching provider/key restarts services (existing pattern); doing it mid-service briefly drops ASR. Consider a hot-swap.
- Anthropic billing errors (400 credit balance) are not distinguished.
- Dashboard UI changes are untested by automation (no renderer test harness); i18n parity test passes.
