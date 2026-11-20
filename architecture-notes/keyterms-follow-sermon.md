# Keyterms that follow the sermon, without reconnecting

Architecture note for the integrator (to be folded into ARCHITECTURE.md as a new
section; it extends sections 86, 95, 104 and 119). Branch:
`worktree-agent-af57b5347fafe968c`.

## Why

Until now the recognition bias was frozen per connection. Deepgram received its
`keyterm`/`keywords` list only in the connect URL, so a book the preacher moved
to mid-service, or a rundown loaded after the mic started, took effect only at
the next reconnect. Planned books were capped at 15 terms. Groq's prompt listed
all 56 French book names in a fixed order. Whisper only conditions on the last
224 prompt tokens and weighs later tokens more, and the fixed order put
Apocalypse last whatever the sermon was about.

## What changes

**Contract (`packages/contracts/asr.ts`).** There is a new provider-neutral type,
`AsrContextHints { focusBooks; plannedBooks }`, with canonical book ids only,
most relevant first. `AsrProvider` gains an optional `setContextHints?(hints)`.
The core never sees keyterms, prompts or provider names. Adapters translate the
ids into spoken names in the right language, using the existing
`plannedBookTerms()` for Deepgram and a French name table for Groq. There is no
`aliases` field: how a book is spoken depends on the language, so that is
provider-side knowledge.

**Core (`apps/server/core/asr-context-hints.ts`, `app-core.ts`).**
`AsrContextHintsTracker` holds:
- the focus books, at most 2, newest first;
- the plan, deduplicated, with ids outside the catalog dropped.

AppCore updates the tracker at these points:
- `showVerse` (any trigger: detected, override, navigation, rundown);
- a final transcript that announces a chapter (`extractAnnouncedChapter`);
- `goto-chapter` navigation;
- `pushPlannedBooks`, which covers `rundown:load`, sermon-prep import and clear.

Hints are pushed only when they actually change. `setPlannedBooks` is still
called exactly as before, so `LocalWhisperProvider` and the volume inference
are unaffected. If the provider has no `setContextHints`, the core logs
`asr.context-hints-unsupported` once (info) and does nothing else. If
`setContextHints` throws, the core logs `asr.context-hints-failed` (warn) and
the caller (verse display, rundown load) carries on.

Partial transcripts never reach these update points. The hints are a lexical
bias only. Detection, validation, the known-valid index and the hallucination
guard are untouched.

**Failover (`failover-provider.ts`).** The wrapper forwards the hints to both
sides at once, like `setPlannedBooks`. A side without the method ignores them.

**Deepgram (`deepgram-provider.ts`, new `deepgram-keyterms.ts`).**
- `currentKeyterms()` builds ONE list, most relevant first: focus book names,
  then planned names (still capped at 15), then the static biblical vocabulary.
- That list goes through `boundedKeyterms()`, which applies NFC, strips
  `, ; :` (a colon reads as a weight) and control characters, trims, collapses
  whitespace, and rejects any term over 40 characters whole (never cut). It then
  dedupes case-insensitively and caps at 80 terms and 400 estimated tokens,
  estimated as `ceil(len/3)+1` per term. Deepgram's limits are 100 terms and 500
  tokens. Whatever goes over is dropped from the least relevant end.
- The same list feeds the connect URL and the mid-stream message, because
  `Configure` REPLACES the stream's whole list.
- `setContextHints()` always stores the hints, so a reconnect carries them.
  It sends `{"type":"Configure","keyterms":[...]}` only when ALL of these hold:
  - the socket is open;
  - the model is Nova-3 (including `multi`, which already upgrades to Nova-3);
  - the term SET differs from what the stream has (a reorder alone is not a change);
  - the debounce (1.5 s) has passed and the minimum interval (10 s since the
    last Configure) is respected.
- At most one timer is pending, and it reads the latest hints when it fires.
  This keeps the rate bounded: at most 6 messages a minute, and churn can't
  postpone an update forever.
- Hints that change while the socket is connecting are sent right after it opens.
- `stop()` and the socket `close` event cancel the timer and reset the
  per-connection state.
- If `send` throws, the provider logs `deepgram.keyterms-configure-send-failed`.
  It is NOT reported through `onError`: that would trigger a failover over a
  bias hint. It is not retried either; the next change tries again.
- A `ConfigureFailure` reply makes the provider record that the stream kept its
  previous list, log `deepgram.keyterms-configure-failed` with the `code`, and
  never retry on its own. After 3 failures on one connection, Configure is
  disabled until the next connect (`deepgram.keyterms-configure-disabled`).
- Each successful send logs `deepgram.keyterms-configured` with counts only:
  count, estimatedTokens, added, removed.
- Nova-2 `keywords` has no documented mid-stream update. The hints wait for the
  next connect, and `deepgram.keyterms-deferred` is logged at debug.

**Groq (`groq-provider.ts`).** The inline book list is now `PROMPT_BOOKS`: the
same 56 names, each mapped to the canonical ids it covers ("samuel" covers 1 and
2 Samuel). `orderPromptBooks(hints)` builds the order:
1. unhinted books, in canonical order;
2. planned books, in plan order;
3. focus books, oldest to newest, so the newest focus book is the last name
   before `Référence actuelle: …`.

Books are moved, never added. The prompt length is unchanged and the
`MAX_PROMPT_CHARS` derivation (730 characters, about 224 tokens) still holds.
The hints are read at flush time, with the same capture rule as
`setCurrentVerseRef`. Without hints the prompt is byte-identical to before.

**Providers without support.** `LocalWhisperProvider`, `HybridAsrProvider`
(web build) and `DryRunAsrProvider` don't implement `setContextHints`. That is
deliberate and observable: the core logs once, and FailoverAsrProvider skips
that side. `HybridAsrProvider` recreates its GroqProvider when the key changes,
so forwarding hints there would also need replaying. That is left for later.

## What breaks

Nothing external. There is no new WS action or event and no config change.
Internal behavior changes:
- The Deepgram URL now lists keyterms in relevance order (focus, plan,
  vocabulary) instead of vocabulary then plan, sanitized and bounded. Existing
  tests only check membership and still pass.
- Over the 400-token estimate, the least relevant static vocabulary terms are
  dropped. Today's largest list (bilingual: 56 static terms plus 15 planned
  plus focus) comes in under it.
- `GroqProvider` gains `setContextHints` and `currentPrompt()` (diagnostic).
  `DeepgramProvider` gains `setContextHints`, `currentKeyterms()` and the
  `configureDebounceMs`, `configureMinIntervalMs` and `timers` options.

## Tests (all deterministic, no network)

- `asr/deepgram-keyterms.test.ts`: sanitization (commas, weights, control and
  zero-width characters, NFC, over-long terms), case-insensitive dedupe that
  keeps relevance order, count cap, token cap, determinism, set comparison.
- `asr/deepgram-provider.context-hints.test.ts` (fake socket, fake clock and timers):
  - debounce, and one Configure for a burst;
  - the minimum interval under churn;
  - an unchanged list is a no-op with no timer, and a change that reverts
    before the timer fires sends nothing;
  - a closed or never-opened socket gets nothing but the next URL has the hints;
  - `stop()` cancels the timer;
  - hints changed during connect are sent after open;
  - a throwing send is logged, causes no `onError` and no retry loop;
  - ConfigureFailure restores the old list, and Configure is disabled after 3;
  - ConfigureFailure never reaches the transcript path;
  - nova-2 defers;
  - multi uses Configure with both names;
  - the list is bounded and sanitized;
  - malformed hints are tolerated.
- `asr/groq-provider.context-hints.test.ts`: the prompt is unchanged without
  hints, relevance ordering is last, the reference stays last, the length is
  unchanged, family dedupe and unknown ids, flush-time capture, malformed input.
- `core/asr-context-hints.test.ts`: focus ordering and bound, unknown ids,
  change detection, immutable snapshots.
- `core/app-core.context-hints.test.ts`: the plan plus the displayed book flow
  to the provider and are pushed only on change; an unsupported provider is
  logged once; a throwing provider doesn't break the caller.
- `asr/failover-provider.test.ts`: hints are forwarded to both sides, and a side
  without the method is fine.

Suite: 1853 pass, 0 fail, 3 skipped (baseline 1814/0/3). `npm run typecheck` is clean.

## Limits and what is NOT verified against live traffic

- **Checked against developers.deepgram.com/docs/keyterm (2026-11):** the
  Configure shape, list replacement, Nova-3 `/v1/listen` support including
  multilingual, the 500-token/100-term limits, and ConfigureFailure with
  `CONFIGURE_KEYTERM_LIMIT_EXCEEDED`.
- **Not verified live:**
  - the exact ConfigureFailure JSON (`type`/`code` field names are assumed from the prose);
  - whether a success acknowledgement exists (none is documented, none is awaited);
  - whether commas inside a Configure array fail silently the way they do in
    the query string (we strip them regardless);
  - whether Configure resets Deepgram's idle timer (we don't count it as
    activity, so KeepAlive behavior is unchanged);
  - any server-side rate limit on Configure (none is documented; ours is 10 s).
- The token estimate is a heuristic, because Deepgram doesn't publish its
  tokenizer. If it under-counts, Deepgram answers ConfigureFailure and the
  stream keeps its previous list, which is handled.
- The recognition gain was not measured on real sermon audio. Whether the
  Groq reordering improves Whisper accuracy is the documented behavior of the
  prompt window, not something measured here.
- Focus is set from displayed and announced books only, never from partials.
  It is never cleared on `verse:clear`: the sermon usually stays in that book.
