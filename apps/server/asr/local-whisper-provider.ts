import type { AsrProvider, AudioFrame, TranscriptResult } from "../../../packages/contracts"
import type { Logger } from "../../../packages/shared/logger"
import { generateUlid } from "../../../packages/shared/ulid"
import { plannedBookTerms } from "./biblical-vocabulary"
import { normalizeBookName } from "../detector/regex-detector"
import { echoWords, isPromptEcho } from "./prompt-echo"
import { filterSegments, parseScoredSegments } from "./segment-quality"

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
  /**
   * Per-request timeout. Default: scales with the batch's audio length
   * (computeLocalTranscriptionTimeoutMs). A number pins it (tests); a function
   * receives the batch's audio milliseconds.
   */
  readonly requestTimeoutMs?: number | ((audioMs: number) => number)
}

const SAMPLE_RATE = 16000
const MIN_BATCH_MS = 700
const MAX_BATCH_MS = 8000
const MAX_BACKLOG = 2
/** Never below the old fixed budget: a cold first request on a weak CPU must still fit. */
export const LOCAL_TIMEOUT_FLOOR_MS = 30_000
/**
 * Budget per second of audio. OpenWhispr (transcriptionTimeout.js, MIT) uses
 * 10x real time for dictation; a live service drops stale batches instead of
 * waiting (MAX_BACKLOG), so half that is enough here.
 */
export const LOCAL_TIMEOUT_PER_AUDIO_SECOND_MS = 5_000
/** Hard ceiling: a hung engine must always fail, and the queue behind it must move. */
export const LOCAL_TIMEOUT_CEILING_MS = 120_000

/** Request timeout for a batch of `audioMs` audio: floor, then linear, then capped. Never infinite. */
export function computeLocalTranscriptionTimeoutMs(audioMs: number): number {
  if (!Number.isFinite(audioMs) || audioMs <= 0) return LOCAL_TIMEOUT_CEILING_MS
  const scaled = Math.ceil((audioMs / 1000) * LOCAL_TIMEOUT_PER_AUDIO_SECOND_MS)
  return Math.min(LOCAL_TIMEOUT_CEILING_MS, Math.max(LOCAL_TIMEOUT_FLOOR_MS, scaled))
}
const DEFAULT_PROMPT_FR = "Lecture biblique : Jean chapitre 3 verset 16, Psaume 23, Romains 8, Deutéronome, Philippiens."
const DEFAULT_PROMPT_EN = "Bible reading: John chapter 3 verse 16, Psalm 23, Romans 8, Deuteronomy, Philippians."
/** Whisper only reads the last ~220 tokens of a prompt; this keeps ours well inside that. */
const MAX_PROMPT_CHARS = 700
/** How much of the previous sentence is carried into the next prompt. */
const PROMPT_TAIL_CHARS = 180
/** A forced cut (MAX_BATCH_MS) looks for a pause inside this much trailing audio. */
const QUIET_SEARCH_MS = 1500
const QUIET_WINDOW_MS = 80
/** A batch slower than this multiple of its own audio length means the machine cannot keep up. */
const SLOW_RTF = 1.2
/**
 * whisper.cpp decoder thresholds sent with every /inference request. The
 * server defaults (entropy 2.4, logprob -1.0) let a mostly-silent window
 * through as outro boilerplate ("Merci d'avoir regardé"). Values from
 * OpenWhispr's whisperServer.js (MIT), measured there over ~4.8k real
 * dictations. The faster-whisper sidecar ignores these fields and applies
 * its own equivalents (server.py).
 */
export const INFERENCE_DECODER_FIELDS: Readonly<Record<string, string>> = Object.freeze({
  entropy_thold: "2.8",
  logprob_thold: "-1.25",
})

/**
 * Where to cut a long run of speech that has to be sent now. Cutting at an
 * arbitrary sample splits a word ("Gen|esis") or a reference ("Genesis 5 | verse
 * 2"); cutting at the quietest 80 ms in the last 1.5 s lands in a breath
 * instead. Returns the sample index to cut at, or null when there is no real
 * dip (continuous speech), in which case the caller sends everything.
 */
export function findQuietCut(samples: Int16Array): number | null {
  const window = Math.round((SAMPLE_RATE * QUIET_WINDOW_MS) / 1000)
  const searchFrom = Math.max(0, samples.length - Math.round((SAMPLE_RATE * QUIET_SEARCH_MS) / 1000))
  const rms: number[] = []
  const starts: number[] = []
  for (let start = searchFrom; start + window <= samples.length; start += window) {
    let sum = 0
    for (let i = start; i < start + window; i++) sum += (samples[i] as number) * (samples[i] as number)
    rms.push(Math.sqrt(sum / window))
    starts.push(start)
  }
  if (rms.length < 4) return null
  const sorted = [...rms].sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)] as number
  const quietest = sorted[0] as number
  // A real pause: clearly below the surrounding speech, and not the very last window
  // (cutting there gains nothing).
  const index = rms.indexOf(quietest)
  if (index >= rms.length - 1 || median <= 0 || quietest > median * 0.5) return null
  return (starts[index] as number) + Math.floor(window / 2)
}

export class LocalWhisperProvider implements AsrProvider {
  private readonly server: LocalWhisperEndpoint
  private readonly logger?: Logger
  private readonly fetchImpl: typeof fetch
  private readonly now: () => number
  private readonly promptOverride?: string
  private readonly timeoutFor: (audioMs: number) => number
  private language: string | undefined
  private active = false
  private plannedBookIds: readonly string[] = []
  private currentBook: string | null = null
  private previousTail = ""
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
    const timeout = options.requestTimeoutMs ?? computeLocalTranscriptionTimeoutMs
    this.timeoutFor = typeof timeout === "number" ? () => timeout : timeout
  }

  setLanguage(language: string | undefined): void {
    this.language = language
  }

  /** Context for the next prompt: the book on screen biases "Corinthiens"-style names toward the right book. */
  setCurrentVerseRef(reference: string | null): void {
    // "1 corinthians 13:4" -> the book part, display-named in the active language.
    const book = reference ? reference.replace(/\s+\d+:\d+\s*$/, "").trim() : ""
    this.currentBook = book ? normalizeBookName(book) : null
  }

  /** Books of the loaded rundown; same signal Deepgram gets as keyterms. */
  setPlannedBooks(bookIds: readonly string[]): void {
    this.plannedBookIds = bookIds
  }

  onTranscript(callback: (result: TranscriptResult) => void): void {
    this.transcriptCallback = callback
  }

  /**
   * Whisper treats the prompt as the text that came just before the audio. So
   * it carries (1) the app's biblical base prompt, (2) the books this service
   * plans to read and the one on screen, (3) the tail of the previous sentence
   * (continuity, the same trick open-whisper uses). Context only: the output
   * still goes through detection, the index and the Bible source like any other.
   */
  buildPrompt(): string {
    const base = this.promptOverride ?? (this.language === "en" ? DEFAULT_PROMPT_EN : DEFAULT_PROMPT_FR)
    const books = plannedBookTerms([...this.plannedBookIds, ...(this.currentBook ? [this.currentBook] : [])], this.language)
    const parts = [base]
    if (books.length > 0) parts.push(books.join(", ") + ".")
    if (this.previousTail) parts.push(this.previousTail)
    const prompt = parts.join(" ")
    // Trim from the FRONT: the newest words matter most to Whisper.
    return prompt.length > MAX_PROMPT_CHARS ? prompt.slice(prompt.length - MAX_PROMPT_CHARS) : prompt
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
    if (msOf(this.bufferedSamples) >= MAX_BATCH_MS) this.enqueueAtQuietPoint()
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

  /** The hard cap hit mid-speech: send up to the last pause and keep the rest for the next batch. */
  private enqueueAtQuietPoint(): void {
    const all = new Int16Array(this.bufferedSamples)
    let offset = 0
    for (const frame of this.frames) {
      all.set(frame, offset)
      offset += frame.length
    }
    const cut = findQuietCut(all)
    if (cut === null || cut < (SAMPLE_RATE * MIN_BATCH_MS) / 1000) {
      this.enqueueBuffered()
      return
    }
    const rest = all.slice(cut)
    this.frames = [all.slice(0, cut)]
    this.bufferedSamples = cut
    this.enqueueBuffered()
    this.frames = [rest]
    this.bufferedSamples = rest.length
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
          const startedAt = this.now()
          const text = await this.transcribeGuarded(batch)
          const tookMs = this.now() - startedAt
          const audioMs = msOf(batch.length)
          const rtf = audioMs > 0 ? tookMs / audioMs : 0
          this.logger?.[rtf > SLOW_RTF ? "warn" : "debug"]({
            component: "asr",
            event: rtf > SLOW_RTF ? "local-whisper.slow" : "local-whisper.batch",
            durationMs: tookMs,
            metadata: { audioMs: Math.round(audioMs), rtf: Number(rtf.toFixed(2)) },
          })
          if (!text) continue
          this.previousTail = text.slice(-PROMPT_TAIL_CHARS)
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

  /**
   * One batch, with the prompt-echo guard: a transcript that is merely the
   * prompt read back is dropped and the same audio is sent ONCE more with no
   * prompt. The retry's result is used as-is — with no prompt there is
   * nothing to echo, so real speech that happened to match is not lost.
   */
  private async transcribeGuarded(samples: Int16Array): Promise<string> {
    const prompt = this.buildPrompt()
    const first = (await this.transcribe(samples, prompt)).trim()
    if (!isPromptEcho(first, prompt)) return first
    this.logger?.warn({
      component: "asr",
      event: "local-whisper.prompt-echo",
      correlationId: this.correlationId,
      metadata: { words: echoWords(first).length, action: "retry-without-prompt" },
    })
    const retry = (await this.transcribe(samples, null)).trim()
    this.logger?.info({
      component: "asr",
      event: "local-whisper.prompt-echo-retry",
      correlationId: this.correlationId,
      metadata: { words: echoWords(retry).length, empty: retry.length === 0 },
    })
    return retry
  }

  /**
   * Segment-quality filter: when the engine returned scored segments, drop the
   * ones that are very likely invented (segment-quality.ts) and rebuild the
   * text from the rest. No usable segments, or nothing dropped: the engine's
   * own `text`, unchanged.
   */
  private dropUnlikelySegments(body: unknown, text: string): string {
    const segments = parseScoredSegments(body)
    if (!segments) return text
    const { kept, dropped } = filterSegments(segments)
    if (dropped.length === 0) return text
    for (const segment of dropped) {
      this.logger?.info({
        component: "asr",
        event: "local-whisper.segment-dropped",
        correlationId: this.correlationId,
        metadata: {
          reason: segment.reason,
          words: segment.words,
          noSpeechProb: round(segment.noSpeechProb),
          avgLogprob: round(segment.avgLogprob),
          compressionRatio: round(segment.compressionRatio),
        },
      })
    }
    return kept.map((segment) => segment.text.trim()).filter(Boolean).join(" ")
  }

  private async transcribe(samples: Int16Array, prompt: string | null): Promise<string> {
    await this.server.ensureStarted()
    const baseUrl = this.server.baseUrl
    if (!baseUrl) throw new Error("Local transcription engine is not running")
    const form = new FormData()
    form.append("file", new Blob([encodeWav(samples)], { type: "audio/wav" }), "audio.wav")
    // verbose_json adds per-segment scores for the hallucination filter; `text` is still there.
    form.append("response_format", "verbose_json")
    form.append("temperature", "0.0")
    form.append("language", this.language ?? "auto")
    for (const [name, value] of Object.entries(INFERENCE_DECODER_FIELDS)) form.append(name, value)
    if (prompt) form.append("prompt", prompt)
    const timeoutMs = this.timeoutFor(msOf(samples.length))
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await this.fetchImpl(`${baseUrl}/inference`, { method: "POST", body: form, signal: controller.signal })
      if (!response.ok) throw new Error(`Local transcription failed (${response.status})`)
      const body = (await response.json()) as { text?: unknown; error?: unknown }
      if (typeof body.text !== "string") throw new Error(`Local transcription returned no text${body.error ? `: ${String(body.error)}` : ""}`)
      return this.dropUnlikelySegments(body, body.text).replace(/\s+/g, " ")
    } catch (error) {
      if (controller.signal.aborted) {
        this.logger?.warn({ component: "asr", event: "local-whisper.timeout", correlationId: this.correlationId, metadata: { timeoutMs } })
        throw new Error(`Local transcription timed out after ${timeoutMs}ms`)
      }
      throw error
    } finally {
      clearTimeout(timer)
    }
  }
}

function round(value: number | undefined): number | null {
  return value === undefined ? null : Number(value.toFixed(3))
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
