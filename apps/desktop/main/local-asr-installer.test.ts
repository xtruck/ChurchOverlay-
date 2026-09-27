import { test } from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { deflateRawSync } from "node:zlib"
import { LocalAsrInstaller, readZip, type LocalAsrInstallState } from "./local-asr-installer"

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

async function serve(routes: Record<string, Buffer>) {
  const server = createServer((req, res) => {
    const body = routes[req.url ?? ""]
    if (!body) return res.writeHead(404).end()
    res.writeHead(200, { "content-length": String(body.length) }).end(body)
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => new Promise<void>((r) => server.close(() => r())) }
}

const FILES = { "Release/whisper-server.exe": "EXE", "Release/whisper.dll": "DLL", "Release/extra.exe": "not wanted" }
const WANTED = ["Release/whisper-server.exe", "Release/whisper.dll"]

test("readZip: reads deflated entries by exact name", () => {
  const entries = readZip(makeZip(FILES))
  assert.equal(entries.get("Release/whisper-server.exe")?.toString(), "EXE")
  assert.equal(entries.size, 3)
})

test("LocalAsrInstaller: unsupported outside Windows x64", async () => {
  const installer = new LocalAsrInstaller({ rootDir: "/nonexistent", platform: "linux", arch: "x64" })
  assert.equal((await installer.status("base")).state, "unsupported")
})

test("LocalAsrInstaller: downloads, verifies, extracts only the needed files, reports progress, then ready", async () => {
  const zip = makeZip(FILES)
  const model = Buffer.from("model-bytes")
  const http = await serve({ "/engine.zip": zip, "/model.bin": model })
  const dir = await mkdtemp(join(tmpdir(), "co-asr-"))
  try {
    const installer = new LocalAsrInstaller({
      rootDir: dir,
      platform: "win32",
      arch: "x64",
      release: { url: `${http.base}/engine.zip`, sha256: createHash("sha256").update(zip).digest("hex"), files: WANTED },
      models: {
        base: { file: "m.bin", url: `${http.base}/model.bin`, sha1: createHash("sha1").update(model).digest("hex"), approxMb: 1 },
        small: { file: "s.bin", url: `${http.base}/none`, sha1: "x", approxMb: 1 },
      },
    })
    assert.equal((await installer.status("base")).state, "not-installed")
    const seen: LocalAsrInstallState[] = []
    const result = await installer.install("base", (s) => seen.push(s))
    assert.equal(result.state, "ready")
    assert.ok(seen.some((s) => s.state === "downloading" && s.step === "engine"))
    assert.ok(seen.some((s) => s.state === "downloading" && s.step === "model"))
    assert.equal((await readFile(installer.serverPath)).toString(), "EXE")
    await assert.rejects(readFile(join(installer.engineDir, "extra.exe")), "unwanted files are never written")
    assert.equal((await installer.status("base")).state, "ready")
  } finally {
    await http.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test("LocalAsrInstaller: a tampered engine archive is refused and nothing is extracted", async () => {
  const zip = makeZip(FILES)
  const http = await serve({ "/engine.zip": zip })
  const dir = await mkdtemp(join(tmpdir(), "co-asr-"))
  try {
    const installer = new LocalAsrInstaller({
      rootDir: dir,
      platform: "win32",
      arch: "x64",
      release: { url: `${http.base}/engine.zip`, sha256: "0".repeat(64), files: WANTED },
    })
    const result = await installer.install("base")
    assert.equal(result.state, "error")
    assert.match((result as { error: string }).error, /verification/)
    await assert.rejects(readFile(installer.serverPath))
  } finally {
    await http.close()
    await rm(dir, { recursive: true, force: true })
  }
})
