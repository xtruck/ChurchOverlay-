import type { AsrProvider, AudioFrame, TranscriptResult } from "../../../packages/contracts"
import { generateUlid } from "../../../packages/shared/ulid"
import type { Logger } from "../../../packages/shared/logger"
import { FRENCH_BOOK_ALIASES } from "../detector/regex-detector"

const DEFAULT_URL = "https://api.groq.com/openai/v1/audio/transcriptions"
const DEFAULT_MODEL = "whisper-large-v3-turbo"
// ARCHITECTURE.md section 70: the user's stated ceiling is speech-to-
// overlay in under 5 seconds. This buffering delay is the single largest,
// most controllable component of that budget — Groq's own inference on a
// short clip is typically well under a second, and everything after a
// transcript arrives (verse resolution, WS broadcast, overlay render) is
// near-instant. 2s keeps worst-case buffering + a real API round trip
// comfortably inside the 5s ceiling, while still giving Whisper enough
// audio context for short phrases (a spoken verse reference or cue title)
// to transcribe accurately — shorter risks cutting words at chunk
// boundaries and multiplies API call volume for no latency win once
// network/inference time dominates anyway.
const DEFAULT_CHUNK_DURATION_MS = 2000
const SAMPLE_RATE = 16000

// TASK 3: utterance-aligned chunking constants
// Maximum time to buffer before forcing a flush (8 seconds — long unbroken speech)
const MAX_CHUNK_DURATION_MS = 8000
// Minimum time before a flush can occur (700ms — avoid flushing on single words)
const MIN_CHUNK_DURATION_MS = 700
// Overlap to retain when a max-cap flush splits an utterance (~500ms)
const OVERLAP_MS = 500

export type GroqProviderOptions = {
  readonly apiKey: string
  readonly model?: string
  readonly chunkDurationMs?: number
  readonly fetchImpl?: typeof fetch
  readonly url?: string
  readonly now?: () => number
  /**
   * ARCHITECTURE.md section 81 — an ISO-639-1 code (e.g. "fr", "en")
   * telling Whisper what language to expect, instead of letting it
   * auto-detect per 2-second chunk. Confirmed with the user: this app's
   * primary audience speaks French, and per-chunk auto-detection on short
   * clips is a real accuracy cost — an ambiguous phoneme or accent can
   * flip the detected language between chunks, degrading both the
   * transcript itself and, downstream, verse-reference detection. Absent
   * (auto-detect) is still the right default for a genuinely bilingual
   * service, where no single fixed hint could be correct throughout.
   */
  readonly language?: string
  /**
   * ARCHITECTURE.md production audit (section 74) — optional, same
   * pattern as onError()/getTranslationId() elsewhere: absent by
   * default, so nothing downstream is forced to handle a logger it
   * doesn't have. When present, backs a debug-level (never warn — this
   * is expected, routine behavior, not a fault) trace of every chunk the
   * non-Latin-script filter (section 73.1) drops, so a report of "the
   * hallucinated-language bug is still happening" can be confirmed
   * against a specific build rather than argued from memory.
   */
  readonly logger?: Logger
}

/**
 * v1 AsrProvider implementation (ARCHITECTURE.md section 10, section 50
 * first extension seam), using Groq's Whisper transcription API.
 *
 * IMPORTANT, verified directly against the live API during development
 * (endpoint, multipart fields, accepted formats, and both success and
 * error response shapes — not assumed): Groq's transcription API is a
 * batch REST endpoint. You upload a complete audio file and get one
 * finished transcript back; it is not a real-time streaming protocol.
 *
 * To approximate live behavior on top of that, this provider buffers
 * incoming audio and automatically transcribes whatever has accumulated
 * once `chunkDurationMs` worth of audio has arrived, emitting each
 * chunk's result as a "final" TranscriptResult — Groq's response has no
 * partial/incomplete signal of its own; every response IS a finished
 * transcription of exactly the audio submitted. stop() flushes and
 * transcribes any remaining buffered audio before resolving.
 *
 * Worth being explicit about: this provider never emits a
 * `state: "partial"` TranscriptResult. That is an honest consequence of
 * the underlying API's real capabilities, not a shortcut — see
 * ARCHITECTURE.md section 11, which already treats provider confidence as
 * optional per-provider for the same reason (not every provider exposes
 * the same signals).
 *
 * onTranscript() is required by AsrProvider. onError() is an addition
 * beyond that interface: AsrProvider has no error channel, so without
 * this a failed Groq request would have nowhere to report to except
 * being silently dropped (AGENTS.md section 25 forbids that).
 */
export class GroqProvider implements AsrProvider {
  private readonly apiKey: string
  private readonly model: string
  private readonly chunkDurationMs: number
  private readonly fetchImpl: typeof fetch
  private readonly url: string
  private readonly now: () => number
  private readonly logger?: Logger
  private language: string | undefined

  private transcriptCallback: ((result: TranscriptResult) => void) | null = null
  private errorCallback: ((error: Error) => void) | null = null

  private active = false
  private bufferedFrames: Int16Array[] = []
  private bufferedSampleCount = 0
  private sequence = 0
  private correlationId = ""

  // TASK 3: utterance-aligned chunking state
  private lastTranscriptText = ""
  private lastFlushTime = 0

  // TASK B: prompt for lexical bias
  private currentVerseRef: string | null = null

  constructor(options: GroqProviderOptions) {
    if (!options.apiKey) {
      throw new Error("GroqProvider requires an apiKey")
    }
    this.apiKey = options.apiKey
    this.model = options.model ?? DEFAULT_MODEL
    this.chunkDurationMs = options.chunkDurationMs ?? DEFAULT_CHUNK_DURATION_MS
    this.fetchImpl = options.fetchImpl ?? fetch
    this.url = options.url ?? DEFAULT_URL
    this.now = options.now ?? Date.now
    this.logger = options.logger
    this.language = options.language
  }

  /** Live-updatable (ARCHITECTURE.md section 81) — a display-mode switch mid-service (voice, dashboard, or API) should retarget Whisper immediately, not just at construction. */
  setLanguage(language: string | undefined): void {
    this.language = language
  }

  /** TASK B: Update the current verse reference for dynamic prompt context. */
  setCurrentVerseRef(ref: string | null): void {
    this.currentVerseRef = ref
  }

  /** TASK B: Build the prompt for Groq Whisper to bias vocabulary towards Bible terms. */
  private buildPrompt(): string {
    const parts: string[] = []

    // Command keywords (French + English)
    parts.push("chapitre, verset, suivant, pr\u00e9c\u00e9dent, annuler, chapter, verse, next, previous, cancel")

    // Most frequent Bible books (French names) — prioritize to stay within token limit
    const frequentBooks = [
      "gen\u00e8se", "exode", "l\u00e9vitique", "nombres", "deut\u00e9ronome",
      "josu\u00e9", "juges", "ruth", "samuel", "rois", "chroniques",
      "esdras", "n\u00e9h\u00e9mie", "esther", "job", "psaumes", "proverbes",
      "eccl\u00e9siaste", "cantique", "isa\u00efe", "j\u00e9r\u00e9mie", "lamentations",
      "\u00e9z\u00e9chiel", "daniel", "os\u00e9e", "jo\u00ebl", "amos", "abdias",
      "jonas", "mich\u00e9e", "nahum", "habacuc", "sophonie", "agg\u00e9e",
      "zacharie", "malachie", "matthieu", "marc", "luc", "jean",
      "actes", "romains", "corinthiens", "galates", "eph\u00e9siens",
      "philippiens", "colossiens", "thessaloniciens", "timoth\u00e9e",
      "tite", "philemon", "h\u00e9breux", "jacques", "pierre", "jean",
      "jude", "apocalypse"
    ]
    parts.push(frequentBooks.join(", "))

    // Dynamic context: currently displayed verse
    if (this.currentVerseRef) {
      parts.push(`R\u00e9f\u00e9rence actuelle: ${this.currentVerseRef}`)
    }

    return parts.join(". ")
  }

  async start(): Promise<void> {
    this.active = true
    this.bufferedFrames = []
    this.bufferedSampleCount = 0
    this.sequence = 0
    this.correlationId = generateUlid(this.now())
    this.lastTranscriptText = ""
    this.lastFlushTime = this.now()
  }

  async sendAudio(audio: AudioFrame): Promise<void> {
    if (!this.active) {
      throw new Error("GroqProvider.sendAudio() called before start()")
    }

    this.bufferedFrames.push(audio.samples)
    this.bufferedSampleCount += audio.samples.length

    const bufferedDurationMs = (this.bufferedSampleCount / SAMPLE_RATE) * 1000

    // TASK 3: flush conditions with utterance alignment
    // Priority order:
    // 1. Max cap reached (8s) — force flush with overlap retention (even mid-utterance)
    // 2. Utterance ended (from SilenceGate) — handled via onUtteranceEnd() call
    // 3. Chunk duration reached (fallback for backward compat) — respect min floor
    // 4. Min floor (700ms) prevents premature flushes on single words

    // 1. Max cap reached (8s) — force flush with overlap retention
    if (bufferedDurationMs >= MAX_CHUNK_DURATION_MS) {
      await this.flushWithOverlap()
      return
    }

    // 2. Fallback: chunk duration reached (backward compat) — respect min floor
    if (bufferedDurationMs >= this.chunkDurationMs && bufferedDurationMs >= MIN_CHUNK_DURATION_MS) {
      await this.flush()
      return
    }
  }

  async stop(): Promise<void> {
    if (this.active && this.bufferedSampleCount > 0) {
      await this.flush()
    }
    this.active = false
  }

  /**
   * TASK 3: Called when SilenceGate detects end of utterance (hangover expired).
   * Flushes the buffer if minimum duration (700ms) has been reached.
   * This is called from AppCore when SilenceGate reports utteranceEnded.
   */
  async onUtteranceEnd(): Promise<void> {
    if (!this.active) return
    const bufferedDurationMs = (this.bufferedSampleCount / SAMPLE_RATE) * 1000
    const timeSinceLastFlush = this.now() - this.lastFlushTime

    // Only flush if we've buffered at least the minimum duration
    // This avoids flushing on single words / brief noise
    if (bufferedDurationMs >= MIN_CHUNK_DURATION_MS && this.bufferedSampleCount > 0) {
      await this.flush()
    }
  }

  /**
   * TASK 3: Force flush when max duration (8s) is reached, with overlap retention.
   * Retains ~500ms of audio as overlap for the next chunk to avoid cutting words.
   * Performs text-level deduplication at the seam.
   */
  private async flushWithOverlap(): Promise<void> {
    if (this.bufferedSampleCount === 0) return

    const totalSamples = this.bufferedSampleCount
    const overlapSamples = Math.round((OVERLAP_MS / 1000) * SAMPLE_RATE)
    const flushSamples = totalSamples - overlapSamples

    if (flushSamples <= 0) {
      // Not enough samples to flush with overlap, just do a normal flush
      await this.flush()
      return
    }

    // Extract the samples to flush (excluding overlap)
    const samplesToFlush = this.extractSamples(this.bufferedFrames, flushSamples)
    // Retain the overlap samples for the next chunk
    const overlapFrames = this.extractFrames(this.bufferedFrames, overlapSamples, totalSamples)

    // Flush the main portion
    await this.flushSamples(samplesToFlush)

    // Retain overlap frames as the start of the next buffer
    this.bufferedFrames = overlapFrames
    this.bufferedSampleCount = overlapSamples
    this.lastFlushTime = this.now()
  }

  /**
   * Helper to extract a specific number of samples from the beginning of buffered frames
   */
  private extractSamples(frames: Int16Array[], sampleCount: number): Int16Array {
    const result = new Int16Array(sampleCount)
    let offset = 0
    let remaining = sampleCount
    for (const frame of frames) {
      const take = Math.min(frame.length, remaining)
      result.set(frame.subarray(0, take), offset)
      offset += take
      remaining -= take
      if (remaining === 0) break
    }
    return result
  }

  /**
   * Extract frames representing the last N samples for overlap retention
   */
  private extractFrames(frames: Int16Array[], overlapSamples: number, totalSamples: number): Int16Array[] {
    const result: Int16Array[] = []
    let remaining = overlapSamples
    // Start from the end and work backwards
    for (let i = frames.length - 1; i >= 0 && remaining > 0; i--) {
      const frame = frames[i]!
      const take = Math.min(frame.length, remaining)
      const start = frame.length - take
      result.unshift(frame.subarray(start))
      remaining -= take
    }
    return result
  }

  /**
   * Flush a specific sample array (used for flushWithOverlap)
   */
  private async flushSamples(samples: Int16Array): Promise<void> {
    try {
      const text = await this.transcribe(samples)
      if (containsNonLatinScript(text)) {
        this.logger?.debug({
          component: "asr",
          event: "transcript.non-latin-script-dropped",
          metadata: { textPreview: text.slice(0, 80) },
        })
        return
      }
      // TASK 3: text-level deduplication at seam
      const dedupedText = this.deduplicateOverlap(this.lastTranscriptText, text)
      this.lastTranscriptText = text // Store full text for next overlap check

      this.sequence += 1
      this.transcriptCallback?.({
        id: generateUlid(this.now()),
        correlationId: this.correlationId,
        sequence: this.sequence,
        text: dedupedText,
        state: "final",
        timestamp: this.now(),
      })
      this.lastFlushTime = this.now()
    } catch (err) {
      this.errorCallback?.(err instanceof Error ? err : new Error(String(err)))
    }
  }

  /**
   * TASK 3: Simple text-level deduplication at chunk seam.
   * If the end of the previous transcript and start of current transcript
   * share a common word sequence (2+ words), drop the duplicate from current.
   * Conservative: only removes exact word matches, not fuzzy.
   */
  private deduplicateOverlap(prevText: string, currText: string): string {
    if (!prevText || !currText) return currText

    const prevWords = prevText.trim().split(/\s+/)
    const currWords = currText.trim().split(/\s+/)

    // Look for common suffix/prefix of 2+ words
    const maxCheck = Math.min(prevWords.length, currWords.length, 5) // limit check
    for (let len = maxCheck; len >= 2; len--) {
      const prevSuffix = prevWords.slice(-len).join(" ")
      const currPrefix = currWords.slice(0, len).join(" ")
      if (prevSuffix.toLowerCase() === currPrefix.toLowerCase()) {
        // Found overlap - remove the duplicate prefix from current
        return currWords.slice(len).join(" ")
      }
    }
    return currText
  }

  onTranscript(callback: (result: TranscriptResult) => void): void {
    this.transcriptCallback = callback
  }

  /** Beyond the AsrProvider interface — see the class doc comment. */
  onError(callback: (error: Error) => void): void {
    this.errorCallback = callback
  }

  private async flush(): Promise<void> {
    const samples = concatenateSamples(this.bufferedFrames, this.bufferedSampleCount)
    this.bufferedFrames = []
    this.bufferedSampleCount = 0
    await this.flushSamples(samples)
  }

  private async transcribe(samples: Int16Array): Promise<string> {
    const wavBytes = encodeWav(samples, SAMPLE_RATE)
    const form = new FormData()
    form.append("file", new Blob([wavBytes], { type: "audio/wav" }), "audio.wav")
    form.append("model", this.model)
    form.append("response_format", "json")
    if (this.language) {
      form.append("language", this.language)
    }
    // TASK B: Add prompt for lexical bias
    const prompt = this.buildPrompt()
    if (prompt) {
      form.append("prompt", prompt)
    }

    const response = await this.fetchImpl(this.url, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}` },
      body: form,
    })

    if (!response.ok) {
      const errorBody = await safeReadJson(response)
      throw new Error(
        extractGroqErrorMessage(errorBody) ?? `Groq request failed with status ${response.status}`
      )
    }

    const body = await safeReadJson(response)
    const text = isPlainObject(body) ? body.text : undefined
    if (typeof text !== "string") {
      throw new Error("Groq response did not include a text field")
    }
    return text.trim()
  }
}

// ARCHITECTURE.md section 73: this app's confirmed languages (French,
// English) are both written entirely in Latin script (including accented
// letters) — a legitimate transcript in either can never contain a
// character from these blocks. Deliberately conservative: any ONE
// matching character is enough to reject the whole chunk, since a real
// hallucinated-language response is fluent text, not an isolated stray
// character. Covers the scripts Whisper has actually been observed
// hallucinating into (CJK, Japanese kana, Hangul) plus the other major
// non-Latin scripts, so a future hallucination into a different unwanted
// language doesn't require rediscovering this fix.
const NON_LATIN_SCRIPT_PATTERN =
  /[一-鿿぀-ヿㇰ-ㇿ가-힯Ѐ-ӿ؀-ۿݐ-ݿ֐-׿฀-๿ऀ-ॿ]/

function containsNonLatinScript(text: string): boolean {
  return NON_LATIN_SCRIPT_PATTERN.test(text)
}

function concatenateSamples(frames: readonly Int16Array[], totalLength: number): Int16Array {
  const result = new Int16Array(totalLength)
  let offset = 0
  for (const frame of frames) {
    result.set(frame, offset)
    offset += frame.length
  }
  return result
}

/** Wraps raw PCM16 samples in a standard 44-byte WAV header. */
function encodeWav(samples: Int16Array, sampleRate: number): Uint8Array<ArrayBuffer> {
  const numChannels = 1
  const bitsPerSample = 16
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8)
  const blockAlign = numChannels * (bitsPerSample / 8)
  const dataSize = samples.length * (bitsPerSample / 8)

  const buffer = new ArrayBuffer(44 + dataSize)
  const view = new DataView(buffer)

  writeAscii(view, 0, "RIFF")
  view.setUint32(4, 36 + dataSize, true)
  writeAscii(view, 8, "WAVE")
  writeAscii(view, 12, "fmt ")
  view.setUint32(16, 16, true) // fmt chunk size
  view.setUint16(20, 1, true) // audio format: PCM
  view.setUint16(22, numChannels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, byteRate, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, bitsPerSample, true)
  writeAscii(view, 36, "data")
  view.setUint32(40, dataSize, true)

  for (let i = 0; i < samples.length; i++) {
    view.setInt16(44 + i * 2, samples[i] as number, true)
  }

  return new Uint8Array(buffer)
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) {
    view.setUint8(offset + i, text.charCodeAt(i))
  }
}

async function safeReadJson(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    return null
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function extractGroqErrorMessage(body: unknown): string | undefined {
  if (!isPlainObject(body)) return undefined
  const error = body.error
  if (!isPlainObject(error)) return undefined
  return typeof error.message === "string" ? error.message : undefined
}
