import { test } from "node:test"
import assert from "node:assert/strict"
import { extractAnnouncedChapter } from "./announced-context"

test("extractAnnouncedChapter: the live sentence announces Isaiah 4 even though verse 8 does not exist", () => {
  assert.deepEqual(extractAnnouncedChapter("Dans Esaïe 4, le verset 8"), { book: "isaiah", chapter: 4 })
  assert.deepEqual(extractAnnouncedChapter("Dans Esaïe 4 le verset 8, Dans Esaïe 4, le verset 8. La régie Esaïe chapitre 4, verset 8."), { book: "isaiah", chapter: 4 })
})

test("extractAnnouncedChapter: with and without the chapter keyword, numbered books, English names", () => {
  assert.deepEqual(extractAnnouncedChapter("Allons dans Jean chapitre 3"), { book: "john", chapter: 3 })
  assert.deepEqual(extractAnnouncedChapter("Ouvrons Romains 8"), { book: "romans", chapter: 8 })
  assert.deepEqual(extractAnnouncedChapter("dans 1 Jean 4 verset 8"), { book: "1 john", chapter: 4 })
  assert.deepEqual(extractAnnouncedChapter("turn to John chapter 3 verse 16"), { book: "john", chapter: 3 })
})

test("extractAnnouncedChapter: the most recent announcement wins", () => {
  assert.deepEqual(extractAnnouncedChapter("Jean 3 puis Romains 8 verset 28"), { book: "romans", chapter: 8 })
})

test("extractAnnouncedChapter: a reference that already has its verse is not an announcement", () => {
  assert.equal(extractAnnouncedChapter("Jean 3:16"), null)
  assert.equal(extractAnnouncedChapter("Jean 3.16"), null)
})

test("extractAnnouncedChapter: unknown books, out-of-range chapters and ordinary speech announce nothing", () => {
  assert.equal(extractAnnouncedChapter("Jean 23"), null) // John has 21 chapters
  assert.equal(extractAnnouncedChapter("dans la Bible que dans"), null)
  assert.equal(extractAnnouncedChapter("Verset 8."), null)
  assert.equal(extractAnnouncedChapter("il y avait 12 personnes"), null)
  assert.equal(extractAnnouncedChapter("Lundi 4 octobre"), null)
})

test("extractAnnouncedChapter: 'nombre' (also an everyday word) only counts with an explicit chapter keyword", () => {
  assert.equal(extractAnnouncedChapter("un grand nombre 12"), null)
  assert.deepEqual(extractAnnouncedChapter("dans nombre chapitre 12"), { book: "numbers", chapter: 12 })
})
