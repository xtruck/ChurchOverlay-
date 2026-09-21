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

// TASK B: conservative character budget for the Whisper prompt.
//
// Groq documents the transcription `prompt` at a maximum of 224 tokens
// (https://console.groq.com/docs/speech-to-text). The previous value here
// was 800, justified as "~4 chars/token for French" — that ratio is an
// English-prose heuristic and is too optimistic for accented French, which
// the multilingual BPE used by Whisper tokenizes at ~3.3-3.5 chars/token.
// At 800 chars the prompt could therefore be ~230-240 tokens, i.e. ABOVE
// the documented limit it was meant to respect.
//
// Recalculated conservatively at the low end of that range and rounded
// down for extra margin (224 * 3.3 = 739, budget set to 730):
// the static base measures 582 chars, so a normal reference (~30 chars)
// still fits comfortably.
export const MAX_PROMPT_TOKENS = 224
export const CONSERVATIVE_CHARS_PER_TOKEN = 3.3
export const MAX_PROMPT_CHARS = 730

export const DEFAULT_RATE_LIMIT_REQUESTS = 18
export const DEFAULT_RATE_LIMIT_WINDOW_MS = 60_000
export const MAX_THROTTLED_BUFFER_MS = 15_000
export const SUSTAINED_429_THRESHOLD = 3
export const RATE_LIMIT_RETRY_BASE_MS = 2000

/** Error thrown by transcribe() when Groq returns 429, carrying the suggested retry delay. */
export class RateLimitError extends Error {
  readonly retryAfterMs: number | undefined
  readonly type: "throttling" | "429" // "throttling" = proactive budget exhaustion, "429" = actual HTTP 429 response
  constructor(message: string, retryAfterMs?: number, type: "throttling" | "429" = "429") {
    super(message)
    this.name = "RateLimitError"
    this.retryAfterMs = retryAfterMs
    this.type = type
  }
}

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
  private rateLimitedSustainedCallback: (() => void) | null = null

  private active = false
  private bufferedFrames: Int16Array[] = []
  private bufferedSampleCount = 0
  private sequence = 0
  private correlationId = ""

  // TASK 3: utterance-aligned chunking state
  private lastTranscriptText = ""
  private lastFlushTime = 0

  // TASK 1: rate-limit (leaky-bucket) state
  private requestsInWindow = 0
  private windowStart = 0
  private throttledUntil = 0

  // TASK 2: consecutive 429 tracking
  private consecutive429s = 0
  private last429Time = 0

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

  /**
   * TASK B: Update the current verse reference for dynamic prompt context.
   *
   * CAPTURE POINT (audited 2026-09) — when exactly is this value read?
   *
   * It is read at FLUSH time, not at buffer time. The chain is:
   *   sendAudio()/stop()/onUtteranceEnd() -> flush()/flushWithOverlap()
   *     -> flushSamples() -> transcribe() -> buildPrompt()
   * Every function in that chain runs synchronously up to its first
   * `await`, and buildPrompt() is called immediately before `fetchImpl()`
   * with NO await in between. So the reference is captured in the same
   * synchronous tick that builds the FormData and dispatches the request:
   *   - a setCurrentVerseRef() during buffering (before the chunk is full)
   *     DOES affect that chunk's prompt;
   *   - a setCurrentVerseRef() while the request is already in flight does
   *     NOT affect it, and only applies to the next flush.
   * Both directions are pinned by tests in groq-provider.test.ts
   * ("currentVerseRef is read at flush time, not at buffer time" and
   * "a setCurrentVerseRef() while a request is in flight ...").
   *
   * Known, accepted limitation (deliberately not "fixed"): if the operator
   * clears or changes the verse between the audio being buffered and the
   * chunk flushing, the prompt reflects the CURRENT on-screen reference
   * rather than the one showing while that audio was spoken. This is a
   * lexical-bias hint only: it can never influence which verse is shown,
   * because detection/validation/hallucination-guard all run on the final
   * transcript (AGENTS.md sections 13-14). Snapshotting the reference at
   * buffer time would instead send a stale hint for audio recorded before
   * a mid-chunk verse change, for no correctness gain (AGENTS.md 57).
   */
  setCurrentVerseRef(ref: string | null): void {
    this.currentVerseRef = ref
  }

  /** TASK B: Build the prompt for Groq Whisper to bias vocabulary towards Bible terms.
   *
   * Groq documents the `prompt` parameter at a maximum of 224 tokens
   * (https://console.groq.com/docs/speech-to-text — prompt guidance). The
   * static keyword + book-list portion measures ~71 words (~180-200 tokens
   * once sub-word tokenization of accented French is accounted for), which
   * leaves little headroom — so the dynamic verse reference is only
   * appended if the joined prompt stays under a conservative character
   * budget, and is dropped (never silently truncated mid-word) otherwise.
   */
  private buildPrompt(): string {
    const parts: string[] = []

    // Command keywords (French + English)
    parts.push("chapitre, verset, suivant, précédent, annuler, chapter, verse, next, previous, cancel")

    // Most frequent Bible books (French names) — prioritize to stay within token limit
    const frequentBooks = [
      "genèse", "exode", "lévitique", "nombres", "deutéronome",
      "josué", "juges", "ruth", "samuel", "rois", "chroniques",
      "esdras", "néhémie", "esther", "job", "psaumes", "proverbes",
      "ecclésiaste", "cantique", "isaïe", "jérémie", "lamentations",
      "ézéchiel", "daniel", "osée", "joël", "amos", "abdias",
      "jonas", "michée", "nahum", "habacuc", "sophonie", "aggée",
      "zacharie", "malachie", "matthieu", "marc", "luc", "jean",
      "actes", "romains", "corinthiens", "galates", "éphésiens",
      "philippiens", "colossiens", "thessaloniciens", "timothée",
      "tite", "philemon", "hébreux", "jacques", "pierre",
      "jude", "apocalypse"
    ]
    parts.push(frequentBooks.join(", "))

    const base = parts.join(". ")

    // Dynamic context: currently displayed verse. TASK B correction: the
    // reference passed in by AppCore (via setCurrentVerseRef) is the real
    // last-shown reference — no hard-coded value anywhere.
    if (this.currentVerseRef) {
      const withRef = `${base}. Référence actuelle: ${this.currentVerseRef}`
      // See MAX_PROMPT_CHARS above for the derivation (224 documented
      // tokens * 3.3 chars/token for accented French = 739, budget 730).
      if (withRef.length <= MAX_PROMPT_CHARS) {
        return withRef
      }
      this.logger?.debug({
        component: "asr",
        event: "prompt.verse-ref-dropped",
        metadata: { refPreview: this.currentVerseRef.slice(0, 40), baseChars: base.length },
      })
    }

    return base
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
    // checkRateLimit() is the single authority for whether throttling may
    // be bypassed at the bounded-buffer ceiling; requeue denied samples here.
    if (!this.checkRateLimit(samples.length)) {
      this.bufferedFrames.unshift(samples)
      this.bufferedSampleCount += samples.length
      this.errorCallback?.(new RateLimitError(
        "Transcription en pause, reprise dans " + Math.round(DEFAULT_RATE_LIMIT_WINDOW_MS / 1000) + "s — débit élevé",
        undefined,
        "throttling"
      ))
      return
    }

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
   * TASK 1: leaky-bucket rate limiter for Groq's free-tier 20 RPM ceiling.
   * Returns true if a request may be sent; false if the budget is exhausted
   * and the caller should throttle (keep buffering, skip this flush).
   * If the absolute buffer cap is reached, send a longer chunk anyway.
   */
  private checkRateLimit(sampleCount: number): boolean {
    const now = this.now()
    const bufferedDurationMs = ((this.bufferedSampleCount + sampleCount) / SAMPLE_RATE) * 1000

    // Reset window if it expired
    if (now - this.windowStart >= DEFAULT_RATE_LIMIT_WINDOW_MS) {
      this.requestsInWindow = 0
      this.windowStart = now
    }

    // If currently throttled from a prior 429 sustained signal
    if (now < this.throttledUntil) {
      if (bufferedDurationMs >= MAX_THROTTLED_BUFFER_MS) {
        // Cap reached — send a long chunk rather than lose everything
        this.throttledUntil = now
        this.requestsInWindow = 1
        this.windowStart = now
        return true
      }
      // Still below cap — throttle, keep buffering
      return false
    }

    // Budget available: we're within the window and under the limit
    if (this.requestsInWindow < DEFAULT_RATE_LIMIT_REQUESTS) {
      this.requestsInWindow++
      return true
    }

    // Budget exhausted — enter throttle period
    this.throttledUntil = now + DEFAULT_RATE_LIMIT_WINDOW_MS
    this.requestsInWindow = 1
    this.windowStart = now

    if (bufferedDurationMs >= MAX_THROTTLED_BUFFER_MS) {
      // Cap reached — send a long chunk rather than lose everything
      this.throttledUntil = now
      this.requestsInWindow = 1
      this.windowStart = now
      return true
    }

    // Still below cap — throttle, keep buffering
    return false
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

  onRateLimitedSustained(callback: () => void): void {
    this.rateLimitedSustainedCallback = callback
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
      const errorMessage = extractGroqErrorMessage(errorBody) ?? `Groq request failed with status ${response.status}`
      // TASK 2: detect 429 and parse retry-after delay
      if (response.status === 429) {
        const retryAfter = extractGroqRetryAfter(errorBody)
        const retryAfterMs = retryAfter ?? RATE_LIMIT_RETRY_BASE_MS
        this.consecutive429s++
        this.last429Time = this.now()
        // Emit sustained event if threshold exceeded
        if (this.consecutive429s >= SUSTAINED_429_THRESHOLD && this.rateLimitedSustainedCallback) {
          this.rateLimitedSustainedCallback()
        }
        throw new RateLimitError(
          this.consecutive429s >= SUSTAINED_429_THRESHOLD
            ? "Limite de débit Groq atteinte, envisagez une mise à jour du palier"
            : "Transcription en pause, reprise dans " + Math.round(retryAfterMs / 1000) + "s — débit élevé",
          retryAfterMs,
          "429"
        )
      }
      throw new Error(errorMessage)
    }

    // Reset consecutive 429 counter on successful request
    this.consecutive429s = 0

    const body = await safeReadJson(response)
    const text = isPlainObject(body) ? body.text : undefined
    if (typeof text !== "string") {
      throw new Error("Groq response did not include a text field")
    }

    // TASK B: log FR/PT (or other Romance-language) divergence. When the
    // expected language is French but a transcript comes back with strong
    // Portuguese/Spanish lexical markers, that is a per-chunk
    // language-detection flip worth observing (debug-level: it is a data
    // quality signal, not a fault). Detection is a cheap, deterministic
    // heuristic — good enough to spot the trend in logs, never used to
    // alter or reject the transcript itself.
    if (this.language === "fr" && looksLikePortugueseOrSpanish(text)) {
      this.logger?.debug({
        component: "asr",
        event: "transcript.language-divergence",
        metadata: { expected: this.language, textPreview: text.slice(0, 80) },
      })
    }

    return text.trim()
  }
}

// TASK B: heuristic Romance-language divergence markers for a French-
// expected transcript. Presence of several markers together is a strong
// signal; a single marker alone would false-positive on legitimate French.
const PT_ES_DIVERGENCE_PATTERNS = [
  /\b(não|você|obrigado|senhor\b.*\bdeus|espirito|espíritu|gracias|señor)\b/i,
  /\b\w+ção\b/i,
  /\b\w+ción\b/i,
]

function looksLikePortugueseOrSpanish(text: string): boolean {
  const matches = PT_ES_DIVERGENCE_PATTERNS.filter((p) => p.test(text)).length
  return matches >= 2
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

/** Extract the "retry-after" delay from a Groq 429 error body, if present. */
function extractGroqRetryAfter(body: unknown): number | undefined {
  if (!isPlainObject(body)) return undefined
  const error = body.error
  if (!isPlainObject(error)) return undefined
  // Groq may include a "retry_after" field in seconds, or a message like
  // "Please try again in Xs". Check both.
  if (typeof error.retry_after === "number") {
    return error.retry_after * 1000 // convert s -> ms
  }
  const message = typeof error.message === "string" ? error.message : ""
  const match = message.match(/Please try again in (\d+)s/i)
  if (match && match[1]) {
    return parseInt(match[1], 10) * 1000
  }
  return undefined
}
