import { readFile } from "node:fs/promises"
import { join } from "node:path"
import type { Verse, VerseReference, VerseSource } from "../../../packages/contracts"
import { OFFLINE_BIBLE_BOOK_KEYS } from "./offline-bible-book-keys"

// This module compiles to dist/apps/server/verse/offline-verse-source.js,
// but the data file itself is NOT copied into dist by tsc (it's read at
// runtime via readFile, never a TypeScript `import`, deliberately — see
// loadOfflineBibleData's own comment on why not). It stays in its
// original source location and is referenced relative to it, the exact
// same "static asset shipped from source, not dist" pattern
// apps/overlay/public and apps/desktop/renderer already use (see
// electron-builder's own `files` list in package.json, which this file's
// directory is added to alongside them) — 4 levels up from this
// compiled module's own dist location reaches the repo root, matching
// REPO_ROOT's identical math in apps/desktop/main/index.ts.
const DEFAULT_DATA_PATH = join(__dirname, "..", "..", "..", "..", "apps", "server", "verse", "data", "fra_lsg.json")

/**
 * The parsed shape of `data/fra_lsg.json`: book key -> chapter number
 * (as a string) -> verse number (as a string) -> verse text. Loaded once
 * at startup (see loadOfflineBibleData below) and handed in already
 * parsed, rather than this class touching the filesystem itself — keeps
 * it trivially testable with a small in-memory fixture instead of the
 * real 4.5MB bundled file.
 */
export type OfflineBibleData = Readonly<Record<string, Readonly<Record<string, Readonly<Record<string, string>>>>>>

const TRANSLATION = "ls1910"

/**
 * ARCHITECTURE.md section 77: a bundled, always-available French Bible
 * (Louis Segond 1910 — the same public-domain translation
 * GetBibleVerseSource fetches live, per BOOK_CATALOG's own precedent for
 * bundling public-domain text directly) — not a replacement for the live
 * API, a fallback for when it's unreachable. Never makes a network call,
 * so it can never itself be the thing that fails.
 *
 * Returns null (the standard VerseSource "confirmed not found" contract,
 * ARCHITECTURE.md section 16) for a book this dataset doesn't recognize
 * or a chapter/verse it doesn't contain — this should be rare in
 * practice, since KnownValidVerseIndex has already validated the
 * reference against the same 66-book/chapter/verse-count catalog before
 * anything reaches a VerseSource at all.
 */
export class OfflineVerseSource implements VerseSource {
  constructor(private readonly data: OfflineBibleData) {}

  async getVerse(reference: VerseReference): Promise<Verse | null> {
    const bookKey = OFFLINE_BIBLE_BOOK_KEYS[reference.book]
    if (!bookKey) return null

    const text = this.data[bookKey]?.[String(reference.chapter)]?.[String(reference.verse)]
    if (!text) return null

    return {
      reference,
      text,
      translation: TRANSLATION,
      // Distinct from GetBibleVerseSource's "getbible.net" (ARCHITECTURE.md
      // section 77) — same translation identity for cache-key purposes,
      // different provenance for diagnostics (a session export or log
      // showing "offline-bundled" tells you the live API was unreachable
      // for that verse, without it ever being visibly different on the
      // overlay itself).
      source: "offline-bundled",
    }
  }
}

/**
 * Reads and parses the bundled dataset once at startup — mirrors
 * MediaLibrary.load()/ConfigStore.load()'s own "explicit async load
 * step, called once before the class is used" pattern, rather than
 * OfflineVerseSource touching the filesystem itself on every lookup (or
 * in its constructor, which can't be async). A malformed or missing
 * bundle is a real packaging failure worth surfacing loudly (unlike
 * MediaLibrary's tolerant "missing metadata is fine, it's just empty" —
 * there is no legitimate reason for this file to ever be absent from a
 * real build), so this deliberately does not swallow either error.
 *
 * filePath defaults to the bundled file next to this module's own
 * compiled location (dist/apps/server/verse/data/fra_lsg.json) — callers
 * don't need to know or reconstruct that path themselves; the override
 * exists purely for tests that want to point at a small fixture instead
 * of the real ~4.5MB dataset.
 */
export async function loadOfflineBibleData(filePath: string = DEFAULT_DATA_PATH): Promise<OfflineBibleData> {
  const raw = await readFile(filePath, "utf8")
  return JSON.parse(raw) as OfflineBibleData
}
