import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"

/**
 * Source guard (real browser execution is not automatable here, TESTING.md):
 * the overlay must reset the channels the server re-syncs when its socket
 * (re)opens. The server only re-sends verse/media/poster if active and never
 * sends a clear, so without this reset a verse cleared while the overlay was
 * disconnected stays on the stream. Verified manually in a browser by
 * restarting the server under a visible verse.
 */
const REPO_ROOT = join(__dirname, "..", "..", "..")
const overlayJs = readFileSync(join(REPO_ROOT, "apps", "overlay", "public", "overlay.js"), "utf8")

test("overlay.js: the WebSocket open handler clears verse, media and poster before the server resync", () => {
  const open = overlayJs.match(/addEventListener\("open",\s*\(\)\s*=>\s*\{([\s\S]*?)\n    \}\)/)
  assert.ok(open, "open handler not found")
  const body = open[1] ?? ""
  for (const call of ["clearVerse()", "clearMedia()", "clearPoster()"]) {
    assert.ok(body.includes(call), `open handler must call ${call}`)
  }
})
