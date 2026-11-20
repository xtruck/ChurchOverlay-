import { test } from "node:test"
import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import {
  DEFAULT_CONFIGURE_DEBOUNCE_MS,
  DEFAULT_CONFIGURE_MIN_INTERVAL_MS,
  DeepgramProvider,
  MAX_CONFIGURE_FAILURES_PER_CONNECTION,
  type DeepgramTimers,
} from "./deepgram-provider"
import { Logger } from "../../../packages/shared/logger"
import type { AsrContextHints } from "../../../packages/contracts"

/** Named per AGENTS.md section 45: a test double for the ws socket, never a network. */
class FakeDeepgramSocket extends EventEmitter {
  static readonly OPEN = 1
  static readonly CONNECTING = 0
  static instances: FakeDeepgramSocket[] = []
  readonly sent: string[] = []
  readonly url: string
  readyState = FakeDeepgramSocket.OPEN
  throwOnSend = false
  constructor(url: string) {
    super()
    this.url = url
    FakeDeepgramSocket.instances.push(this)
    queueMicrotask(() => this.emit("open"))
  }
  send(data: Buffer | string): void {
    if (this.throwOnSend) throw new Error("socket send failed")
    if (typeof data === "string") this.sent.push(data)
  }
  close(): void {
    this.readyState = 3
    this.emit("close")
  }
  configures(): string[][] {
    return this.sent
      .map((raw) => JSON.parse(raw) as { type?: string; keyterms?: string[] })
      .filter((message) => message.type === "Configure")
      .map((message) => message.keyterms ?? [])
  }
}

/** Deterministic clock + one-shot timers. */
function fakeTime() {
  let now = 1_000_000
  let nextId = 1
  const pending = new Map<number, { at: number; run: () => void }>()
  const timers: DeepgramTimers = {
    setTimeout(callback, ms) {
      const id = nextId++
      pending.set(id, { at: now + ms, run: callback })
      return id
    },
    clearTimeout(handle) {
      pending.delete(handle as number)
    },
  }
  const advance = (ms: number) => {
    const target = now + ms
    for (;;) {
      const due = [...pending.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0]
      if (!due) break
      pending.delete(due[0])
      now = due[1].at
      due[1].run()
    }
    now = target
  }
  return { timers, advance, now: () => now, pendingCount: () => pending.size }
}

function capturingLogger(): { logger: Logger; events: { event: string; metadata?: Record<string, unknown> }[] } {
  const events: { event: string; metadata?: Record<string, unknown> }[] = []
  const logger = new Logger({ minLevel: "debug", write: (line) => events.push(JSON.parse(line)) })
  return { logger, events }
}

const hints = (focusBooks: string[], plannedBooks: string[] = []): AsrContextHints => ({ focusBooks, plannedBooks })

async function openProvider(options: { model?: string; language?: string } = {}) {
  FakeDeepgramSocket.instances = []
  const time = fakeTime()
  const { logger, events } = capturingLogger()
  const provider = new DeepgramProvider({
    apiKey: "k",
    model: options.model ?? "nova-3",
    language: options.language ?? "fr",
    WebSocketImpl: FakeDeepgramSocket as never,
    keepAliveIntervalMs: 0,
    timers: time.timers,
    now: time.now,
    logger,
  })
  await provider.start()
  const socket = FakeDeepgramSocket.instances[0]!
  return { provider, socket, time, events }
}

test("DeepgramProvider hints: a changed list is sent once as a mid-stream Configure after the debounce, replacing the whole list", async () => {
  const { provider, socket, time, events } = await openProvider()
  provider.setContextHints(hints(["john"], ["romans"]))
  assert.equal(socket.configures().length, 0, "nothing before the debounce")
  time.advance(DEFAULT_CONFIGURE_DEBOUNCE_MS - 1)
  assert.equal(socket.configures().length, 0)
  time.advance(1)
  const [sent] = socket.configures()
  assert.ok(sent, "one Configure")
  assert.equal(sent[0], "Jean", "the focus book is the most relevant term")
  assert.ok(sent.includes("Romains"))
  assert.ok(sent.includes("Deutéronome"), "the static vocabulary is kept: Configure replaces the whole list")
  assert.equal(FakeDeepgramSocket.instances.length, 1, "no reconnect")
  assert.ok(events.some((e) => e.event === "deepgram.keyterms-configured" && e.metadata?.added === 2))
  await provider.stop()
})

test("DeepgramProvider hints: a burst of changes produces one Configure carrying the latest hints", async () => {
  const { provider, socket, time } = await openProvider()
  provider.setContextHints(hints(["john"]))
  time.advance(500)
  provider.setContextHints(hints(["romans", "john"]))
  provider.setContextHints(hints(["acts", "romans"]))
  time.advance(DEFAULT_CONFIGURE_DEBOUNCE_MS)
  assert.equal(socket.configures().length, 1)
  assert.equal(socket.configures()[0]![0], "Actes")
  await provider.stop()
})

test("DeepgramProvider hints: never more than one Configure per minimum interval", async () => {
  const { provider, socket, time } = await openProvider()
  provider.setContextHints(hints(["john"]))
  time.advance(DEFAULT_CONFIGURE_DEBOUNCE_MS)
  assert.equal(socket.configures().length, 1)
  provider.setContextHints(hints(["romans"]))
  time.advance(DEFAULT_CONFIGURE_MIN_INTERVAL_MS - 1)
  assert.equal(socket.configures().length, 1, "held back by the minimum interval")
  time.advance(1)
  assert.equal(socket.configures().length, 2)
  // Sustained churn: at most one message per interval.
  for (let i = 0; i < 50; i++) {
    provider.setContextHints(hints([i % 2 === 0 ? "acts" : "luke"]))
    time.advance(1_000)
  }
  assert.ok(socket.configures().length <= 2 + Math.ceil(50_000 / DEFAULT_CONFIGURE_MIN_INTERVAL_MS))
  await provider.stop()
})

test("DeepgramProvider hints: an unchanged term list sends nothing and arms no timer", async () => {
  const { provider, socket, time } = await openProvider()
  provider.setContextHints(hints([], []))
  assert.equal(time.pendingCount(), 0, "empty hints = the list the stream already has")
  provider.setContextHints(hints(["john"]))
  time.advance(DEFAULT_CONFIGURE_DEBOUNCE_MS)
  assert.equal(socket.configures().length, 1)
  provider.setContextHints(hints(["john"]))
  provider.setContextHints({ focusBooks: ["john"], plannedBooks: ["john"] })
  assert.equal(time.pendingCount(), 0)
  time.advance(DEFAULT_CONFIGURE_MIN_INTERVAL_MS * 3)
  assert.equal(socket.configures().length, 1)
  await provider.stop()
})

test("DeepgramProvider hints: a change that reverts before the timer fires sends nothing", async () => {
  const { provider, socket, time } = await openProvider()
  provider.setContextHints(hints(["john"]))
  provider.setContextHints(hints([]))
  time.advance(DEFAULT_CONFIGURE_DEBOUNCE_MS)
  assert.equal(socket.configures().length, 0)
  await provider.stop()
})

test("DeepgramProvider hints: with no open socket the hints are stored for the next connect's URL, never sent", async () => {
  FakeDeepgramSocket.instances = []
  const time = fakeTime()
  const provider = new DeepgramProvider({
    apiKey: "k",
    model: "nova-3",
    language: "fr",
    WebSocketImpl: FakeDeepgramSocket as never,
    keepAliveIntervalMs: 0,
    timers: time.timers,
    now: time.now,
  })
  provider.setContextHints(hints(["john"]))
  assert.equal(time.pendingCount(), 0, "not connected: nothing scheduled")
  assert.ok(new URL(provider.buildUrl()).searchParams.getAll("keyterm").includes("Jean"))
  await provider.start()
  const socket = FakeDeepgramSocket.instances[0]!
  assert.ok(new URL(socket.url).searchParams.getAll("keyterm").includes("Jean"), "applied at connect")
  time.advance(DEFAULT_CONFIGURE_MIN_INTERVAL_MS)
  assert.equal(socket.configures().length, 0, "already in the URL: no Configure")
  await provider.stop()
})

test("DeepgramProvider hints: a socket closed before the timer fires gets nothing; stop() cancels the timer", async () => {
  const { provider, socket, time } = await openProvider()
  provider.onError(() => {})
  provider.setContextHints(hints(["john"]))
  assert.equal(time.pendingCount(), 1)
  socket.readyState = 3 // closing, close event not yet delivered
  time.advance(DEFAULT_CONFIGURE_DEBOUNCE_MS)
  assert.equal(socket.configures().length, 0)

  const second = await openProvider()
  second.provider.setContextHints(hints(["john"]))
  await second.provider.stop()
  assert.equal(second.time.pendingCount(), 0, "stop() clears the pending Configure")
  second.time.advance(DEFAULT_CONFIGURE_MIN_INTERVAL_MS)
  assert.equal(second.socket.configures().length, 0)
})

test("DeepgramProvider hints: hints changed while connecting are sent once the socket opens", async () => {
  FakeDeepgramSocket.instances = []
  const time = fakeTime()
  const provider = new DeepgramProvider({
    apiKey: "k",
    model: "nova-3",
    language: "fr",
    WebSocketImpl: FakeDeepgramSocket as never,
    keepAliveIntervalMs: 0,
    timers: time.timers,
    now: time.now,
  })
  const starting = provider.start() // URL built now, without "Jean"
  provider.setContextHints(hints(["john"]))
  await starting
  const socket = FakeDeepgramSocket.instances[0]!
  assert.ok(!new URL(socket.url).searchParams.getAll("keyterm").includes("Jean"))
  time.advance(DEFAULT_CONFIGURE_DEBOUNCE_MS)
  assert.equal(socket.configures().length, 1)
  assert.ok(socket.configures()[0]!.includes("Jean"))
  await provider.stop()
})

test("DeepgramProvider hints: a send that throws is logged, not reported as an ASR error (no failover), and not retried in a loop", async () => {
  const { provider, socket, time, events } = await openProvider()
  const errors: Error[] = []
  provider.onError((error) => errors.push(error))
  socket.throwOnSend = true
  provider.setContextHints(hints(["john"]))
  time.advance(DEFAULT_CONFIGURE_DEBOUNCE_MS)
  assert.equal(errors.length, 0)
  assert.ok(events.some((e) => e.event === "deepgram.keyterms-configure-send-failed"))
  assert.equal(time.pendingCount(), 0, "no automatic retry")
  socket.throwOnSend = false
  await provider.stop()
})

test("DeepgramProvider hints: ConfigureFailure restores the previous list, is logged, and after repeated failures Configure stops for that connection", async () => {
  const { provider, socket, time, events } = await openProvider()
  const errors: Error[] = []
  provider.onError((error) => errors.push(error))
  const fail = () => socket.emit("message", Buffer.from(JSON.stringify({ type: "ConfigureFailure", code: "CONFIGURE_KEYTERM_LIMIT_EXCEEDED" })))
  const books = ["john", "romans", "acts", "luke"]
  for (let i = 0; i < MAX_CONFIGURE_FAILURES_PER_CONNECTION; i++) {
    provider.setContextHints(hints([books[i]!]))
    time.advance(DEFAULT_CONFIGURE_MIN_INTERVAL_MS)
    assert.equal(socket.configures().length, i + 1)
    fail()
  }
  assert.equal(errors.length, 0, "a refused hint is never an ASR error")
  const failed = events.filter((e) => e.event === "deepgram.keyterms-configure-failed")
  assert.equal(failed.length, MAX_CONFIGURE_FAILURES_PER_CONNECTION)
  assert.equal(failed[0]?.metadata?.code, "CONFIGURE_KEYTERM_LIMIT_EXCEEDED")
  assert.ok(events.some((e) => e.event === "deepgram.keyterms-configure-disabled"))
  provider.setContextHints(hints([books[3]!]))
  time.advance(DEFAULT_CONFIGURE_MIN_INTERVAL_MS * 2)
  assert.equal(socket.configures().length, MAX_CONFIGURE_FAILURES_PER_CONNECTION, "disabled on this connection")
  await provider.stop()
})

test("DeepgramProvider hints: after a ConfigureFailure the same list can be sent again on the next change (the stream kept the old one)", async () => {
  const { provider, socket, time } = await openProvider()
  provider.setContextHints(hints(["john"]))
  time.advance(DEFAULT_CONFIGURE_DEBOUNCE_MS)
  socket.emit("message", Buffer.from(JSON.stringify({ type: "ConfigureFailure" })))
  provider.setContextHints(hints(["john"]))
  time.advance(DEFAULT_CONFIGURE_MIN_INTERVAL_MS)
  assert.equal(socket.configures().length, 2)
  await provider.stop()
})

test("DeepgramProvider hints: a ConfigureFailure message never reaches the transcript path", async () => {
  const { provider, socket } = await openProvider()
  const results: unknown[] = []
  provider.onTranscript((result) => results.push(result))
  socket.emit("message", Buffer.from(JSON.stringify({ type: "ConfigureFailure", code: 7 })))
  assert.deepEqual(results, [])
  await provider.stop()
})

test("DeepgramProvider hints: nova-2 (keywords) has no documented mid-stream update, so hints wait for the next connect and that is logged", async () => {
  const { provider, socket, time, events } = await openProvider({ model: "nova-2" })
  provider.setContextHints(hints(["john"]))
  time.advance(DEFAULT_CONFIGURE_MIN_INTERVAL_MS)
  assert.equal(socket.configures().length, 0)
  assert.ok(events.some((e) => e.event === "deepgram.keyterms-deferred"))
  assert.ok(new URL(provider.buildUrl()).searchParams.getAll("keywords").includes("Jean:2"), "next connect carries them")
  await provider.stop()
})

test("DeepgramProvider hints: language=multi upgrades to nova-3, so Configure is used, with both names of the focus book", async () => {
  const { provider, socket, time } = await openProvider({ model: "nova-2", language: "multi" })
  provider.setContextHints(hints(["john"]))
  time.advance(DEFAULT_CONFIGURE_DEBOUNCE_MS)
  const sent = socket.configures()[0]
  assert.ok(sent)
  assert.deepEqual(sent.slice(0, 2), ["Jean", "John"])
  await provider.stop()
})

test("DeepgramProvider hints: the term list is sanitized, deduplicated and bounded", async () => {
  const { provider } = await openProvider({ language: "multi" })
  const all66 = [
    "genesis", "exodus", "leviticus", "numbers", "deuteronomy", "joshua", "judges", "ruth", "1 samuel", "2 samuel",
    "1 kings", "2 kings", "1 chronicles", "2 chronicles", "ezra", "nehemiah", "esther", "job", "psalm", "proverbs",
    "isaiah", "jeremiah", "matthew", "mark", "luke", "john", "acts", "romans", "hebrews", "revelation",
  ]
  provider.setContextHints({ focusBooks: ["john"], plannedBooks: all66 })
  const terms = provider.currentKeyterms()
  assert.ok(terms.length <= 80)
  assert.equal(new Set(terms.map((t) => t.toLowerCase())).size, terms.length, "no duplicates")
  assert.ok(terms.every((t) => !/[,;:]/.test(t) && t === t.trim() && t.length > 0))
  assert.deepEqual(terms.slice(0, 2), ["Jean", "John"], "focus first")
  await provider.stop()
})

test("DeepgramProvider hints: malformed hints are tolerated (non-string ids dropped, never thrown)", async () => {
  const { provider } = await openProvider()
  assert.doesNotThrow(() => provider.setContextHints({ focusBooks: [7, "john", null] as unknown as string[], plannedBooks: "x" as unknown as string[] }))
  assert.equal(provider.currentKeyterms()[0], "Jean")
  assert.doesNotThrow(() => provider.setContextHints({ focusBooks: ["not-a-book"], plannedBooks: [] }))
  await provider.stop()
})
