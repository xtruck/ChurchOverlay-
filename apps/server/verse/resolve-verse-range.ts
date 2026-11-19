import type { Verse } from "../../../packages/contracts"
import type { Logger } from "../../../packages/shared/logger"
import type { DetectedVerseRange } from "../detector/verse-range-detector"
import { CircuitBreaker } from "./circuit-breaker"
import { VerseCache } from "./verse-cache"
import { resolveVerseDetailed, translationIdFor, type VerseLookupFailure } from "./resolve-verse"

/**
 * Innovation pass (ARCHITECTURE.md section 145): resolve a validated verse
 * RANGE into ONE displayable Verse — the range's start reference carries a
 * bracket-numbered joined text ("[16] ... [17] ...") and the additive
 * `verseEnd` field, so the existing single-verse `verse:show` funnel, wire
 * shape and session recording are unchanged end to end.
 *
 * Every verse is resolved through the same guarded path as a single
 * reference (resolveVerseDetailed: cache -> circuit breaker -> source,
 * response validation, negative caching) — a range is never a second,
 * weaker way to reach verse text. In practice the whole range resolves
 * from the cache after the FIRST verse pays one chapter read (the
 * chapter-capable sources' cache warming, section 144.3), so a six-verse
 * spoken range costs one network round-trip, same as one verse.
 *
 * Display honesty (AGENTS.md sections 13-15): only verses that actually
 * resolved are joined, and each carries its bracketed number, so a
 * versification gap is VISIBLE, never papered over by adjacency. If the
 * start verse itself fails, nothing is shown (null) — the operator's
 * lookup report already says why. A verse confirmed absent (or
 * unavailable) inside the range is logged and skipped, never faked.
 */
export async function resolveVerseRange(
  range: DetectedVerseRange,
  source: Parameters<typeof resolveVerseDetailed>[1],
  cache: VerseCache,
  circuitBreaker: CircuitBreaker,
  translation: string = translationIdFor(source) ?? "kjv",
  logger?: Logger,
  /** Called once per verse in the range, with the failure reason or null on success. */
  onLookup?: (reference: { readonly book: string; readonly chapter: number; readonly verse: number }, failure: VerseLookupFailure | null) => void
): Promise<Verse | null> {
  const resolved: Verse[] = []
  for (let verse = range.startVerse; verse <= range.endVerse; verse++) {
    const reference = { book: range.book, chapter: range.chapter, verse }
    const { verse: resolvedVerse, failure } = await resolveVerseDetailed(reference, source, cache, circuitBreaker, translation, logger)
    onLookup?.(reference, failure)
    if (resolvedVerse) resolved.push(resolvedVerse)
  }

  if (resolved.length === 0) return null

  const joinVerses = (verses: readonly Verse[]): string =>
    verses.map((v) => `[${v.reference.verse}] ${v.text.trim()}`).join(" ")

  const primary: Verse = {
    reference: { book: range.book, chapter: range.chapter, verse: range.startVerse },
    verseEnd: range.endVerse,
    text: joinVerses(resolved),
    translation: resolved[0]!.translation,
    source: resolved[0]!.source,
  }

  // Bilingual mode (section 63): the secondary text joins only when EVERY
  // resolved verse carries it — a half-translated range would show a
  // bilingual layout with a silently missing half.
  if (resolved.every((v) => v.secondary) && resolved[0]!.secondary) {
    primary.secondary = {
      text: resolved.map((v) => `[${v.reference.verse}] ${v.secondary!.text.trim()}`).join(" "),
      translation: resolved[0]!.secondary!.translation,
      source: resolved[0]!.secondary!.source,
    }
  }

  if (resolved.length < range.endVerse - range.startVerse + 1) {
    logger?.warn({
      component: "verse-range-resolver",
      event: "range-partially-resolved",
      metadata: {
        book: range.book,
        chapter: range.chapter,
        startVerse: range.startVerse,
        endVerse: range.endVerse,
        resolvedVerses: resolved.map((v) => v.reference.verse),
      },
    })
  }

  return primary
}
