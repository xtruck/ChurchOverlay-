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
  const out: string[] = []
  let previousWord = ""
  for (let w = 0; w < words.length; w++) {
    const word = words[w] as string
    const bare = strip(word).replace(/[.,;:!?]+$/, "")
    const previousBare = strip(previousWord).replace(/[.,;:!?]+$/, "")
    const context = NUMBER_CONTEXT.test(previousBare) || /\d$/.test(previousWord) || (isBookWord?.(previousBare) ?? false)
    if (context && (bare in UNITS || bare in TENS || bare.includes("-"))) {
      const parsed = parseNumberWords(words.map((x) => x.replace(/[.,;:!?]+$/, "")), w)
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
  "(?:samuel|rois|kings|chroniques|chronicles|corinthiens|corinthians|thessaloniciens|thessalonians|timothee|timothy|pierre|peter|jean|john)"

function rewriteOrdinals(text: string): string {
  // Matched on an accent-stripped copy (same length: NFD+strip only removes
  // combining marks, so we map indices through a per-character strip instead).
  const pattern = new RegExp(
    `(?<![\\p{L}\\d])([\\p{L}\\d]+)\\s+(?:${EPISTLE_WORDS}\\s+(?:${LINK_WORDS}\\s*)?)?(?=${NUMBERED_BOOKS}(?![\\p{L}]))`,
    "giu"
  )
  const folded = foldPreservingLength(text)
  let result = ""
  let last = 0
  for (const match of folded.matchAll(pattern)) {
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

/** Lower-cases and strips accents character by character, keeping every index aligned with the original. */
function foldPreservingLength(text: string): string {
  let out = ""
  for (const char of text) {
    const folded = strip(char)
    out += folded.length === char.length ? folded : char.toLowerCase()
  }
  return out
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
  // "v." / "v" between two numbers is the written abbreviation of verset/verse.
  result = result.replace(/(\d)\s*[,]?\s+v\.?\s*(?=\d)/giu, "$1 verset ")
  result = rewriteNumberWords(result, isBookWord)
  return result
}
