import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { LOGO_MAX_INPUT_BYTES, LogoRejectedError, detectLogoFormat, importBrandLogo, normalizeLogo, type LogoDecoder } from "./brand-logo"

const PNG_HEAD = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const png = (extra = 8): Buffer => Buffer.concat([PNG_HEAD, Buffer.alloc(extra)])

/** Named per AGENTS.md section 45: a stand-in for the Electron nativeImage decoder. */
const fakeDecoder = (width: number, height: number): LogoDecoder => () => ({ width, height, toPng: () => png(4) })

test("detectLogoFormat decides by magic bytes, never by name, and refuses SVG/HTML/garbage", () => {
  assert.equal(detectLogoFormat(png()), "png")
  assert.equal(detectLogoFormat(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0])), "jpeg")
  assert.equal(detectLogoFormat(Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8 ")])), "webp")
  assert.equal(detectLogoFormat(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>')), null)
  assert.equal(detectLogoFormat(Buffer.from("<html>")), null)
  assert.equal(detectLogoFormat(Buffer.alloc(0)), null)
})

test("normalizeLogo rejects empty, oversize, SVG, undecodable and huge-pixel images with a reason", () => {
  const reason = (fn: () => unknown): string => {
    try {
      fn()
    } catch (e) {
      assert.ok(e instanceof LogoRejectedError)
      return e.reason
    }
    return "accepted"
  }
  assert.equal(reason(() => normalizeLogo(Buffer.alloc(0), fakeDecoder(10, 10))), "empty")
  assert.equal(reason(() => normalizeLogo(Buffer.concat([PNG_HEAD, Buffer.alloc(LOGO_MAX_INPUT_BYTES)]), fakeDecoder(10, 10))), "too-large")
  assert.equal(reason(() => normalizeLogo(Buffer.from("<svg/>"), fakeDecoder(10, 10))), "unsupported-format")
  assert.equal(reason(() => normalizeLogo(png(), () => null)), "undecodable")
  assert.equal(reason(() => normalizeLogo(png(), fakeDecoder(5000, 10))), "too-many-pixels")
  assert.equal(reason(() => normalizeLogo(png(), fakeDecoder(100, 100))), "accepted")
})

test("importBrandLogo stores a normalized PNG atomically and leaves no temp file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "churchoverlay-logo-import-"))
  try {
    const src = join(dir, "in.png")
    const dest = join(dir, "brand", "logo.png")
    await writeFile(src, png(64))
    await importBrandLogo(src, dest, fakeDecoder(200, 100))
    assert.deepEqual(await readFile(dest), png(4))
    assert.deepEqual(await readdir(join(dir, "brand")), ["logo.png"])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("importBrandLogo refuses an oversize file before reading it and keeps the previous logo", async () => {
  const dir = await mkdtemp(join(tmpdir(), "churchoverlay-logo-import-"))
  try {
    const src = join(dir, "big.png")
    const dest = join(dir, "logo.png")
    await writeFile(dest, "previous")
    await writeFile(src, Buffer.concat([PNG_HEAD, Buffer.alloc(LOGO_MAX_INPUT_BYTES)]))
    await assert.rejects(() => importBrandLogo(src, dest, fakeDecoder(10, 10)), LogoRejectedError)
    assert.equal(await readFile(dest, "utf8"), "previous")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
