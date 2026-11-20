import { test } from "node:test"
import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import type { spawn } from "node:child_process"
import {
  buildWhisperCppServerArgs,
  parseVadCapability,
  probeWhisperVadSupport,
  resolveLocalVad,
  type VadCapability,
  type VadModelState,
} from "./whisper-vad"
import { WhisperServerProcess } from "./local-whisper-server"

// architecture-notes/offline-vad.md. No real binary, no network.

/** Excerpt of whisper-server v1.8.0 `--help` (examples/server/server.cpp, whisper_print_usage). */
const V180_HELP = `
usage: whisper-server.exe [options]

options:
  -h,        --help              [default] show this help message and exit
  -t N,      --threads N         [4      ] number of threads to use during computation
  -sns,      --suppress-nst      [false  ] suppress non-speech tokens

Voice Activity Detection (VAD) options:
             --vad                           [false  ] enable Voice Activity Detection (VAD)
  -vm FNAME, --vad-model FNAME               [       ] VAD model path
  -vt N,     --vad-threshold N               [0.50   ] VAD threshold for speech recognition
`

const OLD_HELP = `
usage: whisper-server.exe [options]
  -t N,      --threads N         [4      ] number of threads to use during computation
  -sns,      --suppress-nst      [false  ] suppress non-speech tokens
`

test("buildWhisperCppServerArgs: without a VAD model the command line is unchanged (no --vad at all)", () => {
  const args = buildWhisperCppServerArgs({ modelPath: "C:/m/ggml-base.bin", port: 4321, threads: 4 })
  assert.deepEqual(args, ["-m", "C:/m/ggml-base.bin", "--host", "127.0.0.1", "--port", "4321", "-t", "4", "-l", "auto", "-nt", "-sns"])
  assert.deepEqual(buildWhisperCppServerArgs({ modelPath: "m", port: 1, threads: 2, vadModelPath: null }).includes("--vad"), false)
  assert.deepEqual(buildWhisperCppServerArgs({ modelPath: "m", port: 1, threads: 2, vadModelPath: "" }).includes("--vad"), false)
})

test("buildWhisperCppServerArgs: a verified VAD model adds --vad --vad-model <path>, after the existing flags", () => {
  const args = buildWhisperCppServerArgs({ modelPath: "m", port: 1, threads: 2, vadModelPath: "C:/m/ggml-silero-v5.1.2.bin" })
  assert.deepEqual(args.slice(-3), ["--vad", "--vad-model", "C:/m/ggml-silero-v5.1.2.bin"])
  assert.ok(args.includes("-sns"), "non-speech token suppression stays on")
})

test("parseVadCapability: v1.8.0 help lists both flags; an older build or empty output is unsupported with a reason", () => {
  assert.deepEqual(parseVadCapability(V180_HELP), { supported: true })
  const old = parseVadCapability(OLD_HELP)
  assert.equal(old.supported, false)
  assert.match((old as { reason: string }).reason, /does not list/)
  const empty = parseVadCapability("  \n")
  assert.equal(empty.supported, false)
  assert.match((empty as { reason: string }).reason, /no help text/)
  // --vad-threshold alone is not proof of --vad / --vad-model.
  assert.equal(parseVadCapability("  -vt N, --vad-threshold N").supported, false)
  assert.equal(parseVadCapability("  -vm FNAME, --vad-model FNAME").supported, false, "--vad-model without --vad")
})

class FakeProbeChild extends EventEmitter {
  exitCode: number | null = null
  killed = 0
  readonly stdout = new EventEmitter()
  readonly stderr = new EventEmitter()
  kill(): boolean {
    this.killed += 1
    this.exitCode = 1
    setImmediate(() => this.emit("close", 1))
    return true
  }
}

function fakeSpawn(script: (child: FakeProbeChild) => void, seen: Array<{ cmd: string; args: string[] }> = []) {
  return ((cmd: string, args: string[]) => {
    seen.push({ cmd, args })
    const child = new FakeProbeChild()
    setImmediate(() => script(child))
    return child
  }) as unknown as typeof spawn
}

test("probeWhisperVadSupport: runs '<engine> --help' and reads the help from stderr", async () => {
  const seen: Array<{ cmd: string; args: string[] }> = []
  const spawnImpl = fakeSpawn((child) => {
    child.stderr.emit("data", Buffer.from(V180_HELP.slice(0, 200)))
    child.stderr.emit("data", Buffer.from(V180_HELP.slice(200)))
    child.exitCode = 0
    child.emit("close", 0)
  }, seen)
  assert.deepEqual(await probeWhisperVadSupport("C:/e/whisper-server.exe", { spawnImpl }), { supported: true })
  assert.deepEqual(seen, [{ cmd: "C:/e/whisper-server.exe", args: ["--help"] }])
})

test("probeWhisperVadSupport: an old build is reported unsupported", async () => {
  const spawnImpl = fakeSpawn((child) => {
    child.stdout.emit("data", Buffer.from(OLD_HELP))
    child.emit("close", 0)
  })
  assert.equal((await probeWhisperVadSupport("w.exe", { spawnImpl })).supported, false)
})

test("probeWhisperVadSupport: a spawn error is an explicit unsupported, never a throw", async () => {
  const spawnImpl = fakeSpawn((child) => child.emit("error", new Error("spawn w.exe ENOENT")))
  const result = await probeWhisperVadSupport("w.exe", { spawnImpl })
  assert.equal(result.supported, false)
  assert.match((result as { reason: string }).reason, /ENOENT/)
  const throwing = (() => {
    throw new Error("EACCES")
  }) as unknown as typeof spawn
  const thrown = await probeWhisperVadSupport("w.exe", { spawnImpl: throwing })
  assert.match((thrown as { reason: string }).reason, /EACCES/)
})

test("probeWhisperVadSupport: a hung engine is killed after the timeout and reported unsupported", async () => {
  let probeChild: FakeProbeChild | null = null
  const spawnImpl = fakeSpawn((child) => {
    probeChild = child // never prints, never exits
  })
  const result = await probeWhisperVadSupport("w.exe", { spawnImpl, timeoutMs: 20 })
  assert.equal(result.supported, false)
  assert.match((result as { reason: string }).reason, /timed out/)
  assert.equal((probeChild as unknown as FakeProbeChild).killed, 1)
})

function resolveWith(overrides: {
  enabled?: boolean
  engine?: "whisper.cpp" | "faster-whisper"
  engineReady?: boolean
  model?: VadModelState
  probe?: VadCapability
}) {
  const calls = { model: 0, probe: 0 }
  const promise = resolveLocalVad({
    enabled: overrides.enabled ?? true,
    engine: overrides.engine ?? "whisper.cpp",
    engineReady: overrides.engineReady ?? true,
    model: async () => {
      calls.model += 1
      return overrides.model ?? { state: "verified", path: "C:/m/vad.bin" }
    },
    probe: async () => {
      calls.probe += 1
      return overrides.probe ?? { supported: true }
    },
  })
  return { promise, calls }
}

test("resolveLocalVad: OFF by default does no work at all", async () => {
  const { promise, calls } = resolveWith({ enabled: false })
  assert.deepEqual(await promise, { state: "off" })
  assert.deepEqual(calls, { model: 0, probe: 0 })
})

test("resolveLocalVad: active only when enabled, whisper.cpp, engine ready, model verified and binary supports it", async () => {
  const { promise, calls } = resolveWith({})
  assert.deepEqual(await promise, { state: "active", modelPath: "C:/m/vad.bin" })
  assert.deepEqual(calls, { model: 1, probe: 1 })
})

test("resolveLocalVad: every failure is an explicit 'unavailable' with its reason (no silent fallback)", async () => {
  assert.deepEqual(await resolveWith({ engine: "faster-whisper" }).promise, {
    state: "unavailable",
    reason: "engine-unsupported",
    detail: "VAD is only wired for the whisper.cpp engine.",
  })
  assert.deepEqual(await resolveWith({ engineReady: false }).promise, { state: "unavailable", reason: "local-engine-not-ready" })
  assert.deepEqual(await resolveWith({ model: { state: "missing" } }).promise, { state: "unavailable", reason: "model-missing" })
  assert.deepEqual(await resolveWith({ model: { state: "checksum-unpinned" } }).promise, { state: "unavailable", reason: "checksum-unpinned" })
  assert.deepEqual(await resolveWith({ model: { state: "corrupt", detail: "sha256 mismatch" } }).promise, {
    state: "unavailable",
    reason: "model-corrupt",
    detail: "sha256 mismatch",
  })
  assert.deepEqual(await resolveWith({ probe: { supported: false, reason: "old build" } }).promise, {
    state: "unavailable",
    reason: "binary-unsupported",
    detail: "old build",
  })
})

test("resolveLocalVad: a missing or corrupt model never reaches the binary probe", async () => {
  for (const model of [{ state: "missing" }, { state: "corrupt", detail: "x" }, { state: "checksum-unpinned" }] as const) {
    const { promise, calls } = resolveWith({ model })
    await promise
    assert.equal(calls.probe, 0, model.state)
  }
})

class FakeServerChild extends EventEmitter {
  exitCode: number | null = null
  readonly stderr = new EventEmitter()
  kill(): boolean {
    this.exitCode = 1
    return true
  }
}

async function argsSpawnedWith(options: { vadModelPath?: string | null; buildArgs?: (port: number, threads: number) => string[] }): Promise<string[]> {
  const seen: string[][] = []
  const spawnImpl = ((_cmd: string, args: string[]) => {
    seen.push(args)
    return new FakeServerChild()
  }) as unknown as typeof spawn
  const fetchImpl = (() => Promise.resolve(new Response('{"status":"ok"}', { status: 200 }))) as typeof fetch
  const server = new WhisperServerProcess({ serverPath: "C:/e/w.exe", modelPath: "m", spawnImpl, fetchImpl, threads: 2, ...options })
  await server.ensureStarted()
  await server.stop()
  return seen[0]!
}

test("WhisperServerProcess: passes the VAD flags only when given a verified model path", async () => {
  assert.equal((await argsSpawnedWith({})).includes("--vad"), false)
  assert.equal((await argsSpawnedWith({ vadModelPath: null })).includes("--vad"), false)
  assert.deepEqual((await argsSpawnedWith({ vadModelPath: "C:/m/vad.bin" })).slice(-3), ["--vad", "--vad-model", "C:/m/vad.bin"])
  // The faster-whisper sidecar builds its own command line: no whisper.cpp flags leak into it.
  const sidecar = await argsSpawnedWith({ vadModelPath: "C:/m/vad.bin", buildArgs: (port) => ["server.py", "--port", String(port)] })
  assert.equal(sidecar.includes("--vad"), false)
})
