import type {
  AsrProvider,
  AudioFrame,
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
import { ChurchOverlayWsServer, type ServerTokens } from "../ws/server"
import { resolveTranscriptVerses } from "./resolve-transcript-verses"
import { resolveVerse } from "../verse/resolve-verse"

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
  })

  function broadcastVerse(verse: Verse, correlationId?: string): void {
    wsServer.broadcast({
      id: generateUlid(),
      type: "verse:show",
      timestamp: Date.now(),
      correlationId,
      payload: verse,
    })
  }

  async function handleAudioFrame(frame: AudioFrame): Promise<void> {
    await asr.sendAudio(frame)
  }

  async function handleCommand(message: WsMessage, role: WsRole): Promise<void> {
    switch (message.type) {
      case "mic:start":
        await asr.start()
        logger.info({ component: "app-core", event: "mic.started" })
        return

      case "mic:stop":
        await asr.stop()
        logger.info({ component: "app-core", event: "mic.stopped" })
        return

      case "verse:clear":
        wsServer.broadcast({
          id: generateUlid(),
          type: "verse:clear",
          timestamp: Date.now(),
          correlationId: message.correlationId,
          payload: null,
        })
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
        const verse = await resolveVerse(reference, source, cache, circuitBreaker)
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

      // status:update / transcript:partial / verse:show are server-
      // originated events; the action registry's role check (empty
      // allowedSenders) already refuses any client attempting to send
      // them inbound, so onCommand is never actually invoked for these.
      // Kept only so this switch stays exhaustive and explicit rather
      // than silently ignoring a case (AGENTS.md section 25).
      case "status:update":
      case "transcript:partial":
      case "verse:show":
        logger.warn({
          component: "app-core",
          event: "unreachable-command",
          metadata: { type: message.type, role },
        })
        return
    }
  }

  asr.onTranscript((transcript) => {
    logger.info({
      component: "asr",
      event: "transcript.received",
      correlationId: transcript.correlationId,
      sequence: transcript.sequence,
    })
    resolveTranscriptVerses(transcript, detector, index, source, cache, circuitBreaker)
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
