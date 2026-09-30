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
