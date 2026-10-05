/**
 * Rewrites the ways people actually *say* a Bible reference into the
 * compact written shape the detectors' patterns expect, before any pattern
 * runs. Deterministic, table-driven, and conservative: it never invents a
 * reference, it only rewrites wording that is unambiguously part of one.
 * Every reference produced downstream still passes KnownValidVerseIndex.
 *
 * Found by probing the real detector with natural French/English phrasing:
 * - "1ère Jean 4:8" / "première épître de Jean chapitre 4 verset 8" were
 *   detected as JEAN 4:8 instead of 1 JEAN 4:8 — both exist, so the
 *   hallucination guard could not catch it and the congregation saw the
 *   wrong verse. The ordinal was simply not understood.
 * - "Premier Corinthiens 13:4", "deuxième Timothée", "First Corinthians",
 *   "Second Timothy" were missed entirely.
 * - "chapitre trois verset seize" (number words) was missed.
 * - "Cantique des cantiques 2:4" / "Song of Solomon 2:4" were missed (the
 *   book group is a single word).
 * - "Jean 3 v 16" / "Jean 3 v. 16" were missed ("v" is the written
 *   abbreviation of verset/verse).
 *
 * Found by probing both detectors again with natural French phrasing
 * (ARCHITECTURE.md section 101):
 * - "Jean 3 au verset 16" / "Jean chapitre 3, au verset 16" were missed
 *   entirely — French puts a preposition in front of the keyword ("au
 *   verset"), and every pattern expects the keyword to follow the number
 *   directly. Worse, NavigationCommandDetector turned the second one into
 *   TWO commands (goto-chapter John 3 plus bare verse 16 of the CURRENT
 *   chapter), a race that can display a second, wrong verse.
 * - "Jean chapitre premier" / "au premier verset" / "Jean verset premier"
 *   were missed: no pattern accepts a word where it expects a number.
 * - "l'Apocalypse de Jean chapitre 21 verset 4" displayed John 21:4 — the
 *   full French title of Revelation collapsed onto its last word, and John
 *   21:4 exists, so the hallucination guard could not catch it.
 * - "Actes des apôtres chapitre 2 verset 4" was missed (same multi-word
 *   book-group limitation as "Cantique des cantiques").
 */

const ORDINALS: ReadonlyArray<readonly [RegExp, string]> = [
  [/^(?:premier|premiere|1er|1re|1ere|1eme|first|1st|i)$/, "1"],
  [/^(?:deuxieme|second|seconde|2e|2eme|2nd|ii)$/, "2"],
  [/^(?:troisieme|third|3e|3eme|3rd|iii)$/, "3"],
]

/** Words that may sit between an ordinal and the book name: "première épître de Jean", "second letter to Timothy". */
const EPISTLE_WORDS = "(?:epitre|epitres|lettre|letter|epistle|livre|book)"
const LINK_WORDS = "(?:de|du|des|d'|aux|au|a|to|of|the|la|le|l')"

const MULTI_WORD_BOOKS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bcantique\s+des\s+cantiques\b/giu, "Cantique"],
  [/\bsong\s+of\s+(?:solomon|songs)\b/giu, "Cantique"],
  // Probing round three (ARCHITECTURE.md section 102): French also names this
  // book by its author, and "le psaume de David 23 verset 1" was a miss for
  // the same structural reason as the two titles below — the single-word book
  // group captured the word sitting right before the number ("David") and
  // rejected it, losing "Psaume" entirely. Collapsing the title to "Psaume"
  // before any pattern runs is the same fix, not a new mechanism.
  [/\b(?:psaume|psaumes)\s+de\s+david\b/giu, "Psaume"],
  // The same single-word book group limitation as "Cantique des cantiques",
  // for the two other French titles that are really phrases: "Actes des
  // apôtres" (Acts) and "l'Apocalypse de (saint) Jean" (Revelation).
  // The second one is a correctness fix, not just coverage: collapsing it
  // onto "Jean" made "l'Apocalypse de Jean chapitre 21 verset 4" display
  // John 21:4 — an existing verse, so nothing downstream could catch it.
  // Matched on the raw (accented) text, hence the explicit [oô].
  [/\bactes\s+des\s+ap[oô]tres\b/giu, "Actes"],
  [/\bapocalypse\s+de\s+(?:saint\s+|st\.?\s+)?jean\b/giu, "Apocalypse"],
]

const UNITS: Readonly<Record<string, number>> = {
  zero: 0, un: 1, une: 1, deux: 2, trois: 3, quatre: 4, cinq: 5, six: 6, sept: 7, huit: 8, neuf: 9,
  dix: 10, onze: 11, douze: 12, treize: 13, quatorze: 14, quinze: 15, seize: 16,
  one: 1, two: 2, three: 3, four: 4, five: 5, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19,
}
const TENS: Readonly<Record<string, number>> = {
  vingt: 20, trente: 30, quarante: 40, cinquante: 50, soixante: 60,
  septante: 70, octante: 80, huitante: 80, nonante: 90,
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
}
const HUNDRED = new Set(["cent", "cents", "hundred"])

/** Tokens after which a following run of number words is read as a number. */
const NUMBER_CONTEXT = /^(?:chapitre|chapitres|chapter|chapters|verset|versets|verse|verses|v|psaume|psaumes|psalm|psalms|et|and|a|to)$/

function strip(text: string): string {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
}

/** Value of one (possibly hyphenated) word: "dix-sept" 17, "quatre-vingt-dix" 90, "twenty-one" 21. null if not a number word. */
function wordValue(word: string): number | null {
  const pieces = strip(word).split("-").filter(Boolean)
  if (pieces.length === 0) return null
  let total = 0
  for (let i = 0; i < pieces.length; i++) {
    const piece = pieces[i] as string
    if (piece === "et" && i > 0 && i < pieces.length - 1) continue // "vingt-et-un"
    if ((piece === "vingt" || piece === "vingts") && pieces[i - 1] === "quatre") {
      total += 80 - 4 // "quatre-vingt": the 4 already added becomes 80
      continue
    }
    if (piece in TENS) total += TENS[piece] as number
    else if (piece in UNITS) total += UNITS[piece] as number
    else if (HUNDRED.has(piece)) total = (total === 0 ? 1 : total) * 100
    else return null
  }
  return total
}

/**
 * Parses a run of number words starting at tokens[start], up to 199 (Psalm
 * 119 has 176 verses, the largest count in the Bible). Words chain only in
 * the ways numbers are actually spoken — "vingt et un", "cent vingt",
 * "twenty one" — so two separate numbers said back to back ("trois
 * seize", "huit vingt-huit") stay two numbers: 3 16, 8 28.
 */
export function parseNumberWords(tokens: readonly string[], start: number): { value: number; length: number } | null {
  const first = wordValue(tokens[start] ?? "")
  if (first === null || first === 0) return null
  let value = first
  let length = 1
  for (let i = start + 1; i < tokens.length; i++) {
    const raw = strip(tokens[i] as string)
    const isLink = raw === "et" || raw === "and"
    const nextIndex = isLink ? i + 1 : i
    if (!isLink && HUNDRED.has(raw) && value < 10) {
      value *= 100 // "deux cents", "one hundred"
      length = i - start + 1
      continue
    }
    const next = wordValue(tokens[nextIndex] ?? "")
    if (next === null || next === 0) break
    const lastPart = value % 100
    const canJoin =
      (value % 100 === 0 && next < 100) || // "cent vingt", "one hundred and nine"
      (lastPart >= 20 && lastPart % 10 === 0 && next < 10) || // "twenty one", "vingt et un"
      ((lastPart === 60 || lastPart === 80) && next >= 10 && next < 20) // "soixante et onze", "quatre-vingt dix"
    if (!canJoin) break
    value += next
    length = nextIndex - start + 1
    i = nextIndex
  }
  if (value > 199) return null
  return { value, length }
}

function rewriteNumberWords(text: string, isBookWord?: (word: string) => boolean): string {
  const tokens = text.split(/(\s+)/)
  const words = tokens.filter((_, i) => i % 2 === 0)
  const cleanWords = words.map((x) => x.replace(/[.,;:!?]+$/, ""))
  const out: string[] = []
  let previousWord = ""
  for (let w = 0; w < words.length; w++) {
    const word = words[w] as string
    const bare = strip(cleanWords[w] as string)
    const previousBare = strip(previousWord).replace(/[.,;:!?]+$/, "")
    const context = NUMBER_CONTEXT.test(previousBare) || /\d$/.test(previousWord) || (isBookWord?.(previousBare) ?? false)
    // "cent" opens a number too ("Psaume cent dix-neuf"); English needs no case
    // for it because "one hundred nineteen" already starts with a unit word.
    if (context && (bare in UNITS || bare in TENS || bare === "cent" || bare.includes("-"))) {
      const parsed = parseNumberWords(cleanWords, w)
      if (parsed) {
        const lastToken = words[w + parsed.length - 1] as string
        const trailing = lastToken.match(/[.,;:!?]+$/)?.[0] ?? ""
        out.push(String(parsed.value) + trailing)
        previousWord = String(parsed.value)
        w += parsed.length - 1
        continue
      }
    }
    out.push(word)
    previousWord = word
  }
  return out.join(" ")
}

/**
 * Only books that exist in numbered volumes can take an ordinal — so
 * "wait a second, John 3:16" is never read as 2 John.
 */
const NUMBERED_BOOKS =
  "(?:samuel|rois|kings|chroniques|chronicles|corinthiens|corinthians|corentin|corentien|corretien|corretine|corintien|thessaloniciens|thessalonians|timothee|timothy|pierre|peter|jean|john)"

const ORDINALS_PATTERN = new RegExp(
  `(?<![\\p{L}\\d])([\\p{L}\\d]+)\\s+(?:${EPISTLE_WORDS}\\s+(?:${LINK_WORDS}\\s*)?)?(?=${NUMBERED_BOOKS}(?![\\p{L}]))`,
  "giu"
)

function rewriteOrdinals(text: string): string {
  // Matched on an accent-stripped copy (same length: NFD+strip only removes
  // combining marks, so we map indices through a per-character strip instead).
  const folded = foldPreservingLength(text)
  let result = ""
  let last = 0
  for (const match of folded.matchAll(ORDINALS_PATTERN)) {
    const index = match.index ?? 0
    const candidate = text.slice(index, index + (match[1] as string).length)
    const key = strip(candidate)
    const digit = ORDINALS.find(([ordinal]) => ordinal.test(key))?.[1]
    // Roman "I" alone is also the English pronoun — only upper-case "I" counts.
    if (!digit || (key === "i" && candidate !== "I")) continue
    // "wait a second John…", "one second John…": idiom, not an ordinal.
    if (/(?:^|\s)(?:a|one|per|just\s+a)\s+$/i.test(text.slice(Math.max(0, index - 12), index))) continue
    result += text.slice(last, index) + `${digit} `
    last = index + match[0].length
  }
  return result + text.slice(last)
}

/**
 * A numbered volume said with a CARDINAL rather than an ordinal word:
 * "deux Corinthiens" (2 Corinthians), "trois Jean" (3 John, which was
 * already fine because "trois Jean" happens to collide with nothing),
 * "two Corinthians". Found by probing the real detector (ARCHITECTURE.md
 * section 102): "deux Corinthiens 5 verset 17" and "two Corinthians 5:17"
 * detected nothing, while the ordinal phrasing "deuxième Corinthiens"
 * already worked. Restricted to NUMBERED_BOOKS so the rewrite can never
 * manufacture a volume that does not exist, and deliberately limited to
 * two/three for books whose bare name is also a single-volume book or an
 * ordinary word ("un Jean", a pair of jeans; "un Pierre"). BUT a real service
 * log (2026-10-05) showed a French preacher saying "Un Corinthiens 5 le verset
 * 2" over and over, which was detected as the non-existent book "corinthiens"
 * and rejected. For the books that exist ONLY in numbered volumes and have no
 * other meaning (Samuel, Rois, Chroniques, Corinthiens, Thessaloniciens,
 * Timothée) "un/une/one" is read as volume 1; Jean and Pierre stay excluded.
 */
const CARDINAL_VOLUMES: Readonly<Record<string, string>> = {
  deux: "2",
  two: "2",
  trois: "3",
  three: "3",
  un: "1",
  une: "1",
  one: "1",
}

/** Books that only exist in numbered volumes, so "un <book>" can only mean volume 1. */
const VOLUME_ONLY_BOOKS =
  "(?:samuel|rois|kings|chroniques|chronicles|corinthiens|corinthians|corentin|corentien|corretien|corretine|corintien|thessaloniciens|thessalonians|timothee|timothy)"

const CARDINAL_VOLUME_PATTERN = new RegExp(
  `(?<![\\p{L}\\d])(?:(deux|two|trois|three)\\s+(?=${NUMBERED_BOOKS}(?![\\p{L}]))|(un|une|one)\\s+(?=${VOLUME_ONLY_BOOKS}(?![\\p{L}])))`,
  "giu"
)

function rewriteCardinalVolumes(text: string): string {
  const folded = foldPreservingLength(text)
  let result = ""
  let last = 0
  for (const match of folded.matchAll(CARDINAL_VOLUME_PATTERN)) {
    const index = match.index ?? 0
    const digit = CARDINAL_VOLUMES[(match[1] ?? match[2]) as string]
    if (!digit) continue
    result += text.slice(last, index) + `${digit} `
    last = index + match[0].length
  }
  return result + text.slice(last)
}

/** Lower-cases and strips accents character by character, keeping every index aligned with the original. */
function foldPreservingLength(text: string): string {
  let out = ""
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code < 128) {
      out += code >= 65 && code <= 90 ? String.fromCharCode(code + 32) : text[i]
    } else {
      const char = text[i] as string
      const folded = strip(char)
      out += folded.length === 1 ? folded : char.toLowerCase()
    }
  }
  return out
}

/**
 * A preposition sitting immediately in front of the *verse* keyword: French
 * "au verset 16", English "at verse 16". The keyword alone is what every
 * pattern keys off, and each of them expects it to follow the number
 * directly — so the preposition is dropped here rather than every pattern
 * gaining one more optional branch. Only this exact shape is touched:
 * "deuxième épître aux Corinthiens" keeps its "aux". "a" is included because
 * accent-free ASR output writes French "à" that way (and as an English
 * article it is harmless: a verse keyword must follow it for this to match
 * at all).
 *
 * Deliberately NOT applied to "chapitre"/"chapter", and that is not an
 * oversight: the chapter side is already accepted by
 * SPOKEN_REFERENCE_DOUBLE_KEYWORD_PATTERN's own `au|à|a|dans le|in|at`
 * link, while STRIMMING it would blind NavigationCommandDetector's
 * BARE_CHAPTER_VERSE_PATTERN — whose lookbehind relies on the word in front
 * of "chapitre" not being a capitalized book-like word. "Allons au chapitre
 * 9, verset 3" matched only because "au" (lowercase) sat there; removing it
 * would have exposed "Allons" and silently rejected a real command (caught
 * by that test before it shipped).
 */
const VERSE_KEYWORD_PREPOSITION = /(?<!\p{L})(?:au|aux|à|a|at|in)\s+(?=(?:versets?|verses?)(?!\p{L}))/giu

/**
 * Ordinals that name a chapter/verse *position* ("Jean chapitre premier",
 * "au premier verset", "Jean verset premier") instead of a book number.
 * Probing found every one of those missed: a number slot only ever accepted
 * digits or number words.
 *
 * Deliberately French-only, though the spellings come from the shared
 * ORDINALS table so the two lists cannot drift apart. The English spellings
 * in that table are correct before a *book* number ("First Corinthians")
 * but not here: English "second" is also a unit of time and "a second
 * verse" means "another verse", so "give me a second verse" must never
 * become verse 2 — the same reasoning as the existing "wait a second John"
 * guard. English "the first chapter" is therefore left exactly as it was.
 */
const ENGLISH_ONLY_POSITION_ORDINALS = new Set([
  "first", "1st", "i", "second", "2nd", "ii", "third", "3rd", "iii",
])

const POSITION_KEYWORDS = "(?:chapitres?|versets?)"

/** "<ordinal> chapitre|verset" — "au premier verset", "Jean premier chapitre". */
const ORDINAL_BEFORE_POSITION = new RegExp(
  `(?<![\\p{L}\\d])([\\p{L}\\d]+)\\s+(${POSITION_KEYWORDS})(?![\\p{L}])`,
  "giu"
)

/** "chapitre|verset <ordinal>" — "Jean chapitre premier", "le verset premier". */
const POSITION_BEFORE_ORDINAL = new RegExp(
  `(?<![\\p{L}\\d])(${POSITION_KEYWORDS})\\s+([\\p{L}\\d]+)(?![\\p{L}])`,
  "giu"
)

const SENTENCE_BREAK = /[.!?;\n]/
const FOLLOWING_CHAPTER = /(?:chapitre|chapter)(?!\p{L})/iu

/**
 * True when a stated chapter follows in the same sentence. Used to skip one
 * rewrite: "dans le premier verset du chapitre trois" means chapter 3 verse
 * 1, and rewriting it to a bare "verset 1" would resolve against the
 * CURRENT chapter instead — a valid but wrong verse, the one failure mode
 * the hallucination guard cannot catch. Left alone it produces no command,
 * exactly as before this change.
 */
function chapterStatedAfter(text: string, from: number): boolean {
  const rest = text.slice(from)
  const end = rest.search(SENTENCE_BREAK)
  return FOLLOWING_CHAPTER.test(end === -1 ? rest : rest.slice(0, end))
}

function positionOrdinalDigit(word: string): string | null {
  const key = strip(word)
  if (ENGLISH_ONLY_POSITION_ORDINALS.has(key)) return null
  return ORDINALS.find(([ordinal]) => ordinal.test(key))?.[1] ?? null
}

/**
 * One positional-ordinal pass. Whichever order the speaker used, the match
 * is replaced by "<keyword> <digit>" — the order every pattern expects.
 * Indices are mapped through the accent-preserving fold, so the ordinal
 * itself is read back from the original text (an accented "deuxième" must
 * still normalize).
 */
function rewritePositionPass(text: string, pattern: RegExp, keywordGroup: number, ordinalGroup: number): string {
  const folded = foldPreservingLength(text)
  let result = ""
  let last = 0
  for (const match of folded.matchAll(pattern)) {
    const index = match.index ?? 0
    const keyword = match[keywordGroup]
    const ordinal = match[ordinalGroup]
    if (!keyword || !ordinal) continue
    const ordinalIndex = ordinalGroup === 1 ? index : index + match[0].length - ordinal.length
    const keywordEnd = keywordGroup === 1 ? index + keyword.length : index + match[0].length
    if (chapterStatedAfter(text, keywordEnd)) continue
    const digit = positionOrdinalDigit(text.slice(ordinalIndex, ordinalIndex + ordinal.length))
    if (!digit) continue
    result += text.slice(last, index) + `${keyword} ${digit}`
    last = index + match[0].length
  }
  return result + text.slice(last)
}

/**
 * Noun-first ("chapitre premier", "verset premier") before adjective-first
 * ("premier chapitre"): running the other way round would rewrite the
 * "premier" of "Jean chapitre premier verset premier" into a stray
 * "verset 1" and mangle the rest of the phrase. That phrase also shows why
 * the two passes repeat: rewriting a position ordinal can expose the next
 * one. Every rewrite replaces an ordinal word with a digit, so the loop
 * settles long before its bound.
 */
function rewritePositionOrdinals(text: string): string {
  let current = text
  for (let round = 0; round < 4; round++) {
    const next = rewritePositionPass(
      rewritePositionPass(current, POSITION_BEFORE_ORDINAL, 1, 2),
      ORDINAL_BEFORE_POSITION,
      2,
      1
    )
    if (next === current) return next
    current = next
  }
  return current
}

/**
 * @param isBookWord optional: lets number words directly after a book name
 * ("Romains huit vingt-huit") be read as numbers. Injected rather than
 * imported to keep this module free of catalog knowledge and import cycles.
 */
export function normalizeSpokenReferences(text: string, isBookWord?: (word: string) => boolean): string {
  let result = text
  for (const [pattern, replacement] of MULTI_WORD_BOOKS) result = result.replace(pattern, replacement)
  result = rewriteOrdinals(result)
  result = rewriteCardinalVolumes(result)
  result = rewritePositionOrdinals(result)
  result = result.replace(VERSE_KEYWORD_PREPOSITION, "")
  // "v." / "v" between two numbers is the written abbreviation of verset/verse.
  result = result.replace(/(\d)\s*[,]?\s+v\.?\s*(?=\d)/giu, "$1 verset ")
  result = rewriteNumberWords(result, isBookWord)
  return result
}
