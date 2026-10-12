import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const REPO_ROOT = join(__dirname, "..", "..", "..")
const stageHtml = readFileSync(join(REPO_ROOT, "apps", "stage", "public", "index.html"), "utf8")
const stageJs = readFileSync(join(REPO_ROOT, "apps", "stage", "public", "stage.js"), "utf8")
const stageCss = readFileSync(join(REPO_ROOT, "apps", "stage", "public", "stage.css"), "utf8")

test("stage page: verse overflow has an accessible, operator-visible warning", () => {
  assert.match(stageHtml, /id="stage-overflow-warning"[^>]*role="status"[^>]*aria-live="polite"[^>]*hidden/)
  assert.match(stageHtml, /Verse text exceeds the display — some text is clipped/)
  assert.match(stageCss, /\.stage-overflow-warning\s*\{[^}]*color:\s*var\(--warn\)/)
})

test("stage.js: reports remaining overflow at the minimum verse font size", () => {
  assert.match(stageJs, /const MIN_VERSE_PX = 28;/)
  assert.match(stageJs, /size = Math\.max\(MIN_VERSE_PX, size - 2\);/)
  assert.match(
    stageJs,
    /overflowWarning\.hidden = Boolean\(box && verseTextEl\.scrollHeight > box\.clientHeight \+ 1\);/,
  )
  assert.match(stageJs, /if \(overflowWarning\) overflowWarning\.hidden = true;/)
})
