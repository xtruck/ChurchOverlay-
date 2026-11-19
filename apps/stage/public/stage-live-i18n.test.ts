import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const REPO_ROOT = join(__dirname, "..", "..", "..", "..")

function readPage(name: "stage" | "live"): { html: string; script: string; css: string } {
  const directory = join(REPO_ROOT, "apps", name, "public")
  return {
    html: readFileSync(join(directory, "index.html"), "utf8"),
    script: readFileSync(join(directory, `${name}.js`), "utf8"),
    css: readFileSync(join(directory, name === "stage" ? "stage.css" : "live.css"), "utf8"),
  }
}

function keysOf(script: string, language: "en" | "fr"): Set<string> {
  const start = script.indexOf(`    ${language}: {`)
  const end = language === "en" ? script.indexOf("    fr: {", start) : script.indexOf("  const lang =", start)
  assert.ok(start >= 0 && end > start, `${language} dictionary exists`)
  return new Set([...script.slice(start, end).matchAll(/^\s{6}([\w]+):/gm)].map((match) => match[1] as string))
}

for (const name of ["stage", "live"] as const) {
  test(`${name} page: all static labels have English and French translations and update lang`, () => {
    const { html, script } = readPage(name)
    const english = keysOf(script, "en")
    const french = keysOf(script, "fr")
    const used = [...html.matchAll(/data-t(?:-label)?="([^"]+)"/g)].map((match) => match[1] as string)

    assert.ok(used.length > 0)
    assert.deepEqual([...english].filter((key) => !french.has(key)), [], "English-only keys")
    assert.deepEqual([...french].filter((key) => !english.has(key)), [], "French-only keys")
    assert.deepEqual(used.filter((key) => !english.has(key) || !french.has(key)), [], "HTML labels missing in a language")
    assert.match(html, /<html lang="en">/)
    assert.match(script, /document\.documentElement\.lang = lang/)
  })
}

test("stage and live pages preserve status and control contrast in Windows forced-colors", () => {
  const stage = readPage("stage")
  const live = readPage("live")

  assert.match(stage.html, /class="status-indicator connection-status" role="status" aria-live="polite"/)
  assert.match(stage.css, /@media \(forced-colors: active\)/)
  assert.match(stage.css, /background:\s*Highlight;\s*color:\s*HighlightText;/)
  assert.match(live.css, /@media \(forced-colors: active\)/)
  assert.match(live.css, /body\[data-conn="offline"\] \.live-status \{ border-color: Mark; \}/)
  assert.match(live.css, /\.btn-action:focus-visible \{ outline-color: Highlight; \}/)
})
