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

test("remote page: the verse-string parser accepts accented French book names", () => {
  const match = script.match(/function parseVerseString[\s\S]*?\.match\((\/.+\/[a-z]*)\)/)
  assert.ok(match, "could not find the parseVerseString regex")
  const re = new Function(`return ${match[1]}`)() as RegExp
  assert.ok(re.test("Genèse 1:1"))
  assert.ok(re.test("Ésaïe 41:10"))
  assert.ok(re.test("1 Corinthiens 13:4"))
})

test("remote page: quick stage alerts and the timer title are sent from the translation table", () => {
  const keys = [...html.matchAll(/data-msg-key="([^"]+)"/g)].map((m) => m[1] as string)
  assert.equal(keys.length, 4)
  assert.deepEqual(keys.filter((key) => !en.has(key) || !fr.has(key)), [])
  assert.ok(!/data-msg="/.test(html), "a hardcoded English data-msg is back")
  assert.ok(en.has("timerSermonTitle") && fr.has("timerSermonTitle"))
  assert.ok(!script.includes('title: "Sermon"'), "timer title must come from t()")
})

test("remote page: sends are acknowledged with a toast and offline sends are refused visibly", () => {
  assert.ok(html.includes('id="toast"') && /id="toast"[^>]*aria-live="polite"/.test(html), "toast must be a polite live region")
  for (const key of ["toastSent", "toastOffline", "toastBadRef", "toastShown", "toastPending", "toastNotShown"]) {
    assert.ok(en.has(key) && fr.has(key), `${key} missing in a language`)
  }
  assert.match(script, /function sendJson[\s\S]*?showToast\(t\("toastOffline"\)[\s\S]*?return false/)
  assert.match(script, /message\.type === "verse:pending"[\s\S]*?resolveVerseAck\("toastPending"/)
  assert.match(script, /resolveVerseAck\("toastShown"/)
  assert.match(script, /showToast\(t\("toastBadRef"\)/)
})
