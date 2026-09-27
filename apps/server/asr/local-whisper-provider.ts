import type { AsrProvider, AudioFrame, TranscriptResult } from "../../../packages/contracts"
import type { Logger } from "../../../packages/shared/logger"
import { generateUlid } from "../../../packages/shared/ulid"

/**
 * Offline transcription through a local whisper.cpp server — the last link
 * of the fallback chain, for when the internet is gone (a power cut on the
 * router, a church with no connection at all).
 *
 * Same batching contract as GroqProvider: audio accumulates until
 * SilenceGate reports the end of an utterance (onUtteranceEnd), with a hard
 * cap so one endless sentence still gets transcribed. Each batch becomes a
 * WAV posted to the server's /inference endpoint.
 *
 * CPU inference can be slower than speech on a weak laptop. Requests run
 * one at a time, and if more than MAX_BACKLOG batches wait, the OLDEST is
 * dropped (logged): a verse from two minutes ago is worthless, falling
 * further and further behind is worse than skipping.
 */
export type LocalWhisperEndpoint = {
  readonly baseUrl: string | null
  ensureStarted(): Promise<void>
  stop(): Promise<void>
}

export type LocalWhisperProviderOptions = {
  readonly server: LocalWhisperEndpoint
  readonly language?: string
  readonly logger?: Logger
  readonly fetchImpl?: typeof fetch
  readonly now?: () => number
  /** Whisper initial prompt: vocabulary the model should expect. */
  readonly prompt?: string
  readonly requestTimeoutMs?: number
}

const SAMPLE_RATE = 16000
const MIN_BATCH_MS = 700
const MAX_BATCH_MS = 8000
const MAX_BACKLOG = 2
const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_PROMPT_FR = "Lecture biblique : Jean chapitre 3 verset 16, Psaume 23, Romains 8, Deutéronome, Philippiens."
const DEFAULT_PROMPT_EN = "Bible reading: John chapter 3 verse 16, Psalm 23, Romans 8, Deuteronomy, Philippians."

export class LocalWhisperProvider implements AsrProvider {
  private readonly server: LocalWhisperEndpoint
  private readonly logger?: Logger
  private readonly fetchImpl: typeof fetch
  private readonly now: () => number
  private readonly promptOverride?: string
  private readonly requestTimeoutMs: number
  private language: string | undefined
  private active = false
  private frames: Int16Array[] = []
  private bufferedSamples = 0
  private queue: Int16Array[] = []
  private draining = false
  private sequence = 0
  private correlationId = ""
  private transcriptCallback: ((result: TranscriptResult) => void) | null = null
  private errorCallback: ((error: Error) => void) | null = null

  constructor(options: LocalWhisperProviderOptions) {
    this.server = options.server
    this.language = options.language
    this.logger = options.logger
    this.fetchImpl = options.fetchImpl ?? fetch
    this.now = options.now ?? Date.now
    this.promptOverride = options.prompt
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS
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

  async start(): Promise<void> {
    this.active = true
    this.sequence = 0
    this.correlationId = generateUlid(this.now())
    await this.server.ensureStarted()
  }

  async sendAudio(audio: AudioFrame): Promise<void> {
    if (!this.active) throw new Error("LocalWhisperProvider.sendAudio() called before start()")
    this.frames.push(audio.samples)
    this.bufferedSamples += audio.samples.length
    if (msOf(this.bufferedSamples) >= MAX_BATCH_MS) this.enqueueBuffered()
  }

  async onUtteranceEnd(): Promise<void> {
    if (!this.active) return
    if (msOf(this.bufferedSamples) >= MIN_BATCH_MS) this.enqueueBuffered()
  }

  discardBufferedAudio(): void {
    this.frames = []
    this.bufferedSamples = 0
  }

  async stop(): Promise<void> {
    if (this.active && msOf(this.bufferedSamples) >= MIN_BATCH_MS) this.enqueueBuffered()
    this.active = false
  }

  private enqueueBuffered(): void {
    const batch = new Int16Array(this.bufferedSamples)
    let offset = 0
    for (const frame of this.frames) {
      batch.set(frame, offset)
      offset += frame.length
    }
    this.discardBufferedAudio()
    this.queue.push(batch)
    while (this.queue.length > MAX_BACKLOG) {
      this.queue.shift()
      this.logger?.warn({ component: "asr", event: "local-whisper.backlog-dropped" })
    }
    void this.drain()
  }

  private async drain(): Promise<void> {
    if (this.draining) return
    this.draining = true
    try {
      while (this.queue.length > 0) {
        const batch = this.queue.shift() as Int16Array
        try {
          const text = (await this.transcribe(batch)).trim()
          if (!text) continue
          this.sequence += 1
          this.transcriptCallback?.({
            id: generateUlid(this.now()),
            correlationId: this.correlationId,
            sequence: this.sequence,
            text,
            state: "final",
            timestamp: this.now(),
          })
        } catch (error) {
          this.errorCallback?.(error instanceof Error ? error : new Error(String(error)))
        }
      }
    } finally {
      this.draining = false
    }
  }

  private async transcribe(samples: Int16Array): Promise<string> {
    await this.server.ensureStarted()
    const baseUrl = this.server.baseUrl
    if (!baseUrl) throw new Error("Local transcription engine is not running")
    const form = new FormData()
    form.append("file", new Blob([encodeWav(samples)], { type: "audio/wav" }), "audio.wav")
    form.append("response_format", "json")
    form.append("temperature", "0.0")
    form.append("language", this.language ?? "auto")
    form.append("prompt", this.promptOverride ?? (this.language === "en" ? DEFAULT_PROMPT_EN : DEFAULT_PROMPT_FR))
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs)
    try {
      const response = await this.fetchImpl(`${baseUrl}/inference`, { method: "POST", body: form, signal: controller.signal })
      if (!response.ok) throw new Error(`Local transcription failed (${response.status})`)
      const body = (await response.json()) as { text?: unknown; error?: unknown }
      if (typeof body.text !== "string") throw new Error(`Local transcription returned no text${body.error ? `: ${String(body.error)}` : ""}`)
      return body.text.replace(/\s+/g, " ")
    } finally {
      clearTimeout(timer)
    }
  }
}

function msOf(samples: number): number {
  return (samples / SAMPLE_RATE) * 1000
}

/** 16-bit PCM mono WAV at 16 kHz — the exact format whisper.cpp expects without conversion. */
export function encodeWav(samples: Int16Array): ArrayBuffer {
  const buffer = new ArrayBuffer(44 + samples.length * 2)
  const view = new DataView(buffer)
  const writeString = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i))
  }
  writeString(0, "RIFF")
  view.setUint32(4, 36 + samples.length * 2, true)
  writeString(8, "WAVE")
  writeString(12, "fmt ")
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, SAMPLE_RATE, true)
  view.setUint32(28, SAMPLE_RATE * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeString(36, "data")
  view.setUint32(40, samples.length * 2, true)
  for (let i = 0; i < samples.length; i++) view.setInt16(44 + i * 2, samples[i] as number, true)
  return buffer
}
