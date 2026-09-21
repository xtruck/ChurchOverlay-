import { WebSocket } from "ws"
import type { AsrProvider, AudioFrame, TranscriptResult } from "../../../packages/contracts"
import { generateUlid } from "../../../packages/shared/ulid"

const DEFAULT_MODEL = "nova-2"
const DEFAULT_URL = "wss://api.deepgram.com/v1/listen"

export type DeepgramProviderOptions = {
  readonly apiKey: string
  readonly model?: string
  readonly language?: string
  readonly url?: string
  readonly WebSocketImpl?: typeof WebSocket
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
  private language: string | undefined
  private socket: WebSocket | null = null
  private active = false
  private sequence = 0
  private correlationId = ""
  private transcriptCallback: ((result: TranscriptResult) => void) | null = null
  private errorCallback: ((error: Error) => void) | null = null
  private currentVerseRef: string | null = null

  constructor(options: DeepgramProviderOptions) {
    if (!options.apiKey.trim()) throw new Error("DeepgramProvider requires an apiKey")
    this.apiKey = options.apiKey
    this.model = options.model ?? DEFAULT_MODEL
    this.language = options.language
    this.url = options.url ?? DEFAULT_URL
    this.WebSocketImpl = options.WebSocketImpl ?? WebSocket
  }

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

  async start(): Promise<void> {
    if (this.active) return
    this.active = true
    this.sequence = 0
    this.correlationId = generateUlid()
    const query = new URLSearchParams({
      model: this.model,
      encoding: "linear16",
      sample_rate: "16000",
      channels: "1",
      interim_results: "true",
      smart_format: "true",
    })
    if (this.language) query.set("language", this.language)
    const socket = new this.WebSocketImpl(`${this.url}?${query.toString()}`, {
      headers: { Authorization: `Token ${this.apiKey}` },
    })
    this.socket = socket
    socket.on("message", (data) => this.handleMessage(data.toString()))
    socket.on("error", (error) => this.reportError(error))
    socket.on("close", () => {
      if (this.active) this.reportError(new Error("Deepgram WebSocket closed unexpectedly"))
    })
    await waitForOpen(socket)
  }

  async sendAudio(audio: AudioFrame): Promise<void> {
    if (!this.active || !this.socket || this.socket.readyState !== this.WebSocketImpl.OPEN) {
      throw new Error("DeepgramProvider is not connected")
    }
    this.socket.send(Buffer.from(audio.samples.buffer, audio.samples.byteOffset, audio.samples.byteLength))
  }

  async stop(): Promise<void> {
    this.active = false
    const socket = this.socket
    this.socket = null
    if (!socket) return
    if (socket.readyState === this.WebSocketImpl.OPEN) {
      socket.send(JSON.stringify({ type: "CloseStream" }))
      socket.close()
    }
  }

  private handleMessage(raw: string): void {
    let message: DeepgramMessage
    try {
      message = JSON.parse(raw) as DeepgramMessage
    } catch {
      this.reportError(new Error("Deepgram returned malformed JSON"))
      return
    }
    const alternative = message.channel?.alternatives?.[0]
    const text = alternative?.transcript?.trim() ?? ""
    if (!text) return
    const state = message.is_final ? "final" : "partial"
    this.sequence += 1
    this.transcriptCallback?.({
      id: generateUlid(),
      correlationId: this.correlationId,
      sequence: this.sequence,
      text,
      state,
      ...(typeof alternative?.confidence === "number" ? { providerConfidence: alternative.confidence } : {}),
      timestamp: Date.now(),
    })
  }

  private reportError(error: unknown): void {
    this.errorCallback?.(error instanceof Error ? error : new Error(String(error)))
  }
}

function waitForOpen(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    const onOpen = () => {
      cleanup()
      resolve()
    }
    const onError = (error: Error) => {
      cleanup()
      reject(error)
    }
    const cleanup = () => {
      socket.off("open", onOpen)
      socket.off("error", onError)
    }
    socket.once("open", onOpen)
    socket.once("error", onError)
  })
}
