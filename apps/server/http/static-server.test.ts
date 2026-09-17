import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { get as httpGet } from "node:http"
import { StaticServer } from "./static-server"

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
