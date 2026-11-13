import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const REPO_ROOT = join(__dirname, "..", "..", "..", "..")
const html = readFileSync(join(REPO_ROOT, "apps", "live", "public", "index.html"), "utf8")
const script = readFileSync(join(REPO_ROOT, "apps", "live", "public", "live.js"), "utf8")
const css = readFileSync(join(REPO_ROOT, "apps", "live", "public", "live.css"), "utf8")

function keysOf(language: "en" | "fr"): Set<string> {
  const start = script.indexOf(`    ${language}: {`)
  assert.ok(start >= 0, `live.js has no ${language} table`)
  const end = language === "en" ? script.indexOf("    fr: {") : script.indexOf("  const lang =")
  assert.ok(end > start, `could not find the end of the ${language} table`)
  return new Set([...script.slice(start, end).matchAll(/^\s{6}"?([\w.]+)"?:/gm)].map((match) => match[1] as string))
}

const en = keysOf("en")
const fr = keysOf("fr")

test("live companion strings have English and French parity", () => {
  assert.deepEqual([...en].filter((key) => !fr.has(key)), [], "missing from French")
  assert.deepEqual([...fr].filter((key) => !en.has(key)), [], "missing from English")
  const used = [...html.matchAll(/data-t(?:-label)?="([^"]+)"/g)].map((match) => match[1] as string)
  assert.deepEqual(used.filter((key) => !en.has(key)), [], "HTML labels missing in English")
  assert.deepEqual(used.filter((key) => !fr.has(key)), [], "HTML labels missing in French")
})

test("live companion save and copy are disabled until a non-empty verse is active", () => {
  assert.match(html, /id="btn-save-verse"[^>]*disabled/)
  assert.match(html, /id="btn-copy-verse"[^>]*disabled/)
  assert.match(script, /function updateVerseActions\(\)[\s\S]*?Boolean\(currentVerse && currentVerse\.text\)[\s\S]*?btnSave\.disabled = !enabled[\s\S]*?btnCopy\.disabled = !enabled/)
  assert.match(script, /currentVerse = \{[\s\S]*?updateVerseActions\(\)/)
  assert.match(script, /currentVerse = null;\s*updateVerseActions\(\)/)
  assert.match(css, /\.btn-action:disabled\s*\{[^}]*cursor:\s*not-allowed;/)
  assert.match(css, /\.btn-action:not\(:disabled\):hover/)
})

test("live companion reports the active translation instead of offering a nonfunctional selector", () => {
  assert.match(html, /id="translation-label"[^>]*data-t="translationUnknown"/)
  assert.doesNotMatch(html, /id="translation-select"/)
  assert.match(script, /const TRANSLATION_LABEL_KEYS = \{[\s\S]*?kjv:\s*"translationKjvShort"[\s\S]*?darby:\s*"translationDarbyShort"/)
  assert.match(script, /updateTranslationLabel\(msg\.payload\.translation\)/)
  assert.match(script, /updateTranslationLabel\(""\)/)
})
