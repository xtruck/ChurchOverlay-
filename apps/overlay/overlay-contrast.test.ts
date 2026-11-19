import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { PALETTES, compositeHex, contrastRatio } from "../server/overlay/palettes"

const REPO_ROOT = join(__dirname, "..", "..", "..")
const html = readFileSync(join(REPO_ROOT, "apps", "overlay", "public", "index.html"), "utf8")

function ruleFor(selector: string): string {
  const selectorIndex = html.indexOf(selector)
  assert.notEqual(selectorIndex, -1, `${selector} CSS rule exists`)
  const open = html.indexOf("{", selectorIndex)
  const close = html.indexOf("}", open)
  assert.ok(open > selectorIndex && close > open, `${selector} CSS rule is complete`)
  return html.slice(open + 1, close)
}

test("overlay announcement, definition and outline styles use palette text on a high-opacity palette card", () => {
  const styles = [
    ["#announcement-body", "var(--ov-text2)"],
    ["#announcement-title", "var(--ov-text)"],
    ["#definition-body", "var(--ov-text2)"],
    ["#definition-term", "var(--ov-text)"],
    ["#outline-title", "var(--ov-text)"],
    ["#outline-text", "var(--ov-text2)"],
    ["#outline-badge", "var(--ov-text2)"],
  ] as const

  for (const [selector, color] of styles) {
    assert.ok(ruleFor(selector).includes(`color: ${color}`), `${selector} uses a contrast-checked palette text role`)
  }
  for (const selector of ["#announcement-card", "#definition-card", "#outline-card"]) {
    assert.ok(ruleFor(selector).includes("var(--ov-content-card-a)"), `${selector} keeps contrast over any video`)
  }
})

test("every palette and content-block text role stays at least 4.5:1 over black or white video", () => {
  for (const palette of PALETTES) {
    const colors = palette.colors
    const alpha = Math.max(colors.cardOpacity, 0.94)
    const worstRatio = (foreground: string) =>
      Math.min(
        contrastRatio(foreground, compositeHex(colors.card, alpha, "#000000")),
        contrastRatio(foreground, compositeHex(colors.card, alpha, "#ffffff"))
      )

    for (const [role, color] of [["primary", colors.text], ["secondary", colors.textSecondary]] as const) {
      assert.ok(worstRatio(color) >= 4.5, `${palette.id} ${role} contrast ${worstRatio(color).toFixed(2)}:1`)
    }
  }
})
