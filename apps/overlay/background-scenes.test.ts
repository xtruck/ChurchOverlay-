import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { OVERLAY_BACKGROUNDS, OVERLAY_SCENE_BACKGROUNDS } from "../../packages/contracts/overlay-style"

/**
 * ARCHITECTURE.md section 147: the animated background list lives in
 * packages/contracts, but the overlay page, the dashboard and the gallery are
 * plain files that cannot import it. These source guards keep every copy in
 * step, so a scene can never be selectable yet unstyled, unnamed, or animated
 * in a way OBS has to composite on the CPU.
 */
const REPO_ROOT = join(__dirname, "..", "..", "..")
const read = (...p: string[]) => readFileSync(join(REPO_ROOT, ...p), "utf8")
const overlayHtml = read("apps", "overlay", "public", "index.html")
const overlayJs = read("apps", "overlay", "public", "overlay.js")
const i18n = read("apps", "desktop", "renderer", "i18n.js")
const dashboardHtml = read("apps", "desktop", "renderer", "index.html")
const overlaySettings = read("apps", "desktop", "renderer", "overlay-settings.js")
const gallery = read("scripts", "card-gallery.mjs")

test("overlay.js's own background list matches the contract exactly", () => {
  const listed = overlayJs.match(/const BACKGROUNDS = \[([^\]]*)\]/)
  assert.ok(listed, "overlay.js BACKGROUNDS not found")
  const inJs = [...(listed[1] ?? "").matchAll(/"([a-z-]+)"/g)].map((m) => m[1])
  assert.deepEqual(inJs, [...OVERLAY_BACKGROUNDS])
})

test("every scene has a display rule and DOM markup in the overlay page", () => {
  assert.ok(overlayHtml.includes('id="scene-backdrop"'), "the scene backdrop container is missing")
  for (const scene of OVERLAY_SCENE_BACKGROUNDS) {
    assert.ok(
      overlayHtml.includes(`html[data-scene="${scene}"] .scene-${scene} { display: block; }`),
      `index.html has no display rule for scene-${scene}`,
    )
    assert.ok(overlayHtml.includes(`scene scene-${scene}`), `index.html has no markup for scene-${scene}`)
  }
  // Exactly five scenes are styled: a renamed scene id would leave an orphan rule.
  const rules = [...overlayHtml.matchAll(/html\[data-scene="([a-z-]+)"\] \.scene-[a-z-]+ \{ display: block; \}/g)].map((m) => m[1])
  assert.deepEqual(rules, [...OVERLAY_SCENE_BACKGROUNDS])
})

test("every scene and the picker labels have an English and a French name", () => {
  for (const key of ["overlay.backgroundTitle", "overlay.backgroundHint"]) {
    assert.equal([...i18n.matchAll(new RegExp(`"${key.replace(".", "\\.")}":`, "g"))].length, 2, `${key} must exist in both languages`)
  }
  for (const bg of OVERLAY_BACKGROUNDS) {
    const keys = [...i18n.matchAll(new RegExp(`"overlay\\.background\\.${bg}":`, "g"))]
    assert.equal(keys.length, 2, `overlay.background.${bg} must exist once in English and once in French`)
  }
})

test("the dashboard builds the background picker from meta and never drops background on edit", () => {
  assert.ok(dashboardHtml.includes('id="ov-backgrounds"'), "the dashboard has no background picker row")
  assert.ok(overlaySettings.includes("meta.backgrounds || []"), "the picker is not built from meta.backgrounds")
  // The one silent-regression trap: settingsFrom omitting background would
  // reset the operator's choice to none on ANY unrelated overlay edit.
  assert.ok(overlaySettings.includes("background: s.background"), "settingsFrom must carry background through")
})

test("scenes freeze under prefers-reduced-motion", () => {
  const media = overlayHtml.match(/@media \(prefers-reduced-motion: reduce\) \{[^@]*?#scene-backdrop[^}]*?\{[^}]*?animation: none;/s)
  assert.ok(media, "the reduced-motion block must stop every scene animation")
})

test("gallery previews every scene through the validated hook", () => {
  assert.ok(overlayJs.includes("__setGalleryBackground"), "overlay.js does not expose the gallery hook")
  const select = gallery.match(/<select id="scene">([\s\S]*?)<\/select>/)
  assert.ok(select, "the gallery scene select is missing")
  const options = [...(select[1] ?? "").matchAll(/value="([a-z-]+)"/g)].map((m) => m[1])
  for (const scene of OVERLAY_SCENE_BACKGROUNDS) {
    assert.ok(options.includes(scene), `the gallery cannot preview scene-${scene}`)
  }
  assert.ok(gallery.includes("background: \"none\""), "the gallery's overlay:style payload must carry background")
})

test("every scene keyframe animates ONLY transform and opacity (GPU-compositable in OBS)", () => {
  const blocks = [...overlayHtml.matchAll(/@keyframes (scene-[a-z-]+) \{((?:[^{}]|\{[^{}]*\})*)\}/g)]
  assert.ok(blocks.length >= 8, `expected the scene keyframes, found ${blocks.length}`)
  const FORBIDDEN = /\b(?:width|height|top|left|right|bottom|margin|padding|border|filter|background|box-shadow|font-size)\s*:/
  for (const [, name, body] of blocks) {
    const rules = body ?? ""
    assert.ok(!FORBIDDEN.test(rules), `@keyframes ${name} animates layout/paint properties: only transform and opacity are allowed`)
  }
})

test("the fire and liquid warps are ANIMATED SVG turbulence, applied only when motion is allowed", () => {
  // The warp (feTurbulence + feDisplacementMap, SMIL-morphed) is what makes
  // the flames writhe and the liquid roll; without <animate> the scenes would
  // be static blobs again — the exact regression this pass fixes.
  for (const id of ["scene-fire-warp", "scene-liquid-warp"]) {
    const filter = overlayHtml.match(new RegExp(`<filter id="${id}"[\\s\\S]*?<\\/filter>`))
    assert.ok(filter, `the ${id} filter is missing from index.html`)
    assert.ok(filter[0].includes("feTurbulence") && filter[0].includes("feDisplacementMap"), `${id} must be a turbulence displacement`)
    assert.ok(filter[0].includes("<animate"), `${id} must animate its noise via SMIL or the scene is a static blob`)
  }
  // The filters are paint-time effects (not composited transforms), so they
  // must be attached ONLY under prefers-reduced-motion: no-preference —
  // otherwise reduced-motion would keep the fire boiling.
  const start = overlayHtml.indexOf("@media (prefers-reduced-motion: no-preference)")
  assert.notEqual(start, -1, "the warp filters must be gated behind prefers-reduced-motion: no-preference")
  const block = overlayHtml.slice(start, overlayHtml.indexOf("\n  }", start))
  for (const id of ["scene-fire-warp", "scene-liquid-warp"]) {
    const uses = [...overlayHtml.matchAll(new RegExp(`url\\(#${id}\\)`, "g"))].map((m) => m.index ?? 0)
    assert.ok(uses.length > 0, `${id} is never applied to a scene layer`)
    const end = start + block.length
    assert.ok(uses.every((index) => index >= start && index < end), `${id} must only be applied inside the no-preference media block`)
  }
})
