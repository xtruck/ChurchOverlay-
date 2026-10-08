import type { TranscriptResult, Verse, VerseReference, WsMessage } from "../../../packages/contracts"
import type { Logger } from "../../../packages/shared/logger"
import { scrubSecrets } from "../../../packages/shared/logger"
import { generateUlid } from "../../../packages/shared/ulid"
import { CallBudget, type TextCompleter } from "../ai/claude-client"
import { TranscriptCleaner, looksReferenceRelated } from "../ai/transcript-cleaner"
import { SemanticVerseProposer } from "../ai/semantic-verse-proposer"
import { SermonCopilot } from "../ai/sermon-copilot"
import { DEFAULT_AI_FEATURES, type AiFeature, type AiFeatureFlags } from "../ai/ai-features"
import { RollingTranscriptWindow } from "../asr/rolling-transcript-window"
import { passesTranscriptGate } from "./transcript-gate"
import { suggestionKey, type SuggestionArbiter } from "./suggestion-arbiter"

/**
 * The three optional, live-toggled Anthropic helpers that turn what was said into
 * verse SUGGESTIONS or operator-only hints (ARCHITECTURE.md sections 123-125):
 * transcript cleanup, semantic suggestions and the sermon copilot.
 *
 * Moved out of AppCore without a behaviour change (AGENTS.md sections 26 and 57).
 * It never touches the detector, the index, the verse source or a WebSocket
 * directly: AppCore hands it ports, so the hallucination guard stays where it was.
 * Every proposal goes through `validateProposal` / `detectValidated` (detector +
 * known-valid index), then `resolve` (cache, circuit breaker, verse source), and
 * ends as `offerPending` (a pending suggestion, never a displayed verse) or
 * `sendToOperators` (copilot, operator clients only).
 */

export type AiSuggestionPorts = {
  readonly completer: TextCompleter
  readonly logger: Logger
  readonly flags?: Partial<AiFeatureFlags>
  readonly cleanupTimeoutMs?: number
  /** Minimum gap between two semantic model calls; default 10 s. */
  readonly semanticMinIntervalMs?: number
  /** How often the copilot considers a new cycle; default 45 s. */
  readonly copilotIntervalMs?: number
  readonly isStopped: () => boolean
  /** Book id currently on screen, used as a hint in prompts. */
  readonly currentBook: () => string | null
  readonly currentPosition: () => VerseReference | null
  /** Detector + known-valid index applied to free text. */
  readonly detectValidated: (text: string) => readonly VerseReference[]
  /** A model-proposed reference rendered, re-read by the detector and checked by the index. */
  readonly validateProposal: (proposal: { book: string; chapter: number; verse: number }) => VerseReference | null
  readonly resolve: (reference: VerseReference) => Promise<Verse | null>
  readonly containsBookName: (text: string) => boolean
  /** True when the deterministic quote matcher already recognises this text. */
  readonly quoteMatches: (windowText: string) => boolean
  /** Keys ("book chapter:verse") of the verses shown this session, oldest first. */
  readonly shownKeys: () => readonly string[]
  readonly arbiter: SuggestionArbiter
  readonly offerPending: (verse: Verse, correlationId?: string) => void
  readonly sendToOperators: (message: WsMessage) => void
}

const MAX_CLEANUPS_IN_FLIGHT = 2
const SEMANTIC_MIN_WORDS = 6
const COPILOT_MIN_NEW_CHARS = 200

function errorText(err: unknown): string {
  return scrubSecrets(err instanceof Error ? err.message : String(err))
}

export class AiSuggestionCoordinator {
  private readonly flags: Record<AiFeature, boolean>

  private readonly transcriptCleaner: TranscriptCleaner
  private readonly cleanupBudget = new CallBudget(20)
  private cleanupsInFlight = 0

  // Section 124: rolling window, 4 calls/min, one at a time, >= 10 s apart.
  private readonly semanticProposer: SemanticVerseProposer
  private readonly semanticWindow = new RollingTranscriptWindow({ maxAgeMs: 45_000, maxWords: 120 })
  private readonly semanticBudget = new CallBudget(4)
  private readonly semanticMinIntervalMs: number
  private semanticInFlight = false
  private lastSemanticCallAt = 0

  // Section 125: last ~2 min of validated finals, one cycle at a time, 3 calls/min.
  private readonly sermonCopilot: SermonCopilot
  private readonly copilotWindow = new RollingTranscriptWindow({ maxAgeMs: 120_000, maxWords: 450 })
  private readonly copilotBudget = new CallBudget(3)
  private copilotNewChars = 0
  private copilotInFlight = false
  private readonly copilotTimer: ReturnType<typeof setInterval>

  constructor(private readonly ports: AiSuggestionPorts) {
    this.flags = { ...DEFAULT_AI_FEATURES, ...ports.flags }
    this.transcriptCleaner = new TranscriptCleaner(ports.completer, ports.cleanupTimeoutMs)
    this.semanticProposer = new SemanticVerseProposer(ports.completer)
    this.semanticMinIntervalMs = ports.semanticMinIntervalMs ?? 10_000
    this.sermonCopilot = new SermonCopilot(ports.completer)
    this.copilotTimer = setInterval(() => {
      this.runCopilotCycle().catch((err) => ports.logger.warn({ component: "app-core", event: "ai.copilot-failed", error: errorText(err) }))
    }, ports.copilotIntervalMs ?? 45_000)
  }

  /** Live toggle. Turning a feature off forgets what was buffered for it: nothing is recorded while it is off. */
  setFeature(feature: AiFeature, enabled: boolean): void {
    this.flags[feature] = enabled
    if (!enabled && feature === "semanticDetection") this.semanticWindow.reset()
    if (!enabled && feature === "sermonCopilot") {
      this.copilotWindow.reset()
      this.copilotNewChars = 0
    }
  }

  stop(): void {
    clearInterval(this.copilotTimer)
  }

  /** Called for every transcript; runs beside the raw-text path, never in front of it. */
  cleanupTranscript(transcript: TranscriptResult): void {
    this.suggestFromCleanedTranscript(transcript).catch((err) => this.ports.logger.warn({
      component: "app-core",
      event: "ai.cleanup-failed",
      correlationId: transcript.correlationId,
      error: errorText(err),
    }))
  }

  /**
   * Called once a FINAL has been analysed by the deterministic path.
   * `hasExplicitReferenceOrCommand`: it carried a validated reference or a navigation
   * command, so the semantic proposer is not asked about it.
   */
  onFinalAnalyzed(transcript: TranscriptResult, hasExplicitReferenceOrCommand: boolean): void {
    if (!passesTranscriptGate(transcript)) return
    // Section 125: the copilot only ever sees validated finals, and only while it is on.
    if (this.flags.sermonCopilot) {
      this.copilotWindow.push(transcript.text, transcript.timestamp)
      this.copilotNewChars += transcript.text.length
    }
    // Section 124: only while the feature is on is text kept in the window.
    if (this.flags.semanticDetection) {
      const semanticText = this.semanticWindow.push(transcript.text, transcript.timestamp)
      if (!hasExplicitReferenceOrCommand) {
        this.suggestSemanticVerse(transcript, semanticText).catch((err) => this.ports.logger.warn({
          component: "app-core",
          event: "ai.semantic-failed",
          correlationId: transcript.correlationId,
          error: errorText(err),
        }))
      }
    }
  }

  /**
   * ARCHITECTURE.md section 123: ask the model to correct the transcript, then run
   * the CANDIDATE through the same detector, known-valid index and verse source.
   * A reference found only thanks to the correction is a pending suggestion
   * (origin "ai"), never shown.
   */
  private async suggestFromCleanedTranscript(transcript: TranscriptResult): Promise<void> {
    const { ports } = this
    if (!this.flags.transcriptCleanup || !passesTranscriptGate(transcript)) return
    if (!looksReferenceRelated(transcript.text, ports.containsBookName)) return
    if (this.cleanupsInFlight >= MAX_CLEANUPS_IN_FLIGHT || !this.cleanupBudget.tryTake()) return
    const rawKeys = new Set(ports.detectValidated(transcript.text).map(suggestionKey))
    this.cleanupsInFlight += 1
    let cleaned: string | null
    try {
      cleaned = await this.transcriptCleaner.clean(transcript.text)
    } catch (err) {
      ports.logger.warn({
        component: "app-core",
        event: "ai.cleanup-fallback-raw",
        correlationId: transcript.correlationId,
        error: errorText(err),
      })
      return
    } finally {
      this.cleanupsInFlight -= 1
    }
    if (!cleaned || !this.flags.transcriptCleanup || ports.isStopped()) return
    const reference = ports.detectValidated(cleaned).filter((ref) => !rawKeys.has(suggestionKey(ref)))[0]
    if (!reference) return
    if (!ports.arbiter.aiMayReplacePending() || !ports.arbiter.canOffer(reference, ports.currentPosition())) return
    const verse = await ports.resolve(reference)
    // Re-checked after the await: a detection may have started waiting, the same
    // verse may have been offered by another helper, or the feature/core stopped.
    if (!verse || !this.flags.transcriptCleanup || ports.isStopped() || !ports.arbiter.aiMayReplacePending() || !ports.arbiter.canOffer(reference, ports.currentPosition())) return
    ports.arbiter.markOffered(reference)
    ports.logger.info({
      component: "app-core",
      event: "ai.cleanup-suggested",
      correlationId: transcript.correlationId,
      metadata: { reference: suggestionKey(reference) },
    })
    ports.offerPending({ ...verse, origin: "ai", suggestedBy: "cleanup" } as Verse, transcript.correlationId)
  }

  /**
   * ARCHITECTURE.md section 124: the model proposes the verse a paraphrase or loose
   * quotation refers to. Same path as every proposal and ALWAYS a pending
   * suggestion, never shown by itself.
   */
  private async suggestSemanticVerse(transcript: TranscriptResult, windowText: string): Promise<void> {
    const { ports } = this
    if (!this.flags.semanticDetection || !passesTranscriptGate(transcript)) return
    if (transcript.text.trim().split(/\s+/).length < SEMANTIC_MIN_WORDS) return
    // A verbatim quotation is the deterministic matcher's job; its suggestion wins.
    if (ports.quoteMatches(windowText)) return
    const now = Date.now()
    if (this.semanticInFlight || now - this.lastSemanticCallAt < this.semanticMinIntervalMs || !this.semanticBudget.tryTake()) return
    this.semanticInFlight = true
    this.lastSemanticCallAt = now
    let proposal: Awaited<ReturnType<SemanticVerseProposer["propose"]>>
    try {
      proposal = await this.semanticProposer.propose(windowText, ports.currentBook())
    } finally {
      this.semanticInFlight = false
    }
    if (!proposal || !this.flags.semanticDetection || ports.isStopped()) return
    const reference = ports.validateProposal(proposal)
    if (!reference) {
      ports.logger.info({ component: "app-core", event: "ai.semantic-rejected", correlationId: transcript.correlationId, metadata: { proposed: { book: proposal.book, chapter: proposal.chapter, verse: proposal.verse } } })
      return
    }
    if (!ports.arbiter.aiMayReplacePending() || !ports.arbiter.canOffer(reference, ports.currentPosition())) return
    const verse = await ports.resolve(reference)
    if (!verse || !this.flags.semanticDetection || ports.isStopped() || !ports.arbiter.aiMayReplacePending() || !ports.arbiter.canOffer(reference, ports.currentPosition())) return
    ports.arbiter.markOffered(reference)
    ports.logger.info({
      component: "app-core",
      event: "ai.semantic-suggested",
      correlationId: transcript.correlationId,
      metadata: { reference: suggestionKey(reference) },
    })
    ports.offerPending({ ...verse, origin: "ai", suggestedBy: "semantic" } as Verse, transcript.correlationId)
  }

  /**
   * ARCHITECTURE.md section 125: one copilot cycle. Related verses are candidates
   * (detector, known-valid index, verse source); the result goes to operator-role
   * clients only and is never displayed anywhere without an operator action.
   */
  private async runCopilotCycle(): Promise<void> {
    const { ports } = this
    if (!this.flags.sermonCopilot || this.copilotInFlight || ports.isStopped()) return
    if (this.copilotNewChars < COPILOT_MIN_NEW_CHARS || !this.copilotBudget.tryTake()) return
    this.copilotInFlight = true
    const consumedChars = this.copilotNewChars
    this.copilotNewChars = 0
    try {
      // push("") adds nothing; it only expires old entries and returns the current window.
      const recentText = this.copilotWindow.push("", Date.now())
      const shownKeys = new Set(ports.shownKeys())
      const draft = await this.sermonCopilot.suggest(recentText, [...shownKeys].slice(-8))
      if (!draft || !this.flags.sermonCopilot || ports.isStopped()) return
      const relatedVerses: Verse[] = []
      const offered = new Set<string>()
      for (const proposed of draft.relatedVerses) {
        const reference = ports.validateProposal(proposed)
        if (!reference) {
          ports.logger.info({ component: "app-core", event: "ai.copilot-verse-rejected", metadata: { proposed } })
          continue
        }
        const key = suggestionKey(reference)
        if (shownKeys.has(key) || offered.has(key)) continue
        offered.add(key)
        const verse = await ports.resolve(reference)
        if (verse) relatedVerses.push(verse)
      }
      if (relatedVerses.length === 0 && draft.keyPoint === null) return
      if (!this.flags.sermonCopilot || ports.isStopped()) return
      ports.sendToOperators({
        id: generateUlid(),
        type: "copilot:suggestions",
        timestamp: Date.now(),
        payload: { id: generateUlid(), relatedVerses, keyPoint: draft.keyPoint },
      })
      ports.logger.info({ component: "app-core", event: "ai.copilot-suggested", metadata: { verses: relatedVerses.length, keyPoint: draft.keyPoint !== null } })
    } catch (err) {
      // A failed call must not throw away the text it was meant to cover: keep the trigger armed (the budget still bounds retries).
      if (this.flags.sermonCopilot) this.copilotNewChars += consumedChars
      ports.logger.warn({ component: "app-core", event: "ai.copilot-failed", error: errorText(err) })
    } finally {
      this.copilotInFlight = false
    }
  }
}
