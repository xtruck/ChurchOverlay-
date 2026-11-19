// Plain browser JS, no build step (same convention as parse-reference.js:
// a globalThis module with its own unit tests, loaded before dashboard.js).
// P1-2 (ARCHITECTURE.md section 149): the PURE reference formatting moved out
// of dashboard.js so it is unit-testable directly — dashboard.js keeps only
// the display-mode-aware wrapper (formatDisplayedReference), which reads
// dashboard state (the mode toggle) and can never be a pure function.
//
// ARCHITECTURE.md section 72: the book table is the same as overlay.js's own
// copy (duplicated, not shared — no build step, same precedent as
// float32ToInt16/reconnect-backoff between these files). The translation-id
// list is the same rule and the same list as overlay.js's and remote.js's
// FRENCH_TRANSLATIONS — all copies guarded equal by reference-parity.test.ts.
// "darby" was missing from the dashboard's list until the section 146
// frontend pass: a Darby verse showed "John 3:16" in the pending banner while
// the overlay itself read "Jean 3:16". Change a table here AND in every
// surface in the same commit.
;(function () {
  function capitalize(book) {
    return book.replace(/\b\w/g, (c) => c.toUpperCase())
  }

  const FRENCH_BOOK_NAMES = {
    genesis: "Genèse", exodus: "Exode", leviticus: "Lévitique", numbers: "Nombres",
    deuteronomy: "Deutéronome", joshua: "Josué", judges: "Juges", ruth: "Ruth",
    "1 samuel": "1 Samuel", "2 samuel": "2 Samuel", "1 kings": "1 Rois", "2 kings": "2 Rois",
    "1 chronicles": "1 Chroniques", "2 chronicles": "2 Chroniques", ezra: "Esdras",
    nehemiah: "Néhémie", esther: "Esther", job: "Job", psalm: "Psaumes",
    proverbs: "Proverbes", ecclesiastes: "Ecclésiaste", "song of solomon": "Cantique des Cantiques",
    isaiah: "Ésaïe", jeremiah: "Jérémie", lamentations: "Lamentations", ezekiel: "Ézéchiel",
    daniel: "Daniel", hosea: "Osée", joel: "Joël", amos: "Amos", obadiah: "Abdias",
    jonah: "Jonas", micah: "Michée", nahum: "Nahum", habakkuk: "Habacuc",
    zephaniah: "Sophonie", haggai: "Aggée", zechariah: "Zacharie", malachi: "Malachie",
    matthew: "Matthieu", mark: "Marc", luke: "Luc", john: "Jean", acts: "Actes",
    romans: "Romains", "1 corinthians": "1 Corinthiens", "2 corinthians": "2 Corinthiens",
    galatians: "Galates", ephesians: "Éphésiens", philippians: "Philippiens",
    colossians: "Colossiens", "1 thessalonians": "1 Thessaloniciens",
    "2 thessalonians": "2 Thessaloniciens", "1 timothy": "1 Timothée", "2 timothy": "2 Timothée",
    titus: "Tite", philemon: "Philémon", hebrews: "Hébreux", james: "Jacques",
    "1 peter": "1 Pierre", "2 peter": "2 Pierre", "1 john": "1 Jean", "2 john": "2 Jean",
    "3 john": "3 Jean", jude: "Jude", revelation: "Apocalypse",
  }

  const FRENCH_TRANSLATIONS = new Set(["ls1910", "lsg", "segond", "darby"])

  // Innovation pass (ARCHITECTURE.md section 145): a detected verse RANGE shows as
  // one joined verse; the optional verseEnd extends every label to "Book C:V-E".
  // Payloads without verseEnd render exactly as before.
  function rangeSuffix(ref, verseEnd) {
    return typeof verseEnd === "number" && verseEnd > ref.verse ? "-" + verseEnd : ""
  }

  function formatReference(ref, verseEnd) {
    return capitalize(ref.book) + " " + ref.chapter + ":" + ref.verse + rangeSuffix(ref, verseEnd)
  }

  function formatBilingualReference(ref, verseEnd) {
    const frenchName = FRENCH_BOOK_NAMES[ref.book]
    const frenchRef = (frenchName || capitalize(ref.book)) + " " + ref.chapter + ":" + ref.verse + rangeSuffix(ref, verseEnd)
    return frenchRef + " · " + formatReference(ref, verseEnd)
  }

  globalThis.ChurchOverlayReferenceFormat = {
    capitalize,
    FRENCH_BOOK_NAMES,
    FRENCH_TRANSLATIONS,
    rangeSuffix,
    formatReference,
    formatBilingualReference,
  }
})()
