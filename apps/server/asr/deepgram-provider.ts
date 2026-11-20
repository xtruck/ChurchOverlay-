import { isPlainObject } from "../../../packages/shared/type-guards"
import { WebSocket } from "ws"
import type { AsrContextHints, AsrProvider, AudioFrame, TranscriptResult } from "../../../packages/contracts"
import { boundedKeyterms, estimateKeytermTokens, sameKeyterms } from "./deepgram-keyterms"
import { generateUlid } from "../../../packages/shared/ulid"
import type { Logger } from "../../../packages/shared/logger"
import { biblicalVocabularyFor, plannedBookTerms } from "./biblical-vocabulary"
import { OFF_LANGUAGE_MIN_WORDS, offLanguageShare } from "./language-lock"
import { isBibleWord } from "./transcript-screen"
import type { TranscriptionPolicy } from "./noise-mode"

const DEFAULT_MODEL = "nova-2"
/**
 * `language=multi` (code-switching, English + French among others) is a
 * Nova-3 feature; Nova-2 only code-switches Spanish + English. Checked against
 * developers.deepgram.com (multilingual code-switching, keyterm, languages).
 */
const MULTI_MODEL = "nova-3"
/** Deepgram recommends endpointing=100 for code-switching. */
const MULTI_ENDPOINTING_MS = 100
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

/** After this many language drops in a row the guard stops dropping until a transcript passes it. */
export const DEEPGRAM_LANGUAGE_VALVE_AFTER = 5

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
  /** Receives one debug line per transcript dropped for being in another language. */
  readonly logger?: Logger
  /** Operator noise/tongues strictness: how much off-language speech is tolerated (noise-mode.ts). */
  readonly policy?: TranscriptionPolicy
  /**
   * SF-19: reopen the socket (exponential backoff, driven by incoming audio) after an unexpected close.
   * For when this is the only or the last provider in the chain: nothing else can take over, so without
   * it the app stays deaf until the mic is cycled. Off by default (a failover wrapper handles the close).
   */
  readonly reconnectOnClose?: boolean
  /** Injectable clock for the reconnect backoff and the keyterm Configure interval. */
  readonly now?: () => number
  /** Quiet period before a changed keyterm list is sent mid-stream. Default 1.5 s. */
  readonly configureDebounceMs?: number
  /** Least time between two mid-stream Configure messages. Default 10 s. */
  readonly configureMinIntervalMs?: number
  /** Injectable one-shot timer for the Configure debounce (tests). */
  readonly timers?: DeepgramTimers
}

export type DeepgramTimers = {
  setTimeout(callback: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

const DEFAULT_TIMERS: DeepgramTimers = {
  setTimeout(callback, ms) {
    const handle = setTimeout(callback, ms)
    handle.unref?.()
    return handle
  },
  clearTimeout(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>)
  },
}

/**
 * Mid-stream keyterm updates (architecture note keyterms-follow-sermon.md).
 * The debounce absorbs a burst (a rundown load pushes plan and focus in the
 * same tick); the minimum interval bounds the rate to 6 Configure messages a
 * minute whatever the core does. Deepgram publishes no rate limit for
 * Configure; these are this app's own conservative bounds.
 */
export const DEFAULT_CONFIGURE_DEBOUNCE_MS = 1_500
export const DEFAULT_CONFIGURE_MIN_INTERVAL_MS = 10_000
/** After this many ConfigureFailure replies on one connection, stop sending Configure until the next connect. */
export const MAX_CONFIGURE_FAILURES_PER_CONNECTION = 3

const RECONNECT_INITIAL_MS = 1_000
const RECONNECT_MAX_MS = 30_000

type DeepgramMessage = {
  readonly type?: string
  readonly is_final?: boolean
  readonly speech_final?: boolean
  readonly channel?: {
    readonly alternatives?: readonly {
      readonly transcript?: string
      readonly confidence?: number
      /** Nova-3 `multi` only (unverified against live traffic): detected languages, and a language per word. */
      readonly languages?: readonly string[]
      readonly words?: readonly { readonly language?: string }[]
    }[]
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
  private readonly endpointingExplicit: boolean
  private readonly connectTimeoutMs: number
  private readonly biblicalVocabulary: boolean
  private language: string | undefined
  private readonly logger?: Logger
  private readonly policy?: TranscriptionPolicy
  private offLanguageDrops = 0
  private consecutiveOffLanguage = 0
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
  private reconnectOnClose: boolean
  private readonly now: () => number
  private lostUnexpectedly = false
  private reconnectAttempts = 0
  private nextReconnectAt = 0
  private reconnecting: Promise<void> | null = null
  // Mid-stream keyterms (Configure). connectedKeyterms is the list the OPEN stream has (null: no stream).
  private contextHints: AsrContextHints | null = null
  private connectedKeyterms: readonly string[] | null = null
  private previousKeyterms: readonly string[] | null = null
  private configureTimer: unknown = null
  private lastConfigureAt = Number.NEGATIVE_INFINITY
  private configureFailures = 0
  private configureDisabled = false
  private readonly configureDebounceMs: number
  private readonly configureMinIntervalMs: number
  private readonly timers: DeepgramTimers

  constructor(options: DeepgramProviderOptions) {
    this.reconnectOnClose = options.reconnectOnClose ?? false
    this.now = options.now ?? Date.now
    this.configureDebounceMs = Math.max(0, options.configureDebounceMs ?? DEFAULT_CONFIGURE_DEBOUNCE_MS)
    this.configureMinIntervalMs = Math.max(0, options.configureMinIntervalMs ?? DEFAULT_CONFIGURE_MIN_INTERVAL_MS)
    this.timers = options.timers ?? DEFAULT_TIMERS
    if (!options.apiKey.trim()) throw new Error("DeepgramProvider requires an apiKey")
    this.apiKey = options.apiKey
    this.model = options.model ?? DEFAULT_MODEL
    this.language = options.language
    this.logger = options.logger
    this.policy = options.policy
    this.url = options.url ?? DEFAULT_URL
    this.WebSocketImpl = options.WebSocketImpl ?? WebSocket
    this.keepAliveIntervalMs = options.keepAliveIntervalMs ?? DEFAULT_KEEPALIVE_MS
    this.endpointingMs = options.endpointingMs ?? DEFAULT_ENDPOINTING_MS
    this.endpointingExplicit = options.endpointingMs !== undefined
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS
    this.biblicalVocabulary = options.biblicalVocabulary ?? true
  }

  /** SF-19: the host turns this on once it knows Deepgram is the last provider in the chain (see the option). */
  setReconnectOnClose(enabled: boolean): void {
    this.reconnectOnClose = enabled
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
   * included here too. This entry point takes effect on the NEXT start(),
   * never as a live reconnect. Live updates arrive through setContextHints()
   * (which, once called, is the source of the planned books).
   */
  setPlannedBooks(bookIds: readonly string[]): void {
    this.plannedBookIds = bookIds
  }

  /**
   * Provider-neutral hints from the core (architecture note
   * keyterms-follow-sermon.md). Always stored, so the next connect's URL
   * carries them. On an open Nova-3 stream a changed term list is also sent
   * as a mid-stream Configure (debounced, rate-bounded, never retried).
   * Nova-2 `keywords` has no documented mid-stream update: there the hints
   * wait for the next connect, and that is logged.
   */
  setContextHints(hints: AsrContextHints): void {
    this.contextHints = {
      focusBooks: Array.isArray(hints?.focusBooks) ? hints.focusBooks.filter((id) => typeof id === "string") : [],
      plannedBooks: Array.isArray(hints?.plannedBooks) ? hints.plannedBooks.filter((id) => typeof id === "string") : [],
    }
    this.scheduleConfigure()
  }

  private resolvedModel(): string {
    return this.language === "multi" && !this.model.startsWith("nova-3") ? MULTI_MODEL : this.model
  }

  /**
   * The whole list, MOST relevant first so the budget drops the least
   * relevant: focus books, then the plan (capped at MAX_PLANNED_BOOK_TERMS
   * as before), then the static biblical vocabulary. Sanitized and bounded
   * by deepgram-keyterms.ts. The same list feeds the URL and Configure,
   * because Configure REPLACES the stream's whole list.
   */
  currentKeyterms(): readonly string[] {
    const focus = plannedBookTerms(this.contextHints?.focusBooks ?? [], this.language)
    const focusSet = new Set(focus)
    const planned = plannedBookTerms(this.contextHints ? this.contextHints.plannedBooks : this.plannedBookIds, this.language)
      .filter((term) => !focusSet.has(term))
      .slice(0, MAX_PLANNED_BOOK_TERMS)
    const vocabulary = this.biblicalVocabulary ? biblicalVocabularyFor(this.language) : []
    return boundedKeyterms([...focus, ...planned, ...vocabulary])
  }

  /** The exact streaming URL start() opens. Contains no secret — the key travels in a header. */
  buildUrl(): string {
    return this.buildUrlWith(this.currentKeyterms())
  }

  private buildUrlWith(keyterms: readonly string[]): string {
    const multi = this.language === "multi"
    const model = this.resolvedModel()
    const endpointingMs = multi && !this.endpointingExplicit ? MULTI_ENDPOINTING_MS : this.endpointingMs
    const query = new URLSearchParams({
      model,
      encoding: "linear16",
      sample_rate: "16000",
      channels: "1",
      interim_results: "true",
      smart_format: "true",
      endpointing: String(endpointingMs),
    })
    if (this.language) query.set("language", this.language)
    // nova-3 replaced weighted `keywords` with plain `keyterm` prompting.
    const nova3 = model.startsWith("nova-3")
    for (const term of keyterms) query.append(nova3 ? "keyterm" : "keywords", nova3 ? term : `${term}:2`)
    return `${this.url}?${query.toString()}`
  }

  async start(): Promise<void> {
    if (this.active) return
    this.active = true
    this.sequence = 0
    this.correlationId = generateUlid()
    const keyterms = this.currentKeyterms()
    const socket = new this.WebSocketImpl(this.buildUrlWith(keyterms), {
      headers: { Authorization: `Token ${this.apiKey}` },
    })
    this.socket = socket
    socket.on("message", (data) => this.handleMessage(data.toString()))
    socket.on("error", (error) => this.reportError(error))
    socket.on("close", () => {
      if (this.socket !== socket) return
      this.clearKeepAlive()
      this.resetConfigureState()
      if (!this.active) return
      this.socket = null
      this.active = false
      if (this.reconnectOnClose) {
        this.lostUnexpectedly = true
        this.reconnectAttempts = 0
        this.nextReconnectAt = this.now() + RECONNECT_INITIAL_MS
      }
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
    // stop() ran while this socket was still connecting: it had nothing open to
    // close, so close it here instead of leaving a live, billed connection that
    // keeps delivering transcripts after the mic was stopped.
    if (this.socket !== socket) {
      if (socket.readyState === this.WebSocketImpl.OPEN || socket.readyState === this.WebSocketImpl.CONNECTING) {
        socket.close()
      }
      return
    }
    this.lastSendAt = Date.now()
    this.armKeepAlive(socket)
    this.resetConfigureState()
    this.connectedKeyterms = keyterms
    // Hints that changed while connecting were not in the URL: send them now (same bounds as always).
    this.scheduleConfigure()
  }

  // ---- Mid-stream keyterms (Configure) ------------------------------------

  private resetConfigureState(): void {
    if (this.configureTimer !== null) this.timers.clearTimeout(this.configureTimer)
    this.configureTimer = null
    this.connectedKeyterms = null
    this.previousKeyterms = null
    this.configureFailures = 0
    this.configureDisabled = false
  }

  /**
   * Arms at most ONE pending Configure. A change while one is pending does
   * not re-arm it: the pending one reads the latest hints when it fires, so
   * a stream of changes can never postpone the update indefinitely, nor send
   * more than one message per configureMinIntervalMs.
   */
  private scheduleConfigure(): void {
    if (this.connectedKeyterms === null || this.openSocket() === null) return // next start() puts them in the URL
    if (this.configureTimer !== null || this.configureDisabled) return
    if (sameKeyterms(this.currentKeyterms(), this.connectedKeyterms)) return
    if (!this.resolvedModel().startsWith("nova-3")) {
      this.logger?.debug({
        component: "asr",
        event: "deepgram.keyterms-deferred",
        correlationId: this.correlationId,
        metadata: { reason: "model-without-configure", model: this.resolvedModel() },
      })
      return
    }
    const wait = Math.max(this.configureDebounceMs, this.lastConfigureAt + this.configureMinIntervalMs - this.now())
    this.configureTimer = this.timers.setTimeout(() => {
      this.configureTimer = null
      this.sendConfigure()
    }, wait)
  }

  private sendConfigure(): void {
    const socket = this.openSocket()
    const connected = this.connectedKeyterms
    if (socket === null || connected === null || this.configureDisabled) return
    const next = this.currentKeyterms()
    if (sameKeyterms(next, connected)) return
    try {
      socket.send(JSON.stringify({ type: "Configure", keyterms: next }))
    } catch (err) {
      // Not an ASR error (that would trigger a failover): the stream keeps its list, a later change retries once.
      this.logger?.warn({
        component: "asr",
        event: "deepgram.keyterms-configure-send-failed",
        correlationId: this.correlationId,
        error: err instanceof Error ? err.message : String(err),
      })
      return
    }
    this.previousKeyterms = connected
    this.connectedKeyterms = next
    this.lastConfigureAt = this.now()
    const before = new Set(connected)
    const after = new Set(next)
    this.logger?.info({
      component: "asr",
      event: "deepgram.keyterms-configured",
      correlationId: this.correlationId,
      metadata: {
        count: next.length,
        estimatedTokens: next.reduce((sum, term) => sum + estimateKeytermTokens(term), 0),
        added: next.filter((term) => !before.has(term)).length,
        removed: connected.filter((term) => !after.has(term)).length,
      },
    })
  }

  /**
   * Deepgram answers an over-limit Configure with ConfigureFailure and keeps
   * the previous list. Record that (the stream has the old list again), log
   * it, never retry automatically, and stop sending Configure on this
   * connection after MAX_CONFIGURE_FAILURES_PER_CONNECTION.
   */
  private handleConfigureFailure(message: Record<string, unknown>): void {
    if (this.previousKeyterms !== null) this.connectedKeyterms = this.previousKeyterms
    this.previousKeyterms = null
    this.configureFailures += 1
    const code = typeof message.code === "string" ? message.code.slice(0, 64) : undefined
    this.logger?.warn({
      component: "asr",
      event: "deepgram.keyterms-configure-failed",
      correlationId: this.correlationId,
      metadata: { code, failures: this.configureFailures },
    })
    if (this.configureFailures >= MAX_CONFIGURE_FAILURES_PER_CONNECTION && !this.configureDisabled) {
      this.configureDisabled = true
      if (this.configureTimer !== null) this.timers.clearTimeout(this.configureTimer)
      this.configureTimer = null
      this.logger?.warn({
        component: "asr",
        event: "deepgram.keyterms-configure-disabled",
        correlationId: this.correlationId,
        metadata: { failures: this.configureFailures },
      })
    }
  }

  /** SF-19: one reconnect attempt at a time, spaced by exponential backoff; each failure is reported. */
  private async reconnectIfDue(): Promise<void> {
    if (this.reconnecting) return this.reconnecting
    if (this.now() < this.nextReconnectAt) return
    this.reconnecting = (async () => {
      try {
        await this.start()
        if (this.active) {
          this.lostUnexpectedly = false
          this.reconnectAttempts = 0
          this.logger?.info({ component: "asr", event: "deepgram.reconnected" })
        }
      } catch (error) {
        this.reconnectAttempts += 1
        this.nextReconnectAt = this.now() + Math.min(RECONNECT_INITIAL_MS * 2 ** this.reconnectAttempts, RECONNECT_MAX_MS)
        this.reportError(error instanceof Error ? error : new Error(String(error)))
      }
    })().finally(() => {
      this.reconnecting = null
    })
    return this.reconnecting
  }

  async sendAudio(audio: AudioFrame): Promise<void> {
    let socket = this.openSocket()
    if (!socket && this.lostUnexpectedly) {
      await this.reconnectIfDue()
      socket = this.openSocket()
    }
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
    this.lostUnexpectedly = false
    this.clearKeepAlive()
    this.resetConfigureState()
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
    if (parsed.type === "ConfigureFailure") {
      this.handleConfigureFailure(parsed)
      return
    }
    const message = parsed as DeepgramMessage
    const alternatives = isPlainObject(message.channel) ? message.channel.alternatives : undefined
    const alternative = Array.isArray(alternatives) && isPlainObject(alternatives[0]) ? alternatives[0] : undefined
    const text = typeof alternative?.transcript === "string" ? alternative.transcript.trim() : ""
    if (!text) return
    const state = message.is_final ? "final" : "partial"
    // `language=multi` code-switches ten languages, not two. French and English only: a transcript that is mostly
    // something else is dropped (tolerance by mode: tongues is least tolerant).
    // Only alphabetic words count, Bible book names and numbers never do (engines mis-tag them), and fewer than
    // OFF_LANGUAGE_MIN_WORDS judged words is never enough to drop: "Jean 3 16" must always get through.
    const alphabeticWords = text.split(/[^\p{L}]+/u).filter((word) => word.length > 0 && !isBibleWord(word)).length
    const off = offLanguageShare(alternative?.words, alternative?.languages, { transcriptWords: alphabeticWords, skip: isBibleWord })
    const limit = this.policy?.mode === "tongues" ? 0.25 : this.policy?.mode === "noisy" ? 0.4 : 0.5
    if (off !== null && off.judged >= OFF_LANGUAGE_MIN_WORDS && off.share >= limit) {
      this.consecutiveOffLanguage += 1
      if (this.consecutiveOffLanguage <= DEEPGRAM_LANGUAGE_VALVE_AFTER) {
        this.offLanguageDrops += 1
        const note = this.policy?.ledger.record("off-language", "deepgram")
        if (note === undefined || note.log) {
          this.logger?.info({
            component: "asr",
            event: "deepgram.language-dropped",
            correlationId: this.correlationId,
            metadata: { share: Math.round(off.share * 100) / 100, judged: off.judged, state, total: this.offLanguageDrops, suppressed: note?.suppressed ?? 1 },
          })
        }
        if (state === "final") this.correlationId = generateUlid()
        return
      }
      // Safety valve: many drops in a row means the guard, not the speaker, is probably wrong. Let text through, say so.
      if (this.consecutiveOffLanguage === DEEPGRAM_LANGUAGE_VALVE_AFTER + 1) {
        this.policy?.ledger.setValve("deepgram-language", true)
        this.logger?.warn({
          component: "asr",
          event: "deepgram.language-guard-bypassed",
          metadata: { consecutive: DEEPGRAM_LANGUAGE_VALVE_AFTER, share: Math.round(off.share * 100) / 100 },
        })
      }
    } else if (this.consecutiveOffLanguage > 0) {
      if (this.consecutiveOffLanguage > DEEPGRAM_LANGUAGE_VALVE_AFTER) this.policy?.ledger.setValve("deepgram-language", false)
      this.consecutiveOffLanguage = 0
    }
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
    // AGENTS.md section 23: one processing chain per utterance. The partials and
    // the final of an utterance share an id; the next utterance gets its own, so
    // a single id can be traced through detector, lookup, WS and overlay.
    if (state === "final") this.correlationId = generateUlid()
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
