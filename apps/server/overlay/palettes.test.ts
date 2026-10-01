import test from "node:test"
import assert from "node:assert/strict"
import { OVERLAY_PALETTE_GROUPS } from "../../../packages/contracts/overlay-style"
import { PALETTES, HEX_COLOR, contrastRatio, findPalette, worstCaseCardContrast, DEFAULT_PALETTE_ID } from "./palettes"

test("catalog ids are unique, every colour is #rrggbb, every group is populated", () => {
  assert.equal(new Set(PALETTES.map((x) => x.id)).size, PALETTES.length)
  for (const pal of PALETTES) {
    for (const key of ["backdrop", "card", "text", "textSecondary", "accent", "border"] as const) {
      assert.match(pal.colors[key], HEX_COLOR, `${pal.id}.${key}`)
    }
    assert.ok(pal.colors.cardOpacity >= 0 && pal.colors.cardOpacity <= 1, pal.id)
    assert.ok(pal.label.en && pal.label.fr, pal.id)
  }
  for (const group of OVERLAY_PALETTE_GROUPS) assert.ok(PALETTES.some((x) => x.group === group), group)
  assert.ok(findPalette(DEFAULT_PALETTE_ID))
})

test("contrast helper matches known WCAG values", () => {
  assert.equal(Math.round(contrastRatio("#000000", "#ffffff")), 21)
  assert.ok(Math.abs(contrastRatio("#777777", "#ffffff") - 4.48) < 0.05)
})

for (const pal of PALETTES) {
  test(`palette ${pal.id} meets the contrast gate`, () => {
    const c = pal.colors
    const minText = pal.group === "high-contrast" ? 7 : 4.5
    if (pal.group === "clear-text") {
      // No card: judged against the fullscreen backdrop only (section 110.3).
      assert.ok(contrastRatio(c.text, c.backdrop) >= minText, "text on backdrop")
      assert.ok(contrastRatio(c.textSecondary, c.backdrop) >= 4.5, "secondary on backdrop")
      assert.ok(contrastRatio(c.accent, c.backdrop) >= 3, "accent on backdrop")
      assert.equal(c.cardOpacity, 0)
      return
    }
    assert.ok(worstCaseCardContrast(c, c.text) >= minText, `text on card ${worstCaseCardContrast(c, c.text).toFixed(2)}`)
    assert.ok(worstCaseCardContrast(c, c.textSecondary) >= 4.5, `secondary ${worstCaseCardContrast(c, c.textSecondary).toFixed(2)}`)
    assert.ok(worstCaseCardContrast(c, c.accent) >= 3, `accent ${worstCaseCardContrast(c, c.accent).toFixed(2)}`)
    assert.ok(contrastRatio(c.text, c.backdrop) >= minText, "text on fullscreen backdrop")
    assert.ok(contrastRatio(c.accent, c.backdrop) >= 3, "accent on backdrop")
  })
}
