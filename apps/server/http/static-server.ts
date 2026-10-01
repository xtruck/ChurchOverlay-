import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { createReadStream } from "node:fs"
import { readFile, stat } from "node:fs/promises"
import { extname, join, normalize, sep } from "node:path"
import type { AddressInfo } from "node:net"
import { pipeline } from "node:stream"

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
  // Favicons and the phone home-screen icon. SVG is safe here only because
  // this table serves the app's own bundled pages; operator-imported media
  // goes through MEDIA_CONTENT_TYPES, which deliberately has no SVG (an
  // imported SVG can carry script).
  ".svg": "image/svg+xml",
  ".png": "image/png",
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
/** ARCHITECTURE.md section 110.6: the one operator-imported church logo, always a normalized PNG. */
const BRAND_LOGO_PATH = "/brand/logo"

/**
 * Sent on every response. `nosniff` stops a browser from second-guessing the
 * declared Content-Type (an imported "image" must never execute as script);
 * `no-referrer` keeps the loopback URL, which can carry a token in the
 * dev-preview case, out of any Referer header.
 */
const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
}

/** Fonts are public and change only on an app update: a day is safe and saves OBS a re-download on every scene switch. */
const FONT_CACHE_CONTROL = "public, max-age=86400"
/** Pages/scripts/styles are always revalidated (cheap: ETag -> 304), so an app update is picked up immediately. */
const REVALIDATE_CACHE_CONTROL = "no-cache"

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
  /**
   * Optional (ARCHITECTURE.md section 110.6): returns the absolute path of the
   * stored, already-validated logo PNG, or null when none is set. Called per
   * request so replacing the logo needs no server restart. No part of the
   * request is used as a path.
   */
  readonly brandLogoPath?: () => string | null
}

const DEFAULT_HOST = "127.0.0.1"

export type ByteRange = { readonly start: number; readonly end: number }

/**
 * Parses a single-range `Range: bytes=...` header against a file of `size`
 * bytes (RFC 9110 section 14).
 *
 * Returns:
 * - `null`: no usable Range header — serve the whole file with 200. This
 *   includes syntactically invalid headers and multi-range requests, which
 *   RFC 9110 explicitly lets a server ignore; browsers' media elements only
 *   ever send single ranges.
 * - `"unsatisfiable"`: a well-formed range that lies wholly outside the file
 *   — answer 416.
 * - a `ByteRange` (inclusive on both ends, `end` already clamped to the file).
 */
export function parseRangeHeader(header: string | undefined, size: number): ByteRange | "unsatisfiable" | null {
  if (header === undefined) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match) return null

  const [, startText = "", endText = ""] = match
  if (startText === "" && endText === "") return null

  if (startText === "") {
    // Suffix range: the last N bytes.
    const suffixLength = Number(endText)
    if (!Number.isSafeInteger(suffixLength) || suffixLength === 0 || size === 0) return "unsatisfiable"
    return { start: Math.max(0, size - suffixLength), end: size - 1 }
  }

  const start = Number(startText)
  if (!Number.isSafeInteger(start) || start >= size) return "unsatisfiable"

  if (endText === "") return { start, end: size - 1 }

  const end = Number(endText)
  if (!Number.isSafeInteger(end) || end < start) return null
  return { start, end: Math.min(end, size - 1) }
}

/** Returns null for anything that is not a cleanly decodable path (bad %-escape, NUL byte). */
function decodeRequestPath(rawUrl: string | undefined): string | null {
  const pathPart = (rawUrl ?? "/").split("?")[0] ?? "/"
  try {
    const decoded = decodeURIComponent(pathPart)
    return decoded.includes("\0") ? null : decoded
  } catch {
    // URIError from a malformed escape such as "%E0%A4%A": a client error
    // (400), not a server fault.
    return null
  }
}

function plain(res: ServerResponse, status: number, body: string, extraHeaders: Record<string, string> = {}): void {
  res.writeHead(status, { "Content-Type": "text/plain", ...SECURITY_HEADERS, ...extraHeaders }).end(body)
}

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
 * Deliberately minimal and defensive: read-only (GET/HEAD only), serves
 * only a small fixed set of content types, rejects any request path that
 * would resolve outside `rootDir` (directory traversal via "../"), and
 * returns 404 for anything else rather than leaking arbitrary filesystem
 * contents.
 *
 * Optionally also serves imported media under /media/<id> (ARCHITECTURE.md
 * section 60.4) when constructed with a `mediaResolver` — a separate code
 * path from the `rootDir` serving above, since the request's `id` is never
 * joined onto a directory at all; it is resolved through MediaLibrary's
 * own lookup first, which is what actually enforces "the overlay only
 * ever loads what was really imported" (invariant 13). Media is streamed
 * from disk with HTTP Range support rather than read into memory: imported
 * video can be hundreds of megabytes, and a browser can only seek inside
 * a video/audio element when the server honours Range.
 */
export class StaticServer {
  private readonly server: Server
  private readonly mediaResolver?: MediaFileResolver
  private readonly brandLogoPath?: () => string | null
  readonly ready: Promise<void>

  constructor(options: StaticServerOptions) {
    const rootDir = normalize(options.rootDir)
    this.mediaResolver = options.mediaResolver
    this.brandLogoPath = options.brandLogoPath
    this.server = createServer((req, res) => {
      this.handleRequest(req, res, rootDir).catch(() => {
        if (!res.headersSent) res.writeHead(500, SECURITY_HEADERS)
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
    if (req.method !== "GET" && req.method !== "HEAD") {
      plain(res, 405, "Method Not Allowed", { Allow: "GET, HEAD" })
      return
    }

    const requestedPath = decodeRequestPath(req.url)
    if (requestedPath === null) {
      plain(res, 400, "Bad Request")
      return
    }

    if (requestedPath === BRAND_LOGO_PATH) {
      await this.handleBrandLogoRequest(req, res)
      return
    }

    const mediaMatch = MEDIA_PATH_PATTERN.exec(requestedPath)
    if (mediaMatch) {
      await this.handleMediaRequest(req, res, mediaMatch[1] as string)
      return
    }

    const relativePath = requestedPath === "/" ? "/index.html" : requestedPath
    const resolvedPath = normalize(join(rootDir, relativePath))

    if (resolvedPath !== rootDir && !resolvedPath.startsWith(rootDir + sep)) {
      plain(res, 403, "Forbidden")
      return
    }

    let info
    try {
      info = await stat(resolvedPath)
    } catch {
      plain(res, 404, "Not Found")
      return
    }
    if (!info.isFile()) {
      plain(res, 404, "Not Found")
      return
    }

    const extension = extname(resolvedPath)
    const contentType = CONTENT_TYPES[extension] ?? "application/octet-stream"
    const etag = `W/"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`
    const headers: Record<string, string> = {
      "Content-Type": contentType,
      "Cache-Control": extension === ".woff2" ? FONT_CACHE_CONTROL : REVALIDATE_CACHE_CONTROL,
      ETag: etag,
      ...SECURITY_HEADERS,
    }
    // The dashboard embeds this overlay in a sandboxed iframe (origin
    // "null"), and browsers fetch web fonts in CORS mode: without this
    // header the preview silently fell back to system fonts. Fonts are
    // public, static assets — nothing sensitive is exposed by allowing it.
    if (extension === ".woff2") headers["Access-Control-Allow-Origin"] = "*"

    if (req.headers["if-none-match"] === etag) {
      res.writeHead(304, headers).end()
      return
    }

    let content: Buffer
    try {
      content = await readFile(resolvedPath)
    } catch {
      plain(res, 404, "Not Found")
      return
    }

    headers["Content-Length"] = String(content.length)
    res.writeHead(200, headers)
    res.end(req.method === "HEAD" ? undefined : content)
  }

  /** ARCHITECTURE.md section 110.6. Revalidates (ETag/304); the overlay adds ?v=<version> to bust its own cache. */
  private async handleBrandLogoRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const filePath = this.brandLogoPath?.() ?? null
    if (!filePath) {
      plain(res, 404, "Not Found")
      return
    }
    let info
    let content: Buffer
    try {
      info = await stat(filePath)
      content = await readFile(filePath)
    } catch {
      plain(res, 404, "Not Found")
      return
    }
    if (!info.isFile()) {
      plain(res, 404, "Not Found")
      return
    }
    const etag = `W/"${content.length.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`
    const headers: Record<string, string> = {
      "Content-Type": "image/png",
      "Cache-Control": REVALIDATE_CACHE_CONTROL,
      ETag: etag,
      ...SECURITY_HEADERS,
    }
    if (req.headers["if-none-match"] === etag) {
      res.writeHead(304, headers).end()
      return
    }
    headers["Content-Length"] = String(content.length)
    res.writeHead(200, headers)
    res.end(req.method === "HEAD" ? undefined : content)
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
  private async handleMediaRequest(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
    const filePath = this.mediaResolver?.resolveFilePath(id)
    if (!filePath) {
      plain(res, 404, "Not Found")
      return
    }

    let info
    try {
      info = await stat(filePath)
    } catch {
      plain(res, 404, "Not Found")
      return
    }
    if (!info.isFile()) {
      plain(res, 404, "Not Found")
      return
    }

    const range = parseRangeHeader(req.headers.range, info.size)
    if (range === "unsatisfiable") {
      plain(res, 416, "Range Not Satisfiable", { "Content-Range": `bytes */${info.size}` })
      return
    }

    const start = range?.start ?? 0
    const end = range?.end ?? info.size - 1
    const length = info.size === 0 ? 0 : end - start + 1
    const headers: Record<string, string> = {
      "Content-Type": MEDIA_CONTENT_TYPES[extname(filePath)] ?? "application/octet-stream",
      "Content-Length": String(length),
      "Accept-Ranges": "bytes",
      ...SECURITY_HEADERS,
    }
    if (range) headers["Content-Range"] = `bytes ${start}-${end}/${info.size}`

    res.writeHead(range ? 206 : 200, headers)
    if (req.method === "HEAD" || length === 0) {
      res.end()
      return
    }

    // pipeline() destroys both streams on failure and propagates backpressure,
    // so memory stays at one small read buffer however large the file is. A
    // client that disconnects mid-stream (routine while a viewer seeks in a
    // video) surfaces here as ERR_STREAM_PREMATURE_CLOSE and needs no handling
    // beyond the cleanup pipeline already did; headers are already sent, so
    // there is no response left to change.
    pipeline(createReadStream(filePath, { start, end }), res, () => {})
  }
}
