import { test } from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { LocalAsrInstaller, SILERO_VAD_MODEL, isPinnedSha256, type LocalVadInstallState, type VadModelSpec } from "./local-asr-installer"

// architecture-notes/offline-vad.md: the Silero VAD model download. No network: fetch is injected.

const VAD_BYTES = Buffer.from("fake-silero-vad-model-".repeat(40))
const VAD_SHA256 = createHash("sha256").update(VAD_BYTES).digest("hex")

function spec(overrides: Partial<VadModelSpec> = {}): VadModelSpec {
  return { file: "vad.bin", url: "https://fixture/vad.bin", sha256: VAD_SHA256, bytes: VAD_BYTES.length, ...overrides }
}

function installer(dir: string, body: () => Response, vadModel: VadModelSpec = spec(), platform: NodeJS.Platform = "win32") {
  const calls: string[] = []
  const fetchImpl = (async (url: string | URL | Request) => {
    calls.push(String(url))
    return body()
  }) as typeof fetch
  return { calls, installer: new LocalAsrInstaller({ rootDir: dir, platform, arch: "x64", fetchImpl, vadModel }) }
}

function ok(bytes: Buffer = VAD_BYTES): Response {
  return new Response(bytes, { status: 200, headers: { "content-length": String(bytes.length) } })
}

async function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "co-vad-"))
  try {
    await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test("SILERO_VAD_MODEL: pinned to an immutable revision with a well-formed SHA-256 and an exact size", () => {
  assert.ok(isPinnedSha256(SILERO_VAD_MODEL.sha256))
  assert.match(SILERO_VAD_MODEL.url, /^https:\/\/huggingface\.co\/ggml-org\/whisper-vad\/resolve\/[0-9a-f]{40}\//, "a commit, never 'main'")
  assert.ok(SILERO_VAD_MODEL.url.endsWith(`/${SILERO_VAD_MODEL.file}`))
  assert.ok(SILERO_VAD_MODEL.bytes > 0 && SILERO_VAD_MODEL.bytes < 2 * 1024 * 1024)
  assert.equal(isPinnedSha256(""), false)
  assert.equal(isPinnedSha256("ABC"), false)
})

test("VAD model: status is 'missing' before any download", async () => {
  await withDir(async (dir) => {
    const { installer: i } = installer(dir, ok)
    assert.deepEqual(await i.vadModelStatus(), { state: "missing" })
  })
})

test("VAD model: downloads, verifies the SHA-256, moves into place atomically, reports progress, then 'verified'", async () => {
  await withDir(async (dir) => {
    const { installer: i, calls } = installer(dir, ok)
    const seen: LocalVadInstallState[] = []
    const result = await i.installVadModel((s) => seen.push(s))
    assert.deepEqual(result, { state: "ready", modelPath: i.vadModelPath })
    assert.deepEqual(calls, ["https://fixture/vad.bin"])
    assert.deepEqual(await readFile(i.vadModelPath), VAD_BYTES)
    await assert.rejects(stat(`${i.vadModelPath}.partial`), "no partial left behind")
    assert.ok(seen.some((s) => s.state === "downloading"))
    assert.equal(seen.at(-1)?.state, "ready")
    assert.deepEqual(await i.vadModelStatus(), { state: "verified", path: i.vadModelPath })
    // Idempotent: a verified model is not downloaded again.
    await i.installVadModel()
    assert.equal(calls.length, 1)
  })
})

test("VAD model: a download with the wrong content is refused, deleted, and never installed", async () => {
  await withDir(async (dir) => {
    const tampered = Buffer.from(VAD_BYTES)
    tampered[0] = tampered[0]! ^ 0xff
    const { installer: i } = installer(dir, () => ok(tampered))
    const result = await i.installVadModel()
    assert.equal(result.state, "error")
    assert.match((result as { error: string }).error, /failed verification/)
    await assert.rejects(stat(i.vadModelPath))
    await assert.rejects(stat(`${i.vadModelPath}.partial`))
    assert.deepEqual(await i.vadModelStatus(), { state: "missing" })
  })
})

test("VAD model: a body larger than the pinned size is refused mid-stream (bounded download)", async () => {
  await withDir(async (dir) => {
    const { installer: i } = installer(dir, () => ok(Buffer.concat([VAD_BYTES, Buffer.from("extra")])))
    const result = await i.installVadModel()
    assert.equal(result.state, "error")
    assert.match((result as { error: string }).error, /larger than expected/)
    await assert.rejects(stat(i.vadModelPath))
  })
})

test("VAD model: an empty pinned checksum fails closed: no network request, status 'checksum-unpinned'", async () => {
  await withDir(async (dir) => {
    const { installer: i, calls } = installer(dir, ok, spec({ sha256: "" }))
    const result = await i.installVadModel()
    assert.equal(result.state, "error")
    assert.match((result as { error: string }).error, /not pinned/)
    assert.deepEqual(calls, [], "never downloads what it cannot verify")
    // Even a file already on disk is not trusted without a pinned checksum.
    await mkdir(join(dir, "models"), { recursive: true })
    await writeFile(i.vadModelPath, VAD_BYTES)
    assert.deepEqual(await i.vadModelStatus(), { state: "checksum-unpinned" })
  })
})

test("VAD model: a corrupt file on disk is reported 'corrupt' (size or hash) and replaced by the next install", async () => {
  await withDir(async (dir) => {
    const { installer: i, calls } = installer(dir, ok)
    await mkdir(join(dir, "models"), { recursive: true })
    await writeFile(i.vadModelPath, VAD_BYTES.subarray(0, 10))
    const truncated = await i.vadModelStatus()
    assert.equal(truncated.state, "corrupt")
    assert.match((truncated as { detail: string }).detail, /size/)

    const sameSize = Buffer.from(VAD_BYTES)
    sameSize[5] = sameSize[5]! ^ 0x01
    await writeFile(i.vadModelPath, sameSize)
    const flipped = await i.vadModelStatus()
    assert.equal(flipped.state, "corrupt")
    assert.match((flipped as { detail: string }).detail, /sha256/)

    assert.equal((await i.installVadModel()).state, "ready")
    assert.equal(calls.length, 1)
    assert.deepEqual(await i.vadModelStatus(), { state: "verified", path: i.vadModelPath })
  })
})

test("VAD model: unsupported outside Windows x64, like the engine itself", async () => {
  await withDir(async (dir) => {
    const { installer: i, calls } = installer(dir, ok, spec(), "linux")
    assert.equal((await i.installVadModel()).state, "unsupported")
    assert.deepEqual(calls, [])
  })
})

test("VAD model: an HTTP failure is an explicit error, nothing is installed", async () => {
  await withDir(async (dir) => {
    const { installer: i } = installer(dir, () => new Response("nope", { status: 503 }))
    const result = await i.installVadModel()
    assert.equal(result.state, "error")
    assert.match((result as { error: string }).error, /503/)
    await assert.rejects(stat(i.vadModelPath))
  })
})
