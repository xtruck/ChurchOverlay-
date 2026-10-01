import test from "node:test"
import assert from "node:assert/strict"
import { defaultOverlayStyleSettings, isOverlayStylePayload, normalizeOverlayStyleSettings, resolveOverlayStyle, BRAND_TEXT_MAX } from "./overlay-style"
import { PALETTES } from "./palettes"

test("defaults are stable under normalization and resolve to the gilt-night legacy look", () => {
  const d = defaultOverlayStyleSettings()
  assert.deepEqual(normalizeOverlayStyleSettings(d), d)
  const style = resolveOverlayStyle(d, 1)
  assert.equal(style.colors.accent, "#e6c27a") // legacy --accent
  assert.equal(style.colors.backdrop, "#0c1320") // legacy fullscreen backdrop
  assert.equal(style.card, "classic")
  assert.equal(d.brand.name.visible, false)
  assert.equal(d.brand.logo.visible, false)
})

test("garbage input never throws and yields defaults", () => {
  for (const bad of [null, undefined, 5, "x", [], { brand: 7 }, { brand: { name: [] } }]) {
    assert.deepEqual(normalizeOverlayStyleSettings(bad), defaultOverlayStyleSettings())
  }
})

test("enums, clamps, text and colours are sanitized", () => {
  const out = normalizeOverlayStyleSettings({
    paletteId: "nope",
    card: "<script>",
    evil: true,
    brand: {
      name: { visible: true, text: "  Grace\u0000 \n Church  " + "x".repeat(200), font: "comic", size: 9999, weight: 555, x: -50, y: 500, scale: 99, rotation: 1e9, opacity: NaN, color: "red; background:url(x)", plate: "yes" },
      logo: { visible: true, version: -3, x: 33.3, scale: 0.01 },
    },
  })
  assert.equal(out.paletteId, "gilt-night")
  assert.equal(out.card, "classic")
  assert.ok(!("evil" in out))
  const n = out.brand.name
  assert.equal(n.text.length, BRAND_TEXT_MAX)
  assert.ok(n.text.startsWith("Grace Church"))
  assert.equal(n.font, "sans")
  assert.equal(n.size, 160)
  assert.equal(n.weight, 600)
  assert.equal(n.x, 0)
  assert.equal(n.y, 100)
  assert.equal(n.scale, 4)
  assert.equal(n.rotation, 180)
  assert.equal(n.opacity, 0.85)
  assert.equal(n.color, undefined)
  assert.equal(n.plate, true)
  assert.equal(out.brand.logo.version, 0)
  assert.equal(out.brand.logo.x, 33.3)
  assert.equal(out.brand.logo.scale, 0.25)
})

test("custom palette keeps only #rrggbb colours and falls back per role", () => {
  const out = normalizeOverlayStyleSettings({
    paletteId: "custom",
    customColors: { backdrop: "#112233", card: "rgb(0,0,0)", cardOpacity: 7, text: "#ABCDEF", textSecondary: "javascript:1", accent: "#fff", border: "#000000" },
  })
  const c = resolveOverlayStyle(out, 2).colors
  assert.equal(c.backdrop, "#112233")
  assert.equal(c.card, "#06070a")
  assert.equal(c.cardOpacity, 1)
  assert.equal(c.text, "#abcdef")
  assert.equal(c.textSecondary, "#f2f4f7")
  assert.equal(c.accent, "#e6c27a")
})

test("catalog palettes resolve to their own colours and non-custom drops customColors", () => {
  for (const pal of PALETTES) {
    const s = normalizeOverlayStyleSettings({ paletteId: pal.id, customColors: { text: "#000000" } })
    assert.equal("customColors" in s, false)
    assert.deepEqual(resolveOverlayStyle(s, 1).colors, pal.colors)
  }
})

test("isOverlayStylePayload accepts resolved styles and rejects anything that needed repair", () => {
  const good = resolveOverlayStyle(defaultOverlayStyleSettings(), 3)
  assert.equal(isOverlayStylePayload(good), true)
  assert.equal(isOverlayStylePayload({ ...good, revision: -1 }), false)
  assert.equal(isOverlayStylePayload({ ...good, card: "x" }), false)
  assert.equal(isOverlayStylePayload({ ...good, colors: { ...good.colors, accent: "red" } }), false)
  assert.equal(isOverlayStylePayload({ ...good, extra: 1 }), false)
  assert.equal(isOverlayStylePayload(null), false)
})
