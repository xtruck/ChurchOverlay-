import { WebSocketServer, type WebSocket } from "ws"
import type { Server as HttpServer } from "node:http"
import type { AddressInfo } from "node:net"
import type { AudioFrame, WsMessage, WsRole } from "../../../packages/contracts"
import { decodeAudioFrame } from "../../../packages/shared/audio-frame-codec"
import { validateWsMessage } from "./action-registry"

export type ServerTokens = {
  readonly operatorToken: string
  readonly viewerToken: string
}

export type ChurchOverlayWsServerOptions = {
  /** Defaults to 127.0.0.1. Passing anything else IS the explicit
   * security decision ARCHITECTURE.md section 24 requires before binding
   * externally — there is no separate, easier-to-miss flag for it.
   * Ignored when `server` is provided — the external server's own
   * host/port binding is what's in effect (ARCHITECTURE.md section 80). */
  readonly host?: string
  readonly port: number
  /**
   * ARCHITECTURE.md section 80 (Web Server Mode): when provided, the
   * WebSocket server attaches to this EXISTING http.Server (e.g. an
   * Express app's listener) instead of opening its own independent
   * TCP listener on `host`/`port`. This lets one process serve REST +
   * static files + WebSocket upgrades on a single port. `port` is
   * still required on the type (the desktop app's standalone mode
   * always needs it) but is not used to bind a new listener in this
   * mode — `port` getter below reads the external server's own bound
   * address instead.
   */
  readonly server?: HttpServer
  readonly tokens: ServerTokens
  readonly onCommand?: (message: WsMessage, role: WsRole) => void
  /** Binary WS frames (audio) — see packages/shared/audio-frame-codec.ts
   * for why audio can't be a JSON WsMessage. Only ever fired for the
   * operator connection; a viewer sending binary data is rejected the
   * same as any other message a viewer isn't allowed to send. */
  readonly onAudioFrame?: (frame: AudioFrame) => void
  readonly onRejected?: (reason: string, role: WsRole | null) => void
  /**
   * Fired when a viewer connection opens, handing back a `send` scoped to
   * that ONE connection — never a way to reach any other client. This
   * exists for exactly one purpose (ARCHITECTURE.md section 60.4's
   * reconnect/late-join sync): letting the caller push a `media:show`
   * resync event to a newly-connected viewer without giving viewers any
   * new way to ask for one (that would violate invariant 8 — the overlay
   * cannot issue application commands). Never fired for an operator
   * connection.
   */
  readonly onViewerConnected?: (send: (message: WsMessage) => void) => void
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
  private readonly onAudioFrame: ChurchOverlayWsServerOptions["onAudioFrame"]
  private readonly onRejected: ChurchOverlayWsServerOptions["onRejected"]
  private readonly onViewerConnected: ChurchOverlayWsServerOptions["onViewerConnected"]
  private readonly clientRoles = new WeakMap<WebSocket, WsRole>()

  /** Resolves once the server is actually listening. */
  readonly ready: Promise<void>

  constructor(options: ChurchOverlayWsServerOptions) {
    this.tokens = options.tokens
    this.onCommand = options.onCommand
    this.onAudioFrame = options.onAudioFrame
    this.onRejected = options.onRejected
    this.onViewerConnected = options.onViewerConnected

    this.wss = options.server
      ? new WebSocketServer({
          server: options.server,
          handleProtocols: (protocols) => this.resolveProtocol(protocols),
        })
      : new WebSocketServer({
          host: options.host ?? DEFAULT_HOST,
          port: options.port,
          handleProtocols: (protocols) => this.resolveProtocol(protocols),
        })

    this.ready =
      // An externally-provided server that is ALREADY listening (the
      // normal case — apps/web/index.ts calls httpServer.listen() itself
      // before constructing this class) has already fired its own
      // 'listening' event; ws only forwards that event going forward; it
      // never fires again. Waiting for it here would hang forever. See
      // ARCHITECTURE.md section 80.
      options.server?.listening
        ? Promise.resolve()
        : new Promise((resolve, reject) => {
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

    socket.on("message", (data, isBinary) => this.handleMessage(role, data, isBinary))
    socket.on("close", () => this.clientRoles.delete(socket))

    if (role === "viewer") {
      this.onViewerConnected?.((message) => {
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message))
      })
    }
  }

  private handleMessage(role: WsRole, data: unknown, isBinary: boolean): void {
    if (isBinary) {
      this.handleBinaryMessage(role, data)
      return
    }

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

  private handleBinaryMessage(role: WsRole, data: unknown): void {
    // Audio is never a JSON command, but the same role boundary applies:
    // only the operator's own microphone capture may ever send it
    // (ARCHITECTURE.md section 25 — a viewer cannot issue application
    // input of any kind, audio included).
    if (role !== "operator") {
      this.onRejected?.("only the operator connection may send audio frames", role)
      return
    }

    let frame: AudioFrame
    try {
      frame = decodeAudioFrame(toUint8Array(data))
    } catch (err) {
      this.onRejected?.(
        `malformed audio frame: ${err instanceof Error ? err.message : String(err)}`,
        role
      )
      return
    }

    this.onAudioFrame?.(frame)
  }
}

function toUint8Array(data: unknown): Uint8Array {
  if (data instanceof Buffer) return new Uint8Array(data.buffer, data.byteOffset, data.length)
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  if (Array.isArray(data)) {
    // ws can deliver a fragmented binary message as Buffer[] when
    // fragmentation isn't handled internally; concatenate defensively.
    return new Uint8Array(Buffer.concat(data as Buffer[]))
  }
  throw new Error(`unexpected binary message shape: ${Object.prototype.toString.call(data)}`)
}
