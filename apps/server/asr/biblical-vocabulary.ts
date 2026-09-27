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
