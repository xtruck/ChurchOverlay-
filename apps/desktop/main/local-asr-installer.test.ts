import { test } from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
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

// ---- Model download hardening (ARCHITECTURE.md section 117) ----

const MODEL = Buffer.from("0123456789".repeat(100)) // 1000 bytes
const ENGINE_ZIP = makeZip(FILES)

type ModelReply = (range: string | null) => Response

/** Injected fetch: the engine zip always, the model from a per-test script; records each model request's Range. */
function scriptedInstaller(dir: string, modelReply: ModelReply, opts: { freeBytes?: number | null; sha1?: string } = {}) {
  const ranges: Array<string | null> = []
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).endsWith("/engine.zip")) return new Response(ENGINE_ZIP, { status: 200, headers: { "content-length": String(ENGINE_ZIP.length) } })
    const range = new Headers(init?.headers).get("range")
    ranges.push(range)
    return modelReply(range)
  }) as typeof fetch
  const installer = new LocalAsrInstaller({
    rootDir: dir,
    platform: "win32",
    arch: "x64",
    fetchImpl,
    freeBytes: async () => (opts.freeBytes === undefined ? 10 * 1024 * 1024 * 1024 : opts.freeBytes),
    release: { url: "https://fixture/engine.zip", sha256: createHash("sha256").update(ENGINE_ZIP).digest("hex"), files: WANTED },
    models: {
      base: { file: "m.bin", url: "https://fixture/model.bin", sha1: opts.sha1 ?? createHash("sha1").update(MODEL).digest("hex"), approxMb: 1 },
      small: { file: "s.bin", url: "https://fixture/none", sha1: "x", approxMb: 1 },
    },
  })
  return { installer, ranges }
}

function full(): Response {
  return new Response(MODEL, { status: 200, headers: { "content-length": String(MODEL.length) } })
}

function partialFrom(range: string | null): Response {
  const start = Number(/bytes=(\d+)-/.exec(range ?? "")?.[1] ?? 0)
  const body = MODEL.subarray(start)
  return new Response(body, {
    status: 206,
    headers: { "content-length": String(body.length), "content-range": `bytes ${start}-${MODEL.length - 1}/${MODEL.length}` },
  })
}

test("LocalAsrInstaller: an interrupted model download resumes with an HTTP Range request", async () => {
  const dir = await mkdtemp(join(tmpdir(), "co-asr-"))
  try {
    const { installer, ranges } = scriptedInstaller(dir, (range) => (range ? partialFrom(range) : full()))
    await mkdir(join(dir, "models"), { recursive: true })
    await writeFile(`${installer.modelPath("base")}.partial`, MODEL.subarray(0, 400))
    const result = await installer.install("base")
    assert.equal(result.state, "ready")
    assert.deepEqual(ranges, ["bytes=400-"], "only the missing bytes are requested")
    assert.deepEqual(await readFile(installer.modelPath("base")), MODEL)
    await assert.rejects(stat(`${installer.modelPath("base")}.partial`), "the partial is renamed into place")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("LocalAsrInstaller: a server that ignores Range rewrites the partial from zero (no duplicated bytes)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "co-asr-"))
  try {
    const { installer } = scriptedInstaller(dir, () => full())
    await mkdir(join(dir, "models"), { recursive: true })
    await writeFile(`${installer.modelPath("base")}.partial`, MODEL.subarray(0, 400))
    assert.equal((await installer.install("base")).state, "ready")
    assert.deepEqual(await readFile(installer.modelPath("base")), MODEL)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("LocalAsrInstaller: a cut connection is not taken as complete; the next attempt resumes and verifies", async () => {
  const dir = await mkdtemp(join(tmpdir(), "co-asr-"))
  try {
    let attempt = 0
    const { installer, ranges } = scriptedInstaller(dir, (range) => {
      attempt += 1
      // First attempt: the server declares 1000 bytes but the body stops at 600.
      if (attempt === 1) return new Response(MODEL.subarray(0, 600), { status: 200, headers: { "content-length": String(MODEL.length) } })
      return partialFrom(range)
    })
    const first = await installer.install("base")
    assert.equal(first.state, "error")
    assert.match((first as { error: string }).error, /incomplete/)
    await assert.rejects(stat(installer.modelPath("base")), "nothing is installed")
    assert.equal((await stat(`${installer.modelPath("base")}.partial`)).size, 600, "the bytes received are kept for resume")
    assert.equal((await installer.install("base")).state, "ready")
    assert.deepEqual(ranges, [null, "bytes=600-"])
    assert.deepEqual(await readFile(installer.modelPath("base")), MODEL)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("LocalAsrInstaller: refuses to start a model download without ~1.2x its size free", async () => {
  const dir = await mkdtemp(join(tmpdir(), "co-asr-"))
  try {
    const { installer, ranges } = scriptedInstaller(dir, () => full(), { freeBytes: 1024 * 1024 }) // 1 MB free, 1.2 MB needed
    const result = await installer.install("base")
    assert.equal(result.state, "error")
    assert.match((result as { error: string }).error, /disk space/)
    assert.deepEqual(ranges, [], "the model was never requested")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("LocalAsrInstaller: a resumed model that fails its hash is deleted, never installed, never resumed again", async () => {
  const dir = await mkdtemp(join(tmpdir(), "co-asr-"))
  try {
    const { installer } = scriptedInstaller(dir, (range) => (range ? partialFrom(range) : full()))
    await mkdir(join(dir, "models"), { recursive: true })
    await writeFile(`${installer.modelPath("base")}.partial`, Buffer.from("X".repeat(400))) // corrupt prefix
    const result = await installer.install("base")
    assert.equal(result.state, "error")
    assert.match((result as { error: string }).error, /verification/)
    await assert.rejects(stat(installer.modelPath("base")))
    await assert.rejects(stat(`${installer.modelPath("base")}.partial`))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("LocalAsrInstaller: a body larger than the model can be is refused mid-stream", async () => {
  const dir = await mkdtemp(join(tmpdir(), "co-asr-"))
  try {
    const huge = Buffer.alloc(2 * 1024 * 1024, 1) // approxMb 1 -> limit 1.5 MB; no content-length declared
    const { installer } = scriptedInstaller(dir, () => new Response(new Blob([huge]).stream(), { status: 200 }))
    const result = await installer.install("base")
    assert.equal(result.state, "error")
    assert.match((result as { error: string }).error, /exceeded/)
    await assert.rejects(stat(installer.modelPath("base")))
  } finally {
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
