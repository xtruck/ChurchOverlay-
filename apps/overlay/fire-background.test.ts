import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"

/**
 * ARCHITECTURE.md section 129. The fire is a plain browser script; its pure parts
 * (heat simulation, palette) are exported for node, and the wiring into the overlay
 * page is guarded at source level because real browser execution is not automatable
 * here (TESTING.md).
 */
const REPO_ROOT = join(__dirname, "..", "..", "..")
const PUBLIC = join(REPO_ROOT, "apps", "overlay", "public")
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fire = require(join(PUBLIC, "fire-background.js")) as {
  WIDTH: number
  HEIGHT: number
  createFire: (random?: () => number, decay?: number) => { heat: Uint8Array; step: () => void; width: number; height: number }
  paint: (heat: Uint8Array, rgba: Uint8ClampedArray) => void
}

/** A small deterministic generator (mulberry32) so the simulation is repeatable. */
function seeded(seed: number): () => number {
  let a = seed
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

test("fire: starts cold, and one step lights the bottom row only", () => {
  const f = fire.createFire(seeded(1))
  assert.ok(f.heat.every((h) => h === 0))
  f.step()
  const bottom = (fire.HEIGHT - 1) * fire.WIDTH
  for (let x = 0; x < fire.WIDTH; x++) assert.ok((f.heat[bottom + x] ?? 0) >= 200)
  // the first step only moves heat one row up
  assert.ok((f.heat[(fire.HEIGHT - 3) * fire.WIDTH + 5] ?? 0) === 0)
})

test("fire: is deterministic for a given random source", () => {
  const a = fire.createFire(seeded(42))
  const b = fire.createFire(seeded(42))
  for (let i = 0; i < 60; i++) {
    a.step()
    b.step()
  }
  assert.deepEqual(Array.from(a.heat), Array.from(b.heat))
})

test("fire: flames rise but die out before the top, so the verse area stays clear (default decay)", () => {
  const f = fire.createFire(seeded(7))
  for (let i = 0; i < 200; i++) f.step()
  let hottestTopRow = 0
  for (let x = 0; x < fire.WIDTH; x++) hottestTopRow = Math.max(hottestTopRow, f.heat[x] ?? 0)
  assert.equal(hottestTopRow, 0)
  let litRows = 0
  for (let y = 0; y < fire.HEIGHT; y++) {
    let any = false
    for (let x = 0; x < fire.WIDTH; x++) if ((f.heat[y * fire.WIDTH + x] ?? 0) > 0) any = true
    if (any) litRows += 1
  }
  assert.ok(litRows > 8 && litRows < fire.HEIGHT * 0.7, `flames cover ${litRows} of ${fire.HEIGHT} rows`)
})

test("fire: heat never leaves the 0-255 range and a stepped grid keeps its size", () => {
  const f = fire.createFire(seeded(3))
  for (let i = 0; i < 100; i++) f.step()
  assert.equal(f.heat.length, fire.WIDTH * fire.HEIGHT)
  for (const h of f.heat) assert.ok(h >= 0 && h <= 255)
})

test("fire: cold cells paint fully transparent and the hottest paint opaque and bright", () => {
  const heat = new Uint8Array(3)
  heat[0] = 0
  heat[1] = 120
  heat[2] = 255
  const rgba = new Uint8ClampedArray(12)
  fire.paint(heat, rgba)
  assert.deepEqual(Array.from(rgba.slice(0, 4)), [0, 0, 0, 0])
  assert.equal(rgba[3 + 4], 255 > 120 * 2.2 ? Math.floor(120 * 2.2) : 255)
  assert.deepEqual(Array.from(rgba.slice(8, 12)), [255, 255, 220, 255])
})

test("overlay page: the fire is wired, full-screen only, off by default, and never takes input", () => {
  const html = readFileSync(join(PUBLIC, "index.html"), "utf8")
  const js = readFileSync(join(PUBLIC, "overlay.js"), "utf8")
  assert.match(html, /<script src="fire-background\.js"><\/script>\s*<script src="overlay\.js"><\/script>/)
  assert.match(html, /<canvas id="verse-bg" aria-hidden="true"><\/canvas>/)
  assert.match(html, /#verse-bg\s*\{[^}]*display: none;[^}]*pointer-events: none;/)
  // only the validated closed list can start it, and only in the full-screen layout while a verse shows
  assert.match(js, /const BACKGROUNDS = \["none", "fire"\]/)
  assert.match(js, /BACKGROUNDS\.includes\(style\.background\) \? style\.background : "none"/)
  assert.match(js, /backgroundName === "fire" && verseEl\.classList\.contains\("visible"\) && verseEl\.classList\.contains\("fullscreen"\)/)
  for (const hook of ["verseEl.classList.add(\"visible\")", "verseEl.classList.remove(\"visible\")"]) {
    assert.ok(js.includes(hook))
  }
  assert.ok((js.match(/syncBackground\(\)/g) ?? []).length >= 5, "every visibility/layout/style change must resync the backdrop")
})
