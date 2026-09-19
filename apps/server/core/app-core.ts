import type {
  AsrProvider,
  AsrStatusPayload,
  AudioFrame,
  CanvasSceneData,
  DefinitionShowPayload,
  DisplayMode,
  MediaCue,
  MediaShowPayload,
  Rundown,
  RundownScene,
  RundownStatePayload,
  TranscriptResult,
  Verse,
  VerseDetector,
  VerseIndex,
  VerseReference,
  VerseConfirmationMode,
  VerseShowPayload,
  VerseSource,
  VerseTrigger,
  WsMessage,
  WsRole,
} from "../../../packages/contracts"
import type { Server as HttpServer } from "node:http"
import { generateUlid } from "../../../packages/shared/ulid"
import type { Logger } from "../../../packages/shared/logger"
import { VerseCache } from "../verse/verse-cache"
import { CircuitBreaker } from "../verse/circuit-breaker"
import { SilenceGate } from "../audio/silence-gate"
import { ChurchOverlayWsServer, type ServerTokens } from "../ws/server"
import { resolveTranscriptVerses } from "./resolve-transcript-verses"
import { resolveVerse, translationIdFor } from "../verse/resolve-verse"
import { passesTranscriptGate } from "./transcript-gate"
import type { MediaLibrary } from "../media/media-library"
import { MediaCueDetector } from "../media/media-cue-detector"
import { MediaPlaybackController } from "../media/media-playback-controller"
import { NavigationCommandDetector } from "../detector/navigation-command-detector"
import { resolveNavigationCommand } from "../verse/resolve-navigation-command"
import { RundownController } from "../rundown/rundown-controller"
import { GlossaryDetector } from "../glossary/glossary-detector"
import { SessionRecorder, type SessionEntry } from "./session-recorder"
import type { SessionHistoryStore, SessionHistoryEntry } from "./session-history-store"

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

/**
 * ARCHITECTURE.md section 65.7 — the seam AppCore actually depends on
 * (same "depend on the narrow shape you use, not the concrete class"
 * pattern as VerseSource/AsrProvider): AppCore only ever calls
 * summarize(), never constructs a SermonNotesGenerator itself, so it
 * takes this minimal interface rather than the concrete class type.
 */
type SermonNotesSummarizer = {
  summarize(transcriptText: string): Promise<string>
}

export type StartAppCoreOptions = {
  readonly asr: ObservableAsrProvider
  readonly detector: VerseDetector
  readonly index: VerseIndex
  readonly source: VerseSource
  readonly logger: Logger
  readonly host?: string
  readonly port: number
  /**
   * ARCHITECTURE.md section 80 (Web Server Mode) — when provided, the
   * WebSocket server attaches to this existing http.Server instead of
   * opening its own standalone listener, so one process (e.g. an Express
   * app) can serve REST + static files + WS upgrades on a single port.
   * Passed straight through to ChurchOverlayWsServer; see its own `server`
   * option doc comment for the attach-vs-standalone behavior.
   */
  readonly server?: HttpServer
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
  /**
   * Optional (ARCHITECTURE.md section 79) — a persistent, cross-restart
   * record of every verse shown, separate from SessionRecorder (in-memory,
   * cleared every restart). Absent by default, same "optional capability,
   * gracefully absent" pattern as mediaLibrary above — no history is kept
   * unless the Electron main process constructs and loads one.
   */
  readonly sessionHistoryStore?: SessionHistoryStore
  /**
   * Optional (ARCHITECTURE.md section 65.4) — called after a voice-
   * triggered "switch to french"/"english only"/"switch to bilingual"
   * command successfully changes `source`'s live mode (via its optional
   * setMode() capability, same duck-typed pattern as translationIdFor()).
   * AppCore itself has no ConfigStore/persistence concern (it is provider-
   * agnostic, per section 57) — this hook exists solely so the Electron
   * main process can persist the change exactly like its existing
   * set-display-mode IPC handler does, so a voice-triggered switch
   * survives a restart identically to a dashboard-toggled one.
   */
  readonly onDisplayModeChanged?: (mode: DisplayMode) => void
  /**
   * Optional (ARCHITECTURE.md section 65.5) — how long a voice-triggered
   * glossary definition stays on screen before the server clears it on
   * its own, unprompted. Defaults to 12 seconds. Exposed here (rather
   * than a hardcoded constant) so tests can use a short delay instead of
   * waiting out the real default.
   */
  readonly definitionClearMs?: number
  /**
   * Optional (ARCHITECTURE.md section 65.3) — confirmed explicitly:
   * "auto" (the default, unchanged from pre-existing behavior) shows a
   * detected reference immediately; "review" holds it as a pending
   * suggestion (verse:pending) until the operator confirms it
   * (verse:confirm-pending). Only ever affects DETECTED references —
   * manual override, voice navigation, and rundown scene activation are
   * already explicit operator actions and are never held.
   */
  readonly verseConfirmationMode?: VerseConfirmationMode
  /**
   * Optional (ARCHITECTURE.md section 65.7) — a strictly separate,
   * dashboard-only side channel that never feeds into or is consulted by
   * the verse-detection/hallucination-guard pipeline (the hard boundary
   * the section documents). When absent, no sermon-notes summarization
   * ever happens — same "optional capability, gracefully absent"
   * pattern as mediaLibrary above. When present but sermonNotesEnabled
   * is false (the default, mirroring allowPhoneRemote's opt-in-for-cost
   * reasoning), the generator is held ready but never invoked, so a live
   * dashboard toggle can turn it on mid-service without reconstructing
   * AppCore.
   */
  readonly sermonNotesGenerator?: SermonNotesSummarizer
  readonly sermonNotesEnabled?: boolean
  /**
   * Defaults to 60 seconds (ARCHITECTURE.md section 65.7: "every ~60
   * seconds of accumulated final-transcript text, not on every single
   * transcript"). Exposed here, same reasoning as definitionClearMs
   * above, so tests can use a short interval instead of waiting out the
   * real default.
   */
  readonly sermonNotesIntervalMs?: number
  /**
   * Optional (ARCHITECTURE.md section 67.2) — how long a verse shown while
   * a principal poster is active stays on screen before the server clears
   * it on its own, unprompted, so the poster underneath becomes visible
   * again. Defaults to 2 minutes. Exposed here, same reasoning as
   * definitionClearMs above, so tests can use a short delay instead of
   * waiting out the real default.
   */
  readonly verseAutoClearMs?: number
}

export type AppCoreHandle = {
  readonly wsServer: ChurchOverlayWsServer
  /**
   * ARCHITECTURE.md section 65.3: the live-toggle half of "setup default +
   * live dashboard toggle" (the same pattern section 63.2 established for
   * display mode) — called by the Electron main process's own IPC
   * handler, which also persists the change to ConfigStore.
   */
  setVerseConfirmationMode(mode: VerseConfirmationMode): void
  /**
   * ARCHITECTURE.md section 65.7: the live-toggle half of "held ready,
   * gated by a flag" — called by the Electron main process's own IPC
   * handler, which also persists the change to ConfigStore. Disabling
   * mid-cycle also discards whatever transcript text had already
   * accumulated, so re-enabling later never summarizes stale text from
   * while it was off.
   */
  setSermonNotesEnabled(enabled: boolean): void
  /**
   * ARCHITECTURE.md section 65.8: the Electron main process's own
   * export-session IPC handler reads this to build the plain-text
   * transcript and quote-card images — a snapshot of every verse shown
   * this session, regardless of how it was triggered.
   */
  getSessionEntries(): readonly SessionEntry[]
  /**
   * ARCHITECTURE.md section 79: the persistent, cross-restart counterpart
   * to getSessionEntries() above — every verse ever recorded, not just
   * this run's. Empty when no sessionHistoryStore was configured, the
   * same "absent capability, empty/no-op result" pattern used elsewhere
   * (e.g. mediaLibrary-less media:select handling).
   */
  getSessionHistory(): readonly SessionHistoryEntry[]
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
  const onDisplayModeChanged = options.onDisplayModeChanged
  const mediaCueDetector = mediaLibrary ? new MediaCueDetector(mediaLibrary) : null
  const mediaPlayback = new MediaPlaybackController()
  const navigationCommandDetector = new NavigationCommandDetector()
  const rundownController = new RundownController()
  const sessionRecorder = new SessionRecorder()
  const sessionHistoryStore = options.sessionHistoryStore
  const glossaryDetector = new GlossaryDetector()
  const definitionClearMs = options.definitionClearMs ?? 12000
  let definitionClearTimer: ReturnType<typeof setTimeout> | null = null
  // ARCHITECTURE.md section 67: a principal poster is a persistent
  // background layer, not a scene the rundown state machine needs to know
  // about — held here purely so showVerse() knows whether to arm the
  // auto-clear timer below. Not persisted across restarts (section 67.2's
  // documented gap, matching the rundown's own).
  let principalPosterCueId: string | null = null
  // Every cue id ever appointed as a poster via poster:set stays voice-
  // triggerable by its own title for the rest of the session (section
  // 67.1's amendment: "name it so speaking that name puts it up") — a
  // cue is either a poster or a regular voice-triggered media cue, never
  // both; once marked, MediaCueDetector matches route here instead of
  // the normal media:show path, for as long as the app keeps running.
  const posterCueIds = new Set<string>()
  const verseAutoClearMs = options.verseAutoClearMs ?? 120000 // 2 minutes (section 67.2)
  let verseAutoClearTimer: ReturnType<typeof setTimeout> | null = null
  // ARCHITECTURE.md section 65.3: "auto" is the confirmed default —
  // unchanged from every existing behavior unless the operator explicitly
  // switches to "review". pendingVerse holds at most one not-yet-confirmed
  // detection — a newer one replaces (does not queue behind) an older
  // unconfirmed one, the same "most recent wins" reasoning the rundown's
  // paused-scene state already uses.
  let verseConfirmationMode: VerseConfirmationMode = options.verseConfirmationMode ?? "auto"
  let pendingVerse: Verse | null = null
  // ARCHITECTURE.md section 61.4: updated by every verse:show, however
  // triggered (detected, manual override, or navigation itself) — "next
  // verse" after an operator's manual override continues from wherever
  // the operator pointed, the least-surprising default.
  let currentVersePosition: VerseReference | null = null
  // The actual resolved Verse behind currentVersePosition, kept only so a
  // newly-connecting viewer can be resynced with what is REALLY on screen
  // during a verse-interrupt (see onViewerConnected below) — without this,
  // a reconnect mid-interrupt would resync the rundown's paused scene
  // instead of the verse actually covering it, which is worse than the
  // existing acknowledged "no verse resync at all" gap (ARCHITECTURE.md
  // section 60.5), since it would show something visibly wrong rather than
  // just nothing.
  let lastShownVerse: VerseShowPayload | null = null
  // Surfaces ASR health to the operator dashboard (a real, concrete use of
  // status:update — see its own doc comment in action-registry.ts, written
  // when nothing produced it yet). Tracked so a transcript arriving after
  // an error can broadcast the recovery, not just the failure.
  let asrHasError = false
  // ARCHITECTURE.md section 65.7: a rolling buffer of final-transcript text,
  // flushed and summarized on a fixed cadence rather than per-transcript —
  // both to bound Groq API cost and because a summary of one sentence isn't
  // a useful summary.
  const sermonNotesGenerator = options.sermonNotesGenerator
  const sermonNotesIntervalMs = options.sermonNotesIntervalMs ?? 60000
  let sermonNotesEnabled = options.sermonNotesEnabled ?? false
  let sermonNotesBuffer = ""
  const sermonNotesTimer: ReturnType<typeof setInterval> | null = sermonNotesGenerator
    ? setInterval(() => {
        if (!sermonNotesEnabled) return
        const text = sermonNotesBuffer.trim()
        sermonNotesBuffer = ""
        if (!text) return
        sermonNotesGenerator
          .summarize(text)
          .then((notes) => {
            wsServer.broadcast({
              id: generateUlid(),
              type: "sermonNotes:update",
              timestamp: Date.now(),
              payload: { notes },
            })
          })
          .catch((err) => {
            // ARCHITECTURE.md section 65.7: "logs and skips that cycle
            // silently recoverable next cycle — never affects mic capture,
            // ASR, or verse display in any way."
            logger.error({
              component: "app-core",
              event: "sermon-notes.summarize-failed",
              error: err instanceof Error ? err.message : String(err),
            })
          })
      }, sermonNotesIntervalMs)
    : null

  const wsServer = new ChurchOverlayWsServer({
    host: options.host,
    port: options.port,
    server: options.server,
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
      // ARCHITECTURE.md section 67.3: a principal poster is a persistent
      // backdrop, not scene state — synced independently of the
      // media/rundown blocks below, the same "late-join sync" reasoning
      // section 60.4 already established for every other persistent
      // content type.
      if (principalPosterCueId !== null) {
        const posterCue = mediaLibrary?.resolve(principalPosterCueId) ?? null
        if (posterCue) {
          send({ id: generateUlid(), type: "poster:show", timestamp: Date.now(), payload: { cue: posterCue } })
        }
      }
      const payload = mediaPlayback.currentPayloadForSync()
      if (payload) {
        send({ id: generateUlid(), type: "media:show", timestamp: Date.now(), payload })
      }
      // ARCHITECTURE.md section 64.4 (reusing section 60.4's reconnect/
      // late-join sync pattern): a viewer that connects while a rundown is
      // showing a verse/announcement/blank scene must see it immediately.
      // Media scenes are deliberately excluded here — the block above
      // already resyncs mediaPlayback's actual current state without the
      // side effect activate() has (resetting playback to position 0),
      // which re-running scene content for a "media" scene would cause.
      const rundownState = rundownController.currentState()
      if (rundownState) {
        send({ id: generateUlid(), type: "rundown:state", timestamp: Date.now(), payload: rundownState })
        if (rundownState.interrupted) {
          // The scene rundownController reports here is the PAUSED one —
          // what's actually visible right now is the interrupting verse
          // (section 64.2), so that's what a reconnecting viewer needs,
          // not the paused scene's own content underneath it.
          if (lastShownVerse) {
            send({ id: generateUlid(), type: "verse:show", timestamp: Date.now(), payload: lastShownVerse })
          }
        } else if (rundownState.scene.kind !== "media") {
          syncSceneContent(rundownState.scene, send).catch((err) => {
            logger.error({
              component: "app-core",
              event: "rundown.viewer-sync-failed",
              error: err instanceof Error ? err.message : String(err),
            })
          })
        }
      } else if (lastShownVerse) {
        // ARCHITECTURE.md production audit (section 74): a real,
        // structural gap, not just a narrow timing race — this branch
        // did not exist at all before. A verse shown OUTSIDE any rundown
        // (the common case: live detection/override/navigation with no
        // rundown loaded) was never resynced to a reconnecting viewer,
        // full stop — only the rundown-interrupt case above was covered.
        // A dropped OBS/overlay WS connection (section 48's bounded
        // reconnect backoff, commit 362e51d) reconnecting while a verse
        // was showing would silently never see it again until the next
        // detection — a plausible, previously-unfixed explanation for an
        // intermittently "missing" verse that WAS genuinely detected.
        send({ id: generateUlid(), type: "verse:show", timestamp: Date.now(), payload: lastShownVerse })
      }
    },
  })

  function showVerse(verse: Verse, trigger: VerseTrigger, correlationId?: string): void {
    currentVersePosition = verse.reference
    const payload: VerseShowPayload = { ...verse, trigger }
    lastShownVerse = payload
    const timestamp = Date.now()
    // ARCHITECTURE.md section 65.8: recorded here (not the detection-only
    // broadcastVerse()) so a post-service export includes every verse
    // that was actually visible, regardless of how it got there.
    sessionRecorder.record(verse, timestamp)
    // ARCHITECTURE.md section 79: the same event, additionally recorded
    // to persistent cross-restart history when configured — a write
    // failure here must never affect verse display itself (fire-and-
    // forget with logging, the same pattern handleAudioFrame's own
    // async work elsewhere in this file already uses).
    sessionHistoryStore?.record(verse, timestamp).catch((err) => {
      logger.error({
        component: "app-core",
        event: "session-history.record-failed",
        error: err instanceof Error ? err.message : String(err),
      })
    })
    wsServer.broadcast({
      id: generateUlid(),
      type: "verse:show",
      timestamp,
      correlationId,
      payload,
    })
    // ARCHITECTURE.md section 67 / invariant 25: every trigger funnels
    // through here, so this is the one place that needs to know about
    // verse auto-clear — no principal poster configured means no timer is
    // ever armed, zero behavior change for installs not using this
    // feature. A new verse always resets (never queues behind) a pending
    // timer, the same "most recent wins" pattern definitionClearTimer
    // already uses.
    if (verseAutoClearTimer) clearTimeout(verseAutoClearTimer)
    if (principalPosterCueId !== null) {
      verseAutoClearTimer = setTimeout(() => {
        verseAutoClearTimer = null
        broadcastVerseClear(correlationId)
      }, verseAutoClearMs)
    }
  }

  function clearVerse(correlationId?: string): void {
    currentVersePosition = null
    lastShownVerse = null
    // Invariant 25: whatever ended the verse (manual clear, navigation, a
    // "blank" scene), any pending auto-clear timer for it is now stale —
    // cancel it so it can never later fire against different content.
    if (verseAutoClearTimer) {
      clearTimeout(verseAutoClearTimer)
      verseAutoClearTimer = null
    }
    wsServer.broadcast({
      id: generateUlid(),
      type: "verse:clear",
      timestamp: Date.now(),
      correlationId,
      payload: null,
    })
  }

  /**
   * ARCHITECTURE.md section 64.2: the live-detection-always-wins path — used
   * for a detected reference, a manual override, or voice navigation, never
   * for a rundown's own "verse" scene activation (that goes through
   * showVerse() directly via activateScene() below, since the rundown
   * cursor is already correctly positioned and must not re-pause itself).
   */
  function broadcastVerse(verse: Verse, trigger: VerseTrigger, correlationId?: string): void {
    const rundownState = rundownController.interrupt()
    if (rundownState) broadcastRundownState(rundownState, correlationId)
    showVerse(verse, trigger, correlationId)
  }

  /**
   * ARCHITECTURE.md section 65.3: review mode's holding path for a
   * DETECTED reference — a new pending suggestion replaces (not queues
   * behind) any earlier not-yet-confirmed one, since an unconfirmed
   * suggestion for a verse spoken two sentences ago is almost never still
   * wanted once a newer one exists.
   */
  function broadcastPendingVerse(verse: Verse, correlationId?: string): void {
    pendingVerse = verse
    wsServer.broadcast({ id: generateUlid(), type: "verse:pending", timestamp: Date.now(), correlationId, payload: verse })
  }

  /**
   * The live-clear path (manual verse:clear, voice "cancel"). Hands control
   * back to whatever rundown scene was paused underneath the interrupting
   * verse (section 64.2) — resuming re-displays that scene's real content,
   * not just its metadata.
   */
  function broadcastVerseClear(correlationId?: string): void {
    clearVerse(correlationId)
    const resumed = rundownController.resumeFromInterrupt()
    if (resumed) {
      activateScene(resumed, correlationId).catch((err) => {
        logger.error({
          component: "app-core",
          event: "rundown.resume-failed",
          correlationId,
          error: err instanceof Error ? err.message : String(err),
        })
      })
    }
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

  function broadcastAnnouncement(payload: { title: string; body: string }, correlationId?: string): void {
    wsServer.broadcast({
      id: generateUlid(),
      type: "announcement:show",
      timestamp: Date.now(),
      correlationId,
      payload,
    })
  }

  function broadcastAsrStatus(payload: AsrStatusPayload): void {
    wsServer.broadcast({ id: generateUlid(), type: "status:update", timestamp: Date.now(), payload })
  }

  function broadcastAnnouncementClear(correlationId?: string): void {
    wsServer.broadcast({
      id: generateUlid(),
      type: "announcement:clear",
      timestamp: Date.now(),
      correlationId,
      payload: null,
    })
  }

  /**
   * ARCHITECTURE.md section 66.4: a canvas scene's layers are broadcast
   * exactly as authored — no resolveVerse()/hallucination-guard
   * involvement, since every layer is operator-authored only in this
   * phase (invariant 23).
   */
  function broadcastCanvas(canvas: CanvasSceneData, correlationId?: string): void {
    wsServer.broadcast({
      id: generateUlid(),
      type: "canvas:show",
      timestamp: Date.now(),
      correlationId,
      payload: canvas,
    })
  }

  function broadcastCanvasClear(correlationId?: string): void {
    wsServer.broadcast({
      id: generateUlid(),
      type: "canvas:clear",
      timestamp: Date.now(),
      correlationId,
      payload: null,
    })
  }

  /**
   * ARCHITECTURE.md section 67.3: a principal poster is purely a
   * persistent visual backdrop (invariant 26) — no hallucination-guard
   * involvement, no rundown interaction beyond what MediaLibrary.resolve()
   * and broadcastVerseClear() already provide elsewhere.
   */
  function broadcastPoster(cue: MediaCue, correlationId?: string): void {
    wsServer.broadcast({
      id: generateUlid(),
      type: "poster:show",
      timestamp: Date.now(),
      correlationId,
      payload: { cue },
    })
  }

  function broadcastPosterClear(correlationId?: string): void {
    wsServer.broadcast({
      id: generateUlid(),
      type: "poster:clear",
      timestamp: Date.now(),
      correlationId,
      payload: null,
    })
  }

  /**
   * ARCHITECTURE.md section 65.5: a voice-triggered glossary definition is
   * a momentary aside, not a persistent scene the operator manages —
   * unlike every other content type in this app, it clears itself on a
   * fixed server-owned timer rather than needing an explicit clear
   * command. A new definition replaces (restarts the timer for) whatever
   * was already showing, the same "most recent wins" reasoning the
   * rundown's paused-scene state already uses elsewhere.
   */
  function broadcastDefinition(definition: DefinitionShowPayload, correlationId?: string): void {
    if (definitionClearTimer) clearTimeout(definitionClearTimer)
    wsServer.broadcast({
      id: generateUlid(),
      type: "definition:show",
      timestamp: Date.now(),
      correlationId,
      payload: definition,
    })
    definitionClearTimer = setTimeout(() => {
      definitionClearTimer = null
      wsServer.broadcast({ id: generateUlid(), type: "definition:clear", timestamp: Date.now(), payload: null })
    }, definitionClearMs)
  }

  function broadcastRundownState(state: RundownStatePayload, correlationId?: string): void {
    wsServer.broadcast({
      id: generateUlid(),
      type: "rundown:state",
      timestamp: Date.now(),
      correlationId,
      payload: state,
    })
  }

  /**
   * ARCHITECTURE.md section 64.4: actually displays a scene's real content
   * (not just rundown:state metadata) — used for rundown:load, scene:next/
   * previous/goto, and resuming from an interrupt. "media" resets playback
   * to position 0 via mediaPlayback.activate(), which is correct here (a
   * genuine new activation) but wrong for the viewer-resync path below.
   */
  async function activateScene(state: RundownStatePayload, correlationId?: string): Promise<void> {
    broadcastRundownState(state, correlationId)
    const scene = state.scene
    switch (scene.kind) {
      case "verse": {
        const verse = await resolveVerse(scene.reference, source, cache, circuitBreaker, translationIdFor(source), logger)
        if (verse) {
          showVerse(verse, "rundown", correlationId)
        } else {
          logger.info({
            component: "app-core",
            event: "rundown.scene-verse-unresolved",
            correlationId,
            metadata: { reference: scene.reference },
          })
        }
        return
      }
      case "media": {
        if (!mediaLibrary) {
          logger.warn({ component: "app-core", event: "rundown.scene-media-not-configured", correlationId })
          return
        }
        const cue = mediaLibrary.resolve(scene.mediaCueId)
        if (cue) {
          broadcastMedia(mediaPlayback.activate(cue), correlationId)
        } else {
          logger.info({
            component: "app-core",
            event: "rundown.scene-media-unresolved",
            correlationId,
            metadata: { mediaCueId: scene.mediaCueId },
          })
        }
        return
      }
      case "announcement":
        broadcastAnnouncement({ title: scene.title, body: scene.body }, correlationId)
        return
      case "canvas":
        broadcastCanvas(scene.canvas, correlationId)
        return
      case "blank":
        // Invariant 22/24: always clear every content channel, regardless
        // of whether each one had anything active — over-clearing is safe,
        // under-clearing leaves stale content on screen.
        clearVerse(correlationId)
        mediaPlayback.clear()
        wsServer.broadcast({ id: generateUlid(), type: "media:clear", timestamp: Date.now(), correlationId, payload: null })
        broadcastAnnouncementClear(correlationId)
        broadcastCanvasClear(correlationId)
        return
    }
  }

  /**
   * A newly-connected viewer's resync for a non-media scene (media is
   * handled independently, see onViewerConnected above). Sends directly to
   * the one connecting viewer via `send`, never broadcasts — an existing
   * audience mid-verse must not be interrupted just because someone else
   * joined.
   */
  async function syncSceneContent(scene: RundownScene, send: (message: WsMessage) => void): Promise<void> {
    switch (scene.kind) {
      case "verse": {
        const verse = await resolveVerse(scene.reference, source, cache, circuitBreaker, translationIdFor(source), logger)
        if (verse) {
          const payload: VerseShowPayload = { ...verse, trigger: "rundown" }
          send({ id: generateUlid(), type: "verse:show", timestamp: Date.now(), payload })
        } else {
          logger.info({
            component: "app-core",
            event: "rundown.viewer-sync-verse-unresolved",
            metadata: { reference: scene.reference },
          })
        }
        return
      }
      case "announcement":
        send({
          id: generateUlid(),
          type: "announcement:show",
          timestamp: Date.now(),
          payload: { title: scene.title, body: scene.body },
        })
        return
      case "canvas":
        send({ id: generateUlid(), type: "canvas:show", timestamp: Date.now(), payload: scene.canvas })
        return
      case "blank":
        send({ id: generateUlid(), type: "verse:clear", timestamp: Date.now(), payload: null })
        send({ id: generateUlid(), type: "announcement:clear", timestamp: Date.now(), payload: null })
        send({ id: generateUlid(), type: "canvas:clear", timestamp: Date.now(), payload: null })
        return
      case "media":
        return // handled independently above
    }
  }

  async function handleAudioFrame(frame: AudioFrame): Promise<void> {
    // ARCHITECTURE.md section 9 / AGENTS.md section 11: reduce unnecessary
    // ASR requests by not forwarding obvious silence. This must never
    // silently discard SPEECH without a trace, which is exactly why the
    // gate's own metrics (not just its pass/fail decision) are logged
    // when the mic stops, below — an operator with a "nothing is being
    // detected" complaint can see whether frames were even reaching ASR.
    const wasCalibrating = silenceGate.isCalibrating()
    const { forwarded } = silenceGate.process(frame)
    // ARCHITECTURE.md section 76: the calibration-just-finished transition
    // is only observable here, as a side effect of process() — this is
    // the one place that can see it happen and tell the dashboard.
    if (wasCalibrating && !silenceGate.isCalibrating()) {
      logger.info({
        component: "app-core",
        event: "mic.calibrated",
        metadata: { threshold: silenceGate.getThreshold() },
      })
      broadcastAsrStatus({
        asrHealth: asrHasError ? "error" : "ok",
        micCalibrating: false,
        micThreshold: silenceGate.getThreshold(),
      })
    }
    if (forwarded) {
      await asr.sendAudio(frame)
    }
  }

  async function handleCommand(message: WsMessage, role: WsRole): Promise<void> {
    switch (message.type) {
      case "mic:start":
        // ARCHITECTURE.md section 76: a fresh threshold for THIS room,
        // right before THIS session, rather than one fixed global
        // constant guessed from a single past measurement (section
        // 68.2). Broadcast first so the dashboard can show "Calibrating…"
        // immediately — the ~1.5s window where the gate deliberately
        // forwards nothing yet would otherwise look identical to the mic
        // simply not working, the exact complaint this whole feature
        // exists to prevent a repeat of.
        silenceGate.startCalibration()
        broadcastAsrStatus({ asrHealth: asrHasError ? "error" : "ok", micCalibrating: true })
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
        const verse = await resolveVerse(reference, source, cache, circuitBreaker, translationIdFor(source), logger)
        if (verse) {
          broadcastVerse(verse, "override", message.correlationId)
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

      case "verse:confirm-pending": {
        // ARCHITECTURE.md section 65.3: confirming a pending suggestion
        // still shows it as "detected" (that's what it was), not a new
        // trigger kind of its own — confirmation is how review mode
        // delivers a detection, not a different way a verse got there.
        if (pendingVerse) {
          const verse = pendingVerse
          pendingVerse = null
          broadcastVerse(verse, "detected", message.correlationId)
        } else {
          logger.info({ component: "app-core", event: "verse.no-pending-to-confirm", correlationId: message.correlationId })
        }
        return
      }

      case "poster:set": {
        if (!mediaLibrary) {
          logger.warn({ component: "app-core", event: "poster.not-configured", correlationId: message.correlationId })
          return
        }
        const { mediaCueId } = message.payload as { mediaCueId: string }
        const cue = mediaLibrary.resolve(mediaCueId)
        // ARCHITECTURE.md section 67.1: a poster is a static graphic —
        // "image" is a business rule enforced here, not at the schema
        // layer (action-registry.ts only checks that mediaCueId is a
        // non-empty string, since it can't know the cue's kind without
        // resolving it).
        if (!cue || cue.kind !== "image") {
          logger.info({
            component: "app-core",
            event: "poster.set-rejected",
            correlationId: message.correlationId,
            metadata: { mediaCueId, resolvedKind: cue?.kind ?? null },
          })
          return
        }
        principalPosterCueId = cue.id
        // Confirmed with the user: appointing a poster also makes its
        // existing title (already unique, already the voice-trigger
        // phrase every MediaCue has) bring it back up by voice for the
        // rest of the session — see the posterCueIds declaration above.
        posterCueIds.add(cue.id)
        broadcastPoster(cue, message.correlationId)
        return
      }

      case "poster:clear":
        principalPosterCueId = null
        broadcastPosterClear(message.correlationId)
        return

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

      case "rundown:load": {
        const { rundown } = message.payload as { rundown: Rundown }
        const state = rundownController.load(rundown)
        if (state) {
          await activateScene(state, message.correlationId)
        } else {
          logger.info({
            component: "app-core",
            event: "rundown.load-rejected",
            correlationId: message.correlationId,
            metadata: { rundownId: rundown.id },
          })
        }
        return
      }

      case "scene:next": {
        const state = rundownController.next()
        if (state) await activateScene(state, message.correlationId)
        else logSceneNoOp("next", message.correlationId)
        return
      }

      case "scene:previous": {
        const state = rundownController.previous()
        if (state) await activateScene(state, message.correlationId)
        else logSceneNoOp("previous", message.correlationId)
        return
      }

      case "scene:goto": {
        const { index } = message.payload as { index: number }
        const state = rundownController.goto(index)
        if (state) await activateScene(state, message.correlationId)
        else logSceneNoOp("goto", message.correlationId, { index })
        return
      }

      // status:update / transcript:partial / transcript:final / verse:show /
      // verse:pending / media:show / rundown:state / announcement:show /
      // announcement:clear / definition:show / definition:clear /
      // sermonNotes:update / canvas:show / canvas:clear / poster:show are
      // all server-originated events; the action registry's role check
      // (empty allowedSenders) already refuses any client attempting to
      // send them inbound, so onCommand is never actually invoked for
      // these. Kept only so this switch stays exhaustive and explicit
      // rather than silently ignoring a case (AGENTS.md section 25).
      case "status:update":
      case "transcript:partial":
      case "transcript:final":
      case "verse:show":
      case "verse:pending":
      case "media:show":
      case "rundown:state":
      case "announcement:show":
      case "announcement:clear":
      case "definition:show":
      case "definition:clear":
      case "sermonNotes:update":
      case "canvas:show":
      case "canvas:clear":
      case "poster:show":
        logger.warn({
          component: "app-core",
          event: "unreachable-command",
          metadata: { type: message.type, role },
        })
        return
    }
  }

  function logSceneNoOp(action: "next" | "previous" | "goto", correlationId?: string, metadata?: Record<string, unknown>): void {
    logger.info({
      component: "app-core",
      event: "scene.no-op",
      correlationId,
      metadata: { action, ...metadata },
    })
  }

  /**
   * ARCHITECTURE.md section 61: resolves each detected navigation command
   * sequentially, not concurrently — the same reasoning
   * resolveTranscriptVerses already documents for multiple detected verse
   * references (keeps cache/circuit-breaker state changes easy to reason
   * about, and here also keeps currentVersePosition updates from racing
   * each other within one transcript).
   */
  /**
   * ARCHITECTURE.md section 65.4: an optional duck-typed capability check,
   * same pattern as translationIdFor() — a source with no setMode() (e.g.
   * a plain FreeApiSource/GetBibleVerseSource used standalone, not
   * wrapped in LocalizedVerseSource) simply has nothing to change here.
   */
  function setModeFor(mode: DisplayMode): boolean {
    const withMode = source as VerseSource & { setMode?: (mode: DisplayMode) => void }
    if (!withMode.setMode) return false
    withMode.setMode(mode)
    return true
  }

  async function handleNavigationCommands(transcript: TranscriptResult): Promise<void> {
    for (const command of navigationCommandDetector.detect(transcript.text)) {
      if (command.kind === "goto-display-mode") {
        if (setModeFor(command.mode)) {
          onDisplayModeChanged?.(command.mode)
          logger.info({
            component: "app-core",
            event: "navigation.display-mode-changed",
            correlationId: transcript.correlationId,
            metadata: { mode: command.mode },
          })
        } else {
          logger.info({
            component: "app-core",
            event: "navigation.display-mode-not-configured",
            correlationId: transcript.correlationId,
          })
        }
        continue
      }

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
      const verse = await resolveVerse(resolution.reference, source, cache, circuitBreaker, translationIdFor(source), logger)
      if (verse) {
        broadcastVerse(verse, "navigation", transcript.correlationId)
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
    // ARCHITECTURE.md section 70: a production audit found that every
    // transcript was consumed internally (verse detection, media/glossary/
    // navigation matching) without the raw text ever reaching the
    // dashboard — the operator could see the mic level meter respond to
    // speech but had no way to see, or judge the accuracy or latency of,
    // what was actually transcribed. Broadcast first, before any of the
    // async work below, so this is the fastest possible signal back to
    // the operator, not something waiting behind verse resolution.
    wsServer.broadcast({
      id: generateUlid(),
      type: transcript.state === "partial" ? "transcript:partial" : "transcript:final",
      timestamp: Date.now(),
      correlationId: transcript.correlationId,
      payload: transcript,
    })
    // A transcript arriving at all means the ASR pipeline is working again
    // — the operator-facing recovery signal for whatever error, if any,
    // was last broadcast below.
    if (asrHasError) {
      asrHasError = false
      broadcastAsrStatus({ asrHealth: "ok" })
    }
    resolveTranscriptVerses(transcript, detector, index, source, cache, circuitBreaker, logger)
      .then((verses) => {
        for (const verse of verses) {
          if (verseConfirmationMode === "review") {
            broadcastPendingVerse(verse, transcript.correlationId)
          } else {
            broadcastVerse(verse, "detected", transcript.correlationId)
          }
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
        // ARCHITECTURE.md section 67.1's amendment: a cue once appointed
        // as a poster stays voice-triggerable by its own (already unique)
        // title for the rest of the session — speaking its name puts it
        // up as the persistent poster, not a temporary media:show scene.
        if (posterCueIds.has(cue.id)) {
          principalPosterCueId = cue.id
          broadcastPoster(cue, transcript.correlationId)
        } else {
          broadcastMedia(mediaPlayback.activate(cue), transcript.correlationId)
        }
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

    // On-demand glossary lookup by voice (ARCHITECTURE.md section 65.5),
    // also running alongside everything else above, not instead of it.
    // Gated by the same transcript rule as every other detector: partial
    // transcripts never reach GlossaryDetector.
    if (passesTranscriptGate(transcript)) {
      const definition = glossaryDetector.detect(transcript.text)
      if (definition) broadcastDefinition(definition, transcript.correlationId)
    }

    // ARCHITECTURE.md section 65.7: a read-only observer of the same
    // final-transcript stream every other detector sees — accumulated
    // text only, never consulted by or fed back into the guarded
    // verse-detection pipeline above.
    if (sermonNotesGenerator && sermonNotesEnabled && passesTranscriptGate(transcript)) {
      sermonNotesBuffer += (sermonNotesBuffer ? " " : "") + transcript.text
    }
  })

  asr.onError?.((err) => {
    logger.error({ component: "asr", event: "transcript.failed", error: err.message })
    // A local server-log line alone left the operator no way to know
    // transcription had failed mid-service — a real gap surfaced by web
    // research into how broadcast-captioning tooling treats ASR/network
    // health as a first-class, always-visible signal. Broadcasting it
    // gives the dashboard something concrete to show, without inventing
    // a policy for WHAT the operator should do about it (that stays a
    // human decision, per AGENTS.md section 39 — this only reports state).
    asrHasError = true
    broadcastAsrStatus({ asrHealth: "error", error: err.message })
  })

  await wsServer.ready
  logger.info({ component: "app-core", event: "started", metadata: { port: wsServer.port } })

  return {
    wsServer,
    setVerseConfirmationMode(mode: VerseConfirmationMode) {
      verseConfirmationMode = mode
    },
    setSermonNotesEnabled(enabled: boolean) {
      sermonNotesEnabled = enabled
      if (!enabled) sermonNotesBuffer = ""
    },
    getSessionEntries() {
      return sessionRecorder.getEntries()
    },
    getSessionHistory() {
      return sessionHistoryStore?.getEntries() ?? []
    },
    async stop() {
      if (definitionClearTimer) clearTimeout(definitionClearTimer)
      if (sermonNotesTimer) clearInterval(sermonNotesTimer)
      await asr.stop().catch(() => {})
      await wsServer.close()
      logger.info({ component: "app-core", event: "stopped" })
    },
  }
}
