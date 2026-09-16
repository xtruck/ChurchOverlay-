export type CircuitState = "closed" | "open" | "half-open"

export type CircuitBreakerOptions = {
  readonly failureThreshold?: number
  readonly cooldownMs?: number
  readonly now?: () => number
}

const DEFAULT_FAILURE_THRESHOLD = 5
const DEFAULT_COOLDOWN_MS = 30_000

/**
 * Generic circuit breaker (ARCHITECTURE.md section 21, AGENTS.md section
 * 38): "If a future external service repeatedly fails, use a bounded
 * failure strategy. Do not continuously hammer an unavailable service."
 * Also an explicit v1 scope item — "API failure protection"
 * (ARCHITECTURE.md section 2.1 item 17).
 *
 * Deliberately has no knowledge of *which* external service it protects —
 * VerseSource (not yet implemented; that requires choosing a specific
 * Bible API, a decision this component doesn't need to wait on) would
 * hold one of these, call canProceed() before attempting a request, and
 * report the outcome via recordSuccess()/recordFailure().
 *
 * State names map onto ARCHITECTURE.md section 21's phases:
 *   closed    == "Healthy"
 *   open      == "Repeated failures" / "Temporary circuit-open state" / "Cooldown"
 *   half-open == "Probe"
 *
 * `now` is injectable so cooldown timing is testable deterministically,
 * without real timers (AGENTS.md section 32).
 */
export class CircuitBreaker {
  private readonly failureThreshold: number
  private readonly cooldownMs: number
  private readonly now: () => number

  private state: CircuitState = "closed"
  private consecutiveFailures = 0
  private openedAt = 0
  private probeInFlight = false

  constructor(options: CircuitBreakerOptions = {}) {
    this.failureThreshold = options.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD
    this.cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS
    this.now = options.now ?? Date.now

    if (!Number.isInteger(this.failureThreshold) || this.failureThreshold < 1) {
      throw new RangeError("failureThreshold must be a positive integer")
    }
    if (!Number.isFinite(this.cooldownMs) || this.cooldownMs < 0) {
      throw new RangeError("cooldownMs must be a non-negative number")
    }
  }

  getState(): CircuitState {
    return this.state
  }

  /** May a caller attempt the protected operation right now? */
  canProceed(): boolean {
    if (this.state === "closed") return true

    if (this.state === "open") {
      if (this.now() - this.openedAt < this.cooldownMs) return false
      // Cooldown elapsed: allow exactly one probe through.
      this.state = "half-open"
      this.probeInFlight = true
      return true
    }

    // half-open: only one probe in flight at a time.
    if (this.probeInFlight) return false
    this.probeInFlight = true
    return true
  }

  recordSuccess(): void {
    this.state = "closed"
    this.consecutiveFailures = 0
    this.probeInFlight = false
  }

  recordFailure(): void {
    if (this.state === "half-open") {
      // The probe failed — reopen and restart the cooldown.
      this.state = "open"
      this.openedAt = this.now()
      this.probeInFlight = false
      return
    }

    this.consecutiveFailures += 1
    if (this.consecutiveFailures >= this.failureThreshold) {
      this.state = "open"
      this.openedAt = this.now()
    }
  }
}
