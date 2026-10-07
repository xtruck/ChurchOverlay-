import { BOOK_CATALOG } from "../verse/book-catalog"
import { FRENCH_BOOK_ALIASES } from "../detector/regex-detector"

/**
 * Vocabulary boosted in streaming ASR (Deepgram `keywords` / `keyterm`).
 *
 * Only words that are (a) essential to verse detection and (b) observed or
 * known to be misheard: the rarer book names, and the two structural words
 * every spoken reference hangs on. Common names (Jean, Marc, John, Mark)
 * are deliberately left out — boosting frequent words makes the model
 * insert them where they were never said, which is exactly the kind of
 * false detection the hallucination guard exists to prevent.
 *
 * Kept short on purpose: every term is a URL query parameter, and a long
 * boost list degrades general accuracy.
 */
const FRENCH_TERMS: readonly string[] = [
  "chapitre",
  "verset",
  "Psaume",
  "Lévitique",
  "Deutéronome",
  "Ecclésiaste",
  "Lamentations",
  "Abdias",
  "Habacuc",
  "Sophonie",
  "Aggée",
  "Malachie",
  "Philippiens",
  "Éphésiens",
  "Colossiens",
  "Thessaloniciens",
  "Galates",
  "Corinthiens",
  "Hébreux",
  "Apocalypse",
]

const ENGLISH_TERMS: readonly string[] = [
  "chapter",
  "verse",
  "Psalm",
  "Leviticus",
  "Deuteronomy",
  "Ecclesiastes",
  "Lamentations",
  "Obadiah",
  "Habakkuk",
  "Zephaniah",
  "Haggai",
  "Malachi",
  "Philippians",
  "Ephesians",
  "Colossians",
  "Thessalonians",
  "Galatians",
  "Corinthians",
  "Hebrews",
  "Revelation",
]

/** fr → French terms, en → English terms, anything else (bilingual/unknown) → both. */
export function biblicalVocabularyFor(language: string | undefined): readonly string[] {
  if (language === "fr") return FRENCH_TERMS
  if (language === "en") return ENGLISH_TERMS
  return [...FRENCH_TERMS, ...ENGLISH_TERMS]
}

/**
 * ARCHITECTURE.md section 104: display names for a preacher's PLANNED
 * passages (loaded via a Service Rundown), used to bias ASR toward exactly
 * the books named in this service's own plan. Unlike the module-level lists
 * above, this is not a permanent boost — it changes per rundown:load and
 * covers common book names too, because a rundown entry is an explicit,
 * operator-confirmed signal ("this service will reference John"), not a
 * blind global guess. FRENCH_BOOK_ALIASES' keys are accent-stripped
 * lowercase; capitalize() below restores a readable display form (accents
 * are not restored — a bias hint does not need them, and BOOK_CATALOG has
 * no accented French names to draw from).
 */
const FRENCH_NAME_BY_ID: ReadonlyMap<string, string> = (() => {
  const byId = new Map<string, string>()
  for (const [alias, id] of Object.entries(FRENCH_BOOK_ALIASES)) {
    if (!byId.has(id)) byId.set(id, capitalize(alias))
  }
  return byId
})()

const ENGLISH_NAME_BY_ID: ReadonlyMap<string, string> = new Map(BOOK_CATALOG.map((book) => [book.id, book.name]))

function capitalize(text: string): string {
  return text.replace(/\b\p{L}/gu, (letter) => letter.toUpperCase())
}

/** Bilingual/auto mode: French AND English display name of each book. */
export function plannedBookTermsBilingual(bookIds: readonly string[]): readonly string[] {
  // Both display names per book ("Jean, John"), deduplicated: a bilingual preacher may say either.
  const seen = new Set<string>()
  const terms: string[] = []
  for (const id of bookIds) {
    for (const name of [FRENCH_NAME_BY_ID.get(id), ENGLISH_NAME_BY_ID.get(id)]) {
      if (!name || seen.has(name)) continue
      seen.add(name)
      terms.push(name)
    }
  }
  return terms
}

/**
 * Display names (deduplicated, order preserved) for a set of canonical book
 * ids, in the given language — French where available, English name as the
 * fallback (BOOK_CATALOG covers every id). Used only for a rundown's own
 * planned books, never for global vocabulary boosting.
 */
export function plannedBookTerms(bookIds: readonly string[], language: string | undefined): readonly string[] {
  // Code-switching: the preacher may name a book in either language.
  if (language === "multi") return plannedBookTermsBilingual(bookIds)
  const byId = language === "en" ? ENGLISH_NAME_BY_ID : FRENCH_NAME_BY_ID
  const seen = new Set<string>()
  const terms: string[] = []
  for (const id of bookIds) {
    const name = byId.get(id) ?? ENGLISH_NAME_BY_ID.get(id)
    if (!name || seen.has(name)) continue
    seen.add(name)
    terms.push(name)
  }
  return terms
}
