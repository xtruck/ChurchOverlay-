import { test } from "node:test"
import assert from "node:assert/strict"
import { createServer, type IncomingMessage } from "node:http"
import type { AddressInfo } from "node:net"
import { LocalWhisperProvider, encodeWav } from "./local-whisper-provider"
import { WhisperServerProcess } from "./local-whisper-server"
import type { AudioFrame, TranscriptResult } from "../../../packages/contracts"

function frame(ms: number, level = 1000): AudioFrame {
  return { samples: Int16Array.from(new Array((16000 * ms) / 1000).fill(level)), sampleRate: 16000, sequence: 0 }
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks)
}

async function fakeWhisperServer(handler: (body: Buffer) => { status?: number; json: unknown; delayMs?: number }) {
  const requests: Buffer[] = []
  const server = createServer(async (req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" }).end('{"status":"ok"}')
      return
    }
    const body = await readBody(req)
    requests.push(body)
    const reply = handler(body)
    if (reply.delayMs) await new Promise((resolve) => setTimeout(resolve, reply.delayMs))
    res.writeHead(reply.status ?? 200, { "content-type": "application/json" }).end(JSON.stringify(reply.json))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return {
    requests,
    endpoint: { baseUrl, ensureStarted: async () => {}, stop: async () => {} },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

test("encodeWav: a valid 16 kHz mono PCM16 RIFF header", () => {
  const wav = Buffer.from(encodeWav(Int16Array.from([1, -1, 300])))
  assert.equal(wav.toString("ascii", 0, 4), "RIFF")
  assert.equal(wav.toString("ascii", 8, 12), "WAVE")
  assert.equal(wav.readUInt16LE(22), 1) // mono
  assert.equal(wav.readUInt32LE(24), 16000)
  assert.equal(wav.readUInt16LE(34), 16)
  assert.equal(wav.readUInt32LE(40), 6)
  assert.equal(wav.readInt16LE(48), 300)
})

test("LocalWhisperProvider: utterance end posts a WAV with language, prompt and json format; emits a final transcript", async () => {
  const fake = await fakeWhisperServer(() => ({ json: { text: "  Jean chapitre 3  verset 16 " } }))
  try {
    const provider = new LocalWhisperProvider({ server: fake.endpoint, language: "fr" })
    const results: TranscriptResult[] = []
    provider.onTranscript((r) => results.push(r))
    await provider.start()
    await provider.sendAudio(frame(1000))
    await provider.onUtteranceEnd()
    for (let i = 0; i < 50 && results.length === 0; i++) await new Promise((r) => setTimeout(r, 10))
    assert.equal(results[0]?.text, "Jean chapitre 3 verset 16")
    assert.equal(results[0]?.state, "final")
    const body = fake.requests[0]!.toString("latin1")
    assert.match(body, /name="file"; filename="audio.wav"/)
    assert.match(body, /RIFF/)
    assert.match(body, /name="language"\r\n\r\nfr/)
    assert.match(body, /name="response_format"\r\n\r\njson/)
    assert.match(body, /name="prompt"\r\n\r\nLecture biblique/)
  } finally {
    await fake.close()
  }
})

test("LocalWhisperProvider: too-short utterances are not sent", async () => {
  const fake = await fakeWhisperServer(() => ({ json: { text: "x" } }))
  try {
    const provider = new LocalWhisperProvider({ server: fake.endpoint })
    await provider.start()
    await provider.sendAudio(frame(300))
    await provider.onUtteranceEnd()
    await new Promise((r) => setTimeout(r, 50))
    assert.equal(fake.requests.length, 0)
  } finally {
    await fake.close()
  }
})

test("LocalWhisperProvider: an endless sentence is still cut at 8 s", async () => {
  const fake = await fakeWhisperServer(() => ({ json: { text: "long" } }))
  try {
    const provider = new LocalWhisperProvider({ server: fake.endpoint })
    await provider.start()
    for (let i = 0; i < 9; i++) await provider.sendAudio(frame(1000))
    for (let i = 0; i < 50 && fake.requests.length === 0; i++) await new Promise((r) => setTimeout(r, 10))
    assert.equal(fake.requests.length, 1)
  } finally {
    await fake.close()
  }
})

test("LocalWhisperProvider: a slow engine never builds an unbounded backlog (oldest dropped)", async () => {
  const fake = await fakeWhisperServer(() => ({ json: { text: "ok" }, delayMs: 120 }))
  try {
    const provider = new LocalWhisperProvider({ server: fake.endpoint })
    const results: TranscriptResult[] = []
    provider.onTranscript((r) => results.push(r))
    await provider.start()
    for (let i = 0; i < 6; i++) {
      await provider.sendAudio(frame(1000))
      await provider.onUtteranceEnd()
    }
    await new Promise((r) => setTimeout(r, 600))
    assert.ok(fake.requests.length <= 3, `sent ${fake.requests.length}`)
  } finally {
    await fake.close()
  }
})

test("LocalWhisperProvider: a server error is reported, empty text is silently skipped", async () => {
  let call = 0
  const fake = await fakeWhisperServer(() => (++call === 1 ? { status: 500, json: { error: "boom" } } : { json: { text: "   " } }))
  try {
    const provider = new LocalWhisperProvider({ server: fake.endpoint })
    const errors: Error[] = []
    const results: TranscriptResult[] = []
    provider.onError((e) => errors.push(e))
    provider.onTranscript((r) => results.push(r))
    await provider.start()
    await provider.sendAudio(frame(1000))
    await provider.onUtteranceEnd()
    await new Promise((r) => setTimeout(r, 80))
    await provider.sendAudio(frame(1000))
    await provider.onUtteranceEnd()
    await new Promise((r) => setTimeout(r, 80))
    assert.equal(errors.length, 1)
    assert.match(errors[0]!.message, /500/)
    assert.equal(results.length, 0)
  } finally {
    await fake.close()
  }
})

// Real engine check: runs only when a whisper-server binary and a model are
// provided (developer machine / manual CI job), skipped otherwise.
const realBin = process.env.WHISPER_SERVER_BIN
const realModel = process.env.WHISPER_MODEL
test("WhisperServerProcess + LocalWhisperProvider against the real whisper.cpp server", { skip: !realBin || !realModel }, async () => {
  const server = new WhisperServerProcess({ serverPath: realBin!, modelPath: realModel!, threads: 2 })
  try {
    await server.ensureStarted()
    assert.ok(server.baseUrl)
    const provider = new LocalWhisperProvider({ server, language: "fr" })
    const errors: Error[] = []
    provider.onError((e) => errors.push(e))
    await provider.start()
    await provider.sendAudio(frame(1500, 0))
    await provider.onUtteranceEnd()
    await new Promise((r) => setTimeout(r, 3000))
    assert.deepEqual(errors, [])
  } finally {
    await server.stop()
  }
})

// ---- Local pipeline improvements (ARCHITECTURE.md section 116) ----
import { findQuietCut } from "./local-whisper-provider"

function speechWithPause(totalMs: number, pauseAtMs: number, pauseMs = 200): Int16Array {
  const samples = new Int16Array((16000 * totalMs) / 1000).fill(3000)
  const from = (16000 * pauseAtMs) / 1000
  samples.fill(0, from, from + (16000 * pauseMs) / 1000)
  return samples
}

test("findQuietCut: lands inside a pause in the trailing speech, not at an arbitrary sample", () => {
  const samples = speechWithPause(8000, 7000)
  const cut = findQuietCut(samples) as number
  assert.ok(cut >= 16000 * 7.0 && cut <= 16000 * 7.2, `cut at ${cut / 16000}s should be inside the 7.0-7.2s pause`)
})

test("findQuietCut: continuous speech has no pause to cut at", () => {
  assert.equal(findQuietCut(new Int16Array(16000 * 8).fill(3000)), null)
})

test("LocalWhisperProvider: the prompt carries planned books, the book on screen and the previous sentence", async () => {
  const replies = ["Lisons Éphésiens chapitre 5", "verset 2"]
  const fake = await fakeWhisperServer(() => ({ json: { text: replies.shift() ?? "" } }))
  try {
    const provider = new LocalWhisperProvider({ server: fake.endpoint, language: "fr" })
    provider.setPlannedBooks(["1 corinthians"])
    provider.setCurrentVerseRef("ephesians 5:1")
    const results: TranscriptResult[] = []
    provider.onTranscript((r) => results.push(r))
    await provider.start()
    await provider.sendAudio(frame(1000))
    await provider.onUtteranceEnd()
    for (let i = 0; i < 50 && results.length < 1; i++) await new Promise((r) => setTimeout(r, 10))
    await provider.sendAudio(frame(1000))
    await provider.onUtteranceEnd()
    for (let i = 0; i < 50 && results.length < 2; i++) await new Promise((r) => setTimeout(r, 10))
    const first = fake.requests[0]!.toString("utf8")
    const second = fake.requests[1]!.toString("utf8")
    assert.match(first, /Corinthiens/)
    assert.match(first, /ph[eé]siens/i)
    assert.doesNotMatch(first, /Lisons Éphésiens chapitre 5/, "nothing to carry before the first sentence")
    assert.match(second, /Lisons Éphésiens chapitre 5/, "the previous sentence continues into the next prompt")
  } finally {
    await fake.close()
  }
})

test("LocalWhisperProvider: a forced cut after 8 s lands at the pause and the rest starts the next batch", async () => {
  const sizes: number[] = []
  const fake = await fakeWhisperServer((body) => {
    sizes.push(body.length)
    return { json: { text: "ok" } }
  })
  try {
    const provider = new LocalWhisperProvider({ server: fake.endpoint })
    provider.onTranscript(() => {})
    await provider.start()
    const samples = speechWithPause(8100, 7000)
    // Feed in 100 ms frames, like the real pipeline.
    for (let i = 0; i < samples.length; i += 1600) {
      await provider.sendAudio({ samples: samples.slice(i, i + 1600), sampleRate: 16000, sequence: i })
    }
    for (let i = 0; i < 50 && sizes.length < 1; i++) await new Promise((r) => setTimeout(r, 10))
    const wavBytes = sizes[0] as number
    // The WAV body is the cut audio plus multipart framing; a hard cut would carry ~8.0 s (256 KB).
    assert.ok(wavBytes < 16000 * 2 * 7.4 + 4000, `first batch (${wavBytes} bytes) should stop at the pause near 7.1 s, not run to 8 s`)
    assert.ok(wavBytes > 16000 * 2 * 6.9, "and it must still carry the speech before the pause")
  } finally {
    await fake.close()
  }
})
