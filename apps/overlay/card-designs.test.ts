import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { OVERLAY_CARD_DESIGNS, OVERLAY_TRANSITIONS } from "../../packages/contracts/overlay-style"

/**
 * ARCHITECTURE.md sections 110 and 133: the closed design and transition lists
 * live in packages/contracts, but the overlay page and the dashboard are plain
 * browser files that cannot import them. These source guards keep every copy
 * in step, so a design can never be selectable yet unstyled or unnamed.
 */
const REPO_ROOT = join(__dirname, "..", "..", "..")
const read = (...p: string[]) => readFileSync(join(REPO_ROOT, ...p), "utf8")
const overlayHtml = read("apps", "overlay", "public", "index.html")
const overlayJs = read("apps", "overlay", "public", "overlay.js")
const i18n = read("apps", "desktop", "renderer", "i18n.js")

// eslint-disable-next-line @typescript-eslint/no-require-imports
const motion = require(join(REPO_ROOT, "apps", "overlay", "public", "verse-motion.js")) as { TRANSITIONS: string[] }

test("every card design except classic has a CSS rule and is in overlay.js's own list", () => {
  const listed = overlayJs.match(/const CARD_DESIGNS = \[([^\]]*)\]/)
  assert.ok(listed, "overlay.js CARD_DESIGNS not found")
  const inJs = [...(listed[1] ?? "").matchAll(/"([a-z-]+)"/g)].map((m) => m[1])
  assert.deepEqual(inJs, OVERLAY_CARD_DESIGNS.filter((d) => d !== "classic"))
  for (const design of inJs) {
    assert.ok(overlayHtml.includes(`#verse-card.tpl-${design} {`), `index.html has no base rule for tpl-${design}`)
  }
})

test("every card design and transition has an English and a French name", () => {
  for (const design of OVERLAY_CARD_DESIGNS) {
    const keys = [...i18n.matchAll(new RegExp(`"overlayTemplate\\.${design}":`, "g"))]
    assert.equal(keys.length, 2, `overlayTemplate.${design} must exist once in English and once in French`)
  }
  for (const transition of OVERLAY_TRANSITIONS) {
    const keys = [...i18n.matchAll(new RegExp(`"overlayTransition\\.${transition}":`, "g"))]
    assert.equal(keys.length, 2, `overlayTransition.${transition} must exist in both languages`)
  }
})

test("the overlay's transition list matches the contract", () => {
  assert.deepEqual(motion.TRANSITIONS, [...OVERLAY_TRANSITIONS])
})

test("the overlay page loads verse-motion.js before overlay.js", () => {
  const a = overlayHtml.indexOf('<script src="verse-motion.js"></script>')
  const b = overlayHtml.indexOf('<script src="overlay.js"></script>')
  assert.ok(a > 0 && b > a)
})

test("verse text reaches the DOM only through textContent: no innerHTML in the verse path", () => {
  const verseCode = overlayJs.slice(overlayJs.indexOf("function renderWords"), overlayJs.indexOf("function clearVerse()"))
  assert.ok(verseCode.length > 500, "verse rendering code not found")
  assert.ok(!/innerHTML|insertAdjacentHTML|outerHTML/.test(verseCode))
  const motionJs = read("apps", "overlay", "public", "verse-motion.js")
  assert.ok(!/innerHTML|document\.|fetch\(|WebSocket/.test(motionJs), "verse-motion.js stays pure")
})

test("the overlay stays read-only: overlay.js never sends on its socket", () => {
  assert.ok(!/\bws\.send\(/.test(overlayJs))
})

test("reduced motion: the overlay page has a prefers-reduced-motion block for the verse card", () => {
  const block = overlayHtml.slice(overlayHtml.lastIndexOf("@media (prefers-reduced-motion: reduce)"))
  assert.ok(block.includes("#verse, #verse.visible"))
  assert.ok(block.includes("animation: none !important"))
})
