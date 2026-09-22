/** Keeps punctuation predictable without inventing words or verse content. */
export function normalizePunctuation(text: string): string {
  return text
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/([,.;!?])(?=\S)/g, "$1 ")
    // Colon is handled separately from the other punctuation above: a
    // tight "chapter:verse" reference (e.g. "3:16") must reach
    // RegexDetector with no space on either side of the colon — its
    // reference pattern requires `\d+:\d+` with zero tolerance for
    // whitespace (see regex-detector.ts). Inserting a space here (as the
    // generic punctuation rule above does for ",.;!?") silently broke
    // every live detection of that format, since ASR output for a
    // spoken reference is normally already tight ("John 3:16"), not
    // spaced. Only add the space when the colon is NOT flanked by a
    // digit on both sides, i.e. it isn't a verse reference.
    .replace(/:(?=\S)/g, (match, offset: number, str: string) => {
      const prevChar = str[offset - 1]
      const nextChar = str[offset + 1]
      const isVerseReference = prevChar !== undefined && nextChar !== undefined && /\d/.test(prevChar) && /\d/.test(nextChar)
      return isVerseReference ? ":" : ": "
    })
    .replace(/([.!?]){2,}/g, "$1")
    .replace(/\s+/g, " ")
    .trim()
}
