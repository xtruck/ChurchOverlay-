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
  VerseLayout,
  VerseShowPayload,
  VerseSource,
  VerseTrigger,
  WsMessage,
  WsRole,
} from "../../../packages/contracts"

/** Fixed operator-safe ceiling for every visible verse: 2 minutes 30 seconds. */
export const DEFAULT_VERSE_AUTO_CLEAR_MS = 150_000
/** Upper bound on verse scenes prefetched per rundown:load (sequential requests). */
const MAX_RUNDOWN_PREFETCH = 50
import type { Server as HttpServer } from "node:http"
import { generateUlid } from "../../../packages/shared/ulid"
import type { Logger } from "../../../packages/shared/logger"
import { scrubSecrets } from "../../../packages/shared/logger"
import { InterpreterEchoGuard, guessSpokenLanguage } from "./interpreter-echo-guard"
import { SuggestionArbiter, suggestionKey } from "./suggestion-arbiter"
import { CallBudget, type TextCompleter } from "../ai/claude-client"
import { ReferenceRepairer } from "../ai/reference-repairer"
import { LiveTranslator } from "../ai/live-translator"
import { ClaudeSermonNotes } from "../ai/claude-sermon-notes"
import { type AiFeature, type AiFeatureFlags } from "../ai/ai-features"
import { AiSuggestionCoordinator } from "./ai-suggestion-coordinator"
import { VerseCache } from "../verse/verse-cache"
import { CircuitBreaker } from "../verse/circuit-breaker"
import { SilenceGate } from "../audio/silence-gate"
import { ChurchOverlayWsServer, type ServerTokens } from "../ws/server"
import { resolveTranscriptVerses } from "./resolve-transcript-verses"
import { resolveVerse, translationIdFor } from "../verse/resolve-verse"
import { passesTranscriptGate } from "./transcript-gate"
import { LatencyTracker, type LatencySnapshot } from "./latency-tracker"
import { correctTranscription, detectHallucination } from "../asr/transcription-corrector"
import { postprocessTranscript } from "../asr/postprocess/pipeline"
import { hasForeignScript, isLikelyThirdLatinLanguage } from "../asr/script-guard"
import { resolveQuickBook } from "../detector/quick-book"
import { TranscriptAssembler } from "../asr/transcript-assembler"
import { RollingTranscriptWindow } from "../asr/rolling-transcript-window"
import { allFamiliesAtVolume, applyVolumeHints, buildVolumeHints } from "../detector/volume-inference"
import { RateLimitError } from "../asr/groq-provider"
import type { MediaLibrary } from "../media/media-library"
import { MediaCueDetector } from "../media/media-cue-detector"
import { MediaPlaybackController } from "../media/media-playback-controller"
import { NavigationCommandDetector, containsCatalogBookName } from "../detector/navigation-command-detector"
import { isCatalogBookWord } from "../detector/regex-detector"
import { resolveNavigationCommand } from "../verse/resolve-navigation-command"
import { RundownController } from "../rundown/rundown-controller"
import { parseSermonPrep, type SermonPrepParseOutcome, type SermonPrepResult } from "../rundown/sermon-prep"
import { GlossaryDetector } from "../glossary/glossary-detector"
import { SessionRecorder, type SessionEntry } from "./session-recorder"
import type { SessionHistoryStore, SessionHistoryEntry } from "./session-history-store"
import { AdaptiveGain } from "../audio/adaptive-gain"
import { MicHealthMonitor } from "../audio/mic-health"
import type { QuoteMatcher } from "../detector/quote-matcher"
import type { OverlayStyle, OverlayStyleSettings } from "../../../packages/contracts/overlay-style"
import { normalizeOverlayStyleSettings, resolveOverlayStyle, seedOverlayStyle } from "../overlay/overlay-style"

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
  onRateLimitedSustained?(callback: () => void): void
  onFailoverActivated?(callback: (label?: string) => void): void
  returnToPrimary?(): Promise<void>
  /** Fired when the failover wrapper returned to its primary on its own (not via asr:return-primary). */
  onAutoReturned?(callback: () => void): void
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
  /** Gain applied to audio sent to ASR (server/audio/adaptive-gain.ts). Default: enabled. */
  readonly adaptiveGain?: AdaptiveGain
  /**
   * Recognizes a verse read aloud without its reference (detector/
   * quote-matcher.ts). Optional; matches are only ever offered as a
   * pending suggestion (verse:pending with origin "quote"), never shown
   * automatically — a preacher quoting is not always asking for a display.
   */
  readonly quoteMatcher?: Pick<QuoteMatcher, "match">
  /** Called when the operator toggles auto-gain, so the host can persist it. */
  readonly onAutoGainChanged?: (enabled: boolean) => void
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
   * Optional (ARCHITECTURE.md section 82) — the overlay's initial verse
   * display layout, "fullscreen" by default. Purely a presentation
   * choice for the overlay; carries no effect on detection/lookup.
   * Changed live via the layout:set command; onVerseLayoutChanged below
   * mirrors onDisplayModeChanged's pattern for persisting the change.
   */
  readonly verseLayout?: VerseLayout
  readonly onVerseLayoutChanged?: (layout: VerseLayout) => void
  /**
   * ARCHITECTURE.md section 94 — the overlay-facing counterpart to
   * section 92's dashboard-only branding. Static for the process lifetime
   * (set once at startup, like most other AppCore options here), synced to
   * every viewer on connect via branding:update, never a live command.
   */
  readonly organizationName?: string
  readonly accentColor?: string
  /**
   * ARCHITECTURE.md section 108 — same "static for the process lifetime,
   * synced via branding:update" shape as organizationName/accentColor
   * above: which preset visual template the overlay renders a verse with.
   * Absent means "classic".
   */
  readonly overlayTemplate?: string
  /**
   * ARCHITECTURE.md section 110: the stored overlay style. Normalized again
   * here (untrusted input). Absent means defaults, seeded from the legacy
   * overlayTemplate / organizationName above so an existing install looks
   * the same until the operator opens the Overlay settings.
   */
  readonly overlayStyle?: OverlayStyleSettings
  /**
   * Optional (ARCHITECTURE.md section 82.2) — the poster/media auto-clear
   * duration a fresh AppCore starts with; absent or null means "no
   * auto-clear" (manual poster:clear only), matching the option's own
   * off-by-default convention. Changed live via poster:set-duration.
   */
  readonly posterAutoClearMs?: number | null
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
  /**
   * ARCHITECTURE.md section 121: optional Anthropic-backed helpers (reference
   * repair, bilingual notes, FR<->EN translation). Absent = the app behaves
   * exactly as before. Every helper is rate-capped and fails soft.
   */
  readonly claudeClient?: TextCompleter
  /**
   * ARCHITECTURE.md sections 123-125: initial state of the live AI feature
   * toggles. Every flag defaults to false; without claudeClient none of them
   * can do anything. Changed at runtime through AppCoreHandle.setAiFeature().
   */
  readonly aiFeatures?: Partial<AiFeatureFlags>
  /** How often the live sermon copilot (section 125) considers a new cycle; default 45 s, tests shorten it. */
  readonly aiCopilotIntervalMs?: number
  /** Minimum gap between two semantic-suggestion model calls (section 124); tests shorten it. */
  readonly aiSemanticMinIntervalMs?: number
  /** Hard bound of one transcript-cleanup call (section 123); exposed so tests need not wait out the 3 s default. */
  readonly aiCleanupTimeoutMs?: number
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
   * Optional (ARCHITECTURE.md section 67.2, widened to unconditional in
   * section 82.1) — how long ANY shown verse stays on screen before the
   * server clears it on its own, unprompted, regardless of whether a
   * principal poster is configured. Confirmed explicitly with the user as
   * a firm ceiling: 2 minutes 30 seconds, no exceptions. Exposed here,
   * same reasoning as definitionClearMs above, so tests can use a short
   * delay instead of waiting out the real default.
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
   * ARCHITECTURE.md section 110.4: live apply of the overlay style. The input
   * is normalized, revision-bumped and broadcast as the server-only
   * `overlay:style` event; returns what viewers received so the caller can
   * persist the normalized settings (never the raw input).
   */
  setOverlayStyle(settings: unknown): OverlayStyle
  getOverlayStyle(): OverlayStyle
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
   * ARCHITECTURE.md sections 123-125: live toggle of one optional AI feature
   * (the main process persists it). A no-op in effect without an Anthropic key.
   */
  setAiFeature(feature: AiFeature, enabled: boolean): void
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
  getDiagnostics(): {
    generatedAt: number
    asrHealth: AsrStatusPayload["asrHealth"]
    silenceGate: ReturnType<SilenceGate["getMetrics"]>
    sessionEntries: number
    sessionHistoryEntries: number
    pipelineLatency: LatencySnapshot
  }
  /**
   * Final transcript -> verse handed to viewers or to the operator, over the
   * most recent detections. Read by the dashboard through Electron IPC; not
   * a WS event, so the public protocol and the read-only overlay are unchanged.
   */
  getPipelineLatency(): LatencySnapshot
  /**
   * ARCHITECTURE.md section 130: parses pasted sermon notes (plain text) into
   * validated references and adds their books to the ASR planned-book bias.
   * Displays nothing: each queued verse is shown later by an ordinary
   * verse:override. Replaces any previous import. Electron IPC only.
   */
  importSermonPrep(text: unknown): SermonPrepParseOutcome
  /** The last successful import, or null (lets a reloaded dashboard rebuild its queue). */
  getSermonPrep(): SermonPrepResult | null
  /** Forgets the import and removes its books from the planned-book bias. */
  clearSermonPrep(): void
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
  const adaptiveGain = options.adaptiveGain ?? new AdaptiveGain()
  const micHealth = new MicHealthMonitor()
  const pipelineLatency = new LatencyTracker()
  let rundownPrefetchGeneration = 0
  let stopped = false
  // Broadcast cadence measured in *processed audio time*, not wall clock:
  // deterministic under test, and naturally silent when no audio flows.
  const MIC_HEALTH_INTERVAL_MS = 1000
  let micHealthAudioMs = 0
  const mediaLibrary = options.mediaLibrary
  const onDisplayModeChanged = options.onDisplayModeChanged
  const mediaCueDetector = mediaLibrary ? new MediaCueDetector(mediaLibrary) : null
  const mediaPlayback = new MediaPlaybackController()
  let mediaAutoClearTimer: ReturnType<typeof setTimeout> | null = null
  const navigationCommandDetector = new NavigationCommandDetector()
  // isBookWord turns on the long window: a preacher says "Genesis 5", talks on,
  // then "verse 2" (or the ASR cut the sentence there). See TranscriptAssembler.
  const transcriptAssembler = new TranscriptAssembler({ isBookWord: isCatalogBookWord })
  // The last ~30 s of finals as one run of words, so a verse READ ALOUD across
  // a breath (a cut between two finals) is still recognised as a quotation.
  const quoteWindow = new RollingTranscriptWindow()
  let lastAssembledText = ""
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
  // ARCHITECTURE.md section 82.2 — confirmed with the user: operator-
  // configurable, off (manual-clear-only) by default, matching this
  // codebase's established optional-capability convention rather than a
  // fixed built-in duration like the verse ceiling above.
  let posterAutoClearMs: number | null = options.posterAutoClearMs ?? null
  let posterAutoClearTimer: ReturnType<typeof setTimeout> | null = null
  // Every cue id ever appointed as a poster via poster:set stays voice-
  // triggerable by its own title for the rest of the session (section
  // 67.1's amendment: "name it so speaking that name puts it up") — a
  // cue is either a poster or a regular voice-triggered media cue, never
  // both; once marked, MediaCueDetector matches route here instead of
  // the normal media:show path, for as long as the app keeps running.
  const posterCueIds = new Set<string>()
  const verseAutoClearMs = options.verseAutoClearMs ?? DEFAULT_VERSE_AUTO_CLEAR_MS
  let verseAutoClearTimer: ReturnType<typeof setTimeout> | null = null
  // ARCHITECTURE.md section 65.3: "auto" is the confirmed default —
  // unchanged from every existing behavior unless the operator explicitly
  // switches to "review". pendingVerse holds at most one not-yet-confirmed
  // detection — a newer one replaces (does not queue behind) an older
  // unconfirmed one, the same "most recent wins" reasoning the rundown's
  // paused-scene state already uses.
  let verseConfirmationMode: VerseConfirmationMode = options.verseConfirmationMode ?? "auto"
  // ARCHITECTURE.md section 82: purely a presentation choice for the
  // overlay — never consulted by detection/lookup/caching.
  let verseLayout: VerseLayout = options.verseLayout ?? "fullscreen"
  const organizationName = options.organizationName
  const accentColor = options.accentColor
  const overlayTemplate = options.overlayTemplate
  const onVerseLayoutChanged = options.onVerseLayoutChanged
  // ARCHITECTURE.md section 110: revision orders updates for viewers (section 22).
  let overlayStyleSettings = seedOverlayStyle(options.overlayStyle, options.overlayTemplate, organizationName, options.accentColor)
  let overlayStyleRevision = 1
  const currentOverlayStyle = (): OverlayStyle => resolveOverlayStyle(overlayStyleSettings, overlayStyleRevision)
  let pendingVerse: Verse | null = null
  // Cooldown and "a detected verse is waiting" hold shared by every suggestion path.
  const suggestionArbiter = new SuggestionArbiter()
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

  // Ordering for verse lookups that finish after the world moved on. Every
  // path that fetches a verse and then puts it on screen takes a ticket
  // BEFORE awaiting; when the lookup returns it is dropped if something
  // started later has already been applied (newer lookup wins), or if the
  // operator cleared the screen after the lookup began (emergency clear
  // must stay cleared). The auto-clear timer deliberately does NOT
  // supersede lookups — a fresh detection in flight should still show.
  let displayIntentSeq = 0
  let displayAppliedSeq = 0
  const beginDisplayIntent = (): number => ++displayIntentSeq
  const isSupersededIntent = (ticket: number): boolean => ticket < displayAppliedSeq
  const markIntentApplied = (ticket: number): void => {
    if (ticket > displayAppliedSeq) displayAppliedSeq = ticket
  }
  const supersedeInFlightDisplay = (): void => {
    displayAppliedSeq = ++displayIntentSeq
  }
  const dropStaleLookup = (path: string, correlationId?: string): void => {
    logger.info({ component: "app-core", event: "verse.stale-lookup-dropped", correlationId, metadata: { path } })
  }
  // Surfaces ASR health to the operator dashboard (a real, concrete use of
  // status:update — see its own doc comment in action-registry.ts, written
  // when nothing produced it yet). Tracked so a transcript arriving after
  // an error can broadcast the recovery, not just the failure.
  // ARCHITECTURE.md section 91: bounded, in-memory evidence for real
  // phonetic-correction gaps — a near-miss followed shortly by a manual
  // override is a labeled example ("this exact text should have meant
  // that exact reference"), logged for a human to review and add to
  // transcription-corrector's curated table, never auto-applied. Bounded
  // per AGENTS.md section 36 (no unbounded queue/cache): the array is
  // trimmed to RECENT_NEAR_MISS_LIMIT entries on every push.
  const RECENT_NEAR_MISS_LIMIT = 20
  const RECENT_NEAR_MISS_WINDOW_MS = 30_000
  let recentNearMisses: Array<{ text: string; timestamp: number }> = []
  let lastNearMissText = ""
  let lastNearMissTime = 0
  let asrHasError = false
  let asrIsThrottled = false
  let asrRateLimitedSustained = false
  let asrIsFailedOver = false
  const currentAsrHealth = (): AsrStatusPayload["asrHealth"] => {
    if (asrRateLimitedSustained) return "rate-limited"
    if (asrIsFailedOver) return "failover"
    if (asrHasError) return "error"
    if (asrIsThrottled) return "throttled"
    return "ok"
  }
  // ARCHITECTURE.md section 65.7: a rolling buffer of final-transcript text,
  // flushed and summarized on a fixed cadence rather than per-transcript —
  // both to bound Groq API cost and because a summary of one sentence isn't
  // a useful summary.
  // With an Anthropic key the bilingual notes replace the Groq generator.
  const sermonNotesGenerator: SermonNotesSummarizer | undefined = options.claudeClient
    ? new ClaudeSermonNotes(options.claudeClient)
    : options.sermonNotesGenerator
  const referenceRepairer = options.claudeClient ? new ReferenceRepairer(options.claudeClient) : null
  const liveTranslator = options.claudeClient ? new LiveTranslator(options.claudeClient) : null
  const repairBudget = new CallBudget(6)
  // ARCHITECTURE.md sections 123-125: transcript cleanup, semantic suggestions and the
  // sermon copilot live in AiSuggestionCoordinator (live flags default OFF; inert without a key).
  // It reaches the detector, index, verse source and WebSocket only through these ports.
  const aiSuggestions: AiSuggestionCoordinator | null = options.claudeClient
    ? new AiSuggestionCoordinator({
        completer: options.claudeClient,
        logger,
        flags: options.aiFeatures,
        cleanupTimeoutMs: options.aiCleanupTimeoutMs,
        semanticMinIntervalMs: options.aiSemanticMinIntervalMs,
        copilotIntervalMs: options.aiCopilotIntervalMs,
        isStopped: () => stopped,
        currentBook: () => currentVersePosition?.book ?? null,
        currentPosition: () => currentVersePosition,
        detectValidated: (text) => detector.detect(text).filter((ref) => index.exists(ref)),
        validateProposal: (proposal) =>
          detector.detect(`${proposal.book} ${proposal.chapter}:${proposal.verse}`).find((candidate) => index.exists(candidate)) ?? null,
        resolve: (reference) => resolveVerse(reference, source, cache, circuitBreaker, translationIdFor(source), logger),
        containsBookName: containsCatalogBookName,
        quoteMatches: (windowText) => Boolean(options.quoteMatcher?.match(windowText)),
        shownKeys: () => sessionRecorder.getEntries().map((entry) => suggestionKey(entry.reference)),
        arbiter: suggestionArbiter,
        offerPending: broadcastPendingVerse,
        sendToOperators: (message) => wsServer.broadcastToOperators(message),
      })
    : null
  const translateBudget = new CallBudget(20)
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

  let lastAudioFrameErrorLogTime = 0
  let suppressedAudioFrameErrors = 0

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
      handleAudioFrame(frame).catch((err) => {
        const now = Date.now()
        suppressedAudioFrameErrors++
        if (now - lastAudioFrameErrorLogTime >= 3000) {
          lastAudioFrameErrorLogTime = now
          const count = suppressedAudioFrameErrors
          suppressedAudioFrameErrors = 0
          logger.error({
            component: "app-core",
            event: "audio-frame.failed",
            error: err instanceof Error ? err.message : String(err),
            ...(count > 1 ? { metadata: { suppressedOccurrences: count - 1 } } : {}),
          })
        }
      })
    },
    onRejected: (reason, role) => {
      logger.warn({ component: "ws", event: "message.rejected", metadata: { reason, role } })
    },
    // ARCHITECTURE.md section 60.4's reconnect/late-join sync: a viewer
    // that connects while a media cue is already active must see it
    // immediately, without ever giving viewers a way to ask for one
    // (invariant 8).
    onViewerConnected: (send) => {
      // ARCHITECTURE.md section 82: a fresh viewer connection (e.g. an
      // OBS browser source reloading) must apply the current layout
      // before anything else renders — otherwise it briefly shows the
      // CSS default until the next layout:set happens to be sent, which
      // could be an entire service later.
      send({ id: generateUlid(), type: "layout:update", timestamp: Date.now(), payload: { layout: verseLayout } })
      // ARCHITECTURE.md section 94: same late-join sync reasoning as
      // layout:update above — a fresh viewer connection must see any
      // configured branding immediately, not just from whenever this
      // session happened to start. Sent even when both fields are
      // undefined (the overlay then simply shows nothing extra).
      send({
        id: generateUlid(),
        type: "branding:update",
        timestamp: Date.now(),
        payload: { organizationName, accentColor, overlayTemplate },
      })
      // ARCHITECTURE.md section 110.4: same late-join sync, so an OBS reload or
      // the NDI window is never stale about the style.
      send({ id: generateUlid(), type: "overlay:style", timestamp: Date.now(), payload: currentOverlayStyle() })
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
    // The operator (override, navigation, rundown) took control: whatever is
    // detected next is intentional, never an interpreter's echo.
    if (trigger !== "detected") interpreterEchoGuard.forget()
    // Whatever was waiting for approval has now been dealt with (shown, overridden, rundown).
    suggestionArbiter.clearDetectedWaiting()
    currentVersePosition = verse.reference
    // TASK B: Update ASR prompt with current verse reference for dynamic context
    const refStr = `${verse.reference.book} ${verse.reference.chapter}:${verse.reference.verse}`
    if ("setCurrentVerseRef" in asr && typeof asr.setCurrentVerseRef === "function") {
      (asr as { setCurrentVerseRef: (ref: string | null) => void }).setCurrentVerseRef(refStr)
    }
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
    // ARCHITECTURE.md section 67 / 82.1 / invariant 25: every trigger
    // funnels through here, so this is the one place that needs to know
    // about verse auto-clear. Widened in section 82.1 from "only while a
    // principal poster is active" to unconditional, per the user's
    // explicit, firm instruction: every shown verse clears itself after
    // verseAutoClearMs, no exceptions. A new verse always resets (never
    // queues behind) a pending timer, the same "most recent wins" pattern
    // definitionClearTimer already uses.
    if (verseAutoClearTimer) clearTimeout(verseAutoClearTimer)
    verseAutoClearTimer = setTimeout(() => {
      verseAutoClearTimer = null
      broadcastVerseClear(correlationId)
    }, verseAutoClearMs)
  }

  function clearVerse(correlationId?: string): void {
    currentVersePosition = null
    lastShownVerse = null
    // TASK B: Clear ASR prompt context when verse is cleared
    if ("setCurrentVerseRef" in asr && typeof asr.setCurrentVerseRef === "function") {
      (asr as { setCurrentVerseRef: (ref: string | null) => void }).setCurrentVerseRef(null)
    }
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
  /**
   * The single hand-off for DETECTED verses (review mode holds them as
   * pending, auto mode shows them), timing each one from the final
   * transcript's arrival so a slow Sunday can be traced to the Bible lookup
   * or ruled out as the app's own processing.
   */
  let plannedBookIds: readonly string[] = []
  let rundownPlannedBookIds: readonly string[] = []
  /** Section 130: the last imported sermon notes (references only, never the text itself). */
  let sermonPrep: SermonPrepResult | null = null

  /**
   * "Corinthiens 5 verset 2" names no volume, so detection yields nothing. When the
   * book on screen or the rundown plan names exactly one volume of that family, try
   * the text with that volume filled in. Always a PENDING suggestion, in auto mode
   * too: the volume is a guess (ARCHITECTURE.md section 115).
   */
  async function inferVolumeVerses(text: string, transcript: TranscriptResult): Promise<void> {
    if (transcript.state !== "final") return
    const hints = buildVolumeHints(plannedBookIds, currentVersePosition?.book ?? null)
    const inferred = applyVolumeHints(text, hints)
    const isOnScreen = (verse: Verse): boolean =>
      currentVersePosition !== null &&
      currentVersePosition.book === verse.reference.book &&
      currentVersePosition.chapter === verse.reference.chapter &&
      currentVersePosition.verse === verse.reference.verse

    if (inferred) {
      const verses = await resolveTranscriptVerses({ ...transcript, text: inferred }, detector, index, source, cache, circuitBreaker, logger)
      for (const verse of verses) {
        if (isOnScreen(verse)) continue
        logger.info({
          component: "app-core",
          event: "volume.inferred",
          correlationId: transcript.correlationId,
          metadata: { heard: text, inferred, reference: verse.reference },
        })
        broadcastPendingVerse({ ...verse, origin: "inferred" } as Verse, transcript.correlationId)
      }
      return
    }

    // No context at all: try every volume. A volume that does not have that chapter/verse drops out on
    // its own ("Corinthiens 15 verset 3" only exists in 1 Corinthians), so often exactly one is left;
    // when both exist, the operator is offered both and picks.
    const candidates: Verse[] = []
    for (const volume of ["1", "2"] as const) {
      const candidateText = applyVolumeHints(text, allFamiliesAtVolume(volume))
      if (!candidateText) return // no bare numbered book in this text
      const verses = await resolveTranscriptVerses({ ...transcript, text: candidateText }, detector, index, source, cache, circuitBreaker, logger)
      candidates.push(...verses.filter((verse) => !isOnScreen(verse)))
    }
    const [first, ...others] = candidates
    if (!first) return
    logger.info({
      component: "app-core",
      event: "volume.candidates",
      correlationId: transcript.correlationId,
      metadata: { heard: text, references: candidates.map((verse) => verse.reference) },
    })
    broadcastPendingVerse({ ...first, origin: "inferred", ...(others.length > 0 ? { alternatives: others } : {}) } as Verse, transcript.correlationId)
  }

  // ARCHITECTURE.md section 120: with an English preacher and a French
  // interpreter the same verse is detected twice; only the first (fast)
  // detection is displayed. Applies to live detection only — manual
  // overrides, voice navigation and rundown scenes never pass through here.
  const interpreterEchoGuard = new InterpreterEchoGuard()

  function deliverDetectedVerses(verses: readonly Verse[], transcript: TranscriptResult): void {
    for (const verse of verses) {
      const echo = interpreterEchoGuard.check(verse.reference, transcript.text)
      if (echo.suppress) {
        // Review mode: the interpreter independently said the same reference
        // that is waiting for approval. Say so on the pending prompt (never
        // auto-confirm: approving stays the operator's decision).
        if (
          echo.reason === "interpreter-echo" &&
          pendingVerse &&
          pendingVerse.reference.book === verse.reference.book &&
          pendingVerse.reference.chapter === verse.reference.chapter &&
          pendingVerse.reference.verse === verse.reference.verse
        ) {
          wsServer.broadcast({
            id: generateUlid(),
            type: "verse:pending",
            timestamp: Date.now(),
            correlationId: transcript.correlationId,
            payload: { ...pendingVerse, corroboratedBy: "interpreter" },
          })
        }
        logger.info({
          component: "app-core",
          event: "verse.echo-suppressed",
          correlationId: transcript.correlationId,
          metadata: { reason: echo.reason, ageMs: echo.ageMs, echoWindowMs: interpreterEchoGuard.currentEchoWindowMs() },
        })
        continue
      }
      const delivery = verseConfirmationMode === "review" ? "pending" : "screen"
      if (delivery === "pending") {
        suggestionArbiter.noteDetectedWaiting()
        broadcastPendingVerse(verse, transcript.correlationId)
      } else broadcastVerse(verse, "detected", transcript.correlationId)
      const durationMs = Date.now() - transcript.timestamp
      pipelineLatency.record(durationMs)
      logger.info({
        component: "app-core",
        event: "verse.latency",
        correlationId: transcript.correlationId,
        durationMs,
        metadata: { delivery },
      })
    }
  }

  function broadcastPendingVerse(verse: Verse, correlationId?: string): void {
    // A suggestion (quote, repair, inferred volume, AI) that takes the slot means no detection is waiting any more.
    if ((verse as Verse & { origin?: string }).origin !== undefined) suggestionArbiter.clearDetectedWaiting()
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

  function armMediaAutoClear(payload: MediaShowPayload, correlationId?: string): void {
    cancelMediaAutoClear()
    const durationMs = payload.cue.autoClearMs
    if (durationMs !== undefined && durationMs !== null) {
      mediaAutoClearTimer = setTimeout(() => {
        mediaAutoClearTimer = null
        if (mediaPlayback.clear()) {
          wsServer.broadcast({
            id: generateUlid(),
            type: "media:clear",
            timestamp: Date.now(),
            correlationId,
            payload: null,
          })
        }
      }, durationMs)
    }
  }

  function cancelMediaAutoClear(): void {
    if (mediaAutoClearTimer) {
      clearTimeout(mediaAutoClearTimer)
      mediaAutoClearTimer = null
    }
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
    wsServer.broadcast({
      id: generateUlid(),
      type: "status:update",
      timestamp: Date.now(),
      payload: { ...payload, audioMetrics: silenceGate.getMetrics() },
    })
  }

  /**
   * ARCHITECTURE.md section 91: broadcasts the same near-miss AppCore
   * already logs server-side, and records it (bounded) for the
   * correction-candidate correlation below. Purely additive — the
   * existing logger.warn call at the near-miss site is unchanged.
   */
  function recordAndBroadcastNearMiss(text: string, correlationId?: string): void {
    recentNearMisses.push({ text, timestamp: Date.now() })
    if (recentNearMisses.length > RECENT_NEAR_MISS_LIMIT) {
      recentNearMisses = recentNearMisses.slice(-RECENT_NEAR_MISS_LIMIT)
    }
    wsServer.broadcast({
      id: generateUlid(),
      type: "detector:near-miss",
      timestamp: Date.now(),
      correlationId,
      payload: { text },
    })
  }

  /**
   * ARCHITECTURE.md section 91: if a near-miss happened shortly before an
   * operator's manual override resolved successfully, that pairing is
   * real evidence — the near-miss text almost certainly meant this exact
   * reference. Logged only (never auto-applied to
   * transcription-corrector's table — a human still reviews and adds it),
   * so this stays a diagnostic aid, not a second, uncontrolled correction
   * path.
   */
  function logCorrectionCandidateIfRecentNearMiss(reference: VerseReference, correlationId?: string): void {
    const now = Date.now()
    const recent = recentNearMisses.filter((m) => now - m.timestamp <= RECENT_NEAR_MISS_WINDOW_MS)
    if (recent.length === 0) return
    const candidate = recent[recent.length - 1]!
    logger.info({
      component: "app-core",
      event: "correction.candidate",
      correlationId,
      metadata: {
        nearMissText: candidate.text,
        resolvedReference: `${reference.book} ${reference.chapter}:${reference.verse}`,
      },
    })
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

  // ARCHITECTURE.md section 82.2: a NEW poster resets (never queues
  // behind) any pending auto-clear, the same "most recent wins" pattern
  // verseAutoClearTimer/definitionClearTimer already use.
  function armPosterAutoClear(correlationId?: string): void {
    if (posterAutoClearTimer) clearTimeout(posterAutoClearTimer)
    posterAutoClearTimer = null
    if (posterAutoClearMs === null) return
    posterAutoClearTimer = setTimeout(() => {
      posterAutoClearTimer = null
      principalPosterCueId = null
      broadcastPosterClear(correlationId)
    }, posterAutoClearMs)
  }

  function cancelPosterAutoClear(): void {
    if (posterAutoClearTimer) {
      clearTimeout(posterAutoClearTimer)
      posterAutoClearTimer = null
    }
  }

  function broadcastLayout(correlationId?: string): void {
    wsServer.broadcast({
      id: generateUlid(),
      type: "layout:update",
      timestamp: Date.now(),
      correlationId,
      payload: { layout: verseLayout },
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
  /**
   * The rundown is the service plan: warm the verse cache for every verse
   * scene in the background so stepping to one later is instant, and still
   * works if the venue's internet drops mid-service. Uses the same
   * resolveVerse() path activateScene() uses (cache -> circuit breaker ->
   * source, response validated) and displays nothing. Sequential and capped
   * so a long rundown never causes a request burst (AGENTS.md sections 36-37);
   * a newer rundown:load abandons an older prefetch.
   */
  /**
   * ARCHITECTURE.md section 104: biases the ASR toward exactly the books
   * this rundown's verse scenes reference — a lexical-bias hint only
   * (identical guarantee to setCurrentVerseRef, AGENTS.md section 9: never
   * invents a confidence, never influences detection/validation). A no-op
   * when the active provider does not implement setPlannedBooks (e.g. Groq,
   * whose static prompt already names every book).
   */
  function applyPlannedBooks(rundown: Rundown): void {
    rundownPlannedBookIds = [
      ...new Set(rundown.scenes.flatMap((scene) => (scene.kind === "verse" ? [scene.reference.book] : []))),
    ]
    pushPlannedBooks()
  }

  /**
   * The plan is the loaded rundown's books plus the imported sermon notes'
   * books (section 130), deduplicated, rundown first.
   */
  function pushPlannedBooks(): void {
    const bookIds = [...new Set([...rundownPlannedBookIds, ...(sermonPrep?.bookIds ?? [])])]
    // Kept for volume inference (a planned "1 Corinthians" says what a bare "Corinthiens" means),
    // whether or not the active ASR provider can use the list itself.
    plannedBookIds = bookIds
    if (!("setPlannedBooks" in asr) || typeof asr.setPlannedBooks !== "function") return
    asr.setPlannedBooks(bookIds)
  }

  function prefetchRundownVerses(rundown: Rundown, correlationId?: string): void {
    const generation = ++rundownPrefetchGeneration
    const references = rundown.scenes
      .flatMap((scene) => (scene.kind === "verse" ? [scene.reference] : []))
      .slice(0, MAX_RUNDOWN_PREFETCH)
    if (references.length === 0) return
    const startedAt = Date.now()
    void (async () => {
      let resolved = 0
      for (const reference of references) {
        if (generation !== rundownPrefetchGeneration || stopped) return
        try {
          if (await resolveVerse(reference, source, cache, circuitBreaker, translationIdFor(source), logger)) resolved++
        } catch (err) {
          logger.warn({
            component: "app-core",
            event: "rundown.prefetch-failed",
            correlationId,
            error: err instanceof Error ? err.message : String(err),
            metadata: { reference },
          })
        }
      }
      logger.info({
        component: "app-core",
        event: "rundown.prefetch-complete",
        correlationId,
        durationMs: Date.now() - startedAt,
        metadata: { requested: references.length, resolved },
      })
    })()
  }

  async function activateScene(state: RundownStatePayload, correlationId?: string): Promise<void> {
    broadcastRundownState(state, correlationId)
    const scene = state.scene
    switch (scene.kind) {
      case "verse": {
        const ticket = beginDisplayIntent()
        const verse = await resolveVerse(scene.reference, source, cache, circuitBreaker, translationIdFor(source), logger)
        if (verse && isSupersededIntent(ticket)) {
          dropStaleLookup("rundown", correlationId)
          return
        }
        if (verse) {
          markIntentApplied(ticket)
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
          const payload = mediaPlayback.activate(cue)
          broadcastMedia(payload, correlationId)
          armMediaAutoClear(payload, correlationId)
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
        supersedeInFlightDisplay()
        clearVerse(correlationId)
        mediaPlayback.clear()
        cancelMediaAutoClear()
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

  function broadcastMicHealth(): void {
    micHealth.setGain(adaptiveGain.currentGain())
    wsServer.broadcast({
      id: generateUlid(),
      type: "mic:health",
      timestamp: Date.now(),
      payload: { ...micHealth.snapshot(silenceGate.isCalibrating()), autoGain: adaptiveGain.isEnabled() },
    })
  }

  async function handleAudioFrame(frame: AudioFrame): Promise<void> {
    // ARCHITECTURE.md section 9 / AGENTS.md section 11: reduce unnecessary
    // ASR requests by not forwarding obvious silence. This must never
    // silently discard SPEECH without a trace, which is exactly why the
    // gate's own metrics (not just its pass/fail decision) are logged
    // when the mic stops, below — an operator with a "nothing is being
    // detected" complaint can see whether frames were even reaching ASR.
    const wasCalibrating = silenceGate.isCalibrating()
    const { forwarded, utteranceEnded, rms } = silenceGate.process(frame)
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
        asrHealth: currentAsrHealth(),
        micCalibrating: false,
        micThreshold: silenceGate.getThreshold(),
      })
    }
    const isSpeech = !silenceGate.isCalibrating() && rms >= silenceGate.getThreshold()
    micHealth.observe(frame, rms, isSpeech)
    micHealthAudioMs += (frame.samples.length / frame.sampleRate) * 1000
    if (forwarded) {
      await asr.sendAudio(adaptiveGain.process(frame, rms, isSpeech))
    }
    if (micHealthAudioMs >= MIC_HEALTH_INTERVAL_MS) {
      micHealthAudioMs = 0
      broadcastMicHealth()
    }
    // TASK 3: when SilenceGate signals end of utterance, flush ASR buffer
    if (utteranceEnded) {
      // The asr is typed as AsrProvider but we know it's GroqProvider with onUtteranceEnd
      if ("onUtteranceEnd" in asr && typeof asr.onUtteranceEnd === "function") {
        await (asr as { onUtteranceEnd: () => Promise<void> }).onUtteranceEnd()
      }
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
        adaptiveGain.reset()
        micHealth.reset()
        micHealthAudioMs = 0
        broadcastAsrStatus({ asrHealth: currentAsrHealth(), micCalibrating: true })
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
        interpreterEchoGuard.forget()
        supersedeInFlightDisplay()
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
        const payload = message.payload as VerseReference
        // Same book-id normalization the detector applies (trim, collapse
        // whitespace, lowercase): a typed "John" must reach the source as
        // "john", or the exact-match French source returns null and
        // currentVersePosition.book becomes a non-catalog id.
        // Quick entry ("jn", "1co", "jean"): resolveQuickBook only picks the catalog book;
        // the known-valid index check below still decides whether the verse exists.
        const reference: VerseReference = {
          ...payload,
          book: resolveQuickBook(payload.book) ?? payload.book.trim().replace(/\s+/g, " ").toLowerCase(),
        }
        // The known-valid index is the hallucination guard for EVERY path to
        // the screen. Without it a typed "john 3:16-30" or chapter 3.5 went
        // straight to the Bible API.
        if (!index.exists(reference)) {
          logger.info({
            component: "app-core",
            event: "override.rejected",
            correlationId: message.correlationId,
            metadata: { reference: payload, reason: "unknown-reference" },
          })
          return
        }
        const ticket = beginDisplayIntent()
        const verse = await resolveVerse(reference, source, cache, circuitBreaker, translationIdFor(source), logger)
        if (verse && isSupersededIntent(ticket)) {
          dropStaleLookup("override", message.correlationId)
          return
        }
        if (verse) {
          markIntentApplied(ticket)
          broadcastVerse(verse, "override", message.correlationId)
          logCorrectionCandidateIfRecentNearMiss(reference, message.correlationId)
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

      case "verse:preview": {
        // ARCHITECTURE.md section 131: a look-ahead for the operator's typing
        // box. It goes through the SAME known-valid index and resolveVerse()
        // as a real override, but it never calls beginDisplayIntent() or any
        // broadcast*Verse(), so what is on the congregation screen cannot change.
        // The answer goes to operators only, never to overlay/stage/live pages.
        const { seq, reference: typed } = message.payload as { seq: number; reference: VerseReference }
        const reference: VerseReference = {
          ...typed,
          book: resolveQuickBook(typed.book) ?? typed.book.trim().replace(/\s+/g, " ").toLowerCase(),
        }
        let verse: Verse | null = null
        if (index.exists(reference)) {
          verse = await resolveVerse(reference, source, cache, circuitBreaker, translationIdFor(source), logger)
        }
        wsServer.broadcastToOperators({
          id: generateUlid(),
          type: "verse:preview-result",
          timestamp: Date.now(),
          correlationId: message.correlationId,
          payload: { seq, reference: typed, verse },
        })
        return
      }

      case "verse:confirm-pending": {
        // ARCHITECTURE.md section 65.3: confirming a pending suggestion
        // still shows it as "detected" (that's what it was), not a new
        // trigger kind of its own — confirmation is how review mode
        // delivers a detection, not a different way a verse got there.
        if (pendingVerse) {
          const { origin: _origin, suggestedBy: _suggestedBy, alternatives: _alternatives, ...verse } = pendingVerse as Verse & { origin?: string; suggestedBy?: string; alternatives?: unknown }
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
        armPosterAutoClear(message.correlationId)
        return
      }

      case "poster:clear":
        principalPosterCueId = null
        cancelPosterAutoClear()
        broadcastPosterClear(message.correlationId)
        return

      case "poster:set-duration": {
        const { durationMs } = message.payload as { durationMs: number | null }
        posterAutoClearMs = durationMs
        // A duration change while a poster is already showing re-arms
        // immediately against the NEW duration (or cancels outright, for
        // null) — an operator adjusting this mid-service shouldn't have
        // to re-set the poster just to apply it.
        if (principalPosterCueId !== null) {
          armPosterAutoClear(message.correlationId)
        }
        return
      }

      case "layout:set": {
        const { layout } = message.payload as { layout: VerseLayout }
        verseLayout = layout
        onVerseLayoutChanged?.(layout)
        broadcastLayout(message.correlationId)
        return
      }

      case "mic:auto-gain": {
        const { enabled } = message.payload as { enabled: boolean }
        adaptiveGain.setEnabled(enabled)
        options.onAutoGainChanged?.(enabled)
        broadcastMicHealth()
        return
      }

      case "asr:return-primary":
        if (typeof asr.returnToPrimary === "function") {
          await asr.returnToPrimary()
          asrIsFailedOver = false
          asrRateLimitedSustained = false
          broadcastAsrStatus({ asrHealth: "ok" })
        }
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
        const payload = mediaPlayback.activate(cue)
        broadcastMedia(payload, message.correlationId)
        armMediaAutoClear(payload, message.correlationId)
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
        cancelMediaAutoClear()
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

      case "media:set-duration": {
        if (!mediaLibrary) {
          logger.warn({ component: "app-core", event: "media.not-configured", correlationId: message.correlationId })
          return
        }
        const { mediaCueId, durationMs } = message.payload as { mediaCueId: string; durationMs: number | null }
        const cue = await mediaLibrary.setAutoClearDuration(mediaCueId, durationMs)
        const activePayload = mediaPlayback.currentPayloadForSync()
        if (activePayload?.cue.id === cue.id) {
          if (durationMs === null) cancelMediaAutoClear()
          else armMediaAutoClear({ ...activePayload, cue }, message.correlationId)
        }
        return
      }

      case "rundown:load": {
        const { rundown } = message.payload as { rundown: Rundown }
        const state = rundownController.load(rundown)
        if (state) {
          await activateScene(state, message.correlationId)
          prefetchRundownVerses(rundown, message.correlationId)
          applyPlannedBooks(rundown)
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

  /**
   * ARCHITECTURE.md section 121: the model proposes a reference for a
   * near-miss sentence. The proposal is only a candidate: it goes back through
   * the same detector, the known-valid index and the verse source, and lands as
   * a pending suggestion (origin "ai"), never on screen by itself.
   */
  async function suggestRepairedVerse(transcript: TranscriptResult): Promise<void> {
    if (!referenceRepairer || transcript.state !== "final" || !repairBudget.tryTake()) return
    const repaired = await referenceRepairer.repair(transcript.text, currentVersePosition?.book ?? null)
    if (!repaired) return
    const reference = detector
      .detect(`${repaired.book} ${repaired.chapter}:${repaired.verse}`)
      .find((candidate) => index.exists(candidate))
    if (!reference) {
      logger.info({ component: "app-core", event: "ai.repair-rejected", correlationId: transcript.correlationId, metadata: { proposed: repaired } })
      return
    }
    if (!canOfferSuggestion(reference)) return
    const verse = await resolveVerse(reference, source, cache, circuitBreaker, translationIdFor(source), logger)
    // Re-checked after the await: another helper may have offered the same verse meanwhile.
    if (!verse || !canOfferSuggestion(reference)) return
    markSuggestionOffered(reference)
    logger.info({ component: "app-core", event: "ai.repair-suggested", correlationId: transcript.correlationId, metadata: { reference: suggestionKey(reference) } })
    broadcastPendingVerse({ ...verse, origin: "ai" } as Verse, transcript.correlationId)
  }

  // Shared by every suggestion path (quotation, repair, cleanup, semantic): the rules live in
  // SuggestionArbiter (per-verse 60 s cooldown started only once a suggestion is really
  // offered, not on screen, and the 20 s hold protecting a DETECTED verse waiting for approval).
  function canOfferSuggestion(reference: VerseReference): boolean {
    return suggestionArbiter.canOffer(reference, currentVersePosition)
  }

  function markSuggestionOffered(reference: VerseReference): void {
    suggestionArbiter.markOffered(reference)
  }

  /** Display-only FR<->EN translation for the operator (section 121); never read by detection. */
  async function translateForOperator(transcript: TranscriptResult): Promise<void> {
    if (!liveTranslator || transcript.state !== "final" || transcript.text.length < 25) return
    const from = guessSpokenLanguage(transcript.text)
    if (from === "unknown" || !translateBudget.tryTake()) return
    const to = from === "fr" ? "en" : "fr"
    const text = await liveTranslator.translate(transcript.text, from, to)
    if (!text) return
    wsServer.broadcast({
      id: generateUlid(),
      type: "translation:final",
      timestamp: Date.now(),
      correlationId: transcript.correlationId,
      payload: { id: transcript.id, from, to, text },
    })
  }

  async function suggestQuotedVerse(transcript: TranscriptResult, windowText: string): Promise<void> {
    const match = options.quoteMatcher?.match(windowText)
    if (!match || !index.exists(match.reference)) return
    if (!canOfferSuggestion(match.reference)) return
    const verse = await resolveVerse(match.reference, source, cache, circuitBreaker, translationIdFor(source), logger)
    if (!verse || !canOfferSuggestion(match.reference)) return
    markSuggestionOffered(match.reference)
    logger.info({
      component: "app-core",
      event: "quote.suggested",
      correlationId: transcript.correlationId,
      metadata: { reference: suggestionKey(match.reference), matchedRuns: match.matchedRuns, coverage: match.coverage },
    })
    broadcastPendingVerse({ ...verse, origin: "quote" } as Verse, transcript.correlationId)
  }

  async function handleNavigationCommands(transcript: TranscriptResult): Promise<void> {
    // An explicit, valid reference in the same utterance ("Romains 8 v. 28",
    // "Psaume 23 verset 1") is already being shown by the detection path.
    // Relative navigation parsed from the same words ("verset 28") would be
    // resolved against the *previous* position and race it — showing a
    // second, wrong verse. Explicit wins; cancel and display-mode commands
    // still apply.
    // A bare volume ("Corinthiens 5 verset 2") is explicit too once context names the volume:
    // the relative "verset 2" must not race it and show verse 2 of whatever is on screen.
    // With no context at all, either volume fitting is enough to know a book WAS named.
    const volumeTexts = [
      applyVolumeHints(transcript.text, buildVolumeHints(plannedBookIds, currentVersePosition?.book ?? null)),
      applyVolumeHints(transcript.text, allFamiliesAtVolume("1")),
      applyVolumeHints(transcript.text, allFamiliesAtVolume("2")),
    ]
    const hasExplicitReference =
      detector.detect(transcript.text).some((reference) => index.exists(reference)) ||
      volumeTexts.some((text) => text !== null && detector.detect(text).some((reference) => index.exists(reference)))
    for (const command of navigationCommandDetector.detect(transcript.text)) {
      if (hasExplicitReference && command.kind !== "goto-display-mode" && command.kind !== "cancel") {
        logger.debug({
          component: "app-core",
          event: "navigation.superseded-by-explicit-reference",
          correlationId: transcript.correlationId,
          metadata: { command },
        })
        continue
      }
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
        supersedeInFlightDisplay()
        broadcastVerseClear(transcript.correlationId)
        continue
      }
      if (resolution.kind === "no-op") {
        const contextless =
          currentVersePosition === null &&
          (command.kind === "goto-bare-verse" || command.kind === "goto-bare-chapter-verse")
        logger[contextless ? "debug" : "warn"]({
          component: "app-core",
          event: contextless ? "navigation.contextless-ignored" : "navigation.no-op",
          correlationId: transcript.correlationId,
          metadata: { command, reason: resolution.reason },
        })
        continue
      }

      // TASK 5: if this was a fallback (out-of-range chapter), broadcast a
      // warning so the dashboard can surface it. The reference is valid (last
      // chapter of the book) so we proceed to resolveVerse() normally.
      if (resolution.fallback) {
        logger.warn({
          component: "app-core",
          event: "navigation.fallback",
          correlationId: transcript.correlationId,
          metadata: { originalCommand: command, fallbackReference: resolution.reference },
        })
      }

      // Still the full resolveVerse() pipeline (cache -> circuit breaker ->
      // source), not just the index.exists() check resolveNavigationCommand
      // already did — existence isn't the same as having real verse text
      // to display (invariant 17).
      const ticket = beginDisplayIntent()
      const verse = await resolveVerse(resolution.reference, source, cache, circuitBreaker, translationIdFor(source), logger)
      if (verse && isSupersededIntent(ticket)) {
        dropStaleLookup("navigation", transcript.correlationId)
        continue
      }
      if (verse) {
        markIntentApplied(ticket)
        broadcastVerse(verse, "navigation", transcript.correlationId)
      }
    }
  }

  // Off-language transcripts dropped in a row; a warning is logged once when a run reaches this length.
  const OFF_LANGUAGE_WARN_AFTER = 5
  let consecutiveOffLanguageDrops = 0

  asr.onTranscript((transcript) => {
    // French and English only (ARCHITECTURE.md section 129): an engine that
    // hallucinates Hindi/Urdu/etc. over noise or silence must never reach a
    // detector or the dashboard.
    //
    // Spanish/Portuguese share the Latin alphabet, so they get a separate,
    // conservative word check, applied to final transcripts only, and never
    // to text that is clearly French or English (a sermon may quote "Señor").
    const offLanguage = hasForeignScript(transcript.text)
      ? "foreign-script"
      : transcript.state === "final" && isLikelyThirdLatinLanguage(transcript.text) && guessSpokenLanguage(transcript.text) === "unknown"
        ? "third-language"
        : null
    if (offLanguage !== null) {
      consecutiveOffLanguageDrops += 1
      // Debug for the first few; a run of drops means the mic is live but
      // nothing is being kept, which the operator must be able to see.
      const loud = consecutiveOffLanguageDrops === OFF_LANGUAGE_WARN_AFTER
      logger[loud ? "warn" : "debug"]({
        component: "asr",
        event: `asr.${offLanguage}-dropped`,
        correlationId: transcript.correlationId,
        sequence: transcript.sequence,
        metadata: { textPreview: transcript.text.slice(0, 40), consecutive: consecutiveOffLanguageDrops },
      })
      return
    }
    consecutiveOffLanguageDrops = 0
    // TACHE UNIQUE (audit priorité absolue): apply deterministic phonetic
    // correction to the raw ASR text BEFORE any consumer sees it, so the
    // transcript.received log, every detector, and the operator dashboard
    // all act on corrected text — not the raw hallucinated text.
    //
    // Production evidence (agent-transcripts / sermon-notes buffer review):
    // "verset" was regularly hallucinated as "V.C."/"WC" (6 times in 34
    // transcripts in one real service), and "psaume" as "some"/"sam".
    // Because correctTranscription() was never wired into the pipeline,
    // those tokens reached RegexDetector / NavigationCommandDetector /
    // the dashboard uncorrected, so verse resolution failed silently and
    // the operator saw garbled text.
    //
    // correctTranscription() is conservative (table-driven, only touches
    // non-protected tokens); it returns the SAME text unchanged when there
    // is nothing to fix, so transcripts with no known confusion are a
    // no-op and cost a single regex split.
    //
    // Order matters here: correctTranscription() must run on the RAW text,
    // before postprocessTranscript(). Its table matches whole whitespace-
    // delimited tokens (e.g. "v.c." -> "verset"), and
    // normalizePunctuation() (part of postprocessTranscript) inserts a
    // space after punctuation like periods — running it first turns
    // "V.C." into "V. C." and silently breaks the token match, so the
    // exact hallucination this correction exists to catch would reach
    // every downstream consumer uncorrected.
    const corrected = correctTranscription(transcript.text)
    const correctedText = postprocessTranscript(corrected.correctedText)
    // Audit trail at debug so it never drowns the info-level transcript
    // log — but it IS greppable when tracing a "why did it detect X" case.
    if (corrected.corrections.length > 0) {
      logger.debug({
        component: "asr",
        event: "asr.correction-applied",
        correlationId: transcript.correlationId,
        sequence: transcript.sequence,
        metadata: {
          original: transcript.text,
          corrected: correctedText,
          corrections: corrected.corrections,
        },
      })
    }
    // Rebind the LOCAL parameter to a corrected copy. This does NOT mutate
    // the provider's object (spread creates a new one); it simply makes
    // every downstream transcript.text read — the log preview, the WS
    // broadcast payload, processTranscript(), handleNavigationCommands(),
    // media/glossary/sermon-notes — see the corrected text.
    transcript = { ...transcript, text: correctedText }
    // TASK 4: log transcript text (truncated to 120 chars for 30-day rotating logs)
    // and textLength. Full text goes to dashboard via WS broadcast.
    const textPreview = transcript.text.length > 120 ? transcript.text.slice(0, 120) + "…" : transcript.text
    logger.info({
      component: "asr",
      event: "transcript.received",
      correlationId: transcript.correlationId,
      sequence: transcript.sequence,
      metadata: {
        text: textPreview,
        // partial vs final: without it a log cannot tell which lines could ever trigger detection.
        state: transcript.state,
        textLength: transcript.text.length,
        // TASK 4: include SilenceGate metrics so VAD starvation is diagnosable from one session
        silenceGate: silenceGate.getMetrics(),
      },
    })
    // Production audit (2026-09): a class of Whisper hallucination
    // correctTranscription() above can't fix, because it isn't a
    // mis-heard WORD — it's an entire INVENTED sentence (YouTube-subtitle
    // boilerplate) or a degenerate repeated-word loop, both well-
    // documented Whisper failure modes on silence/noise. Checked here,
    // provider-agnostically, on every transcript from any provider —
    // previously this lived only inside GroqProvider itself, which meant
    // Deepgram's output (or any future provider's) got no protection at
    // all. Dropped the same way the (still per-provider,
    // audio-format-specific) non-Latin-script filter already is: no
    // broadcast, no detection, as if nothing was heard — but still logged
    // at debug level first, so it's diagnosable, never silently invisible
    // (AGENTS.md section 11).
    const hallucinationCheck = detectHallucination(transcript.text)
    if (hallucinationCheck.isHallucination) {
      logger.debug({
        component: "asr",
        event: "transcript.hallucination-dropped",
        correlationId: transcript.correlationId,
        sequence: transcript.sequence,
        metadata: { reason: hallucinationCheck.reason, textPreview },
      })
      return
    }
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
      // `language` is a display hint for the operator's "Heard" badge only
      // (ARCHITECTURE.md section 120); nothing downstream reads it.
      payload: { ...transcript, language: guessSpokenLanguage(transcript.text) },
    })
    translateForOperator(transcript).catch((err) => logger.warn({
      component: "app-core",
      event: "ai.translate-failed",
      correlationId: transcript.correlationId,
      error: err instanceof Error ? err.message : String(err),
    }))
    aiSuggestions?.cleanupTranscript(transcript)
    // A transcript arriving at all means the ASR pipeline is working again
    // — the operator-facing recovery signal for whatever error, if any,
    // was last broadcast below.
    if (asrHasError || asrIsThrottled || asrRateLimitedSustained) {
      asrHasError = false
      asrIsThrottled = false
      asrRateLimitedSustained = false
      broadcastAsrStatus({ asrHealth: "ok" })
    }
    const detectionTicket = beginDisplayIntent()
    resolveTranscriptVerses(transcript, detector, index, source, cache, circuitBreaker, logger)
      .then(async (verses) => {
        if (verses.length > 0 && isSupersededIntent(detectionTicket)) {
          dropStaleLookup("detection", transcript.correlationId)
          return
        }
        if (verses.length > 0) markIntentApplied(detectionTicket)
        deliverDetectedVerses(verses, transcript)
        if (verses.length === 0) await inferVolumeVerses(transcript.text, transcript)
      })
      .catch((err) => {
        logger.error({
          component: "app-core",
          event: "transcript.pipeline-failed",
          correlationId: transcript.correlationId,
          error: err instanceof Error ? err.message : String(err),
        })
      })

    if (transcript.state === "final") {
      const currentHasReference = detector.detect(transcript.text).length > 0
      if (currentHasReference) {
        // This transcript already contains a complete, standalone
        // reference — the primary detection path above already handles
        // it. Reset rather than push: leaving an already-complete
        // fragment in the assembler's window let a later, unrelated
        // transcript recombine with it and re-detect the SAME reference
        // a second time (a real regression — e.g. "next verse" spoken
        // right after a detected reference recombined with it and
        // re-showed the OLD verse instead of advancing to the next one).
        transcriptAssembler.reset()
      } else {
        const assembledText = transcriptAssembler.push({
          text: transcript.text,
          timestamp: transcript.timestamp,
        })
        if (assembledText && assembledText !== transcript.text && assembledText !== lastAssembledText) {
          lastAssembledText = assembledText
          resolveTranscriptVerses(
            { ...transcript, text: assembledText },
            detector,
            index,
            source,
            cache,
            circuitBreaker,
            logger,
          )
            .then(async (verses) => {
              deliverDetectedVerses(verses, transcript)
              if (verses.length === 0) await inferVolumeVerses(assembledText, transcript)
            })
            .catch((err) => logger.error({
              component: "app-core",
              event: "transcript.assembly-failed",
              correlationId: transcript.correlationId,
              error: err instanceof Error ? err.message : String(err),
            }))
        }
      }
    }

    // TASK 4: NEAR-MISS LOG — when a transcript contains chapter/verse keywords
    // but produced zero references AND zero commands, log event "detector.near-miss"
    // with the text. This turns every future pattern gap into a grep instead of
    // an investigation.
    // Use synchronous detector checks to avoid async in this callback.
    // PROD AUDIT 2026-09: extended — "Daniel 8" (no chapitre/verset keyword at
    // all) repeated 3 times in production and stayed invisible even to this
    // log. A word that IS a catalog book name now counts as a near-miss
    // trigger too (containsCatalogBookName, exported by the detector module).
    // The exact-matches-nothing guard (zero validated refs, zero commands) is
    // unchanged, so a successfully detected utterance still does NOT log a
    // near-miss.
    const hasChapterVerseKeywords = /chapitre|chapter|verset|verse/i.test(transcript.text)
    const hasReferenceNumbers = /\d+|premier|première|deuxième|troisième|quatrième|cinquième|one|two|three|four|five|six|seven|eight|nine|ten/i.test(transcript.text)
    const isNearMissCandidate = hasChapterVerseKeywords || (containsCatalogBookName(transcript.text) && hasReferenceNumbers)
    const detectorRefs = detector.detect(transcript.text)
    const validatedRefs = detectorRefs.filter((r) => index.exists(r))
    const navCommands = navigationCommandDetector.detect(transcript.text)
    const now = Date.now()
    if (
      isNearMissCandidate &&
      validatedRefs.length === 0 &&
      navCommands.length === 0 &&
      (transcript.text !== lastNearMissText || now - lastNearMissTime > 5000)
    ) {
      lastNearMissText = transcript.text
      lastNearMissTime = now
      logger.warn({
        component: "app-core",
        event: "detector.near-miss",
        correlationId: transcript.correlationId,
        metadata: { text: transcript.text },
      })
      recordAndBroadcastNearMiss(transcript.text, transcript.correlationId)
      suggestRepairedVerse(transcript).catch((err) => logger.warn({
        component: "app-core",
        event: "ai.repair-failed",
        correlationId: transcript.correlationId,
        error: err instanceof Error ? err.message : String(err),
      }))
    }

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
          const payload = mediaPlayback.activate(cue)
          broadcastMedia(payload, transcript.correlationId)
          armMediaAutoClear(payload, transcript.correlationId)
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

    // ARCHITECTURE.md sections 124-125: the copilot window and the semantic proposer only ever
    // see validated finals, and only while their feature is on (gated inside the coordinator).
    aiSuggestions?.onFinalAnalyzed(transcript, validatedRefs.length > 0 || navCommands.length > 0)

    if (options.quoteMatcher && passesTranscriptGate(transcript)) {
      // Every final feeds the window (even one that carried a reference), so the
      // words either side of it still join up; only a final with no explicit
      // reference is allowed to trigger a suggestion.
      const windowText = quoteWindow.push(transcript.text, transcript.timestamp)
      if (validatedRefs.length === 0) {
        suggestQuotedVerse(transcript, windowText).catch((err) => {
          logger.error({
            component: "app-core",
            event: "quote.suggest-failed",
            correlationId: transcript.correlationId,
            error: err instanceof Error ? err.message : String(err),
          })
        })
      }
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
    // status:update also reaches viewer pages (overlay, stage, live), so the
    // provider's raw text must never carry a credential echoed by an
    // upstream error or proxy.
    const safeMessage = scrubSecrets(err.message)
    if (err instanceof RateLimitError && err.type === "throttling") {
      asrIsThrottled = true
      broadcastAsrStatus({ asrHealth: "throttled", error: safeMessage })
      return
    }
    // A local server-log line alone left the operator no way to know
    // transcription had failed mid-service — a real gap surfaced by web
    // research into how broadcast-captioning tooling treats ASR/network
    // health as a first-class, always-visible signal. Broadcasting it
    // gives the dashboard something concrete to show, without inventing
    // a policy for WHAT the operator should do about it (that stays a
    // human decision, per AGENTS.md section 39 — this only reports state).
    asrHasError = true
    broadcastAsrStatus({ asrHealth: "error", error: safeMessage })
  })

  if (typeof asr.onFailoverActivated === "function") {
    asr.onFailoverActivated((label?: string) => {
      asrIsFailedOver = true
      asrRateLimitedSustained = false
      broadcastAsrStatus({
        asrHealth: "failover",
        error: `Bascule automatique vers ${label ?? "Deepgram"} active`,
      })
    })
    // Without this the dashboard kept saying "failover" after the wrapper
    // had quietly gone back to the streaming primary.
    if (typeof asr.onAutoReturned === "function") {
      asr.onAutoReturned(() => {
        asrIsFailedOver = false
        asrRateLimitedSustained = false
        broadcastAsrStatus({ asrHealth: "ok" })
      })
    }
  } else if ("onRateLimitedSustained" in asr && typeof asr.onRateLimitedSustained === "function") {
    asr.onRateLimitedSustained(() => {
      asrRateLimitedSustained = true
      broadcastAsrStatus({
        asrHealth: "rate-limited",
        error: "Limite de débit Groq atteinte, envisagez une mise à jour du palier",
      })
    })
  }

  await wsServer.ready
  logger.info({ component: "app-core", event: "started", metadata: { port: wsServer.port } })

  return {
    wsServer,
    setVerseConfirmationMode(mode: VerseConfirmationMode) {
      verseConfirmationMode = mode
    },
    setOverlayStyle(settings: unknown) {
      overlayStyleSettings = normalizeOverlayStyleSettings(settings)
      overlayStyleRevision++
      const style = currentOverlayStyle()
      wsServer.broadcast({ id: generateUlid(), type: "overlay:style", timestamp: Date.now(), payload: style })
      return style
    },
    getOverlayStyle: currentOverlayStyle,
    setSermonNotesEnabled(enabled: boolean) {
      sermonNotesEnabled = enabled
      if (!enabled) sermonNotesBuffer = ""
    },
    setAiFeature(feature: AiFeature, enabled: boolean) {
      // No-op without an Anthropic key (no coordinator). Turning a feature off forgets what was buffered for it.
      aiSuggestions?.setFeature(feature, enabled)
    },
    getSessionEntries() {
      return sessionRecorder.getEntries()
    },
    getSessionHistory() {
      return sessionHistoryStore?.getEntries() ?? []
    },
    getDiagnostics() {
      return {
        generatedAt: Date.now(),
        asrHealth: currentAsrHealth(),
        silenceGate: silenceGate.getMetrics(),
        sessionEntries: sessionRecorder.getEntries().length,
        sessionHistoryEntries: sessionHistoryStore?.getEntries().length ?? 0,
        pipelineLatency: pipelineLatency.snapshot(),
      }
    },
    getPipelineLatency() {
      return pipelineLatency.snapshot()
    },
    importSermonPrep(text: unknown) {
      const outcome = parseSermonPrep(text, index)
      if (!outcome.ok) {
        logger.info({ component: "app-core", event: "sermon-prep.rejected", metadata: { reason: outcome.reason } })
        return outcome
      }
      sermonPrep = outcome.result
      pushPlannedBooks()
      // Counts only: the pasted notes are the pastor's private text (AGENTS.md section 24).
      logger.info({
        component: "app-core",
        event: "sermon-prep.imported",
        metadata: {
          references: outcome.result.references.length,
          books: outcome.result.bookIds.length,
          rejected: outcome.result.rejectedCount,
          truncated: outcome.result.truncated,
        },
      })
      return outcome
    },
    getSermonPrep() {
      return sermonPrep
    },
    clearSermonPrep() {
      if (sermonPrep === null) return
      sermonPrep = null
      pushPlannedBooks()
      logger.info({ component: "app-core", event: "sermon-prep.cleared" })
    },
    async stop() {
      stopped = true
      if (definitionClearTimer) clearTimeout(definitionClearTimer)
      if (sermonNotesTimer) clearInterval(sermonNotesTimer)
      aiSuggestions?.stop()
      // ARCHITECTURE.md section 82.1: verseAutoClearMs went from a
      // narrow, poster-gated condition (rarely armed in tests) to firing
      // on EVERY verse:show — a real, pre-existing gap (stop() never
      // cleared this timer even before that change) that was previously
      // easy to never trigger, and now hangs `node --test`'s process
      // exit on almost any test that shows a verse and stops before the
      // real ~2.5-minute default fires. posterAutoClearTimer is the same
      // class of leak for its own new feature.
      if (verseAutoClearTimer) clearTimeout(verseAutoClearTimer)
      if (posterAutoClearTimer) clearTimeout(posterAutoClearTimer)
      if (mediaAutoClearTimer) clearTimeout(mediaAutoClearTimer)
      await asr.stop().catch((error: unknown) => {
        // Shutdown must continue, but a provider that failed to stop may leak a socket or process.
        logger.warn({
          component: "app-core",
          event: "asr.stop-failed",
          error: error instanceof Error ? error.message : String(error),
        })
      })
      await wsServer.close()
      logger.info({ component: "app-core", event: "stopped" })
    },
  }
}
