import type { MediaCue } from "../../../packages/contracts"
import { MediaLibrary, normalizeTitle } from "./media-library"

/**
 * ARCHITECTURE.md section 60.3: voice-triggered media, by exact
 * (case-insensitive, whitespace-normalized) title match only — no
 * stemming, no fuzzy distance, no semantic matching. A sibling to
 * RegexDetector, not a replacement or an extension of it: this detects
 * media-cue names, never Bible references.
 *
 * Unlike VerseDetector, this is not a pure function of text alone — it
 * needs the *current* set of imported titles, which changes as the
 * operator imports media. That's an unavoidable difference in kind from
 * RegexDetector's fixed syntactic pattern, not the same "needs state"
 * problem NavigationCommandDetector was kept separate from VerseDetector
 * over (packages/contracts/verse.ts) — a currently-imported title list is
 * a live reference dataset, not a mutable "current position."
 */
export class MediaCueDetector {
  constructor(private readonly library: MediaLibrary) {}

  detect(text: string): MediaCue[] {
    const normalizedText = normalizeTitle(text)
    const matches: MediaCue[] = []
    for (const cue of this.library.list()) {
      if (normalizedText.includes(normalizeTitle(cue.title))) {
        matches.push(cue)
      }
    }
    return matches
  }
}
