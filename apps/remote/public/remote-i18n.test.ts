import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"

// Compiled to dist/apps/remote/public/ — four levels up is the repo root.
const REPO_ROOT = join(__dirname, "..", "..", "..", "..")
const html = readFileSync(join(REPO_ROOT, "apps", "remote", "public", "index.html"), "utf8")
const script = readFileSync(join(REPO_ROOT, "apps", "remote", "public", "remote.js"), "utf8")

/** Top-level keys of one language's table in remote.js's STRINGS object. */
function keysOf(language: "en" | "fr"): Set<string> {
  const start = script.indexOf(`    ${language}: {`)
  assert.ok(start >= 0, `remote.js has no ${language} table`)
  // The English table ends where the French one starts; the French one ends
  // where the language is chosen (`const lang = ...`), right after STRINGS.
  const end = language === "en" ? script.indexOf("    fr: {") : script.indexOf("  const lang =")
  assert.ok(end > start, `could not find the end of the ${language} table`)
  const block = script.slice(start, end)
  return new Set([...block.matchAll(/^\s{6}"?([\w.]+)"?:/gm)].map((m) => m[1] as string))
}

const en = keysOf("en")
const fr = keysOf("fr")

test("remote page: English and French tables define the same keys", () => {
  assert.deepEqual([...en].filter((key) => !fr.has(key)), [], "in English but missing in French")
  assert.deepEqual([...fr].filter((key) => !en.has(key)), [], "in French but missing in English")
})

test("remote page: every data-t label in the HTML exists in both languages", () => {
  const used = [...html.matchAll(/data-t="([^"]+)"/g)].map((m) => m[1] as string)
  assert.ok(used.length > 10, "expected the page to use many translated labels")
  assert.deepEqual(used.filter((key) => !en.has(key)), [], "missing in English")
  assert.deepEqual(used.filter((key) => !fr.has(key)), [], "missing in French")
})

test("remote page: the Layout & Media card is translated, not hardcoded English", () => {
  for (const key of ["layoutMedia", "layoutFullscreen", "layoutLowerThird"]) {
    assert.ok(html.includes(`data-t="${key}"`), `index.html does not mark ${key} as translatable`)
  }
})
