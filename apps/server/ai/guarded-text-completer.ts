import { CircuitBreaker, type CircuitState } from "../verse/circuit-breaker"
import type { TextCompleter } from "./claude-client"

/**
 * Bounded failure strategy for the optional AI helpers (AGENTS.md sections 37
 * and 38). Several helpers (cleanup, translate, semantic, copilot, notes) each
 * call the model once per final transcript, so a model that answers 404/401
 * used to cost 2-3 doomed requests per utterance for the whole service
 * (live log 2026-10-12). After `failureThreshold` consecutive failures the
 * circuit opens and calls are refused locally, with no network request, until
 * the cooldown elapses; then exactly one probe is allowed through.
 *
 * It never changes provider and never fabricates an answer: a refused call
 * rejects like any other failure, so every helper keeps its fail-soft path
 * (raw transcript, no suggestion).
 *
 * It also reports an operator-facing status (ok / paused / unavailable) with a
 * FIXED reason code, never the provider's raw error text, because that status
 * is broadcast to pages that must not see upstream error bodies.
 */

export class AiCircuitOpenError extends Error {
  constructor() {
    super("AI helpers paused after repeated failures (circuit open)")
    this.name = "AiCircuitOpenError"
  }
}

export type AiHelpersReason = "model-unavailable" | "auth" | "repeated-failures"
export type AiHelpersStatus = { readonly state: "ok" | "paused" | "unavailable"; readonly reason?: AiHelpersReason }

/** What a one-time startup check can conclude. "unknown" (network trouble, an unexpected answer) is never treated as a failure. */
export type AiAvailability = "ok" | "model-unavailable" | "auth" | "unknown"

/** A completer that can check, without spending a completion, that its configured model is usable. */
export interface AvailabilityCheckable {
  checkAvailability(): Promise<AiAvailability>
}

/** What AppCore needs to show the operator the state of the helpers; a plain TextCompleter simply lacks these. */
export interface AiHelpersStatusSource extends AvailabilityCheckable {
  currentStatus(): AiHelpersStatus
  subscribeStatus(listener: (status: AiHelpersStatus) => void): void
}

export type GuardedTextCompleterOptions = {
  readonly failureThreshold?: number
  readonly cooldownMs?: number
  readonly now?: () => number
  /** Called on every circuit state change, with the failure that caused an opening (never carries a key). */
  readonly onStateChange?: (state: CircuitState, error?: string) => void
}

const DEFAULT_FAILURE_THRESHOLD = 3
const DEFAULT_COOLDOWN_MS = 60_000

/** Failure text -> a fixed reason code. The text itself is never forwarded. */
function reasonFor(message: string): AiHelpersReason {
  if (/\((401|403)\)/.test(message)) return "auth"
  if (/\(404\)/.test(message)) return "model-unavailable"
  return "repeated-failures"
}

export class GuardedTextCompleter implements TextCompleter {
  private readonly breaker: CircuitBreaker
  private readonly failureThreshold: number
  private readonly onStateChange?: (state: CircuitState, error?: string) => void
  private readonly statusListeners: Array<(status: AiHelpersStatus) => void> = []
  private lastState: CircuitState = "closed"
  private lastReason: AiHelpersReason = "repeated-failures"
  /** Set by a definitive startup check; cleared by the first successful call. */
  private unavailableReason: AiHelpersReason | null = null
  private lastStatusKey = "ok:" // same `${state}:${reason ?? ""}` format notify() compares against

  constructor(
    readonly inner: TextCompleter,
    options: GuardedTextCompleterOptions = {}
  ) {
    this.failureThreshold = options.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD
    this.breaker = new CircuitBreaker({
      failureThreshold: this.failureThreshold,
      cooldownMs: options.cooldownMs ?? DEFAULT_COOLDOWN_MS,
      now: options.now,
    })
    this.onStateChange = options.onStateChange
  }

  getState(): CircuitState {
    return this.breaker.getState()
  }

  currentStatus(): AiHelpersStatus {
    if (this.unavailableReason !== null) return { state: "unavailable", reason: this.unavailableReason }
    if (this.breaker.getState() !== "closed") return { state: "paused", reason: this.lastReason }
    return { state: "ok" }
  }

  /** Listeners are told only when the status actually changes. */
  subscribeStatus(listener: (status: AiHelpersStatus) => void): void {
    this.statusListeners.push(listener)
  }

  /**
   * One-time startup check. A definitive "model-unavailable" / "auth" answer marks
   * the helpers unavailable and opens the circuit at once, so not even the first
   * transcripts are spent on doomed requests. "unknown" changes nothing.
   */
  async checkAvailability(): Promise<AiAvailability> {
    const inner = this.inner as Partial<AvailabilityCheckable>
    if (typeof inner.checkAvailability !== "function") return "unknown"
    const result = await inner.checkAvailability()
    if (result === "model-unavailable" || result === "auth") {
      this.unavailableReason = result
      this.lastReason = result
      for (let i = 0; i < this.failureThreshold; i++) this.breaker.recordFailure()
      this.notify(result)
    } else if (result === "ok") {
      this.unavailableReason = null
      this.notify()
    }
    return result
  }

  async complete(request: { system: string; user: string; maxTokens?: number; timeoutMs?: number }): Promise<string> {
    if (!this.breaker.canProceed()) throw new AiCircuitOpenError()
    this.notify()
    try {
      const answer = await this.inner.complete(request)
      this.breaker.recordSuccess()
      this.unavailableReason = null
      this.notify()
      return answer
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.lastReason = reasonFor(message)
      this.breaker.recordFailure()
      this.notify(message)
      throw error
    }
  }

  private notify(error?: string): void {
    const state = this.breaker.getState()
    if (state !== this.lastState) {
      this.lastState = state
      this.onStateChange?.(state, error)
    }
    const status = this.currentStatus()
    const key = `${status.state}:${status.reason ?? ""}`
    if (key === this.lastStatusKey) return
    this.lastStatusKey = key
    for (const listener of this.statusListeners) listener(status)
  }
}
