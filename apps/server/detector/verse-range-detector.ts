import {
  CATALOG_IDS,
  COMPACT_FORM_EXCLUDED_WORDS,
  STOPWORDS,
  compactFormFollowedByNonReferenceWord,
  isCatalogBookWord,
  normalizeAsrTypography,
  normalizeBookName,
  stripAccents,
} from "./regex-detector"
import type { LearnedAliasLookup } from "./regex-detector"
import { normalizeSpokenReferences } from "./spoken-reference-normalizer"
import { RANGE_TAIL } from "./range-tail"

/**
 * Innovation pass (ARCHITECTURE.md section 145): the verse-RANGE twin of
 * RegexDetector. A preacher quoting a stretch of text — "Proverbes chapitre
 * 1, verset 5 à 7", "Proverbs chapter 1 verses 16 to 18", the dictated
 * "Jean 3:16-18" — used to be truncated to the first verse (the operator
 * was expected to press "next verse" for the rest). The display decision
 * that previously blocked ranges has now been made: a detected range shows
 * as ONE overlay verse with bracketed verse numbers ("[16] ... [17] ..."),
 * so this detector owns the whole utterance.
 *
 * Boundaries, kept identical to RegexDetector's (section 50):
 *   - purely syntactic: it does not know which books exist (that is
 *     KnownValidVerseIndex's job, applied by detectValidatedRanges in
 *     apps/server/core/detect-and-validate.ts);
 *   - the same spoken-form normalization runs FIRST (number words become
 *     digits, spoken book names become catalog names);
 *   - a learned alias is accepted in the EXPLICIT keyword forms only,
 *     never in the compact "Name N M-K" form (an approved word may also be
 *     an everyday word);
 *   - the compact form keeps the single detector's trailing-word filter
 *     ("Marc 12 14-16 personnes" is a quantity, not a range).
 *
 * One utterance, one command: the single patterns in regex-detector.ts
 * carry the negative lookahead (?!RANGE_TAIL d) built from the SAME
 * RANGE_TAIL expression used positively here, so a range tail can never
 * produce both a truncated single and a range.
 */

export type DetectedVerseRange = {
  readonly book: string
  readonly chapter: number
  readonly startVerse: number
  readonly endVerse: number
}

/** Structural capability looked up on the pipeline's existing detector instance. */
export interface VerseRangeDetectorLike {
  detectRanges(text: string): readonly DetectedVerseRange[]
}

export type VerseRangeDetectorOptions = { readonly learnedAliases?: LearnedAliasLookup }

// Both keyword shapes: "Proverbes chapitre 1, verset 5 à 7" (double keyword)
// and "Jean 3 verset 5 à 7" (single keyword, no "chapitre"). The separator
// slots mirror the single patterns' (including the spoken "et/and" slot and
// the French articles), and the range tail — the SAME RANGE_TAIL string the
// single patterns use as their negative lookahead — joins the start verse to
// the end verse.
const RANGE_DOUBLE_KEYWORD_PATTERN = new RegExp(
  String.raw`(?<![\p{L}\d])((?:[123]\s+)?\p{L}[\p{L}]+)(?:[\s,]+(?:au|à|a|dans\s+le|in|at))?[\s,]+(?:chapitre|chapter)[\s,]+(\d{1,3})(?:[\s,]+(?:et|and)[\s,]+|[\s,]+)(?:le\s+|the\s+)?(?:versets?|verses?)[\s,]+(\d{1,3})(?:${RANGE_TAIL})(\d{1,3})(?![\p{L}\d]|\s*[.,:]\s*\d)`,
  "giu"
)
const RANGE_SINGLE_KEYWORD_PATTERN = new RegExp(
  String.raw`(?<![\p{L}\d])((?:[123]\s+)?\p{L}[\p{L}]+)[\s,]+(\d{1,3})(?:[\s,]+(?:et|and)[\s,]+|[\s,]+)(?:chapitre|chapter|versets?|verses?|le\s+versets?|the\s+verses?)[\s,]+(\d{1,3})(?:${RANGE_TAIL})(\d{1,3})(?![\p{L}\d]|\s*[.,:]\s*\d)`,
  "giu"
)
// The dictated compact forms: "Jean 3:16-18", "Jean 3.16-18", the ASR pause
// "Jean 3, 16-18" and the bare "Jean 3 16-18". Case-sensitive, like the
// single COMPACT_REFERENCE_PATTERN.
const RANGE_COMPACT_PATTERN = new RegExp(
  String.raw`(?<![\p{L}\d])((?:[123]\s+)?\p{L}[\p{L}]+)[\s,]+(\d{1,3})(?:\s*[.,:]\s*|\s+)(\d{1,3})(?:${RANGE_TAIL})(\d{1,3})(?![\p{L}\d]|\s*[.,:]\s*\d)`,
  "gu"
)

// Compiled once at module level (the same rule normalizeBibleTerms and the
// single patterns follow): the detector instance is long-lived, so a detect
// call allocates only its result array.
const ALL_PATTERNS: readonly RegExp[] = [RANGE_DOUBLE_KEYWORD_PATTERN, RANGE_SINGLE_KEYWORD_PATTERN, RANGE_COMPACT_PATTERN]

export class VerseRangeDetector implements VerseRangeDetectorLike {
  private readonly learnedAliases: LearnedAliasLookup | undefined

  constructor(options: VerseRangeDetectorOptions = {}) {
    this.learnedAliases = options.learnedAliases
  }

  detectRanges(rawText: string): readonly DetectedVerseRange[] {
    const ranges: DetectedVerseRange[] = []
    const text = normalizeSpokenReferences(normalizeAsrTypography(rawText), isCatalogBookWord)

    for (const pattern of ALL_PATTERNS) {
      for (const match of text.matchAll(pattern)) {
        const rawBook = match[1]
        const rawChapter = match[2]
        const rawStart = match[3]
        const rawEnd = match[4]
        if (!rawBook || !rawChapter || !rawStart || !rawEnd) continue

        const isCompact = pattern === RANGE_COMPACT_PATTERN
        let book = normalizeBookName(rawBook)
        if (STOPWORDS.has(book)) continue
        // Same alias policy as the single detector: operator-approved
        // mishearings work in the explicit keyword forms, never in the
        // compact form; and the compact form keeps both compact guards.
        if (!CATALOG_IDS.has(book) && this.learnedAliases && !isCompact) {
          const learned = this.learnedAliases.get(stripAccents(rawBook).toLowerCase())
          if (learned !== undefined) book = learned
        }
        if (isCompact && COMPACT_FORM_EXCLUDED_WORDS.has(stripAccents(rawBook).toLowerCase())) continue
        if (isCompact && compactFormFollowedByNonReferenceWord(text, (match.index ?? 0) + match[0].length)) continue

        const startVerse = Number.parseInt(rawStart, 10)
        const endVerse = Number.parseInt(rawEnd, 10)
        // A reversed span ("28 - 5" quantity noise) is not a range; the
        // validator would drop it anyway, but not emitting it at all keeps
        // the detector's own output honest on its own terms.
        if (endVerse < startVerse) continue

        ranges.push({ book, chapter: Number.parseInt(rawChapter, 10), startVerse, endVerse })
      }
    }

    const seen = new Set<string>()
    const unique: DetectedVerseRange[] = []
    for (const range of ranges) {
      const key = `${range.book}:${range.chapter}:${range.startVerse}-${range.endVerse}`
      if (!seen.has(key)) {
        seen.add(key)
        unique.push(range)
      }
    }
    return unique
  }
}

/**
 * The pipeline's detector field is typed as the single-verse VerseDetector
 * interface (packages/contracts, section 50). RegexDetector now also carries
 * detectRanges(), so the composition root's instance serves both — looked up
 * structurally here, without widening the VerseDetector contract every
 * detector implementation must satisfy.
 */
export function asVerseRangeDetector(detector: unknown): VerseRangeDetectorLike | null {
  if (detector === null || detector === undefined) return null
  const candidate = detector as Partial<VerseRangeDetectorLike>
  return typeof candidate.detectRanges === "function" ? (detector as VerseRangeDetectorLike) : null
}
