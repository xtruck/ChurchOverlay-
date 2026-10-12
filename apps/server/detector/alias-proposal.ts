import { CATALOG_IDS, FRENCH_BOOK_ALIASES, PHONETIC_BOOK_ALIASES, normalizeBookName, stripAccents } from "./regex-detector"

/**
 * Operator-approved correction memory, part 1: from ONE real correction (a near-miss
 * the operator then fixed by typing the verse) propose which word the ASR mis-heard
 * as the book name. Pure and deterministic (no APIs, cache, filesystem or WebSocket,
 * AGENTS.md section 12); the proposal is only ever OFFERED to the operator, never
 * applied by itself. Mirrors tools/alias_miner.py, which does the same offline over
 * whole logs.
 *
 *   heard "dans nombre un, le verset 2," + operator typed Numbers 1:2
 *   -> propose  nombre -> numbers
 */

export type AliasProposal = { readonly word: string; readonly book: string }

/** A learned word is one accent-free lower-case word of 3-24 letters: no digits, spaces or punctuation. */
export const LEARNED_WORD_PATTERN = /^[a-z]{3,24}$/

const NUMBER_WORDS = new Set([
  "un", "une", "deux", "trois", "quatre", "cinq", "six", "sept", "huit", "neuf", "dix", "onze", "douze",
  "treize", "quatorze", "quinze", "seize", "vingt", "trente", "quarante", "cinquante", "soixante", "cent",
  "one", "two", "three", "four", "five", "seven", "eight", "nine", "ten", "eleven", "twelve",
  "premier", "premiere", "deuxieme", "troisieme",
])
const STOP_WORDS = new Set([
  "dans", "avec", "pour", "sont", "cette", "les", "des", "est", "que", "qui", "par", "sur", "aux", "the", "and",
  "for", "that", "this", "verset", "versets", "verse", "chapitre", "chapter", "allons", "voir", "lire", "lisons", "ouvrons",
])

const MIN_SIMILARITY = 0.55
const BEFORE_NUMBER_BONUS = 0.15

function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const current = [i]
    for (let j = 1; j <= b.length; j++) {
      current.push(Math.min((previous[j] as number) + 1, (current[j - 1] as number) + 1, (previous[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1)))
    }
    previous = current
  }
  return previous[b.length] as number
}

function similarity(a: string, b: string): number {
  return 1 - levenshtein(a, b) / Math.max(a.length, b.length, 1)
}

function wordsOf(text: string): string[] {
  return stripAccents(text).toLowerCase().replace(/['’`]/g, "").split(/[^a-z0-9]+/).filter(Boolean)
}

/** Every spelling the app already understands for `book` (its id and its French / phonetic aliases), accent-free. */
function knownNamesFor(book: string): string[] {
  const names = new Set<string>([book])
  for (const table of [FRENCH_BOOK_ALIASES, PHONETIC_BOOK_ALIASES]) {
    for (const [alias, target] of Object.entries(table)) if (target === book) names.add(stripAccents(alias).toLowerCase())
  }
  return [...names]
}

/** True when the app already resolves this word to a catalog book (an id, a French name or a known mishearing). */
export function isKnownBookWord(word: string): boolean {
  return CATALOG_IDS.has(normalizeBookName(word))
}

/** Why `word` cannot become a learned alias for `book`, or null when it can. Used for proposals AND again on approval. */
export function learnedAliasProblem(word: string, book: string): string | null {
  if (!LEARNED_WORD_PATTERN.test(word)) return "a learned word must be 3-24 plain letters"
  if (!CATALOG_IDS.has(book)) return "unknown book"
  if (NUMBER_WORDS.has(word) || STOP_WORDS.has(word)) return "too common a word"
  if (isKnownBookWord(word)) return "the app already understands this word"
  return null
}

/** The word in `nearMissText` most likely to be the mis-heard name of `book`, or null. */
export function proposeAlias(nearMissText: string, book: string): AliasProposal | null {
  if (!CATALOG_IDS.has(book)) return null
  const tokens = wordsOf(nearMissText)
  const firstNumber = tokens.findIndex((t) => /^\d+$/.test(t) || NUMBER_WORDS.has(t))
  // "1 john" is spoken "jean": compare against the book word without its volume digit.
  const bases = knownNamesFor(book).map((name) => name.replace(/^[123]\s+/, ""))
  let best: { score: number; word: string } | null = null
  tokens.forEach((token, index) => {
    if (learnedAliasProblem(token, book) !== null) return
    let score = Math.max(...bases.map((base) => similarity(token, base)))
    if (firstNumber > 0 && index === firstNumber - 1) score += BEFORE_NUMBER_BONUS
    if (score >= MIN_SIMILARITY && (best === null || score > best.score)) best = { score, word: token }
  })
  return best === null ? null : { word: (best as { word: string }).word, book }
}
