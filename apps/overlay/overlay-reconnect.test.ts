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

test("overlay.js: a quick reconnect cancels the failsafe without blanking local content", () => {
  const open = overlayJs.match(/addEventListener\("open",\s*\(\)\s*=>\s*\{([\s\S]*?)\n    \}\)/)
  assert.ok(open, "open handler not found")
  const body = open[1] ?? ""
  assert.ok(body.includes("disconnectFailsafe.cancel()"), "a quick reconnect cancels the pending local clear")
  assert.ok(!body.includes("clearAllContent()"), "the current picture remains until targeted server state sync arrives")
})

test("overlay.js: a disconnect arms the local fail-safe to clear every content channel", () => {
  assert.match(overlayJs, /ws\.addEventListener\("close",\s*\(\)\s*=>\s*\{\s*if \(!designPreview\) disconnectFailsafe\.start\(\)/)
  const clearAll = overlayJs.match(/function clearAllContent\(\) \{([\s\S]*?)\n  \}/)
  assert.ok(clearAll, "clearAllContent helper exists")
  for (const call of ["clearVerse()", "clearMedia()", "clearPoster()", "clearAnnouncement()", "clearDefinition()", "clearOutline()", "clearCanvas()"]) {
    assert.ok(clearAll[1]?.includes(call), `disconnect fail-safe clears ${call}`)
  }
  assert.match(overlayJs, /createDisconnectFailsafe\(clearAllContent\)/)
})

test("overlay.js: fitting still uses the existing floor and marks cards that reach it", () => {
  assert.match(overlayJs, /fontSize <= limits\.minFontPx/)
  assert.match(overlayJs, /verseCardEl\.dataset\.fitLimited = "true"/)
  assert.match(overlayJs, /verseCardEl\.style\.setProperty\("--fit-scale", String\(scale\)\)/)
})
