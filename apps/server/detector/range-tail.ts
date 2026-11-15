/**
 * Innovation pass (ARCHITECTURE.md section 145): the shared definition of
 * "the verse number just matched is the START of a range" — a conjunction
 * (dash, "à", "to", "and", "et", "jusqu'à"...) directly followed by the end
 * verse number. Lives in its own import-free module so regex-detector.ts
 * (single patterns) and verse-range-detector.ts (range patterns) can both
 * interpolate it at module level WITHOUT a circular import between them.
 *
 * In the single patterns it appears as the negative lookahead
 * (?!RANGE_TAIL d): a range tail suppresses the single match, the range
 * detector owns the utterance. In the range patterns it joins the two
 * verse numbers positively. One utterance can therefore never produce both
 * a truncated single and a range for the same numbers — the same
 * one-utterance-one-command rule the navigation guard lookaheads apply.
 *
 * "chapter 16 and verse 7" still matches as a single: "and" is followed by
 * "verse", not directly by a digit, so RANGE_TAIL does not fire there.
 *
 * Deliberately ends BEFORE the end-verse number (no trailing d): the range
 * detector captures that number as its own group, and the single patterns
 * interpolate it as (?!RANGE_TAIL d).
 *
 * Kept as a string (not a regex literal) so both files interpolate it.
 */
export const RANGE_TAIL = String.raw`\s*(?:jusqu[''’]\s*)?(?:[-–—]|à|au|aux|et|and|to|till|until|through|thru)[\s'’]*`
