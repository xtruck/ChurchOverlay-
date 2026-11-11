import { test } from "node:test"
import assert from "node:assert/strict"
import { WebSocket } from "ws"
import { startAppCore } from "./app-core"
import { RegexDetector } from "../detector/regex-detector"
import { KnownValidVerseIndex } from "../verse/known-valid-verse-index"
import { BibleWordSearch } from "../verse/bible-word-search"
import { Logger } from "../../../packages/shared/logger"
import type { AsrProvider, AudioFrame, TranscriptResult, Verse, VerseReference, VerseSource, WsMessage } from "../../../packages/contracts"

// Bible Browser (audit-notes/bible-browser.md): the WS commands bible:chapter, bible:search and
// verse:navigate, end to end through a real AppCore + WebSocket server.

const TOKENS = { operatorToken: "op-token", viewerToken: "viewer-token" }

class FakeAsrProvider implements AsrProvider {
  async start(): Promise<void> {}
  async sendAudio(_audio: AudioFrame): Promise<void> {}
  async stop(): Promise<void> {}
  onTranscript(_callback: (result: TranscriptResult) => void): void {}
  onError(_callback: (error: Error) => void): void {}
}

/** A chapter-capable source counting its calls. Chapters of 4 verses for every book. */
class ChapterStubSource implements VerseSource {
  verseCalls = 0
  chapterCalls = 0
  async getVerse(reference: VerseReference): Promise<Verse | null> {
    this.verseCalls += 1
    return { reference, text: `text ${reference.book} ${reference.chapter}:${reference.verse}`, translation: "kjv", source: "stub" }
  }
  async getChapter(book: string, chapter: number): Promise<readonly Verse[] | null> {
    this.chapterCalls += 1
    return [1, 2, 3, 4].map((verse) => ({
      reference: { book, chapter, verse },
      text: `text ${book} ${chapter}:${verse}`,
      translation: "kjv",
      source: "stub",
    }))
  }
}

const SEARCH_FIXTURE = {
  jean: {
    "3": {
      "16": "Car Dieu a tant aimé le monde qu'il a donné son Fils unique, afin que quiconque croit en lui ne périsse point.",
      "17": "Dieu, en effet, n'a pas envoyé son Fils dans le monde pour qu'il juge le monde.",
    },
  },
}

function silentLogger(): Logger {
  return new Logger({ write: () => {} })
}

async function connect(port: number, token: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`, [token])
    socket.once("open", () => resolve(socket))
    socket.once("error", reject)
  })
}

const NOISE = new Set(["transcript:partial", "transcript:final", "layout:update", "branding:update", "overlay:style", "status:update"])

function waitForType(socket: WebSocket, type: string, timeoutMs = 2000): Promise<WsMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off("message", handler)
      reject(new Error(`timed out waiting for ${type}`))
    }, timeoutMs)
    const handler = (data: { toString(): string }) => {
      const message = JSON.parse(data.toString()) as WsMessage
      if (NOISE.has(message.type) || message.type !== type) return
      clearTimeout(timer)
      socket.off("message", handler)
      resolve(message)
    }
    socket.on("message", handler)
  })
}

function send(socket: WebSocket, type: string, payload: unknown): void {
  socket.send(JSON.stringify({ id: `id-${Math.random()}`, type, timestamp: Date.now(), payload }))
}

async function startApp(source: VerseSource, extra: Record<string, unknown> = {}) {
  return startAppCore({
    asr: new FakeAsrProvider(),
    detector: new RegexDetector(),
    index: new KnownValidVerseIndex(),
    source,
    logger: silentLogger(),
    port: 0,
    tokens: TOKENS,
    ...extra,
  })
}

test("bible:chapter answers the operator only, bounded, and a repeat is served from the chapter cache", async () => {
  const source = new ChapterStubSource()
  const app = await startApp(source)
  try {
    const viewer = await connect(app.wsServer.port, TOKENS.viewerToken)
    const operator = await connect(app.wsServer.port, TOKENS.operatorToken)
    const viewerTypes: string[] = []
    viewer.on("message", (data) => viewerTypes.push((JSON.parse(data.toString()) as WsMessage).type))

    const first = waitForType(operator, "bible:chapter-result")
    send(operator, "bible:chapter", { seq: 1, book: "john", chapter: 3 })
    const message = await first
    const payload = message.payload as { seq: number; verses: Array<{ verse: number; text: string }>; translation: string }
    assert.equal(payload.seq, 1)
    assert.deepEqual(payload.verses.map((v) => v.verse), [1, 2, 3, 4])
    assert.equal(payload.translation, "kjv")

    const second = waitForType(operator, "bible:chapter-result")
    send(operator, "bible:chapter", { seq: 2, book: "john", chapter: 3 })
    assert.equal(((await second).payload as { seq: number }).seq, 2)
    assert.equal(source.chapterCalls, 1, "the second read of the same chapter must come from the cache")

    await new Promise((resolve) => setTimeout(resolve, 80))
    assert.ok(!viewerTypes.includes("bible:chapter-result"), "a viewer must never receive Bible Browser data")
    assert.ok(!viewerTypes.includes("verse:show"), "reading a chapter must never change the screen")
    operator.close()
    viewer.close()
  } finally {
    await app.stop()
  }
})

test("bible:chapter for a chapter the known-valid index rejects is not-found and never reaches the source", async () => {
  const source = new ChapterStubSource()
  const app = await startApp(source)
  try {
    const operator = await connect(app.wsServer.port, TOKENS.operatorToken)
    const answer = waitForType(operator, "bible:chapter-result")
    send(operator, "bible:chapter", { seq: 5, book: "john", chapter: 99 })
    const payload = (await answer).payload as { verses: unknown; reason: string }
    assert.equal(payload.verses, null)
    assert.equal(payload.reason, "not-found")
    assert.equal(source.chapterCalls + source.verseCalls, 0)
    operator.close()
  } finally {
    await app.stop()
  }
})

test("bible:chapter from a source that fails answers unavailable (an outage is never 'no such chapter')", async () => {
  const failing: VerseSource & { getChapter(): Promise<never> } = {
    getVerse: async () => {
      throw new Error("down")
    },
    getChapter: async () => {
      throw new Error("down")
    },
  }
  const app = await startApp(failing)
  try {
    const operator = await connect(app.wsServer.port, TOKENS.operatorToken)
    const answer = waitForType(operator, "bible:chapter-result")
    send(operator, "bible:chapter", { seq: 1, book: "genesis", chapter: 1 })
    assert.equal(((await answer).payload as { reason: string }).reason, "unavailable")
    operator.close()
  } finally {
    await app.stop()
  }
})

test("a viewer cannot send bible:chapter, bible:search or verse:navigate", async () => {
  const source = new ChapterStubSource()
  const app = await startApp(source)
  try {
    const viewer = await connect(app.wsServer.port, TOKENS.viewerToken)
    send(viewer, "bible:chapter", { seq: 1, book: "john", chapter: 3 })
    send(viewer, "bible:search", { seq: 1, query: "amour" })
    send(viewer, "verse:navigate", { direction: "next-verse" })
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(source.chapterCalls + source.verseCalls, 0)
    viewer.close()
  } finally {
    await app.stop()
  }
})

test("verse:navigate is a no-op with nothing on screen, then steps from the SERVER's position with the navigation trigger", async () => {
  const source = new ChapterStubSource()
  const app = await startApp(source)
  try {
    const viewer = await connect(app.wsServer.port, TOKENS.viewerToken)
    const operator = await connect(app.wsServer.port, TOKENS.operatorToken)
    const shown: WsMessage[] = []
    viewer.on("message", (data) => {
      const message = JSON.parse(data.toString()) as WsMessage
      if (message.type === "verse:show") shown.push(message)
    })

    send(operator, "verse:navigate", { direction: "next-verse" })
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(shown.length, 0, "no position -> nothing is shown, nothing is guessed")

    send(operator, "verse:override", { book: "john", chapter: 3, verse: 16 })
    await waitFor(() => shown.length === 1)
    send(operator, "verse:navigate", { direction: "next-verse" })
    await waitFor(() => shown.length === 2)
    const next = shown[1]?.payload as { reference: VerseReference; trigger: string }
    assert.deepEqual(next.reference, { book: "john", chapter: 3, verse: 17 })
    assert.equal(next.trigger, "navigation")

    send(operator, "verse:navigate", { direction: "next-chapter" })
    await waitFor(() => shown.length === 3)
    assert.deepEqual((shown[2]?.payload as { reference: VerseReference }).reference, { book: "john", chapter: 4, verse: 1 })

    send(operator, "verse:navigate", { direction: "previous-chapter" })
    await waitFor(() => shown.length === 4)
    assert.deepEqual((shown[3]?.payload as { reference: VerseReference }).reference, { book: "john", chapter: 3, verse: 1 })
    operator.close()
    viewer.close()
  } finally {
    await app.stop()
  }
})

test("verse:navigate does not move past the end of the Bible (Revelation 22:21 has no next)", async () => {
  const source = new ChapterStubSource()
  const app = await startApp(source)
  try {
    const viewer = await connect(app.wsServer.port, TOKENS.viewerToken)
    const operator = await connect(app.wsServer.port, TOKENS.operatorToken)
    const shown: WsMessage[] = []
    viewer.on("message", (data) => {
      const message = JSON.parse(data.toString()) as WsMessage
      if (message.type === "verse:show") shown.push(message)
    })
    send(operator, "verse:override", { book: "revelation", chapter: 22, verse: 21 })
    await waitFor(() => shown.length === 1)
    send(operator, "verse:navigate", { direction: "next-verse" })
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(shown.length, 1)
    operator.close()
    viewer.close()
  } finally {
    await app.stop()
  }
})

test("bible:search finds a French verse by a few of its words, answers the operator only, and says what was searched", async () => {
  const search = new BibleWordSearch(SEARCH_FIXTURE)
  const app = await startApp(new ChapterStubSource(), { bibleWordSearch: { current: () => search } })
  try {
    const viewer = await connect(app.wsServer.port, TOKENS.viewerToken)
    const operator = await connect(app.wsServer.port, TOKENS.operatorToken)
    const viewerTypes: string[] = []
    viewer.on("message", (data) => viewerTypes.push((JSON.parse(data.toString()) as WsMessage).type))
    const answer = waitForType(operator, "bible:search-result")
    send(operator, "bible:search", { seq: 3, query: "tant aimé le monde" })
    const payload = (await answer).payload as { seq: number; hits: Array<{ reference: VerseReference }>; coverage: { french: string } }
    assert.equal(payload.seq, 3)
    assert.deepEqual(payload.hits[0]?.reference, { book: "john", chapter: 3, verse: 16 })
    assert.equal(payload.coverage.french, "offline")
    await new Promise((resolve) => setTimeout(resolve, 60))
    assert.ok(!viewerTypes.includes("bible:search-result"))
    operator.close()
    viewer.close()
  } finally {
    await app.stop()
  }
})

test("bible:search says 'indexing' while the index is still being built, and rejects a too-short query", async () => {
  const app = await startApp(new ChapterStubSource(), { bibleWordSearch: { current: () => null } })
  try {
    const operator = await connect(app.wsServer.port, TOKENS.operatorToken)
    let answer = waitForType(operator, "bible:search-result")
    send(operator, "bible:search", { seq: 1, query: "amour" })
    const payload = (await answer).payload as { coverage: { french: string }; hits: unknown[] }
    assert.equal(payload.coverage.french, "indexing")
    assert.equal(payload.hits.length, 0)

    answer = waitForType(operator, "bible:search-result")
    send(operator, "bible:search", { seq: 2, query: "a" })
    const tooShort = (await answer).payload as { reason?: string }
    assert.equal(tooShort.reason, "too-short")
    operator.close()
  } finally {
    await app.stop()
  }
})

test("bible:search also searches chapters already read this session (the only English text there is)", async () => {
  const app = await startApp(new ChapterStubSource())
  try {
    const operator = await connect(app.wsServer.port, TOKENS.operatorToken)
    const chapter = waitForType(operator, "bible:chapter-result")
    send(operator, "bible:chapter", { seq: 1, book: "john", chapter: 3 })
    await chapter
    const answer = waitForType(operator, "bible:search-result")
    send(operator, "bible:search", { seq: 2, query: "text john 3:2" })
    const payload = (await answer).payload as { hits: Array<{ reference: VerseReference; translation: string }>; coverage: { loadedChapters: number; french: string } }
    assert.equal(payload.coverage.loadedChapters, 1)
    assert.equal(payload.coverage.french, "unavailable")
    assert.ok(payload.hits.length > 0)
    assert.equal(payload.hits[0]?.translation, "kjv")
    operator.close()
  } finally {
    await app.stop()
  }
})

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor() timed out")
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

test("verse:navigate that puts nothing on screen tells the operator why (no position, end of the Bible), never viewers", async () => {
  const app = await startApp(new ChapterStubSource())
  try {
    const viewer = await connect(app.wsServer.port, TOKENS.viewerToken)
    const operator = await connect(app.wsServer.port, TOKENS.operatorToken)
    const viewerTypes: string[] = []
    viewer.on("message", (data) => viewerTypes.push((JSON.parse(data.toString()) as WsMessage).type))
    let answer = waitForType(operator, "verse:navigate-result")
    send(operator, "verse:navigate", { direction: "next-verse" })
    assert.equal(((await answer).payload as { reason: string }).reason, "no-position")

    send(operator, "verse:override", { book: "revelation", chapter: 22, verse: 21 })
    await waitFor(() => viewerTypes.includes("verse:show"))
    answer = waitForType(operator, "verse:navigate-result")
    send(operator, "verse:navigate", { direction: "next-verse" })
    assert.equal(((await answer).payload as { reason: string }).reason, "boundary")
    assert.ok(!viewerTypes.includes("verse:navigate-result"))
    operator.close()
    viewer.close()
  } finally {
    await app.stop()
  }
})

test("verse:navigate whose verse cannot be loaded answers 'unavailable' and leaves the screen unchanged", async () => {
  let fail = false
  const flaky: VerseSource = {
    getVerse: async (reference) => {
      if (fail) throw new Error("down")
      return { reference, text: "t", translation: "kjv", source: "s" }
    },
  }
  const app = await startApp(flaky)
  try {
    const operator = await connect(app.wsServer.port, TOKENS.operatorToken)
    const shown = waitForType(operator, "verse:show").catch(() => null)
    send(operator, "verse:override", { book: "john", chapter: 3, verse: 16 })
    await new Promise((resolve) => setTimeout(resolve, 100))
    void shown
    fail = true
    const answer = waitForType(operator, "verse:navigate-result")
    send(operator, "verse:navigate", { direction: "next-verse" })
    assert.equal(((await answer).payload as { reason: string }).reason, "unavailable")
    operator.close()
  } finally {
    await app.stop()
  }
})

test("bible:search reports a failed French index as unavailable, not indexing", async () => {
  const app = await startApp(new ChapterStubSource(), { bibleWordSearch: { current: () => null, failed: () => true } })
  try {
    const operator = await connect(app.wsServer.port, TOKENS.operatorToken)
    const answer = waitForType(operator, "bible:search-result")
    send(operator, "bible:search", { seq: 1, query: "amour" })
    assert.equal(((await answer).payload as { coverage: { french: string } }).coverage.french, "unavailable")
    operator.close()
  } finally {
    await app.stop()
  }
})
