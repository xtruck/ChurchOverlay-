import { WebSocketServer, type WebSocket } from "ws"
import type { Server as HttpServer } from "node:http"
import type { AddressInfo } from "node:net"
import type { AudioFrame, WsMessage, WsRole } from "../../../packages/contracts"
import { decodeAudioFrame } from "../../../packages/shared/audio-frame-codec"
import { validateWsMessage } from "./action-registry"
import { createHash, randomBytes, timingSafeEqual } from "node:crypto"

/** Constant-time token comparison (hashing first makes the lengths equal), as the HTTP API already does. */
function tokenEquals(offered: string, expected: string): boolean {
  const a = createHash("sha256").update(offered).digest()
  const b = createHash("sha256").update(expected).digest()
  return timingSafeEqual(a, b)
}

/** Per-connection round-trip latency state. Internal to the server: the
 * timestamp of the last latency ping (null when none is in flight) stays
 * inside this process and is never exposed through a snapshot. */
type ClientLatencyState = {
  /** Latest round-trip duration in milliseconds, null while the client has not answered a ping yet. */
  lastMs: number | null
  /** Sliding-window samples of round-trip duration, oldest first. */
  samples: number[]
  /** Number of samples that caused the window to drop the oldest when full. */
  drops: number
  /** Sliding window capacity for this client's latency samples. */
  capacity: number
  /** Send time of the in-flight latency ping, null when none is in flight. */
  sentAt: number | null
}

/**
 * Plain-data latency snapshot for ONE connected client, returned by
 * ChurchOverlayWsServer#getClientLatency. Contains no socket references, so
 * it is safe to hand across the Electron IPC boundary to the dashboard.
 */
export type WsClientLatencySnapshot = {
  /** The connection's negotiated role, for labeling the dashboard panel. */
  readonly role: WsRole
  /** Latest round-trip duration in milliseconds, null while unanswered. */
  readonly lastMs: number | null
  /** Sliding-window samples of round-trip duration, oldest first. */
  readonly samples: readonly number[]
  /** Number of samples that caused the window to drop the oldest when full. */
  readonly drops: number
  /** Sliding window capacity for this client's latency samples. */
  readonly capacity: number
}

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
  /**
   * How often to ping every connected client and drop the ones that did not
   * answer the previous ping. Defaults to 30 s. `0` disables the heartbeat.
   * Without it a client that vanished without a TCP close (a phone that went
   * to sleep, a pulled network cable, a crashed OBS) stays "connected" for
   * minutes to hours and keeps receiving — and buffering — every broadcast.
   * Browsers and `ws` clients answer pings automatically, so no client-side
   * change is needed.
   */
  readonly heartbeatIntervalMs?: number
  /**
   * Upper bound on bytes queued for ONE client before it is dropped instead
   * of buffered further (AGENTS.md section 36: no unbounded queues). Defaults
   * to 4 MiB — far above anything a healthy client accumulates between
   * events, since broadcast messages are a few hundred bytes. A dropped
   * client simply reconnects and is re-synced the normal way.
   */
  readonly maxBufferedBytes?: number

  /**
   * Most simultaneous connections accepted; further ones are refused and
   * reported (AGENTS.md section 36). Defaults to 64: one operator, the
   * overlay, NDI, stage, live and a handful of phones is well under that.
   */
  readonly maxConnections?: number

  /**
   * Most JSON commands one connection may send per second before the
   * excess is dropped and reported. Binary audio frames are not counted.
   * Defaults to 100. `0` disables the limit.
   */
  readonly maxCommandsPerSecond?: number

  /**
   * How many round-trip samples to keep per connected client for latency history. Defaults to 60 (one second of samples at a 10 Hz poll). Bounded by AGENTS.md section 36.
   */
  readonly wsLatencyCapacity?: number
  /** How often to sample each client's round-trip latency (a ping is sent and the pong arrival minus ping send time is measured). Defaults to 10 Hz. `0` disables client-side latency sampling (the server-side heartbeat still runs, but per-client measurements stop). */
  readonly wsLatencySampleIntervalMs?: number
}

const DEFAULT_HOST = "127.0.0.1"
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000
const DEFAULT_MAX_BUFFERED_BYTES = 4 * 1024 * 1024
const DEFAULT_MAX_CONNECTIONS = 64
const DEFAULT_MAX_COMMANDS_PER_SECOND = 100
const DEFAULT_WS_LATENCY_SAMPLE_INTERVAL_MS = 100
const DEFAULT_WS_LATENCY_CAPACITY = 60

/**
 * Random payload attached to every latency ping. `ws` clients echo a ping's
 * payload back verbatim in their pong, which is how the pong handler tells
 * a latency pong apart from the heartbeat's payload-less ping (and from any
 * unsolicited pong a rogue client might send).
 */
const PING_PONG_TOKEN = randomBytes(8)

/**
 * Hard cap on a single inbound WebSocket message. `ws` defaults to 100 MiB,
 * which any token holder — including the read-only viewer role — could make
 * the server buffer and JSON-parse. The largest legitimate message is an
 * audio frame (16 kHz PCM16 = 32 KB/s), so 1 MiB is ~30 s of audio in one
 * frame; ws closes an oversized connection with code 1009 before buffering it.
 */
const MAX_MESSAGE_BYTES = 1024 * 1024

/**
 * The v1 local WebSocket server (ARCHITECTURE.md sections 24-28, section
 * 49 Security Model).
 *
 * Role assignment (operator vs viewer) happens via the token presented in
 * the Sec-WebSocket-Protocol header — never a URL query parameter
 * (section 26, AGENTS.md section 18). A connection presenting neither
 * registered token never becomes a usable client: handleProtocols()
 * rejects a bogus token during negotiation, and handleConnection()
 * re-checks the negotiated protocol so a connection that negotiated NO
 * protocol at all (`ws` only invokes handleProtocols when at least one
 * protocol is offered, and completes the handshake without one when the
 * hook returns false) is terminated before it is ever assigned a role or
 * can receive a broadcast. See SECURITY.md item 13.
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
  /** Clients that have shown a sign of life (pong or any message) since the last heartbeat sweep. */
  private readonly aliveClients = new WeakSet<WebSocket>()
  private readonly maxBufferedBytes: number
  private readonly maxConnections: number
  private readonly maxCommandsPerSecond: number
  /** Per-connection one-second command window. */
  private readonly commandWindows = new WeakMap<WebSocket, { start: number; count: number }>()
  /**
   * Per-connection round-trip latency history: the time between a latency
   * ping we sent and the pong that echoed its payload back. A Map (not a
   * WeakMap) because the public snapshot must iterate it; entries are
   * deleted in the socket's close handler, so it can never outlive its
   * connection or grow past maxConnections (AGENTS.md section 36).
   */
  private readonly clientLatency = new Map<WebSocket, ClientLatencyState>()
  /** Sliding-window capacity for each client's latency samples. */
  private readonly clientLatencyCapacity: number
  /** The interval used to sample per-client round-trip latency. `0` = paused. */
  private readonly wsLatencySampleIntervalMs: number
  /** Repeating timer sending latency pings; cleared in close(). */
  private wsLatencyTimer: ReturnType<typeof setInterval> | undefined
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined

  /** Resolves once the server is actually listening. */
  readonly ready: Promise<void>

  constructor(options: ChurchOverlayWsServerOptions) {
    this.tokens = options.tokens
    this.onCommand = options.onCommand
    this.onAudioFrame = options.onAudioFrame
    this.onRejected = options.onRejected
    this.onViewerConnected = options.onViewerConnected
    this.maxBufferedBytes = options.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES
    this.maxConnections = options.maxConnections ?? DEFAULT_MAX_CONNECTIONS
    this.maxCommandsPerSecond = options.maxCommandsPerSecond ?? DEFAULT_MAX_COMMANDS_PER_SECOND
    this.clientLatencyCapacity = options.wsLatencyCapacity ?? DEFAULT_WS_LATENCY_CAPACITY
    this.wsLatencySampleIntervalMs = options.wsLatencySampleIntervalMs ?? DEFAULT_WS_LATENCY_SAMPLE_INTERVAL_MS

    this.wss = options.server
      ? new WebSocketServer({
          server: options.server,
          maxPayload: MAX_MESSAGE_BYTES,
          handleProtocols: (protocols) => this.resolveProtocol(protocols),
        })
      : new WebSocketServer({
          host: options.host ?? DEFAULT_HOST,
          port: options.port,
          maxPayload: MAX_MESSAGE_BYTES,
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

    const heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS
    if (heartbeatIntervalMs > 0) {
      this.heartbeatTimer = setInterval(() => this.sweepDeadConnections(), heartbeatIntervalMs)
      // The heartbeat must never be the thing keeping the process alive.
      this.heartbeatTimer.unref()
    }

    const sampleIntervalMs = options.wsLatencySampleIntervalMs ?? DEFAULT_WS_LATENCY_SAMPLE_INTERVAL_MS
    if (sampleIntervalMs > 0) {
      this.wsLatencyTimer = setInterval(() => this.sampleClientLatency(), sampleIntervalMs)
      this.wsLatencyTimer.unref()
    }
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
    this.broadcastWhere(message, () => true)
  }

  /**
   * Sends an event to operator-role clients only (ARCHITECTURE.md section 125):
   * content meant for the person running the service, never for the overlay,
   * stage or live pages, which hold the less privileged viewer token.
   */
  broadcastToOperators(message: WsMessage): void {
    this.broadcastWhere(message, (role) => role === "operator")
  }

  private broadcastWhere(message: WsMessage, wants: (role: WsRole | undefined) => boolean): void {
    const payload = JSON.stringify(message)
    for (const client of this.wss.clients) {
      if (client.readyState !== client.OPEN) continue
      if (!wants(this.clientRoles.get(client))) continue

      // A client that stopped reading (stalled network, suspended tab) makes
      // ws queue every further send in memory. Past the bound, drop the
      // connection — observably, via onRejected — rather than grow forever.
      if (client.bufferedAmount > this.maxBufferedBytes) {
        this.onRejected?.(
          `slow consumer dropped: ${client.bufferedAmount} bytes queued and unsent`,
          this.clientRoles.get(client) ?? null
        )
        client.terminate()
        continue
      }

      try {
        client.send(payload)
      } catch (err) {
        this.onRejected?.(
          `broadcast send failed: ${err instanceof Error ? err.message : String(err)}`,
          this.clientRoles.get(client) ?? null
        )
        client.terminate()
      }
    }
  }

  close(): Promise<void> {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = undefined
    }
    if (this.wsLatencyTimer) {
      clearInterval(this.wsLatencyTimer)
      this.wsLatencyTimer = undefined
    }
    return new Promise((resolve, reject) => {
      // wss.close() only stops accepting NEW connections and then waits for
      // every EXISTING client socket to close on its own. Any client that
      // never closes keeps this promise pending forever (and keeps the Node
      // event loop alive — observed as the test suite hanging after all
      // tests pass). A server shutdown is authoritative: terminate all
      // connected clients first, then close the listener.
      for (const client of this.wss.clients) {
        client.terminate()
      }
      this.wss.close((err) => (err ? reject(err) : resolve()))
    })
  }

  private resolveProtocol(protocols: Set<string>): string | false {
    for (const offered of protocols) {
      if (tokenEquals(offered, this.tokens.operatorToken)) return this.tokens.operatorToken
    }
    for (const offered of protocols) {
      if (tokenEquals(offered, this.tokens.viewerToken)) return this.tokens.viewerToken
    }
    return false
  }

  /**
   * One heartbeat tick: a client that showed no sign of life since the
   * previous tick is terminated (reported through onRejected, never silent);
   * every other client is marked "not yet heard from" and pinged, and stays
   * alive by answering with a pong or sending any message. Only fully
   * admitted connections (those with a role) are considered — a socket
   * refused for a bad token is already being torn down.
   */
  private sweepDeadConnections(): void {
    for (const client of this.wss.clients) {
      const role = this.clientRoles.get(client)
      if (role === undefined) continue

      if (!this.aliveClients.has(client)) {
        this.onRejected?.("connection timed out: no pong since the previous heartbeat", role)
        client.terminate()
        continue
      }

      this.aliveClients.delete(client)
      if (client.readyState === client.OPEN) client.ping()
    }
  }

  /**
   * Plain-data snapshot of every admitted client's round-trip latency
   * window, oldest sample first (most recent last). A client that has not
   * answered a latency ping yet reports lastMs = null. No socket
   * references leave this class, so the result is safe to cross the
   * Electron IPC boundary to the dashboard (AGENTS.md section 28); the
   * entries are dropped when their connection closes, so the array can
   * never grow past maxConnections (AGENTS.md section 36).
   */
  getClientLatency(): WsClientLatencySnapshot[] {
    const snapshots: WsClientLatencySnapshot[] = []
    for (const [socket, latency] of this.clientLatency) {
      const role = this.clientRoles.get(socket)
      if (role === undefined) continue
      snapshots.push({
        role,
        lastMs: latency.lastMs,
        samples: [...latency.samples],
        drops: latency.drops,
        capacity: latency.capacity,
      })
    }
    return snapshots
  }

  private sampleClientLatency(): void {
    // Ping every open, admitted client with a token payload. `ws` echoes a
    // ping's payload back verbatim in the pong, which is how the pong
    // handler distinguishes this measurement ping from the heartbeat's
    // payload-less ping. Only the send time is recorded here; the
    // round-trip time is computed when the matching pong arrives.
    const now = Date.now()
    for (const client of this.wss.clients) {
      const latency = this.clientLatency.get(client)
      if (latency === undefined) continue
      if (client.readyState !== client.OPEN) continue
      latency.sentAt = now
      client.ping(PING_PONG_TOKEN)
    }
  }

  /**
   * Record one ping/pong exchange. Any pong counts as a sign of life for
   * the heartbeat (exactly as before latency tracking existed); only a
   * pong echoing our token is also recorded as a measurement, using the
   * per-client send time, so a late or unsolicited pong can never be
   * recorded as a fresh round trip.
   */
  private recordClientLatency(socket: WebSocket, pong: Buffer): void {
    this.aliveClients.add(socket)
    const latency = this.clientLatency.get(socket)
    if (latency === undefined) return
    if (latency.sentAt === null) return
    if (pong.length !== PING_PONG_TOKEN.length) return
    for (let i = 0; i < pong.length; i++) {
      if (pong[i] !== PING_PONG_TOKEN[i]) return
    }
    const rtt = Date.now() - latency.sentAt
    latency.sentAt = null
    // Cap the recorded latency so a one-off stall doesn't dominate the
    // window the operator sees; 2 s is a long time for a loopback or LAN
    // client.
    latency.lastMs = rtt > 2000 ? 2000 : rtt
    latency.samples.push(latency.lastMs)
    while (latency.samples.length > latency.capacity) {
      latency.samples.shift()
      latency.drops++
    }
  }

  private handleConnection(socket: WebSocket): void {
    // `ws` emits protocol violations (oversized or malformed frames, invalid
    // UTF-8) as an 'error' event on the socket. With no listener, Node throws
    // it as an uncaughtException and the whole server process dies — so any
    // client, even the read-only viewer, could crash the app mid-service.
    // ws closes the connection itself after emitting; this only reports it.
    socket.on("error", (error) => this.onRejected?.(`socket error: ${error.message}`, this.clientRoles.get(socket) ?? null))

    // Server-side token check, independent of handleProtocols above: `ws`
    // only calls handleProtocols when the client OFFERS at least one
    // protocol, and it still completes the 101 handshake WITHOUT selecting
    // a protocol when that hook returns false. Such a socket arrives here
    // with protocol === "" and must never be silently classified as a
    // viewer (AGENTS.md section 18, SECURITY.md item 13).
    const isOperator = tokenEquals(socket.protocol, this.tokens.operatorToken)
    if (!isOperator && !tokenEquals(socket.protocol, this.tokens.viewerToken)) {
      this.onRejected?.("connection presented no registered token", null)
      socket.terminate()
      return
    }

    if (this.wss.clients.size > this.maxConnections) {
      this.onRejected?.(`connection refused: more than ${this.maxConnections} clients connected`, null)
      socket.terminate()
      return
    }

    const role: WsRole = isOperator ? "operator" : "viewer"
    this.clientRoles.set(socket, role)
    this.aliveClients.add(socket)

    // Initialize round-trip latency tracking for this connection.
    const latency: ClientLatencyState = {
      lastMs: null,
      samples: [],
      drops: 0,
      capacity: this.clientLatencyCapacity,
      sentAt: null,
    }
    this.clientLatency.set(socket, latency)

    socket.on("pong", (pong: Buffer) => this.recordClientLatency(socket, pong))
    socket.on("message", (data, isBinary) => {
      // Any inbound traffic proves the connection is alive, so a busy
      // operator streaming audio can never be dropped for a late pong.
      this.aliveClients.add(socket)
      this.handleMessage(socket, role, data, isBinary)
    })
    socket.on("close", () => {
      this.clientRoles.delete(socket)
      // Bounded per-connection state: a finished connection must not keep
      // its latency window reachable through the snapshot Map
      // (AGENTS.md section 36).
      this.clientLatency.delete(socket)
    })

    if (role === "viewer") {
      this.guarded("onViewerConnected", role, () =>
        this.onViewerConnected?.((message) => {
          if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message))
        })
      )
    }
  }

  /**
   * A handler that throws inside a ws event listener becomes an uncaught
   * exception and takes the whole process down mid-service. Every call out
   * to an injected callback goes through here: the failure is reported and
   * the connection stays up.
   */
  private guarded(what: string, role: WsRole | null, run: () => void): void {
    try {
      run()
    } catch (err) {
      this.onRejected?.(`${what} threw: ${err instanceof Error ? err.message : String(err)}`, role)
    }
  }

  private commandAllowed(socket: WebSocket): boolean {
    if (this.maxCommandsPerSecond <= 0) return true
    const now = Date.now()
    const window = this.commandWindows.get(socket)
    if (!window || now - window.start >= 1000) {
      this.commandWindows.set(socket, { start: now, count: 1 })
      return true
    }
    window.count += 1
    return window.count <= this.maxCommandsPerSecond
  }

  private handleMessage(socket: WebSocket, role: WsRole, data: unknown, isBinary: boolean): void {
    if (isBinary) {
      this.handleBinaryMessage(role, data)
      return
    }
    if (!this.commandAllowed(socket)) {
      // Reported once per window, not once per dropped message, so a flood
      // cannot also flood the log.
      if (this.commandWindows.get(socket)?.count === this.maxCommandsPerSecond + 1) {
        this.onRejected?.(`command rate limit exceeded (${this.maxCommandsPerSecond}/s); excess dropped`, role)
      }
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

    this.guarded("onCommand", role, () => this.onCommand?.(result.message, role))
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

    this.guarded("onAudioFrame", role, () => this.onAudioFrame?.(frame))
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
