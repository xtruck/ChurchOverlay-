import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { readFile } from "node:fs/promises"
import { extname, join, normalize, sep } from "node:path"
import type { AddressInfo } from "node:net"

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
}

export type StaticServerOptions = {
  /** Defaults to 127.0.0.1, same reasoning as ChurchOverlayWsServer (ARCHITECTURE.md section 24). */
  readonly host?: string
  readonly port: number
  readonly rootDir: string
}

const DEFAULT_HOST = "127.0.0.1"

/**
 * Serves the overlay and operator dashboard pages over plain HTTP — kept
 * entirely separate from ChurchOverlayWsServer (AGENTS.md section 26: one
 * class, one responsibility) and running on its own port rather than
 * sharing the WS server's, to avoid coupling an already-tested class to a
 * static-file concern it was never designed for.
 *
 * This exists because OBS's Browser Source (and any plain browser loading
 * the overlay for preview) needs an actual URL to load — there is no
 * IPC/contextBridge available there the way there is inside the Electron
 * dashboard renderer.
 *
 * Deliberately minimal and defensive: serves only a small fixed set of
 * content types, rejects any request path that would resolve outside
 * `rootDir` (directory traversal via "../"), and returns 404 for anything
 * else rather than leaking arbitrary filesystem contents.
 */
export class StaticServer {
  private readonly server: Server
  readonly ready: Promise<void>

  constructor(options: StaticServerOptions) {
    const rootDir = normalize(options.rootDir)
    this.server = createServer((req, res) => {
      this.handleRequest(req, res, rootDir).catch(() => {
        if (!res.headersSent) res.writeHead(500)
        res.end("Internal Server Error")
      })
    })
    this.server.listen(options.port, options.host ?? DEFAULT_HOST)

    this.ready = new Promise((resolve, reject) => {
      this.server.once("listening", () => resolve())
      this.server.once("error", reject)
    })
  }

  get port(): number {
    const address = this.server.address()
    if (address === null || typeof address === "string") {
      throw new Error("StaticServer is not listening on a network port")
    }
    return (address as AddressInfo).port
  }

  close(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.close((err) => (err ? reject(err) : resolve()))
    })
  }

  private async handleRequest(
    req: IncomingMessage,
    res: ServerResponse,
    rootDir: string
  ): Promise<void> {
    const requestedPath = decodeURIComponent((req.url ?? "/").split("?")[0] ?? "/")
    const relativePath = requestedPath === "/" ? "/index.html" : requestedPath
    const resolvedPath = normalize(join(rootDir, relativePath))

    if (resolvedPath !== rootDir && !resolvedPath.startsWith(rootDir + sep)) {
      res.writeHead(403, { "Content-Type": "text/plain" }).end("Forbidden")
      return
    }

    let content: Buffer
    try {
      content = await readFile(resolvedPath)
    } catch {
      res.writeHead(404, { "Content-Type": "text/plain" }).end("Not Found")
      return
    }

    const contentType = CONTENT_TYPES[extname(resolvedPath)] ?? "application/octet-stream"
    res.writeHead(200, { "Content-Type": contentType })
    res.end(content)
  }
}
