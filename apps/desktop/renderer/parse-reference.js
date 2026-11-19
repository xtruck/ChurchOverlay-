// Plain browser JS, no build step (same convention as mic-capture-guard.js
// and audio-stream.js: a globalThis module with its own unit tests, loaded
// before dashboard.js). ARCHITECTURE.md section 146 (frontend pass): the
// operator's typed-reference parser, its own module so it is unit-testable
// (parse-reference.test.ts) — dashboard.js keeps only the DOM wiring.
//
// Deliberately similar to, but NOT required to stay byte-for-byte in sync
// with, RegexDetector's REFERENCE_PATTERN in apps/server/detector/
// regex-detector.ts — unlike float32ToInt16/reconnect-backoff, a mismatch
// here is not a correctness risk: this only decides whether the manual-
// override input field accepts what the operator typed, then sends it as a
// plain payload. The server-side known-valid-index path re-validates it
// exactly like a detected reference regardless of what this parser let
// through (app-core.ts's verse:override handler, ARCHITECTURE.md section
// 36). Intentionally looser than the server pattern (e.g. it doesn't
// require the book name to start with a capital letter), since rejecting a
// typo-free field here isn't a security boundary.
//
// Section 146: an optional RANGE TAIL after the verse — "Jean 3:16-18",
// "jn 3 16 18", "Ps 119:105-107" — with a hyphen, en dash or em dash
// (spaces around it allowed) or a plain fourth token. A REVERSED tail
// ("16-3") is rejected so the operator sees the format hint instead of a
// surprise single verse; an EQUAL tail ("16-16") is simply verse 16. The
// server clamps the end to the chapter's real verses and caps the span
// (app-core.ts's operatorTypedRange) exactly like a detected range.
;(function () {
  function parseReference(text) {
    // Unicode letters so "Gen\u00e8se 1:1" and multi-word names ("Song of Solomon 2:1") parse; the server re-validates.
    // Quick entry: "jn 3 16", "1co 13 4", "gen 1:1" all work. The chapter and verse are
    // separated by a space, colon, dot or comma; the book may be a shortcut (the server
    // resolves it, see apps/server/detector/quick-book.ts).
    const match =
      /^\s*((?:[123]\s*)?\p{L}[\p{L}.'\u2019 ]*?)\s*(\d{1,3})(?:\s+|\s*[:.,]\s*)(\d{1,3})(?:\s*[-\u2013\u2014]\s*(\d{1,3})|\s+(\d{1,3}))?\s*$/u.exec(
        text
      )
    if (!match) return null
    const reference = {
      book: match[1].trim().replace(/\s+/g, " ").toLowerCase(),
      chapter: Number.parseInt(match[2], 10),
      verse: Number.parseInt(match[3], 10),
    }
    const endText = match[4] || match[5]
    if (endText !== undefined) {
      const verseEnd = Number.parseInt(endText, 10)
      // A REVERSED tail is rejected (the format hint beats a surprise
      // verse); an EQUAL tail is simply the single verse.
      if (verseEnd < reference.verse) return null
      if (verseEnd > reference.verse) reference.verseEnd = verseEnd
    }
    return reference
  }

  globalThis.ChurchOverlayParseReference = { parseReference }
})()
