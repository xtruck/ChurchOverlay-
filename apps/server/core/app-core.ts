import type {
  AsrProvider,
  AudioFrame,
  MediaShowPayload,
  TranscriptResult,
  Verse,
  VerseDetector,
  VerseIndex,
  VerseReference,
  VerseSource,
  WsMessage,
  WsRole,
} from "../../../packages/contracts"
import { generateUlid } from "../../../packages/shared/ulid"
import type { Logger } from "../../../packages/shared/logger"
import { VerseCache } from "../verse/verse-cache"
import { CircuitBreaker } from "../verse/circuit-breaker"
import { SilenceGate } from "../audio/silence-gate"
import { ChurchOverlayWsServer, type ServerTokens } from "../ws/server"
import { resolveTranscriptVerses } from "./resolve-transcript-verses"
import { resolveVerse } from "../verse/resolve-verse"
import { passesTranscriptGate } from "./transcript-gate"
import type { MediaLibrary } from "../media/media-library"
import { MediaCueDetector } from "../media/media-cue-detector"
import { MediaPlaybackController } from "../media/media-playback-controller"
import { NavigationCommandDetector } from "../detector/navigation-command-detector"
import { resolveNavigationCommand } from "../verse/resolve-navigation-command"

/**
 * Every provider/seam is injected, never constructed inside this
 * function — ARCHITECTURE.md section 57's own success criteria are "a
 * new ASR provider can be added without rewriting the application core"
 * and "a new verse source can be added without modifying the detector".
 * Hardcoding GroqProvider/FreeApiSource in here would defeat that; the
 * caller (the Electron main process, or a test) decides which concrete
 * implementations to use and passes them in already constructed.
 */
/**
 * onError is deliberately NOT part of the fixed AsrProvider contract in
 * packages/contracts — that interface has no error channel at all.
 * GroqProvider happens to offer this as an addition (see its doc
 * comment); AppCore uses it opportunistically, when present, so an ASR
 * failure is observable rather than silently swallowed (AGENTS.md
 * section 25), without forcing every future AsrProvider implementation
 * to add a method the shared interface doesn't require.
 */
type ObservableAsrProvider = AsrProvider & {
  onError?(callback: (error: Error) => void): void
}

export type StartAppCoreOptions = {
  readonly asr: ObservableAsrProvider
  readonly detector: VerseDetector
  readonly index: VerseIndex
  readonly source: VerseSource
  readonly logger: Logger
  readonly host?: string
  readonly port: number
  readonly tokens: ServerTokens
  readonly cache?: VerseCache
  readonly circuitBreaker?: CircuitBreaker
  readonly silenceGate?: SilenceGate
  /**
   * Optional (ARCHITECTURE.md section 60) — when absent, media commands
   * are handled gracefully (logged, no-op) rather than crashing or being
   * silently unhandled; existing callers that predate Phase 2 need no
   * changes. When present, wires up both voice-triggered media detection
   * (MediaCueDetector, constructed internally here — not a separate
   * seam of its own, same as VerseCache/CircuitBreaker/SilenceGate above)
   * and the operator's media:select/play/pause/seek/clear commands.
   */
  readonly mediaLibrary?: MediaLibrary
}

export type AppCoreHandle = {
  readonly wsServer: ChurchOverlayWsServer
  stop(): Promise<void>
}

/**
 * Wires the pieces built so far into the running Application Core
 * (ARCHITECTURE.md section 22): a real WS server, a real ASR provider, and
 * the full detect -> validate -> resolve pipeline, connected end to end.
 *
 * This is a plain function, not a class, deliberately: the WS server and
 * the ASR provider each need a callback that closes over the other side
 * of the wiring (the server's onCommand needs to reach the ASR provider;
 * the ASR provider's onTranscript needs to reach the server's broadcast),
 * and a function with local closures expresses that far more plainly than
 * a class would need to via a two-phase constructor/setter dance to break
 * the circular reference. It also keeps this from becoming the kind of
 * "server.ts that knows everything" AGENTS.md section 26 warns against:
 * each piece it wires together already owns its own real logic.
 */
export async function startAppCore(options: StartAppCoreOptions): Promise<AppCoreHandle> {
  const { logger, asr, detector, index, source } = options
  const cache = options.cache ?? new VerseCache()
  const circuitBreaker = options.circuitBreaker ?? new CircuitBreaker()
  const silenceGate = options.silenceGate ?? new SilenceGate()
  const mediaLibrary = options.mediaLibrary
  const mediaCueDetector = mediaLibrary ? new MediaCueDetector(mediaLibrary) : null
  const mediaPlayback = new MediaPlaybackController()
  const navigationCommandDetector = new NavigationCommandDetector()
  // ARCHITECTURE.md section 61.4: updated by every verse:show, however
  // triggered (detected, manual override, or navigation itself) — "next
  // verse" after an operator's manual override continues from wherever
  // the operator pointed, the least-surprising default.
  let currentVersePosition: VerseReference | null = null

  const wsServer = new ChurchOverlayWsServer({
    host: options.host,
    port: options.port,
    tokens: options.tokens,
    onCommand: (message, role) => {
      handleCommand(message, role).catch((err) =>
        logger.error({
          component: "app-core",
          event: "command.failed",
          correlationId: message.correlationId,
          error: err instanceof Error ? err.message : String(err),
        })
      )
    },
    onAudioFrame: (frame) => {
      handleAudioFrame(frame).catch((err) =>
        logger.error({
          component: "app-core",
          event: "audio-frame.failed",
          error: err instanceof Error ? err.message : String(err),
        })
      )
    },
    onRejected: (reason, role) => {
      logger.warn({ component: "ws", event: "message.rejected", metadata: { reason, role } })
    },
    // ARCHITECTURE.md section 60.4's reconnect/late-join sync: a viewer
    // that connects while a media cue is already active must see it
    // immediately, without ever giving viewers a way to ask for one
    // (invariant 8).
    onViewerConnected: (send) => {
      const payload = mediaPlayback.currentPayloadForSync()
      if (payload) {
        send({ id: generateUlid(), type: "media:show", timestamp: Date.now(), payload })
      }
    },
  })

  function broadcastVerse(verse: Verse, correlationId?: string): void {
    currentVersePosition = verse.reference
    wsServer.broadcast({
      id: generateUlid(),
      type: "verse:show",
      timestamp: Date.now(),
      correlationId,
      payload: verse,
    })
  }

  function broadcastVerseClear(correlationId?: string): void {
    currentVersePosition = null
    wsServer.broadcast({
      id: generateUlid(),
      type: "verse:clear",
      timestamp: Date.now(),
      correlationId,
      payload: null,
    })
  }

  function broadcastMedia(payload: MediaShowPayload, correlationId?: string): void {
    wsServer.broadcast({
      id: generateUlid(),
      type: "media:show",
      timestamp: Date.now(),
      correlationId,
      payload,
    })
  }

  async function handleAudioFrame(frame: AudioFrame): Promise<void> {
    // ARCHITECTURE.md section 9 / AGENTS.md section 11: reduce unnecessary
    // ASR requests by not forwarding obvious silence. This must never
    // silently discard SPEECH without a trace, which is exactly why the
    // gate's own metrics (not just its pass/fail decision) are logged
    // when the mic stops, below — an operator with a "nothing is being
    // detected" complaint can see whether frames were even reaching ASR.
    const { forwarded } = silenceGate.process(frame)
    if (forwarded) {
      await asr.sendAudio(frame)
    }
  }

  async function handleCommand(message: WsMessage, role: WsRole): Promise<void> {
    switch (message.type) {
      case "mic:start":
        await asr.start()
        logger.info({ component: "app-core", event: "mic.started" })
        return

      case "mic:stop":
        await asr.stop()
        logger.info({
          component: "app-core",
          event: "mic.stopped",
          metadata: silenceGate.getMetrics(),
        })
        return

      case "verse:clear":
        broadcastVerseClear(message.correlationId)
        return

      case "verse:override": {
        // AGENTS.md section 50 / ARCHITECTURE.md section 36: manual
        // override is still subject to the SAME validation pipeline —
        // never trust the operator's typed reference just because a
        // human entered it. The payload is already schema-shaped by
        // validateWsMessage (book/chapter/verse types are correct), but
        // shape isn't existence: it still goes through resolveVerse()
        // exactly like a detected reference would.
        const reference = message.payload as VerseReference
        const verse = await resolveVerse(reference, source, cache, circuitBreaker, undefined, logger)
        if (verse) {
          broadcastVerse(verse, message.correlationId)
        } else {
          logger.info({
            component: "app-core",
            event: "override.rejected",
            correlationId: message.correlationId,
            metadata: { reference },
          })
        }
        return
      }

      case "media:select": {
        if (!mediaLibrary) {
          logger.warn({ component: "app-core", event: "media.not-configured", correlationId: message.correlationId })
          return
        }
        const { id } = message.payload as { id: string }
        const cue = mediaLibrary.resolve(id)
        if (!cue) {
          logger.info({
            component: "app-core",
            event: "media.select-rejected",
            correlationId: message.correlationId,
            metadata: { id },
          })
          return
        }
        broadcastMedia(mediaPlayback.activate(cue), message.correlationId)
        return
      }

      case "media:play": {
        const payload = mediaPlayback.play()
        if (payload) broadcastMedia(payload, message.correlationId)
        return
      }

      case "media:pause": {
        const payload = mediaPlayback.pause()
        if (payload) broadcastMedia(payload, message.correlationId)
        return
      }

      case "media:seek": {
        const { positionMs } = message.payload as { positionMs: number }
        const payload = mediaPlayback.seek(positionMs)
        if (payload) broadcastMedia(payload, message.correlationId)
        return
      }

      case "media:clear": {
        if (mediaPlayback.clear()) {
          wsServer.broadcast({
            id: generateUlid(),
            type: "media:clear",
            timestamp: Date.now(),
            correlationId: message.correlationId,
            payload: null,
          })
        }
        return
      }

      // status:update / transcript:partial / verse:show / media:show are
      // server-originated events; the action registry's role check (empty
      // allowedSenders) already refuses any client attempting to send
      // them inbound, so onCommand is never actually invoked for these.
      // Kept only so this switch stays exhaustive and explicit rather
      // than silently ignoring a case (AGENTS.md section 25).
      case "status:update":
      case "transcript:partial":
      case "verse:show":
      case "media:show":
        logger.warn({
          component: "app-core",
          event: "unreachable-command",
          metadata: { type: message.type, role },
        })
        return
    }
  }

  /**
   * ARCHITECTURE.md section 61: resolves each detected navigation command
   * sequentially, not concurrently — the same reasoning
   * resolveTranscriptVerses already documents for multiple detected verse
   * references (keeps cache/circuit-breaker state changes easy to reason
   * about, and here also keeps currentVersePosition updates from racing
   * each other within one transcript).
   */
  async function handleNavigationCommands(transcript: TranscriptResult): Promise<void> {
    for (const command of navigationCommandDetector.detect(transcript.text)) {
      const resolution = resolveNavigationCommand(command, currentVersePosition, index)

      if (resolution.kind === "cancel") {
        broadcastVerseClear(transcript.correlationId)
        continue
      }
      if (resolution.kind === "no-op") {
        logger.info({
          component: "app-core",
          event: "navigation.no-op",
          correlationId: transcript.correlationId,
          metadata: { command },
        })
        continue
      }

      // Still the full resolveVerse() pipeline (cache -> circuit breaker ->
      // source), not just the index.exists() check resolveNavigationCommand
      // already did — existence isn't the same as having real verse text
      // to display (invariant 17).
      const verse = await resolveVerse(resolution.reference, source, cache, circuitBreaker, undefined, logger)
      if (verse) {
        broadcastVerse(verse, transcript.correlationId)
      }
    }
  }

  asr.onTranscript((transcript) => {
    logger.info({
      component: "asr",
      event: "transcript.received",
      correlationId: transcript.correlationId,
      sequence: transcript.sequence,
    })
    resolveTranscriptVerses(transcript, detector, index, source, cache, circuitBreaker, logger)
      .then((verses) => {
        for (const verse of verses) {
          broadcastVerse(verse, transcript.correlationId)
        }
      })
      .catch((err) => {
        logger.error({
          component: "app-core",
          event: "transcript.pipeline-failed",
          correlationId: transcript.correlationId,
          error: err instanceof Error ? err.message : String(err),
        })
      })

    // Voice-triggered media (ARCHITECTURE.md section 60.3), running
    // alongside verse detection above, not instead of it — a sentence can
    // plausibly contain both a spoken verse reference and a spoken cue
    // title. Gated by the same transcript rule as verse detection
    // (invariant 1 / invariant 13, section 60.6): partial transcripts
    // never reach MediaCueDetector.
    if (mediaCueDetector && passesTranscriptGate(transcript)) {
      for (const cue of mediaCueDetector.detect(transcript.text)) {
        broadcastMedia(mediaPlayback.activate(cue), transcript.correlationId)
      }
    }

    // Voice-driven verse navigation (ARCHITECTURE.md section 61), also
    // running alongside verse detection and voice-triggered media, not
    // instead of either. Gated by the same transcript rule (invariant 18):
    // partial transcripts never reach NavigationCommandDetector.
    if (passesTranscriptGate(transcript)) {
      handleNavigationCommands(transcript).catch((err) => {
        logger.error({
          component: "app-core",
          event: "navigation.failed",
          correlationId: transcript.correlationId,
          error: err instanceof Error ? err.message : String(err),
        })
      })
    }
  })

  asr.onError?.((err) => {
    logger.error({ component: "asr", event: "transcript.failed", error: err.message })
  })

  await wsServer.ready
  logger.info({ component: "app-core", event: "started", metadata: { port: wsServer.port } })

  return {
    wsServer,
    async stop() {
      await asr.stop().catch(() => {})
      await wsServer.close()
      logger.info({ component: "app-core", event: "stopped" })
    },
  }
}
