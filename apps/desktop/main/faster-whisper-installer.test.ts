import { test } from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { mkdtemp, readFile, rm, writeFile, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { deflateRawSync } from "node:zlib"
import { FasterWhisperInstaller, type FasterWhisperInstallState } from "./faster-whisper-installer"

/** Builds a small valid zip (deflate) in memory. */
function makeZip(files: Record<string, string>): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content)
    const compressed = deflateRawSync(data)
    const nameBuf = Buffer.from(name)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(8, 8)
    local.writeUInt32LE(compressed.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(8, 10)
    central.writeUInt32LE(compressed.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt32LE(offset, 42)
    locals.push(local, nameBuf, compressed)
    centrals.push(central, nameBuf)
    offset += 30 + nameBuf.length + compressed.length
  }
  const centralBuf = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(Object.keys(files).length, 8)
  eocd.writeUInt16LE(Object.keys(files).length, 10)
  eocd.writeUInt32LE(centralBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, centralBuf, eocd])
}

const sha = (data: Buffer) => createHash("sha256").update(data).digest("hex")

async function serve(routes: Record<string, Buffer>) {
  const server = createServer((req, res) => {
    const body = routes[req.url ?? ""]
    if (!body) return res.writeHead(404).end()
    res.writeHead(200, { "content-length": String(body.length) }).end(body)
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => new Promise<void>((r) => server.close(() => r())) }
}

async function withFixture(
  run: (ctx: { root: string; sidecar: string; base: string; pyZip: Buffer; wheel: Buffer; model: Buffer }) => Promise<void>,
  overrides: { wheel?: Buffer } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "fw-installer-"))
  const pyZip = makeZip({ "python.exe": "PY", "python312._pth": "placeholder" })
  const wheel = overrides.wheel ?? makeZip({ "pkg/__init__.py": "x = 1", "pkg-1.0.dist-info/METADATA": "m" })
  const model = Buffer.from("MODELBIN")
  const config = Buffer.from("{}")
  const server = await serve({ "/py.zip": pyZip, "/pkg.whl": wheel, "/model.bin": model, "/config.json": config })
  const sidecar = join(root, "server.py")
  await writeFile(sidecar, "print('sidecar')")
  try {
    await run({ root, sidecar, base: server.base, pyZip, wheel, model })
  } finally {
    await server.close()
    await rm(root, { recursive: true, force: true })
  }
}

function manifestFor(base: string, pyZip: Buffer, wheelHash: string, model: Buffer) {
  return {
    python: { version: "3.12.10", url: `${base}/py.zip`, sha256: sha(pyZip), size: pyZip.length },
    wheels: [{ file: "pkg-1.0-py3-none-any.whl", url: `${base}/pkg.whl`, sha256: wheelHash, size: 1 }],
    models: {
      base: {
        revision: "r",
        files: [
          { path: "model.bin", url: `${base}/model.bin`, sha256: sha(model), size: model.length },
          { path: "config.json", url: `${base}/config.json`, sha256: sha(Buffer.from("{}")), size: 2 },
        ],
      },
      small: { revision: "r", files: [] },
    },
  }
}

test("FasterWhisperInstaller: unsupported outside Windows x64", async () => {
  const installer = new FasterWhisperInstaller({ rootDir: "/nonexistent", sidecarSource: "/nonexistent", platform: "linux", arch: "x64" })
  assert.equal((await installer.status("base")).state, "unsupported")
  assert.equal((await installer.install("base")).state, "unsupported")
})

test("FasterWhisperInstaller: downloads, verifies, extracts, reports progress, then ready", async () => {
  await withFixture(async ({ root, sidecar, base, pyZip, wheel, model }) => {
    const installer = new FasterWhisperInstaller({
      rootDir: join(root, "fw"),
      sidecarSource: sidecar,
      platform: "win32",
      arch: "x64",
      manifest: manifestFor(base, pyZip, sha(wheel), model),
    })
    assert.equal((await installer.status("base")).state, "not-installed")
    const seen: FasterWhisperInstallState[] = []
    const result = await installer.install("base", (state) => seen.push(state))
    assert.equal(result.state, "ready")
    assert.ok(seen.some((s) => s.state === "downloading" && s.step === "engine"))
    assert.ok(seen.some((s) => s.state === "downloading" && s.step === "model"))
    assert.equal(await readFile(join(root, "fw", "python", "Lib", "site-packages", "pkg", "__init__.py"), "utf8"), "x = 1")
    // The embeddable Python only sees site-packages through its ._pth file.
    assert.match(await readFile(join(root, "fw", "python", "python312._pth"), "utf8"), /Lib\\site-packages/)
    assert.equal(await readFile(join(root, "fw", "sidecar", "server.py"), "utf8"), "print('sidecar')")
    assert.equal((await installer.status("base")).state, "ready")
    await assert.rejects(stat(join(root, "fw", "python.staging")))
  })
})

test("FasterWhisperInstaller: a tampered wheel is refused and no engine is marked installed", async () => {
  await withFixture(async ({ root, sidecar, base, pyZip, model }) => {
    const installer = new FasterWhisperInstaller({
      rootDir: join(root, "fw"),
      sidecarSource: sidecar,
      platform: "win32",
      arch: "x64",
      manifest: manifestFor(base, pyZip, "0".repeat(64), model),
    })
    const result = await installer.install("base")
    assert.equal(result.state, "error")
    assert.match((result as { error: string }).error, /verification/)
    assert.equal((await installer.status("base")).state, "not-installed")
    await assert.rejects(stat(join(root, "fw", "engine.json")))
  })
})

test("FasterWhisperInstaller: a wheel entry that escapes site-packages is refused", async () => {
  const evil = makeZip({ "../../escaped.txt": "boom" })
  await withFixture(
    async ({ root, sidecar, base, pyZip, model, wheel }) => {
      const installer = new FasterWhisperInstaller({
        rootDir: join(root, "fw"),
        sidecarSource: sidecar,
        platform: "win32",
        arch: "x64",
        manifest: manifestFor(base, pyZip, sha(wheel), model),
      })
      const result = await installer.install("base")
      assert.equal(result.state, "error")
      assert.match((result as { error: string }).error, /escapes/)
      await assert.rejects(stat(join(root, "fw", "python.staging", "escaped.txt")))
    },
    { wheel: evil },
  )
})

test("FasterWhisperInstaller: a refreshed sidecar replaces the installed copy on status()", async () => {
  await withFixture(async ({ root, sidecar, base, pyZip, wheel, model }) => {
    const installer = new FasterWhisperInstaller({
      rootDir: join(root, "fw"),
      sidecarSource: sidecar,
      platform: "win32",
      arch: "x64",
      manifest: manifestFor(base, pyZip, sha(wheel), model),
    })
    await installer.install("base")
    await writeFile(sidecar, "print('v2')")
    assert.equal((await installer.status("base")).state, "ready")
    assert.equal(await readFile(join(root, "fw", "sidecar", "server.py"), "utf8"), "print('v2')")
  })
})
