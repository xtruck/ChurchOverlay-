/**
 * TÂCHE B: Transcription Corrector - Post-ASR lexical correction module.
 *
 * Corrects known phonetic confusions between English/French tokens
 * that Whisper frequently produces for French biblical speech.
 *
 * Real production observations:
 * - "verset" → "w.c.", "wc", "vc", "v.c.", "verser"
 * - "psaume" → "some", "sam"
 * - "chapitre" → "shapitre", "chapitres"
 * - "suivant" → "souvent"
 * - "précédent" → "precedent", "precedent"
 *
 * Approach: Fixed phonetic mapping table (no ML), conservative application.
 * Only corrects when the token is NOT a valid book name or command word
 * in its original form (to avoid false corrections on already-correct text).
 */
import { BOOK_CATALOG } from "../verse/book-catalog"
import { FRENCH_BOOK_ALIASES } from "../detector/regex-detector"

type CorrectionMap = Readonly<Record<string, string>>

// Phonetic confusion map: WRONG → CORRECT
// Each entry documents the real-world observation justifying the correction.
const PHONETIC_CORRECTIONS: CorrectionMap = {
  // "verset" confusions (most frequent - 6/34 transcripts in production)
  "w.c.": "verset",
  "wc": "verset",
  "v.c.": "verset",
  "vc": "verset",
  "v c": "verset",
  "v.c": "verset",
  "verser": "verset",     // FR/FR confusion: verset → verser (to pour)
  "versets": "verset",    // plural → singular
  "versé": "verset",      // accent confusion
  "versée": "verset",     // feminine form confusion
  "vèrset": "verset",     // accent variation
  "versait": "verset",    // verb form confusion
  "versais": "verset",    // verb form confusion
  "verso": "verset",      // observed French ASR confusion in live use
  "versus": "verset",     // observed English/French phonetic confusion
  "vaissez": "verset",    // observed clipped "verset" output
  "vassier": "verset",    // observed clipped "verset" output
  "vete": "verset",       // observed clipped "verset" output
  "verset.": "verset",    // with punctuation
  "vestu": "verset",      // observed live (2026-09): "verset suivant" heard as "vestu suivant"
  "versic": "verset",     // observed live (2026-09-23): "verset" heard as "versic"

  // "psaume" confusions
  "some": "psaume",
  "som": "psaume",        // observed live (2026-09): "some" clipped further to "som"
  "somme": "psaume",      // observed live (2026-09-23): "some" heard with a French double-m ending
  "sam": "psaume",
  "saum": "psaume",
  "psalme": "psaume",     // missing 'u'
  "psaumes": "psaume",    // plural → singular
  "psalmes": "psaume",    // plural + missing 'u'

  // "chapitre" confusions
  "shapitre": "chapitre",
  "chapitres": "chapitre", // plural → singular
  "chapitr": "chapitre",   // truncated
  "chapitre.": "chapitre", // with punctuation
  "capitre": "chapitre",   // missing 'h' (common FR/EN confusion)
  "chapit": "chapitre",    // truncated
  "chapitres.": "chapitre", // plural + punctuation

  // Navigation command confusions
  // NOTE: "souvent" -> "suivant" is intentionally NOT a blanket mapping:
  // "souvent" ("often") is a common valid French word. It is corrected
  // contextually in correctTranscription() — only when immediately followed
  // by a chapter/verse number (digit or spoken number word), which is the
  // only context where Whisper's "souvent" is actually a misheard "suivant".
  "suivante": "suivante",  // feminine form - already correct form, kept for reference
  "suivants": "suivants",  // plural - already correct form, kept for reference
  "precedent": "précédent", // missing accent
  "precedente": "précédente",
  "precedents": "précédents", // plural

  // "annuler" confusions
  "annule": "annuler",
  "anule": "annuler",      // single 'n'
  "annulée": "annulée",
  "anulée": "annulée",
  "cancel": "annuler",     // English leakage
  "canceller": "annuler",  // double 'l' English form

  // "annuler" / "effacer" confusions
  "efface": "effacer",
  "efacer": "effacer",     // single 'f'
  "effacée": "effacée",
  "efacée": "effacée",
  "clear": "effacer",      // English leakage

  // "verset" Portuguese/Spanish leakage
  "versiculos": "verset",   // Portuguese leakage
  "versiculo": "verset",    // Portuguese/Spanish singular
  "versiculo.": "verset",   // with punctuation

  // "chapitre" Portuguese/Spanish leakage
  "capitulo": "chapitre",   // Portuguese/Spanish leakage
  "capítulo": "chapitre",   // with accent
  "capitulos": "chapitre",  // plural

  // "psaume" Portuguese/Spanish leakage
  "salmo": "psaume",        // Spanish/Portuguese
  "salmos": "psaume",       // plural

  // Book name common phonetic confusions
  "jean": "jean",           // already correct but ensure protected
  "jaum": "jean",           // observed phonetic output for "Jean"
  "jãum": "jean",           // observed accented phonetic output for "Jean"
  "jãun": "jean",           // observed accented phonetic output for "Jean"
  "jhon": "jean",           // common misspelling
  "paul": "paul",           // already correct
  "pierre": "pierre",       // already correct
  "matthieu": "matthieu",   // already correct
  "mathieu": "matthieu",    // common variant
  "matieu": "matthieu",     // truncated
  "luc": "luc",             // already correct
  "lucas": "luc",           // Spanish/Portuguese form
  "marc": "marc",           // already correct
  // "marque": "marc" removed — "marque" (brand/mark) is a valid French
  // word; correcting it corrupted correct sentences.
  "luc.": "luc",            // with punctuation
  "ezaiie": "esaie",        // observed phonetic output for "Ésaïe"
  "ézaiie": "esaie",        // observed accented phonetic output for "Ésaïe"
  "ezaïkat": "esaie",       // observed phonetic output for "Ésaïe"
  "ézaïkat": "esaie",      // observed accented phonetic output for "Ésaïe"
  "azzain": "esaie",       // observed phonetic output for "Ésaïe"
  "kaple": "chapitre",     // observed phonetic output for "chapitre"

  // Number word confusions (French spoken numbers)
  "trois": "3",
  "quatre": "4",
  "cinq": "5",
  "six": "6",
  "sept": "7",
  "huit": "8",
  "neuf": "9",
  "dix": "10",
  "onze": "11",
  "douze": "12",
  "treize": "13",
  "quatorze": "14",
  "quinze": "15",
  "seize": "16",
  "dix-sept": "17",
  "dix-huit": "18",
  "dix-neuf": "19",
  "vingt": "20",
  "vingt-et-un": "21",
  "vingt-deux": "22",
  "vingt-trois": "23",
  "vingt-quatre": "24",
  "vingt-cinq": "25",
  "vingt-six": "26",
  "vingt-sept": "27",
  "vingt-huit": "28",
  "vingt-neuf": "29",
  "trente": "30",
  "trente-et-un": "31",
  "trente-deux": "32",
  "trente-trois": "33",
  "trente-quatre": "34",
  "trente-cinq": "35",
  "trente-six": "36",
  "trente-sept": "37",
  "trente-huit": "38",
  "trente-neuf": "39",
  "quarante": "40",
  "quarante-et-un": "41",
  "quarante-deux": "42",
  "quarante-trois": "43",
  "quarante-quatre": "44",
  "quarante-cinq": "45",
  "quarante-six": "46",
  "quarante-sept": "47",
  "quarante-huit": "48",
  "quarante-neuf": "49",
  "cinquante": "50",
  "cinquante-et-un": "51",
  "cinquante-deux": "52",
  "cinquante-trois": "53",
  "cinquante-quatre": "54",
  "cinquante-cinq": "55",
  "cinquante-six": "56",
  "cinquante-sept": "57",
  "cinquante-huit": "58",
  "cinquante-neuf": "59",
  "soixante": "60",
  "soixante-et-un": "61",
  "soixante-deux": "62",
  "soixante-trois": "63",
  "soixante-quatre": "64",
  "soixante-cinq": "65",
  "soixante-six": "66",
  "soixante-sept": "67",
  "soixante-huit": "68",
  "soixante-neuf": "69",
  "soixante-dix": "70",
  "soixante-et-onze": "71",
  "soixante-douze": "72",
  "soixante-treize": "73",
  "soixante-quatorze": "74",
  "soixante-quinze": "75",
  "soixante-seize": "76",
  "soixante-dix-sept": "77",
  "soixante-dix-huit": "78",
  "soixante-dix-neuf": "79",
  "quatre-vingts": "80",
  "quatre-vingt": "80",
  "quatre-vingt-un": "81",
  "quatre-vingt-deux": "82",
  "quatre-vingt-trois": "83",
  "quatre-vingt-quatre": "84",
  "quatre-vingt-cinq": "85",
  "quatre-vingt-six": "86",
  "quatre-vingt-sept": "87",
  "quatre-vingt-huit": "88",
  "quatre-vingt-neuf": "89",
  "quatre-vingt-dix": "90",
  "quatre-vingt-onze": "91",
  "quatre-vingt-douze": "92",
  "quatre-vingt-treize": "93",
  "quatre-vingt-quatorze": "94",
  "quatre-vingt-quinze": "95",
  "quatre-vingt-seize": "96",
  "quatre-vingt-dix-sept": "97",
  "quatre-vingt-dix-huit": "98",
  "quatre-vingt-dix-neuf": "99",
  "cent": "100",

  // Common French prepositions/articles that might be confused
  "à": "a",                 // accent confusion
  "â": "a",
  "où": "ou",               // accent confusion
  // "et": "et" and "est": "et" were removed — "est" (is) and "et" (and)
  // are both valid French words and blanket-correcting "est"→"et"
  // corrupted correct sentences (real wrong-spelling bug).

  // "évangile" confusions
  "evangile": "évangile",   // missing accent
  "evangiles": "évangiles", // plural

  // "prophète" confusions
  "prophete": "prophète",   // missing accent
  "prophetes": "prophètes", // plural

  // "apôtre" confusions
  "apotre": "apôtre",       // missing accent
  "apotres": "apôtres",     // plural

  // "père" confusions
  "pere": "père",           // missing accent
  "peres": "pères",         // plural

  // "frère" confusions
  "frere": "frère",         // missing accent
  "freres": "frères",       // plural
}

// Multi-word phonetic corrections: a fixed, curated list of two-word
// phrases Whisper produces for a single mis-heard book name. Kept
// deliberately separate from PHONETIC_CORRECTIONS (which corrects exactly
// one token at a time, matching RegexDetector's book-name group, which can
// only ever capture a single word — see its own doc comment on the "Read
// John" greedy-match regression). A two-word mis-hearing has to be
// collapsed to one word BEFORE detection ever runs, not handled as a
// multi-word book alias — this is a narrow, explicit exception, not a
// general multi-word-name mechanism.
const MULTI_WORD_PHONETIC_CORRECTIONS: ReadonlyArray<{ readonly pattern: RegExp; readonly replacement: string }> = [
  // Observed live (2026-09-23), same test-reading session that surfaced
  // "Abacuc"/"Abaku": "Habakkuk" heard as two separate words, "Abba Kouk".
  { pattern: /\babba\s+kouk\b/gi, replacement: "Abacuc" },
  // Observed live (2026-09-23), a later session: the same "Habakkuk as two
  // words" confusion with a different second syllable, "Abba Bouk".
  { pattern: /\babba\s+bouk\b/gi, replacement: "Abacuc" },
]

// CORRECTIF (observed live, 2026-09-23): Whisper sometimes glues a known
// abbreviation directly to the following digit with no space at all
// ("vc2", "wc4" instead of "vc 2"/"wc 4") — a distinct failure mode from
// the trailing-punctuation case below (a MISSING separator, not an extra
// one), so the exact-token lookup and its punctuation-stripping fallback
// both miss it outright. A dedicated pre-pass, same reasoning as the
// multi-word corrections above: this has to happen before tokenizing,
// since "vc2" is one token, not two, until this splits it.
const GLUED_ABBREVIATION_DIGIT_PATTERN = /\b(v\.?c\.?|w\.?c\.?)(\d{1,3})\b/gi

function applyGluedAbbreviationCorrections(text: string): { text: string; corrections: CorrectionResult["corrections"] } {
  const corrections: CorrectionResult["corrections"] = []
  const result = text.replace(GLUED_ABBREVIATION_DIGIT_PATTERN, (match, _abbrev: string, digits: string, offset: number) => {
    const replacement = `verset ${digits}`
    corrections.push({ original: match, corrected: replacement, index: offset })
    return replacement
  })
  return { text: result, corrections }
}

function applyMultiWordCorrections(text: string): { text: string; corrections: CorrectionResult["corrections"] } {
  const corrections: CorrectionResult["corrections"] = []
  let result = text
  for (const { pattern, replacement } of MULTI_WORD_PHONETIC_CORRECTIONS) {
    result = result.replace(pattern, (match, offset: number) => {
      corrections.push({ original: match, corrected: replacement, index: offset })
      return replacement
    })
  }
  return { text: result, corrections }
}

// Words that should NEVER be corrected because they are valid as-is
// (book names, command words, etc.)
function buildProtectedWords(): ReadonlySet<string> {
  const protectedWords = new Set<string>()

  // All book names (canonical + aliases)
  for (const book of BOOK_CATALOG) {
    protectedWords.add(book.id)
  }
  for (const alias of Object.keys(FRENCH_BOOK_ALIASES)) {
    protectedWords.add(alias)
  }

  // Command words (French + English)
  const commands = [
    "chapitre", "verset", "suivant", "précédent", "annuler",
    "chapter", "verse", "next", "previous", "cancel",
    "effacer", "efface", "clear"
  ]
  for (const cmd of commands) {
    protectedWords.add(cmd)
  }

  // Common French words that might look like corrections but are valid
  const commonFrench = [
    "et", "ou", "mais", "donc", "or", "ni", "car",
    "le", "la", "les", "un", "une", "des", "de", "du",
    "à", "au", "aux", "en", "dans", "sur", "pour", "par",
    "avec", "sans", "sous", "sur", "vers", "chez",
    "je", "tu", "il", "elle", "nous", "vous", "ils", "elles",
    "ce", "cet", "cette", "ces", "mon", "ton", "son", "ma", "ta", "sa",
    "notre", "votre", "leur", "mes", "tes", "ses", "nos", "vos", "leurs"
  ]
  for (const word of commonFrench) {
    protectedWords.add(word)
  }

  return protectedWords
}

const PROTECTED_WORDS = buildProtectedWords()

export interface CorrectionResult {
  readonly originalText: string
  readonly correctedText: string
  readonly corrections: Array<{
    readonly original: string
    readonly corrected: string
    readonly index: number
  }>
}

/**
 * Applies phonetic corrections to transcribed text.
 * Conservative: only corrects tokens that are NOT protected words.
 * Returns both corrected text and audit trail of corrections.
 */
export function correctTranscription(text: string): CorrectionResult {
  if (!text || text.trim().length === 0) {
    return { originalText: text, correctedText: text, corrections: [] }
  }

  const multiWord = applyMultiWordCorrections(text)
  const gluedAbbreviation = applyGluedAbbreviationCorrections(multiWord.text)
  const words = gluedAbbreviation.text.split(/(\s+)/) // Keep whitespace as separate tokens
  const corrections: CorrectionResult["corrections"] = [...multiWord.corrections, ...gluedAbbreviation.corrections]

  for (let i = 0; i < words.length; i++) {
    const token = words[i]
    if (!token || /^\s+$/.test(token)) continue // skip pure whitespace

    const lowerToken = token.toLowerCase()

    // Skip if token is a protected word (valid as-is)
    if (PROTECTED_WORDS.has(lowerToken)) continue

    // Contextual correction: "souvent" is only a misheard "suivant" when
    // a chapter/verse number follows immediately. Otherwise it is the
    // valid French word "often" and must be left untouched.
    let effectiveToken = lowerToken
    if (lowerToken === "souvent") {
      const nextLower = nextNonWhitespaceLower(words, i)
      const nextResolved = PHONETIC_CORRECTIONS[nextLower] ?? nextLower
      if (/^\d+([:-]\d+)?$/.test(nextResolved)) {
        effectiveToken = "souvent"
      } else {
        continue
      }
    }

    // Contextual correction (observed live, 2026-09-23): "passé"/"passe"
    // is only a misheard "verset" when immediately followed by "suivant"
    // or "precedent" ("Le passé suivant" instead of "Le verset suivant").
    // "passé" ("past") is otherwise a common, meaningful French word —
    // corrected only in this specific two-word navigation context, the
    // same gating "souvent" above already uses for the same reason.
    if (lowerToken === "passé" || lowerToken === "passe") {
      const nextLower = nextNonWhitespaceLower(words, i).replace(/[,.;:!?]+$/, "")
      const nextResolved = PHONETIC_CORRECTIONS[nextLower] ?? nextLower
      if (nextResolved === "suivant" || nextResolved === "précédent" || nextResolved === "precedent") {
        effectiveToken = "passe-nav-context"
      } else {
        continue
      }
    }

    // Contextual correction (observed live, 2026-09-23, twice in one
    // session): "web" is only a misheard "verset" when immediately
    // followed by a number ("au web 1" instead of "au verset 1") — "web"
    // is an ordinary loanword (site web, web design) that must never be
    // touched otherwise. Same gating shape as "souvent" above.
    if (lowerToken === "web") {
      const nextLower = nextNonWhitespaceLower(words, i)
      const nextResolved = PHONETIC_CORRECTIONS[nextLower] ?? nextLower
      if (/^\d+([:-]\d+)?$/.test(nextResolved)) {
        effectiveToken = "web-nav-context"
      } else {
        continue
      }
    }

    // Contextual correction (observed live, 2026-09-23): "bacille"
    // ("bacillus/germ") is only a misheard "verset" when immediately
    // followed by "suivant" — "le bacille suivant" is not a sentence
    // French ever produces otherwise, the same reasoning "passé suivant"
    // above already uses.
    if (lowerToken === "bacille") {
      const nextLower = nextNonWhitespaceLower(words, i).replace(/[,.;:!?]+$/, "")
      const nextResolved = PHONETIC_CORRECTIONS[nextLower] ?? nextLower
      if (nextResolved === "suivant" || nextResolved === "précédent" || nextResolved === "precedent") {
        effectiveToken = "bacille-nav-context"
      } else {
        continue
      }
    }

    // Trailing-punctuation-tolerant fallback: real ASR output attaches
    // sentence punctuation directly to a word ("v.c.," "verset?"), which
    // would otherwise defeat an exact-token lookup even though the
    // underlying confusion is one this table already knows. Only tried
    // when the exact token doesn't already match — every existing
    // punctuation-inclusive key ("verset.", "v.c.", etc.) still matches
    // exactly first, unchanged. Strips exactly ONE trailing punctuation
    // mark, not a greedy run: a multi-character key like "v.c." already
    // ends in its own period, and greedily stripping every trailing
    // punctuation character would eat into that period too (turning
    // "v.c.," into core "v.c" instead of the intended "v.c."). One
    // stripped mark is also all a real sentence ever attaches. Only
    // trailing (never leading) punctuation is stripped: nothing in this
    // table is ever prefixed.
    let trailingPunct = ""
    const isContextSentinel =
      effectiveToken === "souvent" ||
      effectiveToken === "passe-nav-context" ||
      effectiveToken === "web-nav-context" ||
      effectiveToken === "bacille-nav-context"
    if (!isContextSentinel && !(effectiveToken in PHONETIC_CORRECTIONS)) {
      const stripped = effectiveToken.match(/^(.+)([,.;:!?])$/)
      const core = stripped?.[1]
      const punct = stripped?.[2]
      if (core && punct && !PROTECTED_WORDS.has(core) && core in PHONETIC_CORRECTIONS) {
        effectiveToken = core
        trailingPunct = punct
      }
    }

// Check for correction
    const corrected =
      effectiveToken === "souvent" ? "suivant" :
      effectiveToken === "passe-nav-context" ? "verset" :
      effectiveToken === "web-nav-context" ? "verset" :
      effectiveToken === "bacille-nav-context" ? "verset" :
      PHONETIC_CORRECTIONS[effectiveToken]
    if (corrected && corrected !== effectiveToken) {
      // Use local const with explicit type to satisfy TypeScript control flow
      const corr: string = corrected
      let correctedToken: string
      if (token === token.toUpperCase()) {
        correctedToken = corr.toUpperCase()
      } else {
        const first = token.charAt(0)
        const isCapitalized = first !== "" && first === first.toUpperCase() && token.slice(1) === token.slice(1).toLowerCase()
        if (isCapitalized) {
          correctedToken = corr.charAt(0).toUpperCase() + corr.slice(1)
        } else {
          correctedToken = corr
        }
      }
      correctedToken += trailingPunct

      corrections.push({
        original: token,
        corrected: correctedToken,
        index: i
      })
      words[i] = correctedToken
    }
  }

  return {
    originalText: text,
    correctedText: words.join(""),
    corrections
  }
}

/**
 * Checks if a text contains any phonetic corrections that would be applied.
 * Useful for logging/metrics without applying corrections.
 */
export function hasPhoneticCorrections(text: string): boolean {
  const words = text.toLowerCase().split(/\s+/)
  for (const word of words) {
    if (PHONETIC_CORRECTIONS[word] && !PROTECTED_WORDS.has(word)) {
      return true
    }
  }
  return false
}

export type HallucinationCheck =
  | { readonly isHallucination: false }
  | { readonly isHallucination: true; readonly reason: "boilerplate" | "degenerate-repetition" }

// A well-documented, industry-wide Whisper failure mode, distinct from the
// phonetic mis-hearings PHONETIC_CORRECTIONS above fixes: on silence or
// non-speech audio, Whisper (all sizes, including large-v3) frequently
// hallucinates fixed boilerplate lifted from its training data — almost
// always YouTube-subtitle credits/outros, since that's the dominant source
// of "silence + captions" pairs it was trained on. Deliberately an EXACT,
// curated list rather than a broad heuristic: these specific phrases are
// near-universally reported across independent Whisper deployments (not
// something a real spoken sermon would ever produce verbatim), so matching
// them exactly carries negligible false-positive risk, unlike a fuzzy
// "sounds like an outro" rule would. Provider-agnostic and applied to every
// ASR provider's output uniformly (wired into AppCore's shared transcript
// handler, not any one provider adapter) — Whisper-specific in origin, but
// a real spoken sentence could never legitimately match one exactly
// regardless of which provider produced it.
const KNOWN_HALLUCINATION_PHRASES = [
  // English YouTube-subtitle-outro hallucinations
  "thank you for watching",
  "thanks for watching",
  "thank you for watching!",
  "please subscribe to my channel",
  "don't forget to like and subscribe",
  "like and subscribe",
  "see you in the next video",
  "see you next time",
  // French equivalents (this app's primary audience)
  "sous-titres réalisés par la communauté d'amara.org",
  "sous-titrage st' 501",
  "sous-titrage société radio-canada",
  "merci d'avoir regardé cette vidéo",
  "merci d'avoir regardé",
  "abonnez-vous à la chaîne",
  "n'oubliez pas de vous abonner",
  "à bientôt pour une nouvelle vidéo",
]

/** Normalizes for exact-boilerplate comparison: lowercase, trim, drop trailing punctuation. */
function normalizeForBoilerplateMatch(text: string): string {
  return text.trim().toLowerCase().replace(/[.!?…]+$/u, "")
}

function looksLikeHallucinatedBoilerplate(text: string): boolean {
  return KNOWN_HALLUCINATION_PHRASES.includes(normalizeForBoilerplateMatch(text))
}

// The other well-documented Whisper failure mode on silence/noise: a
// degenerate loop repeating the same short word or phrase many times
// ("sous-titres sous-titres sous-titres...") instead of stopping. Real
// spoken repetition for emphasis ("Amen, amen, amen!") is a genuine,
// common preaching style and must never be caught by this — so the
// thresholds below are deliberately set well above anything a real speaker
// produces in one utterance chunk (a few seconds of audio at most), and
// only trigger once repetition dominates almost the entire chunk, not just
// a few words of it.
const REPETITION_MIN_RUN: Readonly<Record<1 | 2 | 3, number>> = { 1: 8, 2: 5, 3: 5 }
const REPETITION_MIN_COVERAGE = 0.75

function looksLikeDegenerateRepetition(text: string): boolean {
  const words = text.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length < 8) return false

  for (const ngramSize of [1, 2, 3] as const) {
    if (words.length < ngramSize * 2) continue
    let run = 1
    let bestRun = 1
    for (let i = ngramSize; i + ngramSize <= words.length; i += ngramSize) {
      const prev = words.slice(i - ngramSize, i).join(" ")
      const curr = words.slice(i, i + ngramSize).join(" ")
      run = prev === curr ? run + 1 : 1
      bestRun = Math.max(bestRun, run)
    }
    const coverage = (bestRun * ngramSize) / words.length
    if (bestRun >= REPETITION_MIN_RUN[ngramSize] && coverage >= REPETITION_MIN_COVERAGE) {
      return true
    }
  }
  return false
}

/**
 * The central, provider-agnostic authority for "is this text a Whisper
 * hallucination, not real speech" — distinct from correctTranscription()'s
 * job of fixing mis-heard-but-real words. Called from AppCore's shared
 * transcript handler on EVERY provider's output, so a hallucination is
 * caught the same way regardless of whether Groq, Deepgram, or a future
 * provider produced it, instead of duplicating this per provider adapter.
 */
export function detectHallucination(text: string): HallucinationCheck {
  if (looksLikeHallucinatedBoilerplate(text)) return { isHallucination: true, reason: "boilerplate" }
  if (looksLikeDegenerateRepetition(text)) return { isHallucination: true, reason: "degenerate-repetition" }
  return { isHallucination: false }
}

/**
 * Finds the next non-whitespace token's lowercase form after index `from`.
 * Returns "" when none exists (end of utterance).
 */
function nextNonWhitespaceLower(words: readonly string[], from: number): string {
  for (let j = from + 1; j < words.length; j++) {
    const next = words[j]
    if (next && !/^\s+$/.test(next)) {
      return next.toLowerCase()
    }
  }
  return ""
}

export { PHONETIC_CORRECTIONS, PROTECTED_WORDS }
