import type { AsrProvider, AudioFrame, TranscriptResult } from "../../../packages/contracts"
import { generateUlid } from "../../../packages/shared/ulid"
import type { Logger } from "../../../packages/shared/logger"

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

  async start(): Promise<void> {
    this.active = true
    this.bufferedFrames = []
    this.bufferedSampleCount = 0
    this.sequence = 0
    this.correlationId = generateUlid(this.now())
  }

  async sendAudio(audio: AudioFrame): Promise<void> {
    if (!this.active) {
      throw new Error("GroqProvider.sendAudio() called before start()")
    }

    this.bufferedFrames.push(audio.samples)
    this.bufferedSampleCount += audio.samples.length

    const bufferedDurationMs = (this.bufferedSampleCount / SAMPLE_RATE) * 1000
    if (bufferedDurationMs >= this.chunkDurationMs) {
      await this.flush()
    }
  }

  async stop(): Promise<void> {
    if (this.active && this.bufferedSampleCount > 0) {
      await this.flush()
    }
    this.active = false
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

    try {
      const text = await this.transcribe(samples)
      // ARCHITECTURE.md section 73: confirmed live, a real Whisper failure
      // mode — fed ambient noise or unclear audio with no `language` hint,
      // it sometimes hallucinates fluent-looking text in a language never
      // actually spoken (Chinese, in the reported case), rather than
      // returning empty or garbled output. This app's confirmed audience is
      // French/English only, so any non-Latin-script result is noise, not
      // a real transcript worth acting on — dropped here, at the source,
      // rather than reaching verse detection or the dashboard's transcript
      // display. Not a real ASR failure (no onError call): from the
      // operator's perspective this is indistinguishable from a quiet
      // moment producing nothing, which is the correct framing.
      if (containsNonLatinScript(text)) {
        // debug, deliberately not warn: this is expected, routine
        // filtering, not a fault — logged only so a report of "this bug
        // is still happening" can be checked against a specific build's
        // logs (with minLevel lowered to debug) rather than argued from
        // memory. Truncated: this is a diagnostic breadcrumb, not a
        // transcript archive.
        this.logger?.debug({
          component: "asr",
          event: "transcript.non-latin-script-dropped",
          metadata: { textPreview: text.slice(0, 80) },
        })
        return
      }
      this.sequence += 1
      this.transcriptCallback?.({
        id: generateUlid(this.now()),
        correlationId: this.correlationId,
        sequence: this.sequence,
        text,
        state: "final",
        timestamp: this.now(),
      })
    } catch (err) {
      this.errorCallback?.(err instanceof Error ? err : new Error(String(err)))
    }
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
