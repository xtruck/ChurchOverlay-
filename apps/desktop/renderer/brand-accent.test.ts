import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { runInNewContext } from "node:vm"

const REPO_ROOT = join(__dirname, "..", "..", "..", "..")
const helperSource = readFileSync(join(REPO_ROOT, "apps", "desktop", "renderer", "brand-accent.js"), "utf8")
const helperModule = { exports: {} as Record<string, unknown> }
runInNewContext(helperSource, { module: helperModule })
const { clampBrandAccent, relativeLuminance } = helperModule.exports as {
  clampBrandAccent: (color: string) => { color: string; ink: string; luminance: number } | null
  relativeLuminance: (rgb: number[]) => number
}

function contrastRatio(a: number, b: number): number {
  const light = Math.max(a, b)
  const dark = Math.min(a, b)
  return (light + 0.05) / (dark + 0.05)
}

test("branded accent clamp preserves readable button ink and focus contrast", () => {
  const appBackground = relativeLuminance([11, 14, 19])
  for (const input of ["#1f3a8a", "#7b4b12", "#e07b00", "#f0c84b"]) {
    const accent = clampBrandAccent(input)
    assert.ok(accent)
    const darkInk = relativeLuminance([28, 20, 5])
    const ink = accent.ink === "#ffffff" ? 1 : darkInk
    assert.ok(contrastRatio(ink, accent.luminance) >= 4.5, `${input} button ink contrast`)
    assert.ok(contrastRatio(accent.luminance, appBackground) >= 4.5, `${input} focus-ring contrast`)
  }
})

test("branded accent clamp rejects malformed values instead of applying an unsafe accent", () => {
  assert.equal(clampBrandAccent("rgb(0, 0, 0)"), null)
  assert.equal(clampBrandAccent("#123"), null)
})
