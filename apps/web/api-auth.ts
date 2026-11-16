import { createHash, timingSafeEqual } from "node:crypto"
import express, { type Express, type NextFunction, type Request, type RequestHandler, type Response } from "express"
import { isLoopbackAddress, normalizeRemoteAddress } from "../../packages/shared/ip-utils"

const LOOPBACK_HOST = "127.0.0.1"

/**
 * Web Server Mode's bind address (ARCHITECTURE.md sections 24 and 49:
 * loopback unless the operator explicitly opts into the network). Reachable
 * from a phone or another machine only when WEB_HOST is set on purpose.
 */
export function resolveWebHost(value: string | undefined): string {
  const trimmed = value?.trim()
  return trimmed ? trimmed : LOOPBACK_HOST
}

export function isLoopbackHost(host: string): boolean {
  return host === LOOPBACK_HOST || host === "localhost" || host === "::1"
}

/** Shortest operator-supplied (OPERATOR_TOKEN / VIEWER_TOKEN) token accepted. Generated ones are 32 hex chars. */
export const MIN_CONFIGURED_TOKEN_LENGTH = 16

/**
 * Web Server Mode lets the operator pin the tokens through the environment.
 * Reject the two mistakes that silently defeat the role boundary: a short
 * guessable token (there is no lockout on /api or the WS handshake), and the
 * SAME value for both — the WS server checks the operator token first, so
 * every viewer page (overlay, stage, live; handed to the congregation) would
 * then hold operator rights. Returns an error message, or null when fine.
 * Unset values are fine: random ones are generated instead.
 */
export function validateConfiguredTokens(operatorToken: string | undefined, viewerToken: string | undefined): string | null {
  for (const [name, value] of [["OPERATOR_TOKEN", operatorToken], ["VIEWER_TOKEN", viewerToken]] as const) {
    if (value !== undefined && value !== "" && value.length < MIN_CONFIGURED_TOKEN_LENGTH) {
      return `${name} must be at least ${MIN_CONFIGURED_TOKEN_LENGTH} characters (or leave it unset to generate a random one)`
    }
  }
  if (operatorToken && viewerToken && operatorToken === viewerToken) {
    return "OPERATOR_TOKEN and VIEWER_TOKEN must differ: equal tokens would give every viewer page operator rights"
  }
  return null
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest()
}

/**
 * Every /api route can change what the congregation sees (mode, media,
 * synthetic transcripts) or reveals the session, so each request must carry
 * the operator token. Sent as `Authorization: Bearer`, never in the URL
 * (AGENTS.md section 18). Both sides are hashed first so the comparison is
 * constant-time regardless of token length.
 */
function requireOperatorToken(operatorToken: string) {
  const expected = digest(operatorToken)
  return (req: Request, res: Response, next: NextFunction): void => {
    const match = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? "")
    if (match && timingSafeEqual(digest(match[1] as string), expected)) {
      next()
      return
    }
    res.setHeader("WWW-Authenticate", "Bearer")
    res.status(401).json({ error: "Operator token required" })
  }
}

/**
 * S-03: per-client-IP request limiter for /api. The token check alone
 * only throttles IDENTIFIED abuse; an anonymous client can otherwise
 * retry /api endlessly (each miss costs a SHA-256 + response, and a
 * valid leaked token would have an unlimited runway). Sliding window
 * per address, bounded map (AGENTS.md section 36), loopback exempt —
 * the machine running the server is trusted, exactly like the WS
 * handshake limiter.
 */
export type ApiRateLimitOptions = {
  /** Requests allowed per window per client address. 0 disables the limiter. Defaults to 60. */
  readonly maxRequestsPerWindow?: number
  /** Sliding window length in ms. Defaults to 60 000. */
  readonly windowMs?: number
  /** Hard cap on tracked addresses; the oldest entry is evicted past it. Defaults to 4096. */
  readonly maxTrackedAddresses?: number
}

export const DEFAULT_API_RATE_LIMIT: Required<ApiRateLimitOptions> = {
  maxRequestsPerWindow: 60,
  windowMs: 60_000,
  maxTrackedAddresses: 4096,
}

export function createApiRateLimiter(options: ApiRateLimitOptions = {}): RequestHandler {
  const max = options.maxRequestsPerWindow ?? DEFAULT_API_RATE_LIMIT.maxRequestsPerWindow
  const windowMs = options.windowMs ?? DEFAULT_API_RATE_LIMIT.windowMs
  const maxTracked = options.maxTrackedAddresses ?? DEFAULT_API_RATE_LIMIT.maxTrackedAddresses
  const buckets = new Map<string, number[]>()

  return (req: Request, res: Response, next: NextFunction): void => {
    if (max <= 0) {
      next()
      return
    }
    const address = req.socket?.remoteAddress
    if (isLoopbackAddress(address)) {
      next()
      return
    }

    const key = normalizeRemoteAddress(address)
    const now = Date.now()

    // Bound the memory before touching the bucket: expired addresses go,
    // then the hard cap evicts the oldest (insertion order).
    for (const [ip, timestamps] of buckets) {
      const last = timestamps[timestamps.length - 1] ?? 0
      if (last < now - windowMs) buckets.delete(ip)
    }
    while (buckets.size >= maxTracked && !buckets.has(key)) {
      const oldest = buckets.keys().next().value
      if (oldest === undefined) break
      buckets.delete(oldest)
    }

    const timestamps = (buckets.get(key) ?? []).filter((t) => now - t < windowMs)
    if (timestamps.length >= max) {
      const windowEndsAt = (timestamps[0] ?? now) + windowMs
      res.setHeader("Retry-After", String(Math.max(1, Math.ceil((windowEndsAt - now) / 1000))))
      res.status(429).json({ error: "Too many requests" })
      return
    }

    timestamps.push(now)
    // Refresh insertion order so the eviction cap keeps recently active addresses.
    buckets.delete(key)
    buckets.set(key, timestamps)
    next()
  }
}

/**
 * Installs rate limiting, auth and then the JSON parser for /api, in that
 * order on purpose: an anonymous flood is stopped before the token
 * check, and an unauthenticated caller is refused before the server
 * buffers and parses a large body for them.
 */
export function installApiGuard(app: Express, operatorToken: string, jsonLimit: string, rateLimit: ApiRateLimitOptions = {}): void {
  app.use("/api", createApiRateLimiter(rateLimit))
  app.use("/api", requireOperatorToken(operatorToken))
  app.use("/api", express.json({ limit: jsonLimit }))
}
