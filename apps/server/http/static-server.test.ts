import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { get as httpGet } from "node:http"
import { StaticServer, type MediaFileResolver } from "./static-server"

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
