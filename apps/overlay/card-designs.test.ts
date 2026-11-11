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
const readBytes = (...p: string[]) => readFileSync(join(REPO_ROOT, ...p))
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
    assert.ok(overlayHtml.includes(`#verse.fullscreen #verse-card.tpl-${design} {`), `index.html has no fullscreen rule for tpl-${design}`)
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

test("optional nature backdrop is local-only, opt-in, muted, and respects reduced motion", () => {
  assert.match(overlayHtml, /id="nature-background-video" autoplay muted loop playsinline preload="none"/)
  assert.match(overlayHtml, /prefers-reduced-motion: reduce[\s\S]*?#nature-background-video \{ display: none; \}/)
  assert.match(overlayJs, /params\.get\("background"\) === "nature"/)
  assert.match(overlayJs, /"backgrounds\/nature-loop\.mp4"/)
  assert.match(overlayJs, /url\.origin !== window\.location\.origin/)
  const gallery = read("scripts", "card-gallery.mjs")
  const footageNote = read("apps", "overlay", "public", "backgrounds", "README.md")
  assert.ok(footageNote.includes("Astrella Visuals") && footageNote.includes("Pexels Free License"))
  assert.ok(gallery.includes("Nature loop (local)"))
  assert.ok(gallery.includes("__NATURE_VIDEO_SRC__"))
  assert.ok(gallery.includes("__setGalleryNatureBackground"))
  const sourceSetup = overlayJs.slice(overlayJs.indexOf("function syncNatureBackground"), overlayJs.indexOf("window.__setGalleryNatureBackground"))
  assert.ok(!/https?:\/\//.test(sourceSetup), "nature media source is never remote")
})

test("language-driven typography: English italic and French upright from data-language, in either slot and in every design", () => {
  // The language comes from the translation id, for the primary AND the secondary block.
  assert.match(overlayJs, /primaryLanguage = [\s\S]*?languageOf\(verse\.translation\)[\s\S]*?textEl\.dataset\.language = primaryLanguage/)
  assert.match(overlayJs, /secondaryLanguage = languageOf\(verse\.secondary\.translation\)[\s\S]*?secondaryTextEl\.dataset\.language = secondaryLanguage/)
  assert.match(overlayJs, /function languageOf\(translation\)[\s\S]*?FRENCH_TRANSLATIONS\.has/)
  // The reference parts carry their own language too.
  assert.match(overlayJs, /span\.dataset\.language = part\.language/)
  // The rule is keyed off data-language only, never off the primary/secondary slot or off bilingual mode.
  assert.match(overlayHtml, /#verse-card :is\(#verse-text, #verse-secondary-text\)\[data-language="en"\] \{ font-style: italic; \}/)
  assert.match(overlayHtml, /#verse-card :is\(#verse-text, #verse-secondary-text\)\[data-language="fr"\] \{ font-style: normal; \}/)
  assert.match(overlayHtml, /#verse-reference \.vc-ref-part\[data-language="en"\] \{ font-style: italic; \}/)
  assert.match(overlayHtml, /#verse-reference \.vc-ref-part\[data-language="fr"\] \{ font-style: normal; \}/)
  assert.ok(!/#verse\.bilingual[^{]*data-language/.test(overlayHtml), "italic must not depend on bilingual mode")
  // The secondary block no longer hard-codes italic (it used to, whatever its language).
  // (the shared "#verse-text, #verse-secondary-text" rule also starts a line with this selector)
  const secondaryBase = [...overlayHtml.matchAll(/^ {2}#verse-secondary-text \{[^}]*\}/gm)].map((m) => m[0]).find((r) => r.includes("display: none")) ?? ""
  assert.ok(secondaryBase.includes("display: none"), "secondary base rule found")
  assert.ok(!/font-(style|family|weight|size)|line-height|color:|text-shadow/.test(secondaryBase), "the secondary block's own rule carries layout only")
  // The language rules come after every design rule, so they win ties.
  const langRule = overlayHtml.indexOf('[data-language="en"] { font-style: italic; }')
  const lastDesign = overlayHtml.lastIndexOf("#verse.fullscreen #verse-card.tpl-folio {")
  assert.ok(langRule > lastDesign)
  // French keeps the family, weight and spacing of English: every design's typographic rule names both blocks.
  for (const design of OVERLAY_CARD_DESIGNS.filter((d) => d !== "classic")) {
    for (const m of overlayHtml.matchAll(new RegExp(`#verse-card\\.tpl-${design} #verse-text[,\\s{]`, "g"))) {
      const rule = overlayHtml.slice(m.index, overlayHtml.indexOf("}", m.index))
      const header = rule.slice(0, rule.indexOf("{"))
      // A shared rule lists #verse-secondary-text in its selector (split mirrors its own below).
      if (/font-family|font-weight|letter-spacing|line-height/.test(rule) && !header.includes("#verse-secondary-text") && design !== "split") {
        assert.fail(`tpl-${design}: a #verse-text-only typographic rule would style French and English differently: ${rule.slice(0, 80)}`)
      }
    }
  }
  assert.match(overlayHtml, /#verse-card\.tpl-split #verse-secondary-text \{\s+font-family: "Instrument Sans"/, "split mirrors its sans typography on the second language")
  assert.ok(overlayHtml.includes("#verse:not(.fullscreen) #verse-card") && overlayHtml.includes("max-height: 52vh"))
})

test("both language blocks are revealed word by word and the reference is built from per-language spans", () => {
  assert.match(overlayJs, /renderWords\(secondaryTextEl, String\(verse\.secondary\.text\), false\)/)
  assert.match(overlayJs, /function referenceParts\(verse, primaryLanguage\)/)
  assert.match(overlayJs, /function renderReference\(parts\)/)
  assert.ok(!/refEl\.textContent = formatVerseReference/.test(overlayJs))
})

test("verse auto-fit is a binary search over the frame-relative box, refit on resize and font load", () => {
  assert.match(overlayJs, /Motion\.largestFit\(limits\.minFontPx, limits\.maxFontPx, fits\)/)
  assert.match(overlayJs, /Motion\.fitLimits\([\s\S]*?\{ height: window\.innerHeight \}/)
  assert.match(overlayJs, /function cardContentHeight\(\)/)
  assert.doesNotMatch(overlayJs, /verseCardEl\.scrollHeight/, "decorative overflow must not inflate the measured height")
  assert.match(overlayJs, /addEventListener\("resize", scheduleRefit\)/)
  assert.match(overlayJs, /document\.fonts\.addEventListener\("loadingdone", scheduleRefit\)/)
  // One resize listener only (the old file registered two).
  assert.equal(overlayJs.match(/addEventListener\("resize"/g)?.length, 1)
})

test("fullscreen cards may use the full safe area, whatever width their design asked for", () => {
  assert.match(overlayHtml, /#verse\.fullscreen #verse-card\[class\] \{ max-width: 100%; \}/)
  const rule = overlayHtml.indexOf("#verse.fullscreen #verse-card[class] { max-width: 100%; }")
  assert.ok(rule > overlayHtml.lastIndexOf("#verse.fullscreen #verse-card.tpl-folio {"))
  // The reference scales with the verse type through one variable.
  assert.match(overlayHtml, /--ref-size: clamp\(3\.2vh, calc\(var\(--vc-font, 44px\) \* var\(--ref-k\)\), 11vh\);/)
  for (const m of overlayHtml.matchAll(/[^{}]*#verse-reference[^{}]*\{([^}]*)\}/g)) {
    const size = /font-size:\s*([^;]+);/.exec(m[1] ?? "")
    if (size) assert.equal(size[1], "var(--ref-size)", "every reference size derives from the verse type")
  }
})

test("verse auto-fit ignores decorative card overflow and measures displayed text", () => {
  assert.match(overlayJs, /function contentScrollWidth\(\)[\s\S]*?textEl\.scrollWidth[\s\S]*?secondaryTextEl\.scrollWidth[\s\S]*?refEl\.scrollWidth/)
  assert.doesNotMatch(overlayJs, /verseCardEl\.scrollWidth/)
})

test("the overlay stays read-only: overlay.js never sends on its socket", () => {
  assert.ok(!/\bws\.send\(/.test(overlayJs))
})

test("reduced motion: the overlay page has a prefers-reduced-motion block for the verse card", () => {
  const block = overlayHtml.slice(overlayHtml.lastIndexOf("@media (prefers-reduced-motion: reduce)"))
  assert.ok(block.includes("#verse, #verse.visible"))
  assert.ok(block.includes("animation: none !important"))
})

test("app icon PNG, Windows ICO and macOS ICNS carry the documented sizes and appear in the gallery", () => {
  const png = readBytes("assets", "icons", "icon.png")
  assert.equal(png.toString("hex", 0, 8), "89504e470d0a1a0a")
  assert.equal(png.readUInt32BE(16), 512)
  assert.equal(png.readUInt32BE(20), 512)

  const ico = readBytes("assets", "icons", "icon.ico")
  assert.equal(ico.readUInt16LE(0), 0)
  assert.equal(ico.readUInt16LE(2), 1)
  const count = ico.readUInt16LE(4)
  const sizes = Array.from({ length: count }, (_, i) => {
    const at = 6 + i * 16
    const size = ico[at] || 256
    const offset = ico.readUInt32LE(at + 12)
    assert.equal(ico.toString("hex", offset, offset + 8), "89504e470d0a1a0a")
    assert.equal(ico.readUInt32BE(offset + 16), size)
    assert.equal(ico.readUInt32BE(offset + 20), size)
    return size
  })
  assert.deepEqual(sizes, [16, 24, 32, 48, 64, 128, 256])

  const icns = readBytes("assets", "icons", "icon.icns")
  assert.equal(icns.toString("ascii", 0, 4), "icns")
  assert.equal(icns.readUInt32BE(4), icns.length)
  const chunkSizes: Record<string, number> = { icp4: 16, icp5: 32, ic11: 32, ic12: 64, ic07: 128, ic13: 256, ic08: 256, ic14: 512, ic09: 512, ic10: 1024 }
  const chunks: string[] = []
  for (let at = 8; at < icns.length;) {
    const length = icns.readUInt32BE(at + 4)
    assert.ok(length >= 8 && at + length <= icns.length)
    const type = icns.toString("ascii", at, at + 4)
    const pngAt = at + 8
    const expectedSize = chunkSizes[type]
    assert.equal(icns.toString("hex", pngAt, pngAt + 8), "89504e470d0a1a0a")
    assert.equal(icns.readUInt32BE(pngAt + 16), expectedSize)
    assert.equal(icns.readUInt32BE(pngAt + 20), expectedSize)
    chunks.push(type)
    at += length
  }
  assert.deepEqual(chunks, ["icp4", "icp5", "ic11", "ic12", "ic07", "ic13", "ic08", "ic14", "ic09", "ic10"])

  const touch = readBytes("apps", "remote", "public", "apple-touch-icon.png")
  assert.equal(touch.toString("hex", 0, 8), "89504e470d0a1a0a")
  assert.equal(touch.readUInt32BE(16), 180)
  assert.equal(touch.readUInt32BE(20), 180)
  const smallMark = read("assets", "icons", "logo-small.svg")
  for (const page of ["live", "remote"]) assert.equal(read("apps", page, "public", "favicon.svg"), smallMark)
  assert.ok(read("scripts", "card-gallery.mjs").includes("App icon refresh"))
})
