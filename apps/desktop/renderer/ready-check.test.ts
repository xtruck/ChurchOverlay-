import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { READY_CHECK_DETAIL_CODES, READY_CHECK_FIX_CODES, type ReadyCheckId, type ReadyCheckStatus } from "../../server/core/ready-check"

// Compiled to dist/apps/desktop/renderer/ — four levels up is the repo root.
const REPO_ROOT = join(__dirname, "..", "..", "..", "..")
const read = (...parts: string[]) => readFileSync(join(REPO_ROOT, "apps", "desktop", ...parts), "utf8")
const i18n = read("renderer", "i18n.js")
const html = read("renderer", "index.html")
const script = read("renderer", "ready-check.js")
const preload = read("preload", "index.ts")
const main = read("main", "index.ts")

function keysOf(language: "en" | "fr"): Set<string> {
  const start = i18n.indexOf(`    ${language}: {`)
  const end = language === "en" ? i18n.indexOf("    fr: {") : i18n.indexOf("  function ", start)
  return new Set([...i18n.slice(start, end).matchAll(/^\s{6}"([\w.-]+)":/gm)].map((m) => m[1] as string))
}

const IDS: readonly ReadyCheckId[] = ["mic", "asr", "ai", "verse-source", "french-fallback", "offline-model", "viewers", "remote", "logs", "clock"]
const STATUSES: readonly ReadyCheckStatus[] = ["ok", "warn", "fail", "unknown"]

test("Ready check: every code the module can emit has an English and a French string", () => {
  const needed = [
    ...READY_CHECK_DETAIL_CODES.map((code) => `readyCheck.detail.${code}`),
    ...READY_CHECK_FIX_CODES.map((code) => `readyCheck.fix.${code}`),
    ...IDS.map((id) => `readyCheck.check.${id}`),
    ...STATUSES.map((status) => `readyCheck.status.${status}`),
    ...STATUSES.map((status) => `readyCheck.overall.${status}`),
    ...["groq", "deepgram", "local"].map((provider) => `readyCheck.provider.${provider}`),
    ...["readyCheck.run", "readyCheck.running", "readyCheck.idle", "readyCheck.runFailed"],
  ]
  for (const language of ["en", "fr"] as const) {
    const keys = keysOf(language)
    assert.deepEqual(needed.filter((key) => !keys.has(key)), [], `missing in ${language}`)
  }
})

test("Ready check: the card is wired through one allow-listed preload call, after i18n.js", () => {
  assert.match(html, /<script src="\.\/ready-check\.js"><\/script>/)
  assert.ok(html.indexOf('<script src="./i18n.js">') < html.indexOf('<script src="./ready-check.js">'))
  for (const id of ["ready-check-btn", "ready-check-summary", "ready-check-list"]) assert.ok(html.includes(`id="${id}"`), id)
  assert.match(preload, /runReadyCheck: \(\) => ipcRenderer\.invoke\("run-ready-check"\)/, "no argument crosses from the renderer")
  assert.match(main, /ipcMain\.handle\("run-ready-check"/)
  assert.match(main, /readyCheck: lastReadyCheck/, "the last result is part of the diagnostics export")
})

test("Ready check: the renderer builds lines with textContent only and shows a word next to every icon", () => {
  assert.equal(/innerHTML|insertAdjacentHTML|eval\(/.test(script), false)
  assert.match(script, /readyCheck\.status\./, "a status word, not colour alone")
  assert.match(script, /aria-hidden/, "the glyph is decorative; the word carries the state")
})
