import { test } from "node:test"
import assert from "node:assert/strict"
import {
  READY_CHECK_DETAIL_CODES,
  READY_CHECK_FIX_CODES,
  checkClock,
  checkMic,
  overallStatus,
  runReadyCheck,
  type ReadyCheckLine,
  type ReadyCheckProbes,
  type ReadyCheckSnapshot,
} from "./ready-check"

const NOW = Date.UTC(2026, 10, 19, 9, 0, 0)

function greenSnapshot(overrides: Partial<ReadyCheckSnapshot> = {}): ReadyCheckSnapshot {
  return {
    mic: { running: true, calibrating: false, msSinceLastFrame: 20, state: "ok", framesReceived: 500, framesForwarded: 120, loudClosedMs: 0 },
    asr: { health: "ok", primary: "groq" },
    ai: { enabled: true, ready: true },
    frenchTranslation: "ls1910",
    offlineAsrEnabled: true,
    clients: { operators: 2, viewers: 3, internalViewers: 1 },
    remoteEnabled: true,
    ...overrides,
  }
}

function greenProbes(overrides: Partial<ReadyCheckProbes> = {}): ReadyCheckProbes {
  return {
    asrRoundTrip: async () => "reachable",
    aiAvailability: async () => "ok",
    verseLookup: async () => ({ found: true, offline: false }),
    frenchFallbackLookup: async () => "ok",
    offlineModelPresent: async () => true,
    logsWritable: async () => ({ writable: true, writeFailures: 0 }),
    ...overrides,
  }
}

const run = (snapshot: ReadyCheckSnapshot, probes: ReadyCheckProbes, probeTimeoutMs?: number) =>
  runReadyCheck(snapshot, probes, { now: () => NOW, ...(probeTimeoutMs !== undefined ? { probeTimeoutMs } : {}) })

function byId(lines: readonly ReadyCheckLine[], id: string): ReadyCheckLine {
  const found = lines.find((entry) => entry.id === id)
  assert.ok(found, `no line ${id}`)
  return found
}

test("ReadyCheck: all green, every check in its fixed order", async () => {
  const report = await run(greenSnapshot(), greenProbes())
  assert.deepEqual(
    report.lines.map((entry) => entry.id),
    ["mic", "asr", "ai", "verse-source", "french-fallback", "offline-model", "viewers", "remote", "logs", "clock"]
  )
  assert.deepEqual(report.lines.filter((entry) => entry.status !== "ok"), [])
  assert.equal(report.overall, "ok")
  assert.equal(report.startedAt, NOW)
  assert.equal(report.durationMs, 0)
  for (const entry of report.lines) assert.equal(entry.fixHint, null, `${entry.id} is green, so it needs no fix`)
  assert.deepEqual(byId(report.lines, "mic").params, { received: 500, forwarded: 120 })
  assert.deepEqual(byId(report.lines, "viewers").params, { viewers: 3, internal: 1, external: 2 })
  assert.deepEqual(byId(report.lines, "remote").params, { count: 1 })
})

test("ReadyCheck: checks that do not apply are left out instead of shown green", async () => {
  let aiCalled = false
  let modelCalled = false
  const report = await run(
    greenSnapshot({ ai: { enabled: false, ready: false }, offlineAsrEnabled: false, remoteEnabled: false }),
    greenProbes({
      aiAvailability: async () => {
        aiCalled = true
        return "ok"
      },
      offlineModelPresent: async () => {
        modelCalled = true
        return true
      },
    })
  )
  assert.deepEqual(report.lines.map((entry) => entry.id), ["mic", "asr", "verse-source", "french-fallback", "viewers", "logs", "clock"])
  assert.equal(aiCalled, false, "AI keys are checked only when a helper is on")
  assert.equal(modelCalled, false)
})

test("ReadyCheck: microphone failure modes", () => {
  const base = greenSnapshot().mic
  assert.equal(checkMic({ ...base, running: false }).detail, "mic.notRunning")
  assert.equal(checkMic({ ...base, running: false }).status, "warn")
  const stale = checkMic({ ...base, msSinceLastFrame: 9_400 })
  assert.equal(stale.status, "fail")
  assert.equal(stale.detail, "mic.noFrames")
  assert.deepEqual(stale.params, { seconds: 9 })
  assert.equal(checkMic({ ...base, msSinceLastFrame: null }).status, "fail")
  assert.equal(checkMic({ ...base, calibrating: true }).status, "unknown")
  assert.equal(checkMic({ ...base, state: "no-signal" }).detail, "mic.noSignal")
  assert.equal(checkMic({ ...base, state: "no-signal" }).status, "fail")
  const stuck = checkMic({ ...base, loudClosedMs: 25_000 })
  assert.equal(stuck.status, "warn")
  assert.equal(stuck.detail, "mic.gateStuckClosed")
  assert.equal(stuck.fixHint, "mic.noiseMode")
  const neverOpened = checkMic({ ...base, framesForwarded: 0 })
  assert.equal(neverOpened.status, "warn")
  assert.equal(neverOpened.detail, "mic.gateNeverOpened")
})

test("ReadyCheck: ASR health overrides the probe, and a missing probe is 'cannot verify', never green", async () => {
  let probed = false
  const probes = greenProbes({
    asrRoundTrip: async () => {
      probed = true
      return "reachable"
    },
  })
  const failing = await run(greenSnapshot({ asr: { health: "error", primary: "groq" } }), probes)
  assert.equal(byId(failing.lines, "asr").status, "fail")
  assert.equal(byId(failing.lines, "asr").detail, "asr.error")
  assert.equal(failing.overall, "fail")
  assert.equal(probed, false, "no request while the provider is already known to be failing")

  assert.equal(byId((await run(greenSnapshot({ asr: { health: "rate-limited", primary: "groq" } }), probes)).lines, "asr").status, "fail")
  assert.equal(byId((await run(greenSnapshot({ asr: { health: "throttled", primary: "groq" } }), probes)).lines, "asr").status, "warn")
  assert.equal(byId((await run(greenSnapshot({ asr: { health: "failover", primary: "groq" } }), probes)).lines, "asr").detail, "asr.failover")

  const deepgram = await run(greenSnapshot({ asr: { health: "ok", primary: "deepgram" } }), greenProbes({ asrRoundTrip: undefined }))
  const asr = byId(deepgram.lines, "asr")
  assert.equal(asr.status, "unknown")
  assert.equal(asr.detail, "asr.cannotVerify")
  assert.deepEqual(asr.params, { provider: "deepgram" })
  assert.equal(deepgram.overall, "unknown")

  const rejected = await run(greenSnapshot(), greenProbes({ asrRoundTrip: async () => "auth" }))
  assert.equal(byId(rejected.lines, "asr").detail, "asr.authRejected")
  assert.equal(byId(rejected.lines, "asr").status, "fail")
  assert.equal(byId((await run(greenSnapshot(), greenProbes({ asrRoundTrip: async () => "unknown" }))).lines, "asr").status, "unknown")
})

test("ReadyCheck: AI key failure modes", async () => {
  const noKey = await run(greenSnapshot({ ai: { enabled: true, ready: false } }), greenProbes())
  assert.equal(byId(noKey.lines, "ai").detail, "ai.noKey")
  assert.equal(byId(noKey.lines, "ai").status, "fail")
  const auth = await run(greenSnapshot(), greenProbes({ aiAvailability: async () => "auth" }))
  assert.equal(byId(auth.lines, "ai").detail, "ai.auth")
  const model = await run(greenSnapshot(), greenProbes({ aiAvailability: async () => "model-unavailable" }))
  assert.equal(byId(model.lines, "ai").detail, "ai.modelUnavailable")
  const unknown = await run(greenSnapshot(), greenProbes({ aiAvailability: async () => "unknown" }))
  assert.equal(byId(unknown.lines, "ai").status, "unknown")
  const noCompleter = await run(greenSnapshot(), greenProbes({ aiAvailability: undefined }))
  assert.equal(byId(noCompleter.lines, "ai").detail, "ai.noKey")
})

test("ReadyCheck: verse source, French fallback and offline model failure modes", async () => {
  const offline = await run(greenSnapshot(), greenProbes({ verseLookup: async () => ({ found: true, offline: true }) }))
  assert.equal(byId(offline.lines, "verse-source").status, "warn")
  assert.equal(byId(offline.lines, "verse-source").detail, "verse.offlineServing")
  const missing = await run(greenSnapshot(), greenProbes({ verseLookup: async () => ({ found: false, offline: false }) }))
  assert.equal(byId(missing.lines, "verse-source").status, "fail")
  const thrown = await run(greenSnapshot(), greenProbes({ verseLookup: async () => Promise.reject(new Error("ECONNRESET")) }))
  assert.equal(byId(thrown.lines, "verse-source").status, "fail")
  assert.equal(byId(thrown.lines, "verse-source").detail, "probe.error")

  const noData = await run(greenSnapshot(), greenProbes({ frenchFallbackLookup: async () => "missing" }))
  assert.equal(byId(noData.lines, "french-fallback").status, "fail")
  const darby = await run(greenSnapshot({ frenchTranslation: "darby" }), greenProbes({ frenchFallbackLookup: async () => "not-applicable" }))
  assert.equal(byId(darby.lines, "french-fallback").status, "warn")
  assert.deepEqual(byId(darby.lines, "french-fallback").params, { translation: "darby" })
  const odd = await run(greenSnapshot({ frenchTranslation: "<script>" }), greenProbes({ frenchFallbackLookup: async () => "not-applicable" }))
  assert.deepEqual(byId(odd.lines, "french-fallback").params, { translation: "other" }, "only fixed values leave the module")

  const model = await run(greenSnapshot(), greenProbes({ offlineModelPresent: async () => false }))
  assert.equal(byId(model.lines, "offline-model").detail, "offlineModel.missing")
  assert.equal(byId(model.lines, "offline-model").status, "fail")
})

test("ReadyCheck: viewer, remote, logs and clock failure modes", async () => {
  const none = await run(greenSnapshot({ clients: { operators: 1, viewers: 0, internalViewers: 1 } }), greenProbes())
  assert.equal(byId(none.lines, "viewers").status, "fail")
  assert.equal(byId(none.lines, "remote").status, "warn", "only the dashboard itself is an operator")
  const internalOnly = await run(greenSnapshot({ clients: { operators: 2, viewers: 2, internalViewers: 2 } }), greenProbes())
  assert.equal(byId(internalOnly.lines, "viewers").detail, "viewers.onlyInternal")
  assert.equal(byId(internalOnly.lines, "viewers").status, "warn")

  const readOnly = await run(greenSnapshot(), greenProbes({ logsWritable: async () => ({ writable: false, writeFailures: 0 }) }))
  assert.equal(byId(readOnly.lines, "logs").status, "fail")
  const flaky = await run(greenSnapshot(), greenProbes({ logsWritable: async () => ({ writable: true, writeFailures: 3 }) }))
  assert.equal(byId(flaky.lines, "logs").status, "warn")
  assert.deepEqual(byId(flaky.lines, "logs").params, { count: 3 })

  assert.equal(checkClock(Date.UTC(2001, 0, 1)).status, "fail")
  assert.equal(checkClock(Date.UTC(2150, 0, 1)).status, "fail")
  assert.equal(checkClock(Number.NaN).status, "fail")
  assert.equal(checkClock(NOW).status, "ok")
})

test("ReadyCheck: a hanging probe times out as 'unknown' and the run stays bounded", async () => {
  const never = () => new Promise<never>(() => undefined)
  const pending: Array<() => void> = []
  const report = await runReadyCheck(
    greenSnapshot(),
    greenProbes({ asrRoundTrip: never, aiAvailability: never, verseLookup: never, frenchFallbackLookup: never, offlineModelPresent: never, logsWritable: never }),
    {
      now: () => NOW,
      probeTimeoutMs: 4_000,
      // Fake timers: every timeout fires at once, so the test never sleeps.
      timers: {
        setTimeout: (callback) => {
          pending.push(callback)
          queueMicrotask(callback)
          return pending.length
        },
        clearTimeout: () => undefined,
      },
    }
  )
  for (const id of ["asr", "ai", "verse-source", "french-fallback", "offline-model", "logs"]) {
    const entry = byId(report.lines, id)
    assert.equal(entry.status, "unknown", `${id} timed out`)
    assert.equal(entry.detail, "probe.timeout")
    assert.deepEqual(entry.params, { seconds: 4 })
  }
  assert.equal(pending.length, 6, "one bounded timer per probe")
  assert.equal(byId(report.lines, "mic").status, "ok", "snapshot checks are still evaluated")
  assert.equal(report.overall, "unknown", "timed-out probes are never shown green")
})

test("ReadyCheck: a real short timeout ends the run without waiting for the probe", async () => {
  const started = Date.now()
  const report = await runReadyCheck(greenSnapshot(), greenProbes({ verseLookup: () => new Promise(() => undefined) }), { probeTimeoutMs: 30 })
  assert.equal(byId(report.lines, "verse-source").detail, "probe.timeout")
  assert.ok(Date.now() - started < 2_000)
})

test("ReadyCheck: output never contains a probe's error text or a secret", async () => {
  const secret = "gsk_live_SECRET_abcdefghijklmnopqrstuvwxyz0123456789"
  const boom = async (): Promise<never> => {
    throw new Error(`request failed (401): invalid key ${secret} at C:\\Users\\pastor\\AppData`)
  }
  const report = await run(
    greenSnapshot({ frenchTranslation: secret }),
    greenProbes({ asrRoundTrip: boom, aiAvailability: boom, verseLookup: boom, frenchFallbackLookup: boom, offlineModelPresent: boom, logsWritable: boom })
  )
  const json = JSON.stringify(report)
  assert.equal(json.includes(secret), false)
  assert.equal(json.includes("SECRET"), false)
  assert.equal(json.includes("pastor"), false)
  assert.equal(json.includes("401"), false)
  for (const entry of report.lines) {
    for (const value of Object.values(entry.params ?? {})) {
      assert.ok(typeof value === "number" || /^[a-z0-9-]+$/.test(value), `${entry.id} param ${String(value)} is a fixed code`)
    }
  }
})

test("ReadyCheck: every emitted code is in the published code lists", async () => {
  const details = new Set<string>(READY_CHECK_DETAIL_CODES)
  const fixes = new Set<string>(READY_CHECK_FIX_CODES)
  const reports = await Promise.all([
    run(greenSnapshot(), greenProbes()),
    run(greenSnapshot({ asr: { health: "failover", primary: "local" }, ai: { enabled: true, ready: false } }), greenProbes()),
    run(greenSnapshot({ clients: { operators: 1, viewers: 0, internalViewers: 1 } }), greenProbes({ logsWritable: async () => ({ writable: false, writeFailures: 0 }) })),
  ])
  for (const report of reports) {
    for (const entry of report.lines) {
      assert.ok(details.has(entry.detail), entry.detail)
      if (entry.fixHint !== null) assert.ok(fixes.has(entry.fixHint), entry.fixHint)
    }
  }
})

test("ReadyCheck: overall is the worst line (fail > warn > unknown > ok)", () => {
  const mk = (status: ReadyCheckLine["status"]): ReadyCheckLine => ({ id: "logs", status, detail: "logs.ok", fixHint: null })
  assert.equal(overallStatus([]), "ok")
  assert.equal(overallStatus([mk("ok"), mk("unknown")]), "unknown")
  assert.equal(overallStatus([mk("unknown"), mk("warn")]), "warn")
  assert.equal(overallStatus([mk("warn"), mk("fail"), mk("ok")]), "fail")
})
