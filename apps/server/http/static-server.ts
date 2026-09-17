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

const MEDIA_CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
}

const MEDIA_PATH_PATTERN = /^\/media\/([^/]+)$/

/** Narrow, structural — StaticServer depends on this shape, not the concrete MediaLibrary class (AGENTS.md section 26: one class, one responsibility). */
export type MediaFileResolver = {
  resolveFilePath(id: string): string | null
}

export type StaticServerOptions = {
  /** Defaults to 127.0.0.1, same reasoning as ChurchOverlayWsServer (ARCHITECTURE.md section 24). */
  readonly host?: string
  readonly port: number
  readonly rootDir: string
  /** Optional — when provided, serves imported media under /media/<id> (ARCHITECTURE.md section 60.4). */
  readonly mediaResolver?: MediaFileResolver
}

const DEFAULT_HOST = "127.0.0.1"

/**
 * Serves the overlay page over plain HTTP — kept entirely separate from
 * ChurchOverlayWsServer (AGENTS.md section 26: one class, one
 * responsibility) and running on its own port rather than sharing the WS
 * server's, to avoid coupling an already-tested class to a static-file
 * concern it was never designed for.
 *
 * This exists because OBS's Browser Source (and any plain browser loading
 * the overlay for preview) needs an actual URL to load — there is no
 * IPC/contextBridge available there the way there is inside the Electron
 * dashboard renderer.
 *
 * The real operator dashboard is the Electron BrowserWindow in
 * apps/desktop/main/index.ts, loaded via loadFile() with its own
 * preload/contextBridge boundary (ARCHITECTURE.md section 7) — never
 * through this server. Whatever rootDir this is pointed at is reachable
 * by anyone on 127.0.0.1 with no Electron-level sandboxing at all, so it
 * must only ever contain the read-only, viewer-role overlay page. The
 * dev-only browser dashboard (apps/overlay/dev-preview/) can fully
 * impersonate the operator with nothing but the token in its URL — it
 * must run on its own StaticServer instance, never this one.
 *
 * Deliberately minimal and defensive: serves only a small fixed set of
 * content types, rejects any request path that would resolve outside
 * `rootDir` (directory traversal via "../"), and returns 404 for anything
 * else rather than leaking arbitrary filesystem contents.
 *
 * Optionally also serves imported media under /media/<id> (ARCHITECTURE.md
 * section 60.4) when constructed with a `mediaResolver` — a separate code
 * path from the `rootDir` serving above, since the request's `id` is never
 * joined onto a directory at all; it is resolved through MediaLibrary's
 * own lookup first, which is what actually enforces "the overlay only
 * ever loads what was really imported" (invariant 13).
 */
export class StaticServer {
  private readonly server: Server
  private readonly mediaResolver?: MediaFileResolver
  readonly ready: Promise<void>

  constructor(options: StaticServerOptions) {
    const rootDir = normalize(options.rootDir)
    this.mediaResolver = options.mediaResolver
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

    const mediaMatch = MEDIA_PATH_PATTERN.exec(requestedPath)
    if (mediaMatch) {
      await this.handleMediaRequest(res, mediaMatch[1] as string)
      return
    }

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

  /**
   * ARCHITECTURE.md section 60.4 point 4: resolves `id` through the
   * MediaLibrary-shaped resolver FIRST — the request path is never joined
   * onto a directory directly the way the rootDir branch above does, so
   * there is no path in the request that could ever reach outside the
   * media directory, because no part of the request is ever used as a
   * path (invariant 13: the overlay only ever loads what MediaLibrary
   * actually imported).
   */
  private async handleMediaRequest(res: ServerResponse, id: string): Promise<void> {
    const filePath = this.mediaResolver?.resolveFilePath(id)
    if (!filePath) {
      res.writeHead(404, { "Content-Type": "text/plain" }).end("Not Found")
      return
    }

    let content: Buffer
    try {
      content = await readFile(filePath)
    } catch {
      res.writeHead(404, { "Content-Type": "text/plain" }).end("Not Found")
      return
    }

    const contentType = MEDIA_CONTENT_TYPES[extname(filePath)] ?? "application/octet-stream"
    res.writeHead(200, { "Content-Type": contentType })
    res.end(content)
  }
}
