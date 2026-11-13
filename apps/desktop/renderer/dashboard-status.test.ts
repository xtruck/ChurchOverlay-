import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const REPO_ROOT = join(__dirname, "..", "..", "..", "..")
const html = readFileSync(join(REPO_ROOT, "apps", "desktop", "renderer", "index.html"), "utf8")
const css = readFileSync(join(REPO_ROOT, "apps", "desktop", "renderer", "dashboard.css"), "utf8")

test("dashboard connection state is announced and visually distinct", () => {
  assert.match(html, /id="status-pill"[^>]*role="status"[^>]*aria-live="polite"[^>]*aria-atomic="true"/)
  assert.match(css, /\.status-pill\.connected\s*\{[^}]*border-color:[^;]+;/)
  assert.match(css, /\.status-pill\.disconnected\s*\{[^}]*border-color:[^;]+;/)
})
