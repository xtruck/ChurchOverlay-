import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const REPO_ROOT = join(__dirname, "..", "..", "..", "..")
const dashboard = readFileSync(join(REPO_ROOT, "apps", "desktop", "renderer", "dashboard.js"), "utf8")
const html = readFileSync(join(REPO_ROOT, "apps", "desktop", "renderer", "index.html"), "utf8")

test("pending verse can be dismissed with Escape from any focus and Ctrl+Enter avoids text inputs", () => {
  assert.match(dashboard, /key === "Escape" && !event\.shiftKey && versePendingBannerEl\.style\.display !== "none"/)
  assert.match(dashboard, /ctrl && key === "Enter" && !typing && !event\.repeat && versePendingBannerEl\.style\.display !== "none"/)
  assert.match(dashboard, /type: "verse:dismiss-pending"/)
  assert.match(html, /id="verse-pending-dismiss-btn"/)
  assert.match(html, /id="verse-pending-age"/)
})
