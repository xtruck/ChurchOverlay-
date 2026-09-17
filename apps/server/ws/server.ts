import { WebSocketServer, type WebSocket } from "ws"
import type { AddressInfo } from "node:net"
import type { WsMessage, WsRole } from "../../../packages/contracts"
import { validateWsMessage } from "./action-registry"

export type ServerTokens = {
  readonly operatorToken: string
  readonly viewerToken: string
}

export type ChurchOverlayWsServerOptions = {
  /** Defaults to 127.0.0.1. Passing anything else IS the explicit
   * security decision ARCHITECTURE.md section 24 requires before binding
   * externally — there is no separate, easier-to-miss flag for it. */
  readonly host?: string
  readonly port: number
  readonly tokens: ServerTokens
  readonly onCommand?: (message: WsMessage, role: WsRole) => void
  readonly onRejected?: (reason: string, role: WsRole | null) => void
}

const DEFAULT_HOST = "127.0.0.1"

/**
 * The v1 local WebSocket server (ARCHITECTURE.md sections 24-28, section
 * 49 Security Model).
 *
 * Role assignment (operator vs viewer) happens via the token presented in
 * the Sec-WebSocket-Protocol header — never a URL query parameter
 * (section 26, AGENTS.md section 18). A connection presenting neither
 * registered token is refused at the handshake itself; the "connection"
 * event never fires for it.
 *
 * Every inbound message is run through validateWsMessage() (the action
 * registry built earlier) before onCommand() is ever invoked. This class
 * does not special-case any message type itself — AGENTS.md section 17
 * forbids inline/ad-hoc message handling in the server, and section 26
 * ("No God Objects") forbids this class growing into something that also
 * knows how to handle each command; onCommand is the seam for whatever
 * does that (not yet built — that requires wiring up the rest of the
 * Application Core, audio capture, etc., which is a further step).
 */
export class ChurchOverlayWsServer {
  private readonly wss: WebSocketServer
  private readonly tokens: ServerTokens
  private readonly onCommand: ChurchOverlayWsServerOptions["onCommand"]
  private readonly onRejected: ChurchOverlayWsServerOptions["onRejected"]
  private readonly clientRoles = new WeakMap<WebSocket, WsRole>()

  /** Resolves once the server is actually listening. */
  readonly ready: Promise<void>

  constructor(options: ChurchOverlayWsServerOptions) {
    this.tokens = options.tokens
    this.onCommand = options.onCommand
    this.onRejected = options.onRejected

    this.wss = new WebSocketServer({
      host: options.host ?? DEFAULT_HOST,
      port: options.port,
      handleProtocols: (protocols) => this.resolveProtocol(protocols),
    })

    this.ready = new Promise((resolve, reject) => {
      this.wss.once("listening", () => resolve())
      this.wss.once("error", reject)
    })

    this.wss.on("connection", (socket) => this.handleConnection(socket))
  }

  /** The actual bound port — useful when constructed with port: 0. */
  get port(): number {
    const address = this.wss.address()
    if (address === null || typeof address === "string") {
      throw new Error("ChurchOverlayWsServer is not listening on a network port")
    }
    return (address as AddressInfo).port
  }

  /** Sends an event to every currently-connected client (operator and viewer alike). */
  broadcast(message: WsMessage): void {
    const payload = JSON.stringify(message)
    for (const client of this.wss.clients) {
      if (client.readyState === client.OPEN) {
        client.send(payload)
      }
    }
  }

  close(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.wss.close((err) => (err ? reject(err) : resolve()))
    })
  }

  private resolveProtocol(protocols: Set<string>): string | false {
    if (protocols.has(this.tokens.operatorToken)) return this.tokens.operatorToken
    if (protocols.has(this.tokens.viewerToken)) return this.tokens.viewerToken
    return false
  }

  private handleConnection(socket: WebSocket): void {
    const role: WsRole = socket.protocol === this.tokens.operatorToken ? "operator" : "viewer"
    this.clientRoles.set(socket, role)

    socket.on("message", (data) => this.handleMessage(socket, role, data))
    socket.on("close", () => this.clientRoles.delete(socket))
  }

  private handleMessage(_socket: WebSocket, role: WsRole, data: unknown): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(String(data))
    } catch {
      this.onRejected?.("message is not valid JSON", role)
      return
    }

    const result = validateWsMessage(parsed, role)
    if (!result.ok) {
      this.onRejected?.(result.reason, role)
      return
    }

    this.onCommand?.(result.message, role)
  }
}
