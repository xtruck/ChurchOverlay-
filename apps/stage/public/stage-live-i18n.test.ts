import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const REPO_ROOT = join(__dirname, "..", "..", "..", "..")

function readPage(name: "stage" | "live"): { html: string; script: string } {
  const directory = join(REPO_ROOT, "apps", name, "public")
  return {
    html: readFileSync(join(directory, "index.html"), "utf8"),
    script: readFileSync(join(directory, `${name}.js`), "utf8"),
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
