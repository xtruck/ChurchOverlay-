import { stripAccents } from "../detector/regex-detector"
import { GLOSSARY, type GlossaryEntry } from "./glossary"

export type Definition = {
  readonly term: string
  readonly definition: string
}

function normalize(text: string): string {
  return stripAccents(text.trim().replace(/\s+/g, " ").toLowerCase())
}

/**
 * ARCHITECTURE.md section 65.5: on-demand word/term definition lookup by
 * voice ("define grace", "definis la grace"). A sibling to
 * MediaCueDetector, not RegexDetector — matches a fixed trigger phrase by
 * exact substring, no stemming, no fuzzy distance, no semantic matching,
 * the same deterministic philosophy every other detector in this codebase
 * uses. Unlike MediaCueDetector, the glossary is a fixed bundled dataset
 * (GLOSSARY), not a live, operator-mutable one — closer in kind to
 * NavigationCommandDetector's fixed synonym lists.
 *
 * A transcript can only ever surface ONE definition at a time (unlike
 * MediaCueDetector, which can match several cues in one sentence) — a
 * spoken "define X" is a single, deliberate request, and returning the
 * first match keeps the behavior simple and predictable rather than
 * flashing multiple definitions from one utterance.
 */
export class GlossaryDetector {
  detect(text: string): Definition | null {
    const normalized = normalize(text)
    for (const entry of GLOSSARY) {
      if (entry.phrases.some((phrase) => normalized.includes(phrase))) {
        return { term: entry.term, definition: entry.definition }
      }
    }
    return null
  }
}

export type { GlossaryEntry }
