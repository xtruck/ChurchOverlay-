/**
 * Text-level screen applied to every engine's transcript before it reaches
 * the display pipeline (layer 3 of the noise/tongues defence).
 *
 * The audio gate (silence-gate.ts) and the per-segment scores
 * (segment-quality.ts) run earlier and are engine-specific. This is the
 * engine-independent last check, and the only one a streaming engine without
 * segment scores (Deepgram) gets. It composes, never replaces:
 *   - detectHallucination (transcription-corrector.ts): exact outro boilerplate, degenerate loops
 *   - hasForeignScript (script-guard.ts): a letter outside the Latin script
 * and adds: strong hallucination markers anywhere in the text, music symbols
 * and bracketed non-speech annotations, repetition, syllable loops, and the
 * share of words that exist in French or English (glossolalia produces
 * pronounceable non-words).
 *
 * Pure and deterministic. It must never reject a bare verse reference
 * ("Jean 3 16", "Psaume 23"): books, numbers and structural words count as
 * known, and texts under the mode's minWords are exempt from the
 * statistical rules.
 */
import { BOOK_CATALOG } from "../verse/book-catalog"
import { FRENCH_BOOK_ALIASES, PHONETIC_BOOK_ALIASES } from "../detector/regex-detector"
import { detectHallucination } from "./transcription-corrector"
import { hasForeignScript } from "./script-guard"
import type { NoiseMode } from "./noise-mode"

export type ScreenState = "partial" | "final"

export type ScreenReason =
  | "boilerplate"
  | "degenerate-repetition"
  | "hallucination-marker"
  | "music-symbol"
  | "non-speech-annotation"
  | "foreign-script"
  | "repetitive"
  | "syllable-loop"
  | "implausible-words"

/**
 * `cleaned` is present when a credit/outro clause or a music symbol was stripped out of text that also holds real
 * speech or a reference: the caller must continue with `cleaned`, not the original.
 */
export type ScreenVerdict = { readonly ok: true; readonly cleaned?: string } | { readonly ok: false; readonly reason: ScreenReason }

/** Folds accents, curly apostrophes and case so one table serves both languages. */
function fold(text: string): string {
  return text.normalize("NFD").replace(/\p{M}+/gu, "").replace(/[‘’ʼ]/g, "'").toLowerCase()
}

/** Whisper's well-known invented credits and outros. Substring match: these are never said in a sermon. */
const HALLUCINATION_MARKERS: readonly RegExp[] = [
  /amara\.org/,
  /sous-?titr(?:es?|age)\s+(?:realise|par|fait|st|societe|de la communaute)/,
  /sous-?titrage\s/,
  /(?:subtitles?|captions?|transcribed|translated)\s+by\b/,
  /thanks?\s+for\s+watching/,
  /thank\s+you\s+for\s+(?:watching|listening to this video)/,
  /merci\s+d'avoir\s+(?:regarde|ecoute)/,
  /(?:please\s+)?(?:like\s+and\s+)?subscribe\s+(?:to\s+)?(?:my|the|our)\s+channel/,
  /abonnez-vous/,
  /n'oubliez\s+pas\s+de\s+(?:vous\s+abonner|liker)/,
  /see\s+you\s+in\s+the\s+next\s+video/,
  /a\s+bientot\s+pour\s+une\s+nouvelle\s+video/,
]

const MUSIC_SYMBOLS = /[♪♫♬♩\u{1f3b5}\u{1f3b6}]/u

/** Whole text is a bracketed or starred sound label: "[Music]", "(Musique)", "*applause*". */
const NON_SPEECH_ANNOTATION =
  /^[\s[(*]*(?:music|musique|applause|applaudissements|laughter|rires?|silence|noise|bruit|singing|chant|inaudible|blank_audio|foreign|speaking in foreign language)[\s\])*.!]*$/

/** Structural and very common words of both languages (accent-folded). */
const COMMON_WORDS: ReadonlySet<string> = new Set(
  (
    // French
    "le la les un une des du de d l au aux et ou mais donc or ni car que qu qui quoi dont ce cet cette ces ca cela ceci " +
    "je j tu il elle on nous vous ils elles me m te t se s moi toi lui eux leur leurs mon ma mes ton ta tes son sa ses notre nos votre vos " +
    "est es suis sommes etes sont etre ai as a avons avez ont avoir fait faire dit dire va vais vont aller peut peux peuvent pouvoir veut veulent vouloir doit dois devoir " +
    "ete etait etaient sera seront serait avait avaient aura pas ne n plus moins tres bien mal tout tous toute toutes rien jamais toujours encore deja aussi comme " +
    "dans en sur sous avec sans pour par vers chez entre apres avant depuis pendant contre selon si quand comment pourquoi alors ainsi cependant puis " +
    "oui non merci amen alleluia hallelujah seigneur dieu jesus christ esprit saint pere fils ciel terre parole foi grace amour paix vie mort " +
    "chapitre verset versets psaume psaumes livre ouvrez ouvrons lisons lire lis lecture bible texte passage evangile epitre ecriture ecritures " +
    "frere freres soeur soeurs eglise priere prions priez louange gloire " +
    "zero deux trois quatre cinq six sept huit neuf dix onze douze treize quatorze quinze seize trente quarante cinquante soixante septante octante nonante vingt cent cents mille million premier premiere second " +
    "suivant precedent suivante annuler y ici voici voila c " +
    // English
    "the an and but nor so for yet of to in on at by with from as into onto upon about over under between through during before after above below " +
    "i my mine you your yours he him his she her hers it its we us our ours they them their theirs this that these those who whom whose which what where when why how " +
    "am is are was were be been being have has had do does did will would shall should can could may might must " +
    "not no yes all any some each every both few more most other such only own same than too very just also then there here now " +
    "if because while until although though however therefore thus " +
    "lord god spirit holy father son heaven earth word faith grace love peace life death praise glory " +
    "chapter verse verses psalm psalms book open turn read reading text gospel epistle scripture scriptures " +
    "brother brothers sister sisters church prayer pray let " +
    "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty thirty forty fifty sixty seventy eighty ninety hundred thousand million first second third " +
    "next previous cancel " +
    // fragments produced by splitting on apostrophes
    "ll ve re don didn isn wasn doesn won"
  ).split(/\s+/),
)

let knownBibleWords: ReadonlySet<string> | null = null

/** Book names and ids in both languages, accent-folded, split into single words ("1 corinthians" -> "corinthians"). */
function bibleWords(): ReadonlySet<string> {
  if (knownBibleWords) return knownBibleWords
  const words = new Set<string>()
  const add = (value: string) => {
    for (const word of fold(value).split(/[^\p{L}\p{N}]+/u)) if (word.length > 0) words.add(word)
  }
  for (const book of BOOK_CATALOG) {
    add(book.id)
    add(book.name)
  }
  for (const aliases of [FRENCH_BOOK_ALIASES, PHONETIC_BOOK_ALIASES]) {
    for (const [alias, id] of Object.entries(aliases)) {
      add(alias)
      add(id)
    }
  }
  knownBibleWords = words
  return words
}

/** True for a Bible book or book-name word (accent- and case-insensitive); engines often mis-tag these. */
export function isBibleWord(word: string): boolean {
  return bibleWords().has(fold(word))
}

function tokens(text: string): string[] {
  return fold(text)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length > 0)
}

function isKnown(token: string): boolean {
  return /^\p{N}+$/u.test(token) || COMMON_WORDS.has(token) || bibleWords().has(token)
}

type ModeRules = {
  /** The statistical rules ignore texts shorter than this (a bare reference is 3 words). */
  readonly minWords: number
  /** Drop when fewer than this share of words are known French/English/biblical words. */
  readonly minKnownShare: number
  /** Drop when distinct/total words is below this, from 6 words up. */
  readonly minDistinctShare: number
  /** Drop when at least this many tokens are a repeated syllable ("lalala", "shashasha"). */
  readonly syllableLoopTokens: number
}

/**
 * normal: only what real speech cannot produce (8+ words, under 12% known,
 * is not a sentence). noisy/tongues tighten the share and the word floor.
 * Reasoned, not measured on real recordings of this church.
 */
const RULES: Readonly<Record<NoiseMode, ModeRules>> = Object.freeze({
  normal: { minWords: 8, minKnownShare: 0.12, minDistinctShare: 0.2, syllableLoopTokens: 3 },
  noisy: { minWords: 6, minKnownShare: 0.16, minDistinctShare: 0.3, syllableLoopTokens: 2 },
  tongues: { minWords: 4, minKnownShare: 0.2, minDistinctShare: 0.4, syllableLoopTokens: 2 },
})

const SYLLABLE_LOOP = /^(\p{L}{2,3})\1{2,}\p{L}{0,2}$/u

/** Words that make a text a spoken reference or navigation command, whatever else it holds. */
const REFERENCE_WORDS: ReadonlySet<string> = new Set([
  "chapitre", "verset", "versets", "psaume", "psaumes", "suivant", "suivante", "precedent", "annuler",
  "chapter", "verse", "verses", "psalm", "psalms", "next", "previous", "cancel",
])

/** True when the text holds a digit, a Bible book word or a navigation word: a reference or command may be in it. */
export function hasReferenceHint(text: string): boolean {
  if (/\p{N}/u.test(text)) return true
  return tokens(text).some((token) => REFERENCE_WORDS.has(token) || bibleWords().has(token))
}

const MUSIC_SYMBOLS_GLOBAL = /[♪♫♬♩\u{1f3b5}\u{1f3b6}]/gu

/**
 * Cuts the clauses that are credits/outros out of the text. Returns the rest
 * (possibly the whole text), or null when nothing but credits was there.
 */
function withoutCreditClauses(text: string): { readonly rest: string | null; readonly removed: boolean } {
  const clauses = text.split(/(?<=[.!?…])\s+|\n+/u)
  const kept = clauses.filter((clause) => !HALLUCINATION_MARKERS.some((marker) => marker.test(fold(clause))))
  if (kept.length === clauses.length) return { rest: text, removed: false }
  const rest = kept.join(" ").trim()
  return { rest: /\p{L}|\p{N}/u.test(rest) ? rest : null, removed: true }
}

export function screenTranscript(
  text: string,
  options: { readonly state?: ScreenState; readonly mode?: NoiseMode } = {},
): ScreenVerdict {
  const mode = options.mode ?? "normal"

  const known = detectHallucination(text)
  if (known.isHallucination) return { ok: false, reason: known.reason }
  if (NON_SPEECH_ANNOTATION.test(fold(text).trim())) return { ok: false, reason: "non-speech-annotation" }
  if (hasForeignScript(text)) return { ok: false, reason: "foreign-script" }

  // Credits/outros and music symbols: cut the offending span and judge what is left, so one "♪" or a stray credit
  // never discards a reference spoken in the same transcript.
  let working = text
  let cleaned = false
  if (MUSIC_SYMBOLS.test(working)) {
    const stripped = working.replace(MUSIC_SYMBOLS_GLOBAL, " ").replace(/\s+/g, " ").trim()
    // Sung words with nothing a verse detector could use are lyrics, not preaching.
    if (!hasReferenceHint(stripped)) return { ok: false, reason: "music-symbol" }
    working = stripped
    cleaned = true
  }
  const credits = withoutCreditClauses(working)
  if (credits.removed) {
    if (credits.rest === null) return { ok: false, reason: "hallucination-marker" }
    working = credits.rest
    cleaned = true
  }
  const done = (verdict: ScreenVerdict): ScreenVerdict => (verdict.ok && cleaned ? { ok: true, cleaned: working } : verdict)

  // A partial grows word by word; statistics on a fragment are noise. The final decides.
  if (options.state === "partial") return done({ ok: true })

  const rules = RULES[mode]
  const words = tokens(working)
  if (words.length < rules.minWords) return done({ ok: true })

  if (words.length >= 6 && new Set(words).size / words.length < rules.minDistinctShare) return { ok: false, reason: "repetitive" }
  if (words.filter((word) => word.length >= 6 && !isKnown(word) && SYLLABLE_LOOP.test(word)).length >= rules.syllableLoopTokens) {
    return { ok: false, reason: "syllable-loop" }
  }
  // Names (a genealogy, a list of people) are real speech made of unknown words. Outside tongues mode a capitalised word
  // that does not open the text is a name: it counts neither for nor against. Tongues mode keeps counting them, because
  // a names list is then the price of dropping gibberish.
  const original = working.normalize("NFC").split(/[^\p{L}\p{N}]+/u).filter((token) => token.length > 0)
  const judged = original.filter((token, index) => mode === "tongues" || index === 0 || !/^\p{Lu}/u.test(token))
  if (judged.length >= 3) {
    const knownShare = judged.filter((token) => isKnown(fold(token))).length / judged.length
    if (knownShare < rules.minKnownShare) return { ok: false, reason: "implausible-words" }
  }
  return done({ ok: true })
}
