import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { get as httpGet, request as httpRequest } from "node:http"
import { StaticServer, parseRangeHeader, type MediaFileResolver } from "./static-server"

/** Named per AGENTS.md section 45 — a test double, not the real MediaLibrary. */
class FakeMediaFileResolver implements MediaFileResolver {
  constructor(private readonly filesById: Record<string, string>) {}
  resolveFilePath(id: string): string | null {
    return this.filesById[id] ?? null
  }
}

async function withServer(
  files: Record<string, string>,
  fn: (baseUrl: string) => Promise<void>
): Promise<void> {
  const rootDir = await mkdtemp(join(tmpdir(), "churchoverlay-static-test-"))
  try {
    for (const [relativePath, content] of Object.entries(files)) {
      const fullPath = join(rootDir, relativePath)
      await mkdir(join(fullPath, ".."), { recursive: true })
      await writeFile(fullPath, content, "utf8")
    }

    const server = new StaticServer({ port: 0, rootDir })
    await server.ready
    try {
      await fn(`http://127.0.0.1:${server.port}`)
    } finally {
      await server.close()
    }
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
}

test("StaticServer: serves index.html at the root path with the correct content type", async () => {
  await withServer({ "index.html": "<h1>ChurchOverlay</h1>" }, async (baseUrl) => {
    const response = await fetch(baseUrl + "/")
    assert.equal(response.status, 200)
    assert.equal(response.headers.get("content-type"), "text/html; charset=utf-8")
    assert.equal(await response.text(), "<h1>ChurchOverlay</h1>")
  })
})

test("StaticServer: serves a nested file with the correct content type", async () => {
  await withServer({ "scripts/app.js": "console.log('hi')" }, async (baseUrl) => {
    const response = await fetch(baseUrl + "/scripts/app.js")
    assert.equal(response.status, 200)
    assert.equal(response.headers.get("content-type"), "text/javascript; charset=utf-8")
    assert.equal(await response.text(), "console.log('hi')")
  })
})

test("StaticServer: returns 404 for a file that doesn't exist", async () => {
  await withServer({ "index.html": "hi" }, async (baseUrl) => {
    const response = await fetch(baseUrl + "/nonexistent.html")
    assert.equal(response.status, 404)
  })
})

// A standard fetch()/URL client normalizes "../" before the request is
// even sent (WHATWG URL semantics), which would make this test pass
// trivially without ever exercising the server's own guard. A raw
// http.request does not normalize the path — it sends exactly what a
// non-standard or malicious client could send — so this is the request
// shape that actually proves the server-side defense works rather than
// relying on a well-behaved client to sanitize its own input.
test("StaticServer: rejects a directory-traversal attempt instead of leaking filesystem content", async () => {
  await withServer({ "index.html": "hi" }, async (baseUrl) => {
    const { hostname, port } = new URL(baseUrl)
    const status = await new Promise<number>((resolve, reject) => {
      httpGet({ hostname, port, path: "/../../../../../../etc/passwd" }, (res) => {
        res.resume()
        res.on("end", () => resolve(res.statusCode ?? 0))
      }).on("error", reject)
    })
    assert.equal(status, 403)
  })
})

test("StaticServer: uses application/octet-stream for an unrecognized extension", async () => {
  await withServer({ "data.bin": "raw" }, async (baseUrl) => {
    const response = await fetch(baseUrl + "/data.bin")
    assert.equal(response.status, 200)
    assert.equal(response.headers.get("content-type"), "application/octet-stream")
  })
})

test("StaticServer: defaults to binding 127.0.0.1", async () => {
  await withServer({ "index.html": "hi" }, async (baseUrl) => {
    assert.ok(baseUrl.startsWith("http://127.0.0.1:"))
    const response = await fetch(baseUrl + "/")
    assert.equal(response.status, 200)
  })
})

async function withMediaServer(
  fn: (baseUrl: string, mediaFilePath: string) => Promise<void>
): Promise<void> {
  const rootDir = await mkdtemp(join(tmpdir(), "churchoverlay-static-media-test-"))
  const mediaDir = await mkdtemp(join(tmpdir(), "churchoverlay-static-media-files-"))
  try {
    await writeFile(join(rootDir, "index.html"), "hi", "utf8")
    const mediaFilePath = join(mediaDir, "01MEDIAULID.png")
    await writeFile(mediaFilePath, "fake png bytes", "utf8")

    const mediaResolver = new FakeMediaFileResolver({ "01MEDIAULID": mediaFilePath })
    const server = new StaticServer({ port: 0, rootDir, mediaResolver })
    await server.ready
    try {
      await fn(`http://127.0.0.1:${server.port}`, mediaFilePath)
    } finally {
      await server.close()
    }
  } finally {
    await rm(rootDir, { recursive: true, force: true })
    await rm(mediaDir, { recursive: true, force: true })
  }
}

test("StaticServer: serves an imported media file under /media/<id> with the correct content type", async () => {
  await withMediaServer(async (baseUrl) => {
    const response = await fetch(baseUrl + "/media/01MEDIAULID")
    assert.equal(response.status, 200)
    assert.equal(response.headers.get("content-type"), "image/png")
    assert.equal(await response.text(), "fake png bytes")
  })
})

test("StaticServer: returns 404 for an unknown media id", async () => {
  await withMediaServer(async (baseUrl) => {
    const response = await fetch(baseUrl + "/media/not-a-real-id")
    assert.equal(response.status, 404)
  })
})

test("StaticServer: /media/<id> returns 404 when no mediaResolver was configured at all", async () => {
  await withServer({ "index.html": "hi" }, async (baseUrl) => {
    const response = await fetch(baseUrl + "/media/anything")
    assert.equal(response.status, 404)
  })
})

// The /media/<id> route's own pattern only ever matches a single path
// segment with no slashes — a crafted id containing "../" falls through
// to the general rootDir branch instead (not handleMediaRequest at all),
// which is already covered by its own traversal test above and rejects
// with 403. Confirms the fallthrough is safe, not just that the media
// route's regex happens to reject it. Same raw-http-request reasoning as
// the rootDir traversal test: fetch()/URL would normalize "../" away
// before ever sending the request.
test("StaticServer: a crafted /media/ path containing '../' falls through to the rootDir guard, not a leak", async () => {
  await withMediaServer(async (baseUrl) => {
    const { hostname, port } = new URL(baseUrl)
    const status = await new Promise<number>((resolve, reject) => {
      httpGet({ hostname, port, path: "/media/..%2f..%2f..%2fetc%2fpasswd" }, (res) => {
        res.resume()
        res.on("end", () => resolve(res.statusCode ?? 0))
      }).on("error", reject)
    })
    assert.equal(status, 403)
  })
})

type RawResponse = { status: number; headers: Record<string, string | string[] | undefined>; body: string }

/** Raw http.request: sends exactly the method/path/headers given, with no fetch()-level normalization. */
function rawRequest(
  baseUrl: string,
  options: { method?: string; path: string; headers?: Record<string, string> }
): Promise<RawResponse> {
  const { hostname, port } = new URL(baseUrl)
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { hostname, port, path: options.path, method: options.method ?? "GET", headers: options.headers },
      (res) => {
        const chunks: Buffer[] = []
        res.on("data", (chunk: Buffer) => chunks.push(chunk))
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") })
        )
      }
    )
    req.on("error", reject)
    req.end()
  })
}

test("parseRangeHeader: parses the forms a browser's media element actually sends", () => {
  assert.deepEqual(parseRangeHeader("bytes=0-99", 1000), { start: 0, end: 99 })
  assert.deepEqual(parseRangeHeader("bytes=900-", 1000), { start: 900, end: 999 })
  assert.deepEqual(parseRangeHeader("bytes=-100", 1000), { start: 900, end: 999 })
  assert.deepEqual(parseRangeHeader("bytes=0-0", 1000), { start: 0, end: 0 })
})

test("parseRangeHeader: clamps an end past the file, and a suffix longer than the file, to the file", () => {
  assert.deepEqual(parseRangeHeader("bytes=0-5000", 1000), { start: 0, end: 999 })
  assert.deepEqual(parseRangeHeader("bytes=-5000", 1000), { start: 0, end: 999 })
})

test("parseRangeHeader: a well-formed range wholly outside the file is unsatisfiable", () => {
  assert.equal(parseRangeHeader("bytes=1000-1100", 1000), "unsatisfiable")
  assert.equal(parseRangeHeader("bytes=-0", 1000), "unsatisfiable")
  assert.equal(parseRangeHeader("bytes=0-", 0), "unsatisfiable")
})

test("parseRangeHeader: ignores (null = serve the whole file) what RFC 9110 lets a server ignore", () => {
  assert.equal(parseRangeHeader(undefined, 1000), null)
  assert.equal(parseRangeHeader("bytes=5-2", 1000), null)
  assert.equal(parseRangeHeader("bytes=0-1,5-9", 1000), null)
  assert.equal(parseRangeHeader("items=0-1", 1000), null)
  assert.equal(parseRangeHeader("bytes=-", 1000), null)
  assert.equal(parseRangeHeader("garbage", 1000), null)
})

test("StaticServer: a Range request for imported media returns 206 with only the requested bytes", async () => {
  await withMediaServer(async (baseUrl) => {
    // "fake png bytes": indices 5-7 are "png"
    const response = await rawRequest(baseUrl, { path: "/media/01MEDIAULID", headers: { Range: "bytes=5-7" } })
    assert.equal(response.status, 206)
    assert.equal(response.body, "png")
    assert.equal(response.headers["content-range"], "bytes 5-7/14")
    assert.equal(response.headers["content-length"], "3")
    assert.equal(response.headers["accept-ranges"], "bytes")
  })
})

test("StaticServer: a full media response advertises Accept-Ranges and an exact Content-Length", async () => {
  await withMediaServer(async (baseUrl) => {
    const response = await rawRequest(baseUrl, { path: "/media/01MEDIAULID" })
    assert.equal(response.status, 200)
    assert.equal(response.headers["accept-ranges"], "bytes")
    assert.equal(response.headers["content-length"], "14")
    assert.equal(response.headers["content-range"], undefined)
  })
})

test("StaticServer: an unsatisfiable media Range returns 416 with the real size in Content-Range", async () => {
  await withMediaServer(async (baseUrl) => {
    const response = await rawRequest(baseUrl, { path: "/media/01MEDIAULID", headers: { Range: "bytes=500-600" } })
    assert.equal(response.status, 416)
    assert.equal(response.headers["content-range"], "bytes */14")
  })
})

test("StaticServer: HEAD on media returns the headers and no body", async () => {
  await withMediaServer(async (baseUrl) => {
    const response = await rawRequest(baseUrl, { method: "HEAD", path: "/media/01MEDIAULID" })
    assert.equal(response.status, 200)
    assert.equal(response.headers["content-type"], "image/png")
    assert.equal(response.headers["content-length"], "14")
    assert.equal(response.body, "")
  })
})

test("StaticServer: media whose file vanished after import returns 404, not a crashed response", async () => {
  await withMediaServer(async (baseUrl, mediaFilePath) => {
    await rm(mediaFilePath)
    const response = await rawRequest(baseUrl, { path: "/media/01MEDIAULID" })
    assert.equal(response.status, 404)
  })
})

test("StaticServer: every response carries nosniff and no-referrer, including errors", async () => {
  await withServer({ "index.html": "hi" }, async (baseUrl) => {
    for (const path of ["/", "/missing.html"]) {
      const response = await rawRequest(baseUrl, { path })
      assert.equal(response.headers["x-content-type-options"], "nosniff", path)
      assert.equal(response.headers["referrer-policy"], "no-referrer", path)
    }
  })
})

test("StaticServer: a malformed percent-escape is a 400 client error, not a 500", async () => {
  await withServer({ "index.html": "hi" }, async (baseUrl) => {
    const response = await rawRequest(baseUrl, { path: "/%E0%A4%A" })
    assert.equal(response.status, 400)
  })
})

test("StaticServer: an encoded NUL byte in the path is a 400", async () => {
  await withServer({ "index.html": "hi" }, async (baseUrl) => {
    const response = await rawRequest(baseUrl, { path: "/index.html%00.png" })
    assert.equal(response.status, 400)
  })
})

test("StaticServer: only GET and HEAD are allowed; anything else is 405 with an Allow header", async () => {
  await withServer({ "index.html": "hi" }, async (baseUrl) => {
    const response = await rawRequest(baseUrl, { method: "POST", path: "/" })
    assert.equal(response.status, 405)
    assert.equal(response.headers["allow"], "GET, HEAD")
  })
})

test("StaticServer: a directory path is a 404, not a leaked listing or a 500", async () => {
  await withServer({ "scripts/app.js": "x" }, async (baseUrl) => {
    const response = await rawRequest(baseUrl, { path: "/scripts" })
    assert.equal(response.status, 404)
  })
})

test("StaticServer: pages are served with an ETag and revalidation, and a matching If-None-Match gets a bodyless 304", async () => {
  await withServer({ "index.html": "<h1>hi</h1>" }, async (baseUrl) => {
    const first = await rawRequest(baseUrl, { path: "/" })
    assert.equal(first.status, 200)
    assert.equal(first.headers["cache-control"], "no-cache")
    const etag = first.headers["etag"]
    assert.equal(typeof etag, "string")

    const second = await rawRequest(baseUrl, { path: "/", headers: { "If-None-Match": etag as string } })
    assert.equal(second.status, 304)
    assert.equal(second.body, "")

    const stale = await rawRequest(baseUrl, { path: "/", headers: { "If-None-Match": 'W/"stale"' } })
    assert.equal(stale.status, 200)
    assert.equal(stale.body, "<h1>hi</h1>")
  })
})

test("StaticServer: fonts are cacheable for a day and stay readable from the dashboard's sandboxed iframe (CORS)", async () => {
  await withServer({ "fonts/a.woff2": "font-bytes" }, async (baseUrl) => {
    const response = await rawRequest(baseUrl, { path: "/fonts/a.woff2" })
    assert.equal(response.status, 200)
    assert.equal(response.headers["cache-control"], "public, max-age=86400")
    assert.equal(response.headers["access-control-allow-origin"], "*")
    assert.equal(response.headers["content-type"], "font/woff2")
  })
})

test("StaticServer: serves the favicon and touch icon with image types (a generic type makes browsers ignore them)", async () => {
  await withServer({ "favicon.svg": "<svg/>", "apple-touch-icon.png": "png-bytes" }, async (baseUrl) => {
    const svg = await rawRequest(baseUrl, { path: "/favicon.svg" })
    assert.equal(svg.status, 200)
    assert.equal(svg.headers["content-type"], "image/svg+xml")
    assert.equal(svg.headers["x-content-type-options"], "nosniff")

    const png = await rawRequest(baseUrl, { path: "/apple-touch-icon.png" })
    assert.equal(png.status, 200)
    assert.equal(png.headers["content-type"], "image/png")
  })
})

test("StaticServer: HEAD on a page returns headers and Content-Length but no body", async () => {
  await withServer({ "index.html": "<h1>hi</h1>" }, async (baseUrl) => {
    const response = await rawRequest(baseUrl, { method: "HEAD", path: "/" })
    assert.equal(response.status, 200)
    assert.equal(response.headers["content-length"], String("<h1>hi</h1>".length))
    assert.equal(response.body, "")
  })
})

// ARCHITECTURE.md section 110.6: /brand/logo serves the one stored, validated logo.
async function withLogoServer(logoPath: () => string | null, fn: (baseUrl: string) => Promise<void>): Promise<void> {
  const rootDir = await mkdtemp(join(tmpdir(), "churchoverlay-logo-test-"))
  const server = new StaticServer({ port: 0, rootDir, brandLogoPath: logoPath })
  await server.ready
  try {
    await fn(`http://127.0.0.1:${server.port}`)
  } finally {
    await server.close()
    await rm(rootDir, { recursive: true, force: true })
  }
}

test("StaticServer: /brand/logo serves a PNG with nosniff, revalidates with ETag/304, and supports HEAD", async () => {
  const dir = await mkdtemp(join(tmpdir(), "churchoverlay-logo-file-"))
  const file = join(dir, "logo.png")
  await writeFile(file, "png-bytes", "utf8")
  try {
    await withLogoServer(() => file, async (baseUrl) => {
      const ok = await rawRequest(baseUrl, { path: "/brand/logo?v=3" })
      assert.equal(ok.status, 200)
      assert.equal(ok.headers["content-type"], "image/png")
      assert.equal(ok.headers["x-content-type-options"], "nosniff")
      assert.equal(ok.headers["referrer-policy"], "no-referrer")
      assert.equal(ok.headers["cache-control"], "no-cache")
      assert.equal(ok.body, "png-bytes")
      const etag = ok.headers.etag as string
      assert.equal((await rawRequest(baseUrl, { path: "/brand/logo", headers: { "If-None-Match": etag } })).status, 304)
      const head = await rawRequest(baseUrl, { method: "HEAD", path: "/brand/logo" })
      assert.equal(head.status, 200)
      assert.equal(head.body, "")
      assert.equal(head.headers["content-length"], String("png-bytes".length))
    })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("StaticServer: /brand/logo is 404 when no logo is set or the stored file vanished, and rejects non-GET methods", async () => {
  await withLogoServer(() => null, async (baseUrl) => {
    assert.equal((await rawRequest(baseUrl, { path: "/brand/logo" })).status, 404)
    assert.equal((await rawRequest(baseUrl, { method: "POST", path: "/brand/logo" })).status, 405)
  })
  await withLogoServer(() => join(tmpdir(), "churchoverlay-no-such-logo.png"), async (baseUrl) => {
    assert.equal((await rawRequest(baseUrl, { path: "/brand/logo" })).status, 404)
  })
})
