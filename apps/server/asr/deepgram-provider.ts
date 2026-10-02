import { isPlainObject } from "../../../packages/shared/type-guards"
import { WebSocket } from "ws"
import type { AsrProvider, AudioFrame, TranscriptResult } from "../../../packages/contracts"
import { generateUlid } from "../../../packages/shared/ulid"
import { biblicalVocabularyFor, plannedBookTerms } from "./biblical-vocabulary"

const DEFAULT_MODEL = "nova-2"
const DEFAULT_URL = "wss://api.deepgram.com/v1/listen"
/**
 * Deepgram closes a streaming socket that receives neither audio nor a
 * KeepAlive for ~10 s (its NET-0001 close). SilenceGate deliberately stops
 * forwarding frames during silence, so without a keepalive every pause
 * longer than ~10 s (a prayer, a song, the preacher walking to the pulpit)
 * killed the connection and surfaced as "closed unexpectedly". 4 s leaves
 * comfortable margin for timer jitter on a busy machine.
 */
const DEFAULT_KEEPALIVE_MS = 4000
/**
 * How long a pause Deepgram's own endpointer waits before marking a result
 * final. Its default (10 ms) finalizes mid-phrase on the smallest breath;
 * 300 ms tolerates the pause between "Jean chapitre 3" and "verset 16" in
 * real preaching without noticeably delaying the final.
 */
const DEFAULT_ENDPOINTING_MS = 300
/**
 * ARCHITECTURE.md section 104: upper bound on planned-book keyterms added
 * per connection — a real rundown rarely names more than a handful of
 * distinct books, and biblical-vocabulary.ts documents why a long boost
 * list degrades general accuracy.
 */
const MAX_PLANNED_BOOK_TERMS = 15
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000

export type DeepgramProviderOptions = {
  readonly apiKey: string
  readonly model?: string
  readonly language?: string
  readonly url?: string
  readonly WebSocketImpl?: typeof WebSocket
  readonly keepAliveIntervalMs?: number
  /** Longest wait for the WebSocket to open before start() fails. Default 10 s. */
  readonly connectTimeoutMs?: number
  readonly endpointingMs?: number
  /** Boosts Bible book names and "chapitre/verset" (see biblical-vocabulary.ts). Default true. */
  readonly biblicalVocabulary?: boolean
}

type DeepgramMessage = {
  readonly type?: string
  readonly is_final?: boolean
  readonly speech_final?: boolean
  readonly channel?: {
    readonly alternatives?: readonly { readonly transcript?: string; readonly confidence?: number }[]
  }
}

/**
 * Streaming Deepgram adapter. Audio remains canonical PCM16/16kHz at the
 * boundary; only this provider knows the WebSocket protocol and query shape.
 */
export class DeepgramProvider implements AsrProvider {
  private readonly apiKey: string
  private readonly model: string
  private readonly url: string
  private readonly WebSocketImpl: typeof WebSocket
  private readonly keepAliveIntervalMs: number
  private readonly endpointingMs: number
  private readonly connectTimeoutMs: number
  private readonly biblicalVocabulary: boolean
  private language: string | undefined
  private socket: WebSocket | null = null
  private keepAliveTimer: ReturnType<typeof setInterval> | null = null
  private lastSendAt = 0
  private active = false
  private sequence = 0
  private correlationId = ""
  private transcriptCallback: ((result: TranscriptResult) => void) | null = null
  private errorCallback: ((error: Error) => void) | null = null
  private currentVerseRef: string | null = null
  private plannedBookIds: readonly string[] = []

  constructor(options: DeepgramProviderOptions) {
    if (!options.apiKey.trim()) throw new Error("DeepgramProvider requires an apiKey")
    this.apiKey = options.apiKey
    this.model = options.model ?? DEFAULT_MODEL
    this.language = options.language
    this.url = options.url ?? DEFAULT_URL
    this.WebSocketImpl = options.WebSocketImpl ?? WebSocket
    this.keepAliveIntervalMs = options.keepAliveIntervalMs ?? DEFAULT_KEEPALIVE_MS
    this.endpointingMs = options.endpointingMs ?? DEFAULT_ENDPOINTING_MS
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS
    this.biblicalVocabulary = options.biblicalVocabulary ?? true
  }

  /** Takes effect on the next start() — Deepgram fixes language per connection. */
  setLanguage(language: string | undefined): void {
    this.language = language
  }

  onTranscript(callback: (result: TranscriptResult) => void): void {
    this.transcriptCallback = callback
  }

  onError(callback: (error: Error) => void): void {
    this.errorCallback = callback
  }

  setCurrentVerseRef(reference: string | null): void {
    this.currentVerseRef = reference
  }

  /**
   * ARCHITECTURE.md section 104: book ids from a loaded Service Rundown.
   * A rundown entry is an explicit, operator-confirmed signal, so unlike
   * the module-level biblicalVocabulary list, common book names are
   * included here too. Deepgram fixes keyterms per connection — this takes
   * effect on the NEXT start(), never as a live reconnect, so it never
   * interrupts audio already streaming mid-service.
   */
  setPlannedBooks(bookIds: readonly string[]): void {
    this.plannedBookIds = bookIds
  }

  /** The exact streaming URL start() opens. Contains no secret — the key travels in a header. */
  buildUrl(): string {
    const query = new URLSearchParams({
      model: this.model,
      encoding: "linear16",
      sample_rate: "16000",
      channels: "1",
      interim_results: "true",
      smart_format: "true",
      endpointing: String(this.endpointingMs),
    })
    if (this.language) query.set("language", this.language)
    // nova-3 replaced weighted `keywords` with plain `keyterm` prompting.
    const nova3 = this.model.startsWith("nova-3")
    const appendTerm = (term: string) => query.append(nova3 ? "keyterm" : "keywords", nova3 ? term : `${term}:2`)
    if (this.biblicalVocabulary) {
      for (const term of biblicalVocabularyFor(this.language)) appendTerm(term)
    }
    const planned = new Set(plannedBookTerms(this.plannedBookIds, this.language))
    let count = 0
    for (const term of planned) {
      if (count >= MAX_PLANNED_BOOK_TERMS) break
      appendTerm(term)
      count++
    }
    return `${this.url}?${query.toString()}`
  }

  async start(): Promise<void> {
    if (this.active) return
    this.active = true
    this.sequence = 0
    this.correlationId = generateUlid()
    const socket = new this.WebSocketImpl(this.buildUrl(), {
      headers: { Authorization: `Token ${this.apiKey}` },
    })
    this.socket = socket
    socket.on("message", (data) => this.handleMessage(data.toString()))
    socket.on("error", (error) => this.reportError(error))
    socket.on("close", () => {
      if (this.socket !== socket) return
      this.clearKeepAlive()
      if (!this.active) return
      this.socket = null
      this.active = false
      this.reportError(new Error("Deepgram WebSocket closed unexpectedly"))
    })
    try {
      await waitForOpen(socket, this.connectTimeoutMs)
    } catch (error) {
      if (this.socket === socket) this.socket = null
      this.active = false
      if (socket.readyState === this.WebSocketImpl.OPEN || socket.readyState === this.WebSocketImpl.CONNECTING) {
        socket.close()
      }
      throw error
    }
    this.lastSendAt = Date.now()
    this.armKeepAlive(socket)
  }

  async sendAudio(audio: AudioFrame): Promise<void> {
    const socket = this.openSocket()
    if (!socket) throw new Error("DeepgramProvider is not connected")
    socket.send(Buffer.from(audio.samples.buffer, audio.samples.byteOffset, audio.samples.byteLength))
    this.lastSendAt = Date.now()
  }

  /**
   * Called by AppCore when SilenceGate reports the end of an utterance.
   * Deepgram's Finalize flushes whatever it has buffered as a final result
   * immediately instead of waiting for its own endpointer — the speaker
   * has already stopped, so any further wait is pure display delay.
   */
  async onUtteranceEnd(): Promise<void> {
    const socket = this.openSocket()
    if (!socket) return
    socket.send(JSON.stringify({ type: "Finalize" }))
    this.lastSendAt = Date.now()
  }

  async stop(): Promise<void> {
    this.active = false
    this.clearKeepAlive()
    const socket = this.socket
    this.socket = null
    if (!socket) return
    if (socket.readyState === this.WebSocketImpl.OPEN) {
      socket.send(JSON.stringify({ type: "CloseStream" }))
      socket.close()
    }
  }

  private openSocket(): WebSocket | null {
    if (!this.active || !this.socket || this.socket.readyState !== this.WebSocketImpl.OPEN) return null
    return this.socket
  }

  private armKeepAlive(socket: WebSocket): void {
    this.clearKeepAlive()
    if (this.keepAliveIntervalMs <= 0) return
    const timer = setInterval(() => {
      if (this.socket !== socket || socket.readyState !== this.WebSocketImpl.OPEN) return
      if (Date.now() - this.lastSendAt < this.keepAliveIntervalMs) return
      socket.send(JSON.stringify({ type: "KeepAlive" }))
      this.lastSendAt = Date.now()
    }, this.keepAliveIntervalMs)
    timer.unref?.()
    this.keepAliveTimer = timer
  }

  private clearKeepAlive(): void {
    if (this.keepAliveTimer) clearInterval(this.keepAliveTimer)
    this.keepAliveTimer = null
  }

  private handleMessage(raw: string): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      this.reportError(new Error("Deepgram returned malformed JSON"))
      return
    }
    // External data is never trusted (AGENTS.md section 15): valid JSON that
    // is not an object (null, a number) used to throw a TypeError here,
    // inside a socket listener, which is an uncaught exception.
    if (!isPlainObject(parsed)) return
    const message = parsed as DeepgramMessage
    const alternatives = isPlainObject(message.channel) ? message.channel.alternatives : undefined
    const alternative = Array.isArray(alternatives) && isPlainObject(alternatives[0]) ? alternatives[0] : undefined
    const text = typeof alternative?.transcript === "string" ? alternative.transcript.trim() : ""
    if (!text) return
    const state = message.is_final ? "final" : "partial"
    this.sequence += 1
    this.deliverTranscript({
      id: generateUlid(),
      correlationId: this.correlationId,
      sequence: this.sequence,
      text,
      state,
      ...(typeof alternative?.confidence === "number" ? { providerConfidence: alternative.confidence } : {}),
      timestamp: Date.now(),
    })
  }

  /** A consumer that throws must not escape into the socket's message listener. */
  private deliverTranscript(result: TranscriptResult): void {
    try {
      this.transcriptCallback?.(result)
    } catch (err) {
      this.reportError(err)
    }
  }

  private reportError(error: unknown): void {
    this.errorCallback?.(error instanceof Error ? error : new Error(String(error)))
  }
}

function waitForOpen(socket: WebSocket, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    // A connection that neither opens nor errors (blackholed network) would
    // otherwise leave start() pending forever with the microphone "starting".
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`Deepgram connection timed out after ${timeoutMs} ms`))
    }, timeoutMs)
    const onOpen = () => {
      cleanup()
      resolve()
    }
    const onError = (error: Error) => {
      cleanup()
      reject(error)
    }
    const cleanup = () => {
      clearTimeout(timer)
      socket.off("open", onOpen)
      socket.off("error", onError)
    }
    socket.once("open", onOpen)
    socket.once("error", onError)
  })
}
