# Fixes: config tolerance (B6), orphaned verse source (B5), service lifecycle (TS-07)

## B6 - apps/desktop/main/config-store.ts
- Per-field tolerance: every optional/enum field that is invalid or unknown (rollback, downgrade) falls back to its default (or stays absent) with a `config.field-invalid` warning (field name only, never the value). Only the three required encrypted fields being non-strings, or undecryptable tokens, still make a file "bad".
- One undecryptable secret (groq/deepgram/anthropic): the others and the rest of the config load; the name is reported via `getRecovery()` as `key-unreadable:<name>`. The raw encrypted blob is kept and re-written by later saves until the operator supplies a new value (a transient keyring failure never becomes permanent key loss). Names only are logged.
- `schemaVersion` (CONFIG_SCHEMA_VERSION = 1) is always written; absent = 0. A newer version loads tolerantly; on the first rewrite the original is copied once to `config.json.schema-v<N>.bak`, unknown fields are carried through, and the version is not lowered.
- Unparseable/structurally bad main file: moved to `config.json.corrupt-<ts>` (kept), then `config.json.bak` is tried; if usable it is restored to `config.json` (recovery `bak`), otherwise `quarantined` and load() throws as before.
- load() now runs on the same queue as save()/update() (no double quarantine / racing loads).
- Operator notice: `get-startup-status` returns `configRecovered: string[]` (`bak`, `quarantined`, `key-unreadable:<name>`); banner in index.html + `renderConfigRecovery` in dashboard.js, EN+FR keys `config.recovered.*`.
- Existing "load() throws on invalid X" tests were deliberately replaced by one table-driven tolerance test (that behaviour is what B6 changes); the invalid-JSON, missing-required-fields and quarantine tests are unchanged.

## B5 - orphaned verse source
- `LocalizedVerseSource.setEnglishSource(source, sourceId)` changes English in place (twin of setFrenchSource). `getTranslationId()` includes the English source id when a custom endpoint is set (english mode and bilingual), so verses cached from the old endpoint are not served from the new one; default stays plain `english`.
- `set-custom-bible-api-url` no longer creates a new LocalizedVerseSource (and no longer rebuilds the French source).
- `activeConfig.displayMode` is kept current in `set-display-mode` and `onDisplayModeChanged`.
- Reviewed other replacements of instances AppCore holds: `set-french-translation` already uses setFrenchSource (in place); AI completer / ASR plan are only built inside startServices (new AppCore). No other instance of this bug class found.

## TS-07 - service lifecycle
- New `apps/desktop/main/serial-queue.ts` (+ test). `startServices()`/`shutdown()` are now queue wrappers over `startServicesNow()`/`shutdownNow()`; the internal teardown inside startServicesNow calls `shutdownNow()` (no self-wait).
- The overlay-style flush at the start of shutdownNow is try/catch (logged `shutdown.overlay-style-flush-failed`); the core, NDI, whisper and servers are always stopped.

## Tests
- config-store.test.ts: tolerance table (25 cases), unreadable secret(s), blob preservation, schemaVersion (always written / absent / newer), bak restore, both-bad quarantine, concurrent loads.
- localized-verse-source.test.ts: setEnglishSource in place + cache identity. serial-queue.test.ts.

## Unverified
- Not run inside Electron (safeStorage real decrypt failure, banner rendering in the window).
- No AppCore-level integration test of "display-mode switch after URL change" (the wiring is in main/index.ts, which needs Electron); covered at the LocalizedVerseSource level via the held-instance test.
- Full `npm test` not run by instruction; i18n.test.js currently fails only on other agents' not-yet-added keys (session.openLogsButton, log.micTrackEnded, ...).
