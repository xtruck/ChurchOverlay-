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

test("dashboard keeps navigation captions visible and offers a keyboard skip link", () => {
  assert.match(html, /class="skip-link" href="#shell-content" data-i18n="a11y\.skipToMain"/)
  assert.match(html, /id="shell-content" class="shell-content" tabindex="-1"/)
  assert.match(css, /\.sidebar-nav-item > span, \.sidebar-voice-commands-btn > span\s*\{[^}]*overflow-wrap:\s*anywhere;[^}]*hyphens:\s*auto;/)
  assert.doesNotMatch(css, /\.header-group-label\s*\{\s*display:\s*none;/)
})
