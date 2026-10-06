import { createHash, timingSafeEqual } from "node:crypto"
import express, { type Express, type NextFunction, type Request, type Response } from "express"

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
 * Installs auth and then the JSON parser for /api, in that order on purpose:
 * an unauthenticated caller must be refused before the server buffers and
 * parses a large body for them.
 */
export function installApiGuard(app: Express, operatorToken: string, jsonLimit: string): void {
  app.use("/api", requireOperatorToken(operatorToken))
  app.use("/api", express.json({ limit: jsonLimit }))
}
