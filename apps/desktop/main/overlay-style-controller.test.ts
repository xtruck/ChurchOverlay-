import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { OverlayStyle, OverlayStyleSettings } from "../../../packages/contracts/overlay-style"
import { defaultOverlayStyleSettings, normalizeOverlayStyleSettings, resolveOverlayStyle } from "../../server/overlay/overlay-style"
import { LogoRejectedError } from "./brand-logo"
import { OverlayStyleController, type OverlayStyleCore } from "./overlay-style-controller"

class FakeOverlayStyleCore implements OverlayStyleCore {
  settings = defaultOverlayStyleSettings()
  revision = 1
  broadcasts: OverlayStyle[] = []
  getOverlayStyle(): OverlayStyle {
    return resolveOverlayStyle(this.settings, this.revision)
  }
  setOverlayStyle(raw: unknown): OverlayStyle {
    this.settings = normalizeOverlayStyleSettings(raw)
    this.revision++
    const style = this.getOverlayStyle()
    this.broadcasts.push(style)
    return style
  }
}

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(8)])

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "churchoverlay-style-ctl-"))
  const core = new FakeOverlayStyleCore()
  const persisted: OverlayStyleSettings[] = []
  const logs: string[] = []
  const controller = new OverlayStyleController({
    getCore: () => core,
    persist: async (s) => void persisted.push(s),
    logoPath: join(dir, "brand", "logo.png"),
    decodeLogo: () => ({ width: 10, height: 10, toPng: () => PNG }),
    log: (event) => logs.push(event),
    debounceMs: 5,
  })
  return { dir, core, controller, persisted, logs, done: () => rm(dir, { recursive: true, force: true }) }
}

test("apply() normalizes, broadcasts live, and persists only the last of a burst (debounced)", async () => {
  const t = await setup()
  try {
    for (let x = 1; x <= 20; x++) t.controller.apply({ paletteId: "ocean", brand: { name: { x, text: "Grace" } } })
    assert.equal(t.core.broadcasts.length, 20)
    assert.equal(t.persisted.length, 0)
    await t.controller.flush()
    assert.equal(t.persisted.length, 1)
    assert.equal(t.persisted[0]!.brand.name.x, 20)
    assert.equal(t.persisted[0]!.paletteId, "ocean")
  } finally {
    await t.done()
  }
})

test("apply() cannot forge the logo version (it is owned by the controller)", async () => {
  const t = await setup()
  try {
    const style = t.controller.apply({ brand: { logo: { version: 99, visible: true } } })
    assert.equal(style.brand.logo.version, 0)
  } finally {
    await t.done()
  }
})

test("setLogo() stores the logo, bumps the version, shows it; clearLogo() removes it", async () => {
  const t = await setup()
  try {
    const src = join(t.dir, "src.png")
    await writeFile(src, PNG)
    const style = await t.controller.setLogo(src)
    assert.equal(style.brand.logo.version, 1)
    assert.equal(style.brand.logo.visible, true)
    assert.ok(t.controller.currentLogoPath())
    const again = await t.controller.setLogo(src)
    assert.equal(again.brand.logo.version, 2)
    const cleared = await t.controller.clearLogo()
    assert.equal(cleared.brand.logo.version, 0)
    assert.equal(cleared.brand.logo.visible, false)
    assert.equal(t.controller.currentLogoPath(), null)
    assert.equal(existsSync(join(t.dir, "brand", "logo.png")), false)
    await t.controller.flush()
    assert.equal(t.persisted.at(-1)!.brand.logo.version, 0)
  } finally {
    await t.done()
  }
})

test("a rejected logo changes nothing and surfaces the reason", async () => {
  const t = await setup()
  try {
    const src = join(t.dir, "evil.svg")
    await writeFile(src, "<svg><script>1</script></svg>")
    await assert.rejects(() => t.controller.setLogo(src), (e: unknown) => e instanceof LogoRejectedError && e.reason === "unsupported-format")
    assert.equal(t.core.broadcasts.length, 0)
    assert.equal(t.controller.get().brand.logo.version, 0)
  } finally {
    await t.done()
  }
})

test("a persist failure is logged, not thrown, and later edits still persist", async () => {
  const t = await setup()
  try {
    let fail = true
    const logs: string[] = []
    const c = new OverlayStyleController({
      getCore: () => t.core,
      persist: async () => {
        if (fail) throw new Error("disk full")
      },
      logoPath: join(t.dir, "l.png"),
      decodeLogo: () => null,
      log: (e) => logs.push(e),
      debounceMs: 1,
    })
    c.apply({ card: "glass" })
    await c.flush()
    assert.deepEqual(logs, ["persist-failed"])
    fail = false
    c.apply({ card: "ribbon" })
    await c.flush()
    assert.deepEqual(logs, ["persist-failed"])
  } finally {
    await t.done()
  }
})

test("with no running core every operation fails explicitly instead of silently dropping the edit", async () => {
  const c = new OverlayStyleController({ getCore: () => null, persist: async () => {}, logoPath: "x", decodeLogo: () => null, log: () => {} })
  assert.throws(() => c.apply({}), /not started/)
  assert.equal(c.currentLogoPath(), null)
})
