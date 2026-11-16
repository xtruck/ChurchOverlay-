import { isLoopbackAddress, normalizeRemoteAddress } from "../../../packages/shared/ip-utils"

/**
 * Per-client-IP rate limiting for the WS handshake (S-03: the handshake
 * was free to spam, and the 64-connection cap was saturable by one
 * address retrying in a loop).
 *
 * Sliding window per address: at most `maxAttemptsPerMinute` handshake
 * attempts per window. Every REFUSED attempt (over the limit, or while
 * banned) counts toward `refusalThreshold`; crossing it bans the address
 * for `banSeconds` — so a hammering client bans itself instead of
 * probing at exactly the allowed rate forever.
 *
 * Bounded by construction (AGENTS.md section 36): expired addresses are
 * pruned on every attempt, and the map is hard-capped — the oldest
 * (insertion-order) entry is evicted when the cap is exceeded, so no
 * number of spoofed addresses can grow memory without bound.
 *
 * Loopback is never limited: the app's own pages (dashboard, OBS overlay
 * on the same machine, dev-preview) connect from 127.0.0.1 and must
 * reconnect freely; the threat model is a remote address, not the
 * machine itself.
 */
export type HandshakeRateLimitOptions = {
  /** Handshake attempts allowed per sliding window, per address. 0 disables the limiter entirely. Defaults to 10. */
  readonly maxAttemptsPerMinute?: number
  /** Length of the sliding window in ms. Defaults to 60 000. */
  readonly windowMs?: number
  /** Refused attempts (within the window) that trigger the ban. Defaults to 3. */
  readonly refusalThreshold?: number
  /** Ban length in ms once the refusal threshold is crossed. Defaults to 60 000. */
  readonly banMs?: number
  /** Hard cap on tracked addresses; the oldest entry is evicted past it. Defaults to 4096. */
  readonly maxTrackedAddresses?: number
}

export const DEFAULT_HANDSHAKE_RATE_LIMIT: Required<HandshakeRateLimitOptions> = {
  maxAttemptsPerMinute: 10,
  windowMs: 60_000,
  refusalThreshold: 3,
  banMs: 60_000,
  maxTrackedAddresses: 4096,
}

export type HandshakeAttemptOutcome =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: string; readonly retryAfterSeconds: number }

type AddressState = {
  /** Timestamps of the attempts inside the current sliding window. */
  attempts: number[]
  /** Consecutive refused attempts inside the window (reset when an attempt is allowed). */
  refusals: number
  /** Ban deadline, 0 while not banned. */
  bannedUntil: number
}

export class HandshakeRateLimiter {
  private readonly options: Required<HandshakeRateLimitOptions>
  private readonly states = new Map<string, AddressState>()

  constructor(options: HandshakeRateLimitOptions = {}) {
    this.options = { ...DEFAULT_HANDSHAKE_RATE_LIMIT, ...options }
  }

  get disabled(): boolean {
    return this.options.maxAttemptsPerMinute <= 0
  }

  /**
   * Records one handshake attempt for this client address and says whether
   * the server should proceed with the upgrade. A refused attempt returns
   * the whole-window wait so the HTTP layer can answer with Retry-After.
   */
  attempt(address: string | undefined, now: number = Date.now()): HandshakeAttemptOutcome {
    if (this.disabled) return { allowed: true }
    if (isLoopbackAddress(address)) return { allowed: true }

    const key = normalizeRemoteAddress(address)
    this.prune(now)

    const state = this.states.get(key) ?? { attempts: [], refusals: 0, bannedUntil: 0 }

    if (state.bannedUntil > now) {
      this.recordRefusal(key, state, now)
      return {
        allowed: false,
        reason: `handshake rate limit: address banned for flooding`,
        retryAfterSeconds: this.retryAfter(state.bannedUntil, now),
      }
    }

    state.attempts = state.attempts.filter((t) => now - t < this.options.windowMs)
    if (state.attempts.length >= this.options.maxAttemptsPerMinute) {
      this.recordRefusal(key, state, now)
      const banned = state.bannedUntil > now
      return {
        allowed: false,
        reason: banned
          ? `handshake rate limit: address banned for flooding`
          : `handshake rate limit exceeded (${this.options.maxAttemptsPerMinute} per ${Math.round(this.options.windowMs / 1000)}s)`,
        retryAfterSeconds: this.retryAfter(
          banned ? state.bannedUntil : (state.attempts[0] ?? now) + this.options.windowMs,
          now
        ),
      }
    }

    state.attempts.push(now)
    state.refusals = 0
    state.bannedUntil = 0
    this.touch(key, state)
    return { allowed: true }
  }

  /** Test/diagnostic hook: is this address currently banned? */
  isBanned(address: string | undefined, now: number = Date.now()): boolean {
    const state = this.states.get(normalizeRemoteAddress(address))
    return (state?.bannedUntil ?? 0) > now
  }

  private recordRefusal(key: string, state: AddressState, now: number): void {
    state.refusals += 1
    if (state.refusals >= this.options.refusalThreshold) {
      state.bannedUntil = now + this.options.banMs
      state.refusals = 0
    }
    this.touch(key, state)
  }

  private retryAfter(until: number, now: number): number {
    return Math.max(1, Math.ceil((until - now) / 1000))
  }

  private touch(key: string, state: AddressState): void {
    // Refresh insertion order so the eviction cap actually keeps the
    // recently active addresses, not whichever arrived first.
    this.states.delete(key)
    this.states.set(key, state)
    if (this.states.size > this.options.maxTrackedAddresses) {
      const oldest = this.states.keys().next().value
      if (oldest !== undefined) this.states.delete(oldest)
    }
  }

  private prune(now: number): void {
    for (const [key, state] of this.states) {
      const lastActivity = state.bannedUntil > 0 ? state.bannedUntil : (state.attempts[state.attempts.length - 1] ?? 0)
      if (lastActivity < now - this.options.windowMs) this.states.delete(key)
    }
  }
}

/**
 * Which role (if any) the offered Sec-WebSocket-Protocol values carry.
 * Mirror of resolveProtocol()'s ordering (operator checked first), used
 * BEFORE the connection is admitted so capacity decisions can be
 * role-aware. Returns null for unregistered tokens — those are rejected
 * later by the same existing path as before (never silently admitted).
 *
 * The comparator is injected so the server path passes its hash-based
 * constant-time tokenEquals — the offered values are attacker-controlled
 * and must never be compared with === against the real tokens.
 */
export function offeredRole(
  protocols: string | undefined,
  tokens: { readonly operatorToken: string; readonly viewerToken: string },
  equals: (offered: string, expected: string) => boolean
): "operator" | "viewer" | null {
  const offered = (protocols ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)
  for (const value of offered) {
    if (equals(value, tokens.operatorToken)) return "operator"
  }
  for (const value of offered) {
    if (equals(value, tokens.viewerToken)) return "viewer"
  }
  return null
}
