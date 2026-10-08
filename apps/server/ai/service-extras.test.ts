import { test } from "node:test"
import assert from "node:assert/strict"
import {
  MAX_EXTRAS_VERSES,
  MAX_EXTRAS_VERSE_CHARS,
  ServiceExtrasGenerator,
  buildServiceExtrasInput,
  buildServiceNotesMarkdown,
  parseServiceExtras,
} from "./service-extras"
import type { SessionEntry } from "../core/session-recorder"

const T0 = 1_700_000_000_000
const ENTRIES: SessionEntry[] = [
  { reference: { book: "john", chapter: 3, verse: 16 }, text: "For God so loved the world...", translation: "kjv", timestamp: T0 },
  { reference: { book: "romans", chapter: 8, verse: 28 }, text: "All things work together for good...", translation: "kjv", timestamp: T0 + 95_000 },
]
const NOTES = "- La grâce suffit / Grace is enough\n- Dieu est fidèle en toute saison / God is faithful in every season"

const GOOD = {
  recapFr: "Un culte centré sur la grâce.",
  recapEn: "A service centred on grace.",
  verseCards: [2],
  noteQuotes: ["Dieu est fidèle en toute saison / God is faithful in every season"],
}

test("buildServiceExtrasInput: numbers the shown verses, includes the notes, and is bounded", () => {
  const input = buildServiceExtrasInput(ENTRIES, NOTES)
  assert.ok(input.includes('[1] john 3:16: "For God so loved the world..."'))
  assert.ok(input.includes("[2] romans 8:28"))
  assert.ok(input.includes("La grâce suffit"))

  const many: SessionEntry[] = Array.from({ length: 200 }, (_, i) => ({
    reference: { book: "john", chapter: 3, verse: (i % 30) + 1 },
    text: "x".repeat(1_000),
    translation: "kjv",
    timestamp: T0 + i,
  }))
  const bounded = buildServiceExtrasInput(many, "n".repeat(20_000))
  assert.equal(bounded.split("\n").filter((line) => /^\[\d+\]/.test(line)).length, MAX_EXTRAS_VERSES)
  assert.ok(bounded.length < MAX_EXTRAS_VERSES * (MAX_EXTRAS_VERSE_CHARS + 40) + 6_200)

  assert.ok(buildServiceExtrasInput([], "").includes("No verses were shown"))
  assert.ok(buildServiceExtrasInput([], "").includes("No sermon notes"))
})

test("parseServiceExtras: a good answer gives both recaps, the chosen verse card and the verified note quote", () => {
  const extras = parseServiceExtras(JSON.stringify(GOOD), ENTRIES, NOTES)
  assert.deepEqual(extras.recap, { fr: GOOD.recapFr, en: GOOD.recapEn })
  assert.equal(extras.cards.length, 2)
  assert.deepEqual(extras.cards[0], { kind: "verse", entry: ENTRIES[1] })
  assert.deepEqual(extras.cards[1], { kind: "note", text: GOOD.noteQuotes[0] })
})

test("parseServiceExtras: prose around the JSON is tolerated; unreadable or recap-less answers are errors", () => {
  assert.equal(parseServiceExtras("Here you go:\n" + JSON.stringify(GOOD) + "\nEnjoy!", ENTRIES, NOTES).cards.length, 2)
  assert.throws(() => parseServiceExtras("no json at all", ENTRIES, NOTES), /could not be read/)
  assert.throws(() => parseServiceExtras("[1,2]", ENTRIES, NOTES), /could not be read/)
  assert.throws(() => parseServiceExtras('{"recapFr":"seulement"}', ENTRIES, NOTES), /both the French and the English/)
  assert.throws(() => parseServiceExtras(JSON.stringify({ ...GOOD, recapEn: "  " }), ENTRIES, NOTES), /both the French and the English/)
})

test("parseServiceExtras: out-of-range, duplicate, non-integer and excess verse card numbers are dropped", () => {
  const many: SessionEntry[] = Array.from({ length: 6 }, (_, i) => ({ ...(ENTRIES[0] as SessionEntry), timestamp: T0 + i }))
  const extras = parseServiceExtras(JSON.stringify({ ...GOOD, noteQuotes: [], verseCards: [0, 7, 1.5, "2", 3, 3, 4, 5, 6] }), many, NOTES)
  assert.deepEqual(extras.cards.map((card) => (card.kind === "verse" ? card.entry.timestamp - T0 : -1)), [2, 3, 4])
  assert.equal(parseServiceExtras(JSON.stringify({ ...GOOD, verseCards: [1] }), [], NOTES).cards.filter((c) => c.kind === "verse").length, 0)
})

test("parseServiceExtras: a note quote that is not word for word in the notes (paraphrase, invention) is dropped", () => {
  const extras = parseServiceExtras(
    JSON.stringify({
      ...GOOD,
      verseCards: [],
      noteQuotes: ["God is always faithful", "Dieu est fidèle en toute saison", "short", 42, "x".repeat(400)],
    }),
    ENTRIES,
    NOTES,
  )
  // only the exact fragment of the notes survives (case, spacing and list markers are ignored)
  assert.deepEqual(extras.cards, [{ kind: "note", text: "Dieu est fidèle en toute saison" }])
  const withMarker = parseServiceExtras(JSON.stringify({ ...GOOD, verseCards: [], noteQuotes: ["- LA GRÂCE   SUFFIT"] }), ENTRIES, NOTES)
  assert.equal(withMarker.cards.length, 1)
})

test("parseServiceExtras: at most 2 note cards and 3 verse cards; hostile text is cleaned and bounded", () => {
  const extras = parseServiceExtras(
    JSON.stringify({
      recapFr: "a\u0000b\n" + "x".repeat(3_000),
      recapEn: "<b>bold</b>",
      verseCards: [1, 2],
      noteQuotes: ["La grâce suffit", "Grace is enough", "Dieu est fidèle en toute saison"],
    }),
    ENTRIES,
    NOTES,
  )
  assert.ok(extras.recap.fr.length <= 1_200 && extras.recap.fr.startsWith("a b "))
  assert.equal(extras.recap.en, "<b>bold</b>")
  assert.equal(extras.cards.filter((card) => card.kind === "note").length, 2)
})

test("ServiceExtrasGenerator: one call with the verified inputs and the strict prompt; failures reject", async () => {
  const seen: Array<{ system: string; user: string; maxTokens?: number }> = []
  const generator = new ServiceExtrasGenerator({
    complete: async (request) => {
      seen.push(request)
      return JSON.stringify(GOOD)
    },
  })
  const extras = await generator.generate(ENTRIES, NOTES)
  assert.equal(extras.cards.length, 2)
  assert.equal(seen.length, 1)
  assert.ok(seen[0]?.system.includes("WORD FOR WORD") && seen[0].system.includes("Never invent"))
  assert.ok(seen[0]?.user.includes("[2] romans 8:28") && seen[0].user.includes("La grâce suffit"))

  const failing = new ServiceExtrasGenerator({ complete: async () => { throw new Error("Claude request failed (500)") } })
  await assert.rejects(failing.generate(ENTRIES, NOTES), /500/)
})

test("buildServiceNotesMarkdown: bilingual recap, verified verses with elapsed time, notes, cards and the AI disclaimer", () => {
  const extras = parseServiceExtras(JSON.stringify(GOOD), ENTRIES, NOTES)
  const markdown = buildServiceNotesMarkdown({
    title: "Grace Church",
    date: "2026-10-04",
    extras,
    entries: ENTRIES,
    notesText: NOTES,
    cardFiles: ["quote-card-ai-1.png", "quote-card-ai-2.png"],
  })
  assert.ok(markdown.startsWith("# Grace Church - 2026-10-04"))
  assert.ok(markdown.includes("Not verified content"))
  assert.ok(markdown.includes("## Recap (Français)\n\nUn culte centré sur la grâce."))
  assert.ok(markdown.includes("## Recap (English)\n\nA service centred on grace."))
  assert.ok(markdown.includes("- 00:00 John 3:16 (kjv): For God so loved the world..."))
  assert.ok(markdown.includes("- 01:35 Romans 8:28 (kjv): All things work together for good..."))
  assert.ok(markdown.includes("## Sermon notes (AI)\n\n- La grâce suffit"))
  assert.ok(markdown.includes("- quote-card-ai-1.png: Romans 8:28 (kjv)"))
  assert.ok(markdown.includes('- quote-card-ai-2.png: Sermon note (AI): "Dieu est fidèle en toute saison / God is faithful in every season"'))
})

test("buildServiceNotesMarkdown: an empty service still produces a valid, honest document", () => {
  const markdown = buildServiceNotesMarkdown({
    title: "T",
    date: "d",
    extras: { recap: { fr: "r", en: "r" }, cards: [] },
    entries: [],
    notesText: "  ",
    cardFiles: [],
  })
  assert.ok(markdown.includes("No verses were shown during this service."))
  assert.ok(markdown.includes("No sermon notes were generated during this service."))
  assert.ok(markdown.includes("No cards were selected."))
})
