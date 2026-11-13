import { test } from "node:test"
import assert from "node:assert/strict"
import { NavigationCommandDetector, containsCatalogBookName } from "./navigation-command-detector"

test("NavigationCommandDetector: 'next verse' as a substring triggers next-verse", () => {
  const detector = new NavigationCommandDetector()
  assert.deepEqual(detector.detect("Let's look at the next verse now."), [{ kind: "next-verse" }])
})

test("NavigationCommandDetector: 'previous verse' and 'go back' both trigger previous-verse", () => {
  const detector = new NavigationCommandDetector()
  assert.deepEqual(detector.detect("Go to the previous verse."), [{ kind: "previous-verse" }])
  assert.deepEqual(detector.detect("Let's go back for a moment."), [{ kind: "previous-verse" }])
})

test("NavigationCommandDetector: 'next chapter' / 'previous chapter' trigger chapter navigation", () => {
  const detector = new NavigationCommandDetector()
  assert.deepEqual(detector.detect("Turn to the next chapter."), [{ kind: "next-chapter" }])
  assert.deepEqual(detector.detect("Back to the previous chapter please."), [{ kind: "previous-chapter" }])
})

test("NavigationCommandDetector: 'clear the screen' triggers cancel as a substring", () => {
  const detector = new NavigationCommandDetector()
  assert.deepEqual(detector.detect("Let's clear the screen for a moment."), [{ kind: "cancel" }])
})

test("NavigationCommandDetector: short synonyms ('next', 'previous', 'cancel', 'clear') only trigger as the WHOLE utterance", () => {
  const detector = new NavigationCommandDetector()
  assert.deepEqual(detector.detect("Next"), [{ kind: "next-verse" }])
  assert.deepEqual(detector.detect("  next  "), [{ kind: "next-verse" }])
  assert.deepEqual(detector.detect("Previous"), [{ kind: "previous-verse" }])
  assert.deepEqual(detector.detect("Cancel"), [{ kind: "cancel" }])
  assert.deepEqual(detector.detect("Clear"), [{ kind: "cancel" }])
})

test("NavigationCommandDetector: short synonyms tolerate realistic ASR trailing punctuation", () => {
  const detector = new NavigationCommandDetector()
  assert.deepEqual(detector.detect("Next."), [{ kind: "next-verse" }])
  assert.deepEqual(detector.detect("Cancel."), [{ kind: "cancel" }])
  assert.deepEqual(detector.detect("Clear!"), [{ kind: "cancel" }])
  assert.deepEqual(detector.detect("Previous?"), [{ kind: "previous-verse" }])
})

test("NavigationCommandDetector: short synonyms embedded in a longer sentence do NOT trigger", () => {
  const detector = new NavigationCommandDetector()
  assert.deepEqual(detector.detect("The next thing I want to say is important."), [])
  assert.deepEqual(detector.detect("I previously mentioned this."), [])
  assert.deepEqual(detector.detect("Please cancel your plans for tonight."), [])
  assert.deepEqual(detector.detect("The sky is clear today."), [])
})

test("NavigationCommandDetector: natural next/previous-one phrases work only as complete commands", () => {
  const detector = new NavigationCommandDetector()
  for (const phrase of [
    "next one",
    "the next one",
    "go to the next one",
    "show me the next one",
    "go forward one verse",
    "one verse forward",
    "go to the next best",
    "go to the nearest west",
  ]) {
    assert.deepEqual(detector.detect(`${phrase}.`), [{ kind: "next-verse" }], phrase)
  }
  for (const phrase of ["previous one", "the previous one", "go to the previous one", "go back one verse", "go back a verse", "one verse back"]) {
    assert.deepEqual(detector.detect(`${phrase}.`), [{ kind: "previous-verse" }], phrase)
  }
  assert.deepEqual(detector.detect("I will go to the next one after this reading."), [])
  assert.deepEqual(detector.detect("We can go back one verse in the story."), [])
  assert.deepEqual(detector.detect("We should go to the next best book after this."), [])
  assert.deepEqual(detector.detect("The nearest west side of town is quiet."), [])
})

test("NavigationCommandDetector: 'goto-chapter' parses 'Book chapter N' correctly", () => {
  const detector = new NavigationCommandDetector()
  assert.deepEqual(detector.detect("Let's go to Romans chapter 8 now."), [
    { kind: "goto-chapter", book: "romans", chapter: 8 },
  ])
})

test("NavigationCommandDetector: 'goto-chapter' handles a numeral-prefixed book name", () => {
  const detector = new NavigationCommandDetector()
  assert.deepEqual(detector.detect("Turn to 1 Corinthians chapter 13."), [
    { kind: "goto-chapter", book: "1 corinthians", chapter: 13 },
  ])
})

test("NavigationCommandDetector: 'goto-chapter' does NOT fire on RegexDetector's own territory ('Book Chapter:Verse')", () => {
  const detector = new NavigationCommandDetector()
  assert.deepEqual(detector.detect("Turn to Romans 8:28 tonight."), [])
})

// TASK 1: "Book chapter N, verse M" now produces goto-book-chapter-verse
// (a full reference in prose form with all three components). The old
// behavior was to reject this as RegexDetector's territory, but that left
// French "Jean chapitre 3 verset 16" unhandled. The new pattern catches it.
test("NavigationCommandDetector: 'Book chapter N, verse M' produces goto-book-chapter-verse", () => {
  const detector = new NavigationCommandDetector()
  assert.deepEqual(detector.detect("Turn to Romans chapter 9, verse 3."), [
    { kind: "goto-book-chapter-verse", book: "romans", chapter: 9, verse: 3 },
  ])
  assert.deepEqual(detector.detect("Turn to Romans chapter 9 verse 3."), [
    { kind: "goto-book-chapter-verse", book: "romans", chapter: 9, verse: 3 },
  ])
})

test("NavigationCommandDetector: 'goto-chapter' does NOT treat a lowercase word immediately before 'chapter N' as a book name", () => {
  const detector = new NavigationCommandDetector()
  // "to" and "go" are not books — the pattern must require an actually
  // capitalized word, not just any word (a bug: the pattern's own /i flag
  // previously made `[A-Z]` match any letter, capitalized or not).
  assert.deepEqual(detector.detect("Let's turn to chapter 8."), [])
  assert.deepEqual(detector.detect("Now go to chapter 9."), [])
})

test("NavigationCommandDetector: returns no commands for an empty or unrelated transcript", () => {
  const detector = new NavigationCommandDetector()
  assert.deepEqual(detector.detect(""), [])
  assert.deepEqual(detector.detect("Welcome everyone, let's begin worship."), [])
})

test("NavigationCommandDetector: a transcript can trigger multiple distinct commands at once", () => {
  const detector = new NavigationCommandDetector()
  const result = detector.detect("Let's go to Romans chapter 8, then show the next verse.")
  assert.deepEqual(result, [{ kind: "next-verse" }, { kind: "goto-chapter", book: "romans", chapter: 8 }])
})

// ARCHITECTURE.md section 65.1: elliptical/continuation references.
test("NavigationCommandDetector: a bare 'verse N' triggers goto-bare-verse", () => {
  const detector = new NavigationCommandDetector()
  assert.deepEqual(detector.detect("Now look at verse 17."), [{ kind: "goto-bare-verse", verse: 17 }])
})

test("NavigationCommandDetector: 'chapter N verse M' and 'chapter N, verse M' both trigger goto-bare-chapter-verse", () => {
  const detector = new NavigationCommandDetector()
  assert.deepEqual(detector.detect("Turn to chapter 9 verse 3."), [
    { kind: "goto-bare-chapter-verse", chapter: 9, verse: 3 },
  ])
  assert.deepEqual(detector.detect("Turn to chapter 9, verse 3."), [
    { kind: "goto-bare-chapter-verse", chapter: 9, verse: 3 },
  ])
})

test("NavigationCommandDetector: 'chapter N, verse M' does NOT also fire a redundant bare-verse command", () => {
  const detector = new NavigationCommandDetector()
  const result = detector.detect("Turn to chapter 9, verse 3.")
  assert.deepEqual(result, [{ kind: "goto-bare-chapter-verse", chapter: 9, verse: 3 }])
})

// TASK 1: a stated book name before "chapter N verse M" now correctly
// produces goto-book-chapter-verse (not a bare continuation). This fixes
// the dead zone where "Jean chapitre 3 verset 16" was unhandled.
test("NavigationCommandDetector: a book name before 'chapter N verse M' produces goto-book-chapter-verse", () => {
  const detector = new NavigationCommandDetector()
  assert.deepEqual(detector.detect("Turn to Romans chapter 9, verse 3."), [
    { kind: "goto-book-chapter-verse", book: "romans", chapter: 9, verse: 3 },
  ])
  assert.deepEqual(detector.detect("Turn to 1 Corinthians chapter 13, verse 4."), [
    { kind: "goto-book-chapter-verse", book: "1 corinthians", chapter: 13, verse: 4 },
  ])
})

test("NavigationCommandDetector: a book name immediately before a bare 'verse N' phrase is unaffected (verse pattern has no book-name guard of its own, by design)", () => {
  const detector = new NavigationCommandDetector()
  // Only the chapter+verse form needs the book-name guard (RegexDetector's
  // own territory is "Book Chapter:Verse", not "Book verse N" alone,
  // which isn't a real reference shape this app parses anywhere else).
  assert.deepEqual(detector.detect("Look at verse 17."), [{ kind: "goto-bare-verse", verse: 17 }])
})

test("NavigationCommandDetector: voice commands to switch display mode (short imperative forms only)", () => {
  const detector = new NavigationCommandDetector()
  assert.deepEqual(detector.detect("Switch to French."), [{ kind: "goto-display-mode", mode: "french" }])
  assert.deepEqual(detector.detect("English only"), [{ kind: "goto-display-mode", mode: "english" }])
  assert.deepEqual(detector.detect("Please switch to bilingual mode."), [{ kind: "goto-display-mode", mode: "bilingual" }])
  assert.deepEqual(detector.detect("Display in English"), [{ kind: "goto-display-mode", mode: "english" }])
  assert.deepEqual(detector.detect("Switch to bilingual"), [{ kind: "goto-display-mode", mode: "bilingual" }])
})

// AUDIT TS-01: a display-mode switch must only fire when the utterance IS the
// command, never because "en français"/"in english" appears inside prose.
test("NavigationCommandDetector: display-mode phrases inside ordinary sentences never switch mode (TS-01, FR+EN)", () => {
  const detector = new NavigationCommandDetector()
  const prose = [
    "il parle en français",
    "Ce mot se traduit en français.",
    "en anglais on dit grace",
    "Il a écrit ce livre en anglais et en français.",
    "Let's switch to French for this next part.",
    "English only from here.",
    "He said it in english only because the crowd was small.",
    "The text was translated to french and then switch to english later in the sermon",
    "Passons en français maintenant pour lire ce passage ensemble.",
    "Mets-toi en anglais pour ce passage.",
    "Français seulement pour ce passage.",
    "Mode bilingue pour la suite.",
    "En anglais.",
    "En français",
    "the display in english is nice",
  ]
  for (const text of prose) {
    assert.deepEqual(detector.detect(text), [], text)
  }
})

test("NavigationCommandDetector: narrative 'in the next verse' / 'go back to' are not navigation commands", () => {
  const detector = new NavigationCommandDetector()
  assert.deepEqual(detector.detect("In the next verse Paul says something else."), [])
  assert.deepEqual(detector.detect("Dans le verset suivant Paul explique."), [])
  assert.deepEqual(detector.detect("Let's go back to the beginning of the story."), [])
})

// French phrases (ARCHITECTURE.md section 65 — confirmed explicitly: the
// app's primary deployment target is a French-speaking church).
test("NavigationCommandDetector: French substring phrases for verse/chapter navigation and cancel", () => {
  const detector = new NavigationCommandDetector()
  assert.deepEqual(detector.detect("Passons au verset suivant."), [{ kind: "next-verse" }])
  assert.deepEqual(detector.detect("Retournons au verset précédent."), [{ kind: "previous-verse" }])
  assert.deepEqual(detector.detect("Passons au chapitre suivant."), [{ kind: "next-chapter" }])
  assert.deepEqual(detector.detect("Retournons au chapitre précédent."), [{ kind: "previous-chapter" }])
  assert.deepEqual(detector.detect("Il faut effacer l'écran maintenant."), [{ kind: "cancel" }])
})

test("NavigationCommandDetector: French one-verse forward/back phrases work as complete commands", () => {
  const detector = new NavigationCommandDetector()
  for (const phrase of ["avance d'un verset", "avançons d'un verset", "un verset en avant"]) {
    assert.deepEqual(detector.detect(`${phrase}.`), [{ kind: "next-verse" }], phrase)
  }
  for (const phrase of ["recule d'un verset", "reculons d'un verset", "un verset en arrière"]) {
    assert.deepEqual(detector.detect(`${phrase}.`), [{ kind: "previous-verse" }], phrase)
  }
  assert.deepEqual(detector.detect("Nous avancerons d'un verset dans notre lecture."), [])
})

// ARCHITECTURE.md section 72: "prochain X" (adjective-first) is just as
// natural in French as "X suivant" (noun-first) — a live-testing gap
// found "le prochain verset" produced no command at all under the old
// "suivant"-only coverage.
test("NavigationCommandDetector: the 'prochain X' (adjective-first) French word order is recognized alongside 'X suivant'", () => {
  const detector = new NavigationCommandDetector()
  assert.deepEqual(detector.detect("Passons au prochain verset."), [{ kind: "next-verse" }])
  assert.deepEqual(detector.detect("Passons au prochain chapitre."), [{ kind: "next-chapter" }])
})

test("NavigationCommandDetector: French short synonyms only trigger as the whole utterance, with or without an accent", () => {
  const detector = new NavigationCommandDetector()
  assert.deepEqual(detector.detect("Suivant"), [{ kind: "next-verse" }])
  assert.deepEqual(detector.detect("Précédent"), [{ kind: "previous-verse" }])
  assert.deepEqual(detector.detect("Precedent"), [{ kind: "previous-verse" }]) // accent dropped by ASR
  assert.deepEqual(detector.detect("Annuler"), [{ kind: "cancel" }])
  assert.deepEqual(detector.detect("Effacer"), [{ kind: "cancel" }])
  // Embedded in a longer sentence, must NOT trigger — same false-positive
  // guard as the English short synonyms.
  assert.deepEqual(detector.detect("Le suivant sur la liste est prêt."), [])
})

// TASK 1: French book name before "chapitre N verset M" now correctly
// produces goto-book-chapter-verse (not a bare continuation).
test("NavigationCommandDetector: a French 'chapitre N verset M' with a stated book produces goto-book-chapter-verse", () => {
  const detector = new NavigationCommandDetector()
  assert.deepEqual(detector.detect("Allons au chapitre 9, verset 3."), [
    { kind: "goto-bare-chapter-verse", chapter: 9, verse: 3 },
  ])
  assert.deepEqual(detector.detect("Maintenant regardez le verset 17."), [{ kind: "goto-bare-verse", verse: 17 }])
  // "Romains" is the stated book — now correctly produces goto-book-chapter-verse
  assert.deepEqual(detector.detect("Allons à Romains chapitre 9, verset 3."), [
    { kind: "goto-book-chapter-verse", book: "romans", chapter: 9, verse: 3 },
  ])
  // Accented French book name — same behavior, now produces goto-book-chapter-verse
  assert.deepEqual(detector.detect("Allons à Ésaïe chapitre 6, verset 8."), [
    { kind: "goto-book-chapter-verse", book: "isaiah", chapter: 6, verse: 8 },
  ])
})

// ARCHITECTURE.md section 101 (second probing round): French says "after"/
// "before" as well as "next"/"previous", and a positional ordinal is a real
// command ("au premier verset" = verse 1).
test("NavigationCommandDetector: French 'd'après'/'d'avant' relative navigation", () => {
  const detector = new NavigationCommandDetector()
  assert.deepEqual(detector.detect("On passe au chapitre d'après."), [{ kind: "next-chapter" }])
  assert.deepEqual(detector.detect("Passons au verset d'après."), [{ kind: "next-verse" }])
  assert.deepEqual(detector.detect("Revenons au chapitre d'avant."), [{ kind: "previous-chapter" }])
  assert.deepEqual(detector.detect("Revenons au verset d'avant."), [{ kind: "previous-verse" }])
})

test("NavigationCommandDetector: a positional ordinal names a chapter or a verse", () => {
  const detector = new NavigationCommandDetector()
  assert.deepEqual(detector.detect("Jean chapitre premier"), [{ kind: "goto-chapter", book: "john", chapter: 1 }])
  assert.deepEqual(detector.detect("Jean chapitre 1er"), [{ kind: "goto-chapter", book: "john", chapter: 1 }])
  assert.deepEqual(detector.detect("Jean verset premier"), [{ kind: "goto-bare-verse", verse: 1 }])
  assert.deepEqual(detector.detect("Passons au premier verset."), [{ kind: "goto-bare-verse", verse: 1 }])
  assert.deepEqual(detector.detect("Passons à Jean deuxième chapitre."), [
    { kind: "goto-chapter", book: "john", chapter: 2 },
  ])
})

test("NavigationCommandDetector: a positional ordinal with the chapter stated later produces NO command", () => {
  const detector = new NavigationCommandDetector()
  // "chapter 3 verse 1", not "verse 1 of the current chapter" — a bare-verse
  // command here would display a valid but WRONG verse, so nothing fires.
  assert.deepEqual(detector.detect("Dans le premier verset du chapitre trois."), [])
  assert.deepEqual(detector.detect("Dans le verset premier du chapitre trois."), [])
})

test("NavigationCommandDetector: 'au verset' is the same command as 'verset'", () => {
  const detector = new NavigationCommandDetector()
  assert.deepEqual(detector.detect("Regardons au verset 16."), [{ kind: "goto-bare-verse", verse: 16 }])
  // With a book and chapter stated, it is a full reference, not a race
  // between a chapter jump and a bare verse.
  assert.deepEqual(detector.detect("Jean 3 au verset 16"), [
    { kind: "goto-bare-verse", verse: 16 },
  ])
  assert.deepEqual(detector.detect("Jean chapitre 3, au verset 16"), [
    { kind: "goto-book-chapter-verse", book: "john", chapter: 3, verse: 16 },
  ])
  assert.deepEqual(detector.detect("Allons au chapitre 9, verset 3."), [
    { kind: "goto-bare-chapter-verse", chapter: 9, verse: 3 },
  ])
})

test("NavigationCommandDetector: a typographic apostrophe matches the same phrases", () => {
  const detector = new NavigationCommandDetector()
  // ASR output and pasted text disagree about the apostrophe; both forms are
  // the same phrase to an operator (ARCHITECTURE.md section 101).
  assert.deepEqual(detector.detect("Il faut effacer l\u2019écran maintenant."), [{ kind: "cancel" }])
  assert.deepEqual(detector.detect("On passe au chapitre d\u2019après."), [{ kind: "next-chapter" }])
})

test("NavigationCommandDetector: French voice commands to switch display mode, independent of verb conjugation", () => {
  const detector = new NavigationCommandDetector()
  // Any conjugation of a short imperative is accepted, but the utterance must
  // BE the command (TS-01): nothing but optional politeness around it.
  for (const text of ["Passons en français.", "Passe en français", "Passez en français", "Mets en français", "Affichage en français", "Passons en français maintenant.", "Mode français", "Français seulement"]) {
    assert.deepEqual(detector.detect(text), [{ kind: "goto-display-mode", mode: "french" }], text)
  }
  for (const text of ["Passons en anglais", "Affichage en anglais", "Anglais seulement", "S'il vous plaît passe en anglais"]) {
    assert.deepEqual(detector.detect(text), [{ kind: "goto-display-mode", mode: "english" }], text)
  }
  for (const text of ["Mode bilingue", "Passons en bilingue", "Affichage bilingue"]) {
    assert.deepEqual(detector.detect(text), [{ kind: "goto-display-mode", mode: "bilingual" }], text)
  }
})

// ---------------------------------------------------------------------------
// PROD AUDIT 2026-09, point 3: bare "<Book> N" with NO "chapitre"/"chapter"
// keyword. The production journal shows "Daniel 8" spoken 3 times, which
// produced no command at all AND no near-miss log (the near-miss guard
// required a chapitre/verset keyword in the text).
// ---------------------------------------------------------------------------

test("NavigationCommandDetector: a bare '<Book> N' with no keyword produces goto-chapter — the exact production case 'Daniel 8'", () => {
  const detector = new NavigationCommandDetector()
  assert.deepEqual(detector.detect("Daniel 8"), [{ kind: "goto-chapter", book: "daniel", chapter: 8 }])
})

test("NavigationCommandDetector: each repeated bare '<Book> N' occurrence produces its own command (production journal repeated it 3x)", () => {
  const detector = new NavigationCommandDetector()
  assert.deepEqual(detector.detect("Daniel 8. Daniel 8. Daniel 8."), [
    { kind: "goto-chapter", book: "daniel", chapter: 8 },
    { kind: "goto-chapter", book: "daniel", chapter: 8 },
    { kind: "goto-chapter", book: "daniel", chapter: 8 },
  ])
})

test("NavigationCommandDetector: the bare '<Book> N' pattern does NOT collide with RegexDetector's 'Book N:M' references", () => {
  const detector = new NavigationCommandDetector()
  // RegexDetector owns these; a competing goto-chapter here would fight the
  // real verse:show for the same utterance.
  assert.deepEqual(detector.detect("Turn to Daniel 8:1 tonight."), [])
  assert.deepEqual(detector.detect("Regardons Daniel 8:1."), [])
})

test("NavigationCommandDetector: the bare '<Book> N' pattern does not swallow a following 'verset M' continuation", () => {
  const detector = new NavigationCommandDetector()
  // "Daniel 8 verset 5" is an elliptical continuation ("verset 5" resolved
  // against the current position), not a chapter jump to Daniel 8 — the
  // (?!...verse|verset) guard keeps the two from both firing.
  assert.deepEqual(detector.detect("Daniel 8 verset 5"), [{ kind: "goto-bare-verse", verse: 5 }])
})

test("NavigationCommandDetector: the bare '<Book> N' pattern only accepts real BOOK_CATALOG names", () => {
  const detector = new NavigationCommandDetector()
  // Ordinary words followed by a number must not become chapter jumps.
  assert.deepEqual(detector.detect("Salut 8"), [])
  assert.deepEqual(detector.detect("Ensuite 8"), [])
  assert.deepEqual(detector.detect("Nous avons 8 personnes"), [])
})

test("NavigationCommandDetector: the bare '<Book> N' pattern handles accented and lowercase book names via normalizeBookName()", () => {
  const detector = new NavigationCommandDetector()
  assert.deepEqual(detector.detect("Ésaïe 6"), [{ kind: "goto-chapter", book: "isaiah", chapter: 6 }])
  assert.deepEqual(detector.detect("daniel 8"), [{ kind: "goto-chapter", book: "daniel", chapter: 8 }])
  // Numeral-prefixed book, same as GOTO_CHAPTER_PATTERN supports.
  assert.deepEqual(detector.detect("1 Corinthiens 13"), [
    { kind: "goto-chapter", book: "1 corinthians", chapter: 13 },
  ])
})

// The near-miss guard (AppCore) needs to know whether a transcript merely
// MENTIONS a book, even with no navigation/reference keyword anywhere in the
// text — that is the exact gap that made "Daniel 8" invisible in production.
test("containsCatalogBookName: true for a transcript that mentions a catalog book with no keyword at all", () => {
  assert.equal(containsCatalogBookName("Daniel 8"), true)
  assert.equal(containsCatalogBookName("Nous étions dans Ésaïe hier soir"), true)
  assert.equal(containsCatalogBookName("daniel"), true)
})

test("containsCatalogBookName: false for text with no catalog book name", () => {
  assert.equal(containsCatalogBookName("Salut 8"), false)
  assert.equal(containsCatalogBookName("Bonsoir tout le monde"), false)
  assert.equal(containsCatalogBookName(""), false)
})

test("containsCatalogBookName: does not fire on the English word 'to' (the classic RegexDetector false-positive trap)", () => {
  assert.equal(containsCatalogBookName("Turn to chapter 9"), false)
})

// CORRECTIF (observed live, 2026-09-23): a real service reading references
// aloud produced a comma at every spoken pause. Mirrors the identical fix
// already applied to RegexDetector's own SPOKEN_REFERENCE_PATTERN.
test("NavigationCommandDetector: comma-separated spoken references (live-observed, 2026-09-23)", () => {
  const detector = new NavigationCommandDetector()
  assert.deepEqual(detector.detect("Abacuc, 1, 2, 3,"), [{ kind: "goto-chapter", book: "habakkuk", chapter: 1 }])
  assert.deepEqual(detector.detect("Jean, chapitre 1, verset 2"), [
    { kind: "goto-book-chapter-verse", book: "john", chapter: 1, verse: 2 },
  ])
})

// CORRECTIF (observed live, 2026-09-23): "le verset"/"the verse" is at
// least as natural in spoken French/English as the bare keyword, and was
// already tolerated by RegexDetector's own SPOKEN_REFERENCE_PATTERN but
// missing from every pattern here.
test("NavigationCommandDetector: 'le verset'/'the verse' is tolerated everywhere 'verset'/'verse' is (live-observed, 2026-09-23)", () => {
  const detector = new NavigationCommandDetector()
  assert.deepEqual(detector.detect("Jean chapitre 1, le verset 2"), [
    { kind: "goto-book-chapter-verse", book: "john", chapter: 1, verse: 2 },
  ])
  assert.deepEqual(detector.detect("chapitre 1, le verset 2"), [
    { kind: "goto-bare-chapter-verse", chapter: 1, verse: 2 },
  ])
  assert.deepEqual(detector.detect("Turn to the verse 2"), [{ kind: "goto-bare-verse", verse: 2 }])
})
