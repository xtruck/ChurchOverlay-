import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"

// Compiled to dist/apps/web/ — three levels up is the repo root.
const REPO_ROOT = join(__dirname, "..", "..", "..")
const html = readFileSync(join(REPO_ROOT, "apps", "web", "public", "index.html"), "utf8")

// Web Server Mode's "/" is reachable without a token, so this page must never
// carry one, and it has no reason to run any script.
test("web landing page: carries no script and no token", () => {
  assert.ok(!/<script/i.test(html), "the landing page must not run scripts")
  assert.ok(!/token=/i.test(html), "the landing page must not embed a token")
})

test("web landing page: explains where the operator dashboard lives, in English and French", () => {
  assert.ok(/desktop app/i.test(html), "English explanation missing")
  assert.ok(/application de bureau/i.test(html), "French explanation missing")
})

test("web landing page: names the four pages Web Server Mode serves", () => {
  for (const path of ["/overlay/", "/remote/", "/stage/", "/live/"]) {
    assert.ok(html.includes(path), `landing page does not mention ${path}`)
  }
})
