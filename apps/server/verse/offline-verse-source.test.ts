import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { OfflineVerseSource, loadOfflineBibleData, type OfflineBibleData } from "./offline-verse-source"

const FIXTURE: OfflineBibleData = {
  jean: {
    "3": {
      "16": "Car Dieu a tant aimé le monde...",
      "17": "Dieu, en effet, n'a pas envoyé son Fils...",
    },
  },
}

test("OfflineVerseSource: resolves a known reference with the expected shape", async () => {
  const source = new OfflineVerseSource(FIXTURE)
  const verse = await source.getVerse({ book: "john", chapter: 3, verse: 16 })
  assert.deepEqual(verse, {
    reference: { book: "john", chapter: 3, verse: 16 },
    text: "Car Dieu a tant aimé le monde...",
    translation: "ls1910",
    source: "offline-bundled",
  })
})

test("OfflineVerseSource: returns null (never throws) for a book this dataset doesn't map at all", async () => {
  const source = new OfflineVerseSource(FIXTURE)
  assert.equal(await source.getVerse({ book: "not-a-real-book", chapter: 1, verse: 1 }), null)
})

test("OfflineVerseSource: returns null for a chapter or verse absent from the data, even for a known book", async () => {
  const source = new OfflineVerseSource(FIXTURE)
  assert.equal(await source.getVerse({ book: "john", chapter: 999, verse: 1 }), null)
  assert.equal(await source.getVerse({ book: "john", chapter: 3, verse: 999 }), null)
})

test("loadOfflineBibleData: reads and parses a real file from disk", async () => {
  const dir = await mkdtemp(join(tmpdir(), "churchoverlay-offline-bible-test-"))
  try {
    const filePath = join(dir, "fixture.json")
    await writeFile(filePath, JSON.stringify(FIXTURE))
    const data = await loadOfflineBibleData(filePath)
    assert.deepEqual(data, FIXTURE)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("loadOfflineBibleData: a missing file throws, rather than silently returning an empty dataset", async () => {
  await assert.rejects(() => loadOfflineBibleData("C:/definitely/does/not/exist.json"))
})
