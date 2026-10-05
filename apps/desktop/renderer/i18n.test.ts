import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"

// Compiled to dist/apps/desktop/renderer/ — four levels up is the repo root.
const REPO_ROOT = join(__dirname, "..", "..", "..", "..")
const script = readFileSync(join(REPO_ROOT, "apps", "desktop", "renderer", "i18n.js"), "utf8")
const html = readFileSync(join(REPO_ROOT, "apps", "desktop", "renderer", "index.html"), "utf8")

/** key -> value for one language's table in i18n.js (single-line string entries). */
function tableOf(language: "en" | "fr"): Map<string, string> {
  const start = script.indexOf(`    ${language}: {`)
  assert.ok(start >= 0, `i18n.js has no ${language} table`)
  const end = language === "en" ? script.indexOf("    fr: {") : script.indexOf("  function ", start)
  assert.ok(end > start, `could not find the end of the ${language} table`)
  const entries = new Map<string, string>()
  for (const match of script.slice(start, end).matchAll(/^\s{6}"([\w.-]+)":\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'),?\s*$/gm)) {
    entries.set(match[1] as string, (match[2] ?? match[3]) as string)
  }
  return entries
}

const en = tableOf("en")
const fr = tableOf("fr")
const params = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1] as string).sort()

test("dashboard i18n: English and French define the same keys", () => {
  assert.ok(en.size > 300, "expected a large English table")
  assert.deepEqual([...en.keys()].filter((key) => !fr.has(key)), [], "in English but missing in French")
  assert.deepEqual([...fr.keys()].filter((key) => !en.has(key)), [], "in French but missing in English")
})

test("dashboard i18n: every {placeholder} appears in both languages", () => {
  for (const [key, value] of en) {
    assert.deepEqual(params(fr.get(key) ?? ""), params(value), `placeholder mismatch for ${key}`)
  }
})

test("dashboard i18n: every data-i18n key used by index.html exists in both languages", () => {
  const used = [...html.matchAll(/data-i18n(?:-[a-z-]+)?="([^"]+)"/g)].map((m) => m[1] as string)
  assert.ok(used.length > 100, "expected the page to use many translated labels")
  assert.deepEqual(used.filter((key) => !en.has(key)), [], "missing in English")
  assert.deepEqual(used.filter((key) => !fr.has(key)), [], "missing in French")
})

test("dashboard i18n: every t(\"key\") literal in dashboard.js exists in both languages", () => {
  const dashboard = readFileSync(join(REPO_ROOT, "apps", "desktop", "renderer", "dashboard.js"), "utf8")
  const used = [...dashboard.matchAll(/\bt\("([\w.]+)"/g)].map((m) => m[1] as string).filter((key) => !key.endsWith(".")) // "prefix." keys are built dynamically
  assert.ok(used.length > 50)
  assert.deepEqual([...new Set(used)].filter((key) => !en.has(key)), [], "missing in English")
  assert.deepEqual([...new Set(used)].filter((key) => !fr.has(key)), [], "missing in French")
})
