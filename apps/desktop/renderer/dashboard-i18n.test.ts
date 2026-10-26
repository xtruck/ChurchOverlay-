import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"

// Compiled to dist/apps/desktop/renderer/ — four levels up is the repo root.
const RENDERER = join(__dirname, "..", "..", "..", "..", "apps", "desktop", "renderer")
const i18nSource = readFileSync(join(RENDERER, "i18n.js"), "utf8")
const html = readFileSync(join(RENDERER, "index.html"), "utf8")

/** Keys of one language table in i18n.js (a flat `"dotted.key": "text"` list). */
function keysOf(language: "en" | "fr"): Set<string> {
  const start = i18nSource.indexOf(`    ${language}: {`)
  assert.ok(start >= 0, `i18n.js has no ${language} table`)
  const other = language === "en" ? "    fr: {" : null
  const end = other ? i18nSource.indexOf(other) : i18nSource.length
  assert.ok(end > start, `could not find the end of the ${language} table`)
  const block = i18nSource.slice(start, end)
  return new Set([...block.matchAll(/^\s{6}"([\w.]+)":/gm)].map((m) => m[1] as string))
}

const en = keysOf("en")
const fr = keysOf("fr")

test("dashboard i18n: English and French define the same keys", () => {
  assert.ok(en.size > 100, "expected a large English table")
  assert.deepEqual([...en].filter((key) => !fr.has(key)), [], "in English but missing in French")
  assert.deepEqual([...fr].filter((key) => !en.has(key)), [], "in French but missing in English")
})

test("dashboard i18n: every data-i18n key used in the HTML exists in both languages", () => {
  const used = [...html.matchAll(/data-i18n(?:-[a-z-]+)?="([^"]+)"/g)].map((m) => m[1] as string)
  assert.ok(used.length > 50, "expected the page to use many translated labels")
  assert.deepEqual([...new Set(used)].filter((key) => !en.has(key)), [], "missing in English")
  assert.deepEqual([...new Set(used)].filter((key) => !fr.has(key)), [], "missing in French")
})

test("dashboard i18n: the pending-verse 'heard' label exists in both languages", () => {
  assert.ok(en.has("livePreview.pendingHeard") && fr.has("livePreview.pendingHeard"))
})
