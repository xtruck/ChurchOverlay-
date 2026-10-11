import { test } from "node:test"
import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import type { spawn } from "node:child_process"
import { WhisperServerProcess, watchSystemResume } from "./local-whisper-server"
import { Logger } from "../../../packages/shared/logger"

/** A stand-in child process: never really spawned, killed on request. */
class FakeChild extends EventEmitter {
  exitCode: number | null = null
  killed = 0
  readonly stderr = new EventEmitter()
  kill(): boolean {
    this.killed += 1
    this.exitCode = 1
    setImmediate(() => this.emit("exit", 1))
    return true
  }
}

type Health = "ok" | "hung" | "down"

function harness() {
  const children: FakeChild[] = []
  const state = { health: "ok" as Health, healthCalls: 0 }
  const spawnImpl = (() => {
    const child = new FakeChild()
    children.push(child)
    if (children.length > 1) state.health = "ok" // a fresh process answers
    return child
  }) as unknown as typeof spawn
  const fetchImpl = ((_url: string | URL | Request, init?: RequestInit) => {
    state.healthCalls += 1
    if (state.health === "ok") return Promise.resolve(new Response('{"status":"ok"}', { status: 200 }))
    if (state.health === "down") return Promise.reject(new TypeError("fetch failed"))
    // hung: only an abort ends it
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))
    })
  }) as typeof fetch
  const server = new WhisperServerProcess({
    serverPath: "C:/engine/whisper-server.exe",
    modelPath: "C:/models/m.bin",
    spawnImpl,
    fetchImpl,
    resumeHealthTimeoutMs: 30,
    readyTimeoutMs: 2_000,
  })
  return { server, children, state }
}

test("WhisperServerProcess.onSystemResume: a healthy engine is left alone", async () => {
  const { server, children, state } = harness()
  await server.ensureStarted()
  const before = state.healthCalls
  await server.onSystemResume()
  assert.equal(state.healthCalls, before + 1, "health re-checked once")
  assert.equal(children.length, 1, "no restart")
  assert.equal(children[0]!.killed, 0)
  await server.stop()
})

test("WhisperServerProcess.onSystemResume: an engine hung after sleep is killed and restarted once (bounded check)", async () => {
  const { server, children, state } = harness()
  await server.ensureStarted()
  state.health = "hung"
  await server.onSystemResume()
  assert.equal(children.length, 2, "exactly one restart")
  assert.equal(children[0]!.killed, 1, "the hung process is killed")
  assert.ok(server.baseUrl, "ready again")
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(children.length, 2, "the old process's exit does not schedule a second restart")
  await server.stop()
})

test("WhisperServerProcess.onSystemResume: does nothing once stopped", async () => {
  const { server, children, state } = harness()
  await server.ensureStarted()
  await server.stop()
  const before = state.healthCalls
  await server.onSystemResume()
  assert.equal(state.healthCalls, before)
  assert.equal(children.length, 1)
})

test("WhisperServerProcess: a restart whose launch throws is logged and retried, never silently dropped", async () => {
  const lines: Array<{ event?: string }> = []
  const logger = new Logger({ write: (line) => lines.push(JSON.parse(line)) })
  const children: FakeChild[] = []
  let spawns = 0
  const spawnImpl = (() => {
    spawns += 1
    if (spawns === 2) throw new Error("spawn EPERM") // the first restart fails before any child exists
    const child = new FakeChild()
    children.push(child)
    return child
  }) as unknown as typeof spawn
  const fetchImpl = (() => Promise.resolve(new Response('{"status":"ok"}', { status: 200 }))) as typeof fetch
  const server = new WhisperServerProcess({
    serverPath: "C:/engine/whisper-server.exe",
    modelPath: "C:/models/m.bin",
    spawnImpl,
    fetchImpl,
    readyTimeoutMs: 2_000,
    logger,
  })
  await server.ensureStarted()
  children[0]!.emit("exit", 1) // the engine crashes; the restart is scheduled (1 s backoff)

  // The second retry (2 s backoff) must succeed: the failure above did not end the restart cycle.
  const deadline = Date.now() + 6_000
  while (children.length < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50))
  assert.equal(children.length, 2, "a later restart attempt still brings the engine back")
  assert.ok(server.baseUrl, "ready again")
  assert.ok(lines.some((line) => line.event === "local-whisper.restart-failed"), "the failed restart is logged")
  await server.stop()
})

test("watchSystemResume: resume events are debounced and reach the CURRENT engine; unsubscribe detaches", async () => {
  const source = new EventEmitter()
  const calls: string[] = []
  let current: { onSystemResume(): Promise<void> } | null = { onSystemResume: async () => void calls.push("a") }
  const unsubscribe = watchSystemResume(source as never, () => current, { settleMs: 20 })
  source.emit("resume")
  source.emit("resume")
  current = { onSystemResume: async () => void calls.push("b") }
  await new Promise((r) => setTimeout(r, 50))
  assert.deepEqual(calls, ["b"], "one check, on the engine current at fire time")
  current = null
  source.emit("resume")
  await new Promise((r) => setTimeout(r, 50))
  assert.deepEqual(calls, ["b"], "no engine, nothing to check")
  unsubscribe()
  current = { onSystemResume: async () => void calls.push("c") }
  source.emit("resume")
  await new Promise((r) => setTimeout(r, 50))
  assert.deepEqual(calls, ["b"])
  assert.equal(source.listenerCount("resume"), 0)
})

// ---- Section 118: engine runs below normal priority so it never starves OBS ----
import { constants as osConstants } from "node:os"

test("WhisperServerProcess: the engine child is lowered to below-normal priority at spawn", async () => {
  const calls: Array<[number, number]> = []
  const spawnImpl = (() => Object.assign(new FakeChild(), { pid: 4321 })) as unknown as typeof spawn
  const server = new WhisperServerProcess({
    serverPath: "C:/engine/whisper-server.exe",
    modelPath: "C:/models/m.bin",
    spawnImpl,
    fetchImpl: (() => Promise.resolve(new Response('{"status":"ok"}', { status: 200 }))) as typeof fetch,
    setPriorityImpl: (pid, priority) => void calls.push([pid, priority]),
  })
  await server.ensureStarted()
  await server.stop()
  assert.deepEqual(calls, [[4321, osConstants.priority.PRIORITY_BELOW_NORMAL]])
})

test("WhisperServerProcess: a refused priority change is logged, not fatal", async () => {
  const spawnImpl = (() => Object.assign(new FakeChild(), { pid: 99 })) as unknown as typeof spawn
  const lines: string[] = []
  const { Logger } = await import("../../../packages/shared/logger")
  const server = new WhisperServerProcess({
    serverPath: "C:/engine/whisper-server.exe",
    modelPath: "C:/models/m.bin",
    spawnImpl,
    fetchImpl: (() => Promise.resolve(new Response('{"status":"ok"}', { status: 200 }))) as typeof fetch,
    setPriorityImpl: () => {
      throw new Error("EPERM")
    },
    logger: new Logger({ minLevel: "debug", write: (line) => lines.push(line) }),
  })
  await server.ensureStarted()
  await server.stop()
  assert.ok(lines.some((line) => line.includes("local-whisper.priority-failed") && line.includes("EPERM")))
})
