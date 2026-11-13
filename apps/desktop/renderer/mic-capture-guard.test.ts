import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { runInNewContext } from "node:vm"

// Compiled to dist/apps/desktop/renderer/ — four levels up is the repo root.
const REPO_ROOT = join(__dirname, "..", "..", "..", "..")
const read = (...parts: string[]) => readFileSync(join(REPO_ROOT, ...parts), "utf8")
const source = read("apps", "desktop", "renderer", "mic-capture-guard.js")

type Status = "idle" | "starting" | "live" | "muted" | "suspended" | "no-frames" | "ended" | "silent"
type Watchdog = {
  start(now: number): void
  stop(): void
  frame(peak: number, now: number): void
  trackEnded(): void
  trackMuted(muted: boolean): void
  contextState(state: string): void
  status(now: number): Status
  isLive(now: number): boolean
  frameCount(): number
  recoveryAction(now: number): "reacquire" | "resume-context" | "none"
}
type Policy = {
  next(): { retry: true; attempt: number; delayMs: number } | { retry: false; attempts: number }
  noteLive(now: number): void
  noteNotLive(): void
  reset(): void
  attempts(): number
  maxAttempts(): number
}
type Guard = {
  classifyMicError(error: unknown): { kind: string; retryable: boolean; name: string }
  createMicWatchdog(options?: object): Watchdog
  createRecoveryPolicy(options?: object): Policy
  peakInt16(samples: Int16Array): number
}

function loadGuard(): Guard {
  const context: { ChurchOverlayMicGuard?: Guard } = {}
  runInNewContext(source, context)
  if (!context.ChurchOverlayMicGuard) throw new Error("mic guard did not register")
  return context.ChurchOverlayMicGuard
}

const guard = loadGuard()

test("classifyMicError gives each failure its own kind (no more blanket 'permission denied')", () => {
  const kind = (name: string) => guard.classifyMicError({ name, message: "x" }).kind
  assert.equal(kind("NotAllowedError"), "permission-denied")
  assert.equal(kind("SecurityError"), "permission-denied")
  assert.equal(kind("NotFoundError"), "not-found")
  assert.equal(kind("NotReadableError"), "in-use")
  assert.equal(kind("AbortError"), "in-use")
  assert.equal(kind("OverconstrainedError"), "overconstrained")
  assert.equal(kind("SomethingElse"), "other")
  assert.equal(guard.classifyMicError(undefined).kind, "other")
  assert.equal(guard.classifyMicError(null).kind, "other")
  assert.equal(guard.classifyMicError({ name: "NotAllowedError" }).retryable, false)
  assert.equal(guard.classifyMicError({ name: "NotFoundError" }).retryable, true)
  assert.equal(guard.classifyMicError({ name: "NotReadableError" }).retryable, true)
})

test("watchdog: idle until started, 'starting' inside the grace, never 'live' before a frame", () => {
  const wd = guard.createMicWatchdog()
  assert.equal(wd.status(0), "idle")
  wd.start(1000)
  assert.equal(wd.status(1000), "starting")
  assert.equal(wd.isLive(2000), false)
  assert.equal(wd.status(1000 + 4999), "starting")
  // No first frame within the grace: capture never produced audio.
  assert.equal(wd.status(1000 + 5001), "no-frames")
  assert.equal(wd.recoveryAction(1000 + 5001), "reacquire")
})

test("watchdog: live only while frames flow; a stall becomes no-frames and asks for re-acquire", () => {
  const wd = guard.createMicWatchdog()
  wd.start(0)
  wd.frame(120, 100)
  assert.equal(wd.status(200), "live")
  assert.equal(wd.isLive(200), true)
  assert.equal(wd.recoveryAction(200), "none")
  wd.frame(120, 2900)
  assert.equal(wd.status(5000), "live") // 2100 ms since the last frame: still inside 3 s
  assert.equal(wd.status(6000), "no-frames") // 3100 ms
  assert.equal(wd.isLive(6000), false)
  assert.equal(wd.recoveryAction(6000), "reacquire")
  wd.frame(80, 6100)
  assert.equal(wd.status(6200), "live", "frames returning restore live")
})

test("watchdog: track ended, muted, suspended and closed each report their own state", () => {
  const wd = guard.createMicWatchdog()
  wd.start(0)
  wd.frame(50, 10)

  wd.trackMuted(true)
  assert.equal(wd.status(20), "muted")
  assert.equal(wd.recoveryAction(20), "none", "a mute cannot be fixed by re-opening the device")
  wd.trackMuted(false)
  assert.equal(wd.status(20), "live")

  wd.contextState("suspended")
  assert.equal(wd.status(20), "suspended")
  assert.equal(wd.recoveryAction(20), "resume-context")
  wd.contextState("running")
  assert.equal(wd.status(20), "live")

  wd.contextState("closed")
  assert.equal(wd.status(20), "ended")
  assert.equal(wd.recoveryAction(20), "reacquire")
  wd.start(30) // a fresh capture resets every per-capture flag
  wd.frame(50, 40)
  assert.equal(wd.status(50), "live")

  wd.trackEnded()
  assert.equal(wd.status(50), "ended")
  assert.equal(wd.recoveryAction(50), "reacquire")
  assert.equal(wd.isLive(50), false)
})

test("watchdog: frames that are pure digital silence for a long time are 'silent', not live", () => {
  const wd = guard.createMicWatchdog()
  wd.start(0)
  for (let now = 100; now <= 25000; now += 100) wd.frame(0, now)
  assert.equal(wd.status(25000), "silent")
  assert.equal(wd.recoveryAction(25000), "none", "digital silence only warns; it never tears down a working device")
  wd.frame(3, 25100)
  assert.equal(wd.status(25100), "live", "any signal clears it")
  // Quiet-but-nonzero speech floor must never trip it.
  const quiet = guard.createMicWatchdog()
  quiet.start(0)
  for (let now = 100; now <= 60000; now += 100) quiet.frame(now % 700 === 0 ? 1 : 0, now)
  assert.equal(quiet.status(60000), "live")
})

test("watchdog: stop() returns to idle and ignores late frames", () => {
  const wd = guard.createMicWatchdog()
  wd.start(0)
  wd.frame(10, 5)
  wd.stop()
  assert.equal(wd.status(10), "idle")
  const frames = wd.frameCount()
  wd.frame(10, 20)
  assert.equal(wd.frameCount(), frames)
})

test("recovery policy: bounded attempts with exponential, capped backoff", () => {
  const policy = guard.createRecoveryPolicy({ maxAttempts: 4, baseDelayMs: 1000, maxDelayMs: 3000 })
  const delays: number[] = []
  for (let i = 0; i < 4; i++) {
    const decision = policy.next()
    assert.equal(decision.retry, true)
    if (decision.retry) delays.push(decision.delayMs)
  }
  assert.deepEqual(delays, [1000, 2000, 3000, 3000])
  const exhausted = policy.next()
  assert.equal(exhausted.retry, false)
  assert.equal(policy.attempts(), 4)
  assert.equal(policy.maxAttempts(), 4)
})

test("recovery policy: a stable live streak refills the budget, a manual restart resets it", () => {
  const policy = guard.createRecoveryPolicy({ maxAttempts: 2, stableMs: 30000 })
  assert.equal(policy.next().retry, true)
  assert.equal(policy.next().retry, true)
  assert.equal(policy.next().retry, false)
  policy.reset()
  assert.equal(policy.attempts(), 0)

  assert.equal(policy.next().retry, true)
  policy.noteLive(1000)
  policy.noteLive(20000) // not stable long enough
  assert.equal(policy.attempts(), 1)
  policy.noteNotLive() // a dropout restarts the streak
  policy.noteLive(40000)
  policy.noteLive(60000)
  assert.equal(policy.attempts(), 1)
  policy.noteLive(70001)
  assert.equal(policy.attempts(), 0)
})

test("peakInt16 finds the largest magnitude", () => {
  assert.equal(guard.peakInt16(new Int16Array([0, 0, 0])), 0)
  assert.equal(guard.peakInt16(new Int16Array([3, -9, 4])), 9)
  assert.equal(guard.peakInt16(new Int16Array([])), 0)
})

test("dashboard wiring: every capture-loss signal is handled and 'active' is driven by honest state", () => {
  const dashboard = read("apps", "desktop", "renderer", "dashboard.js")
  for (const needle of [
    'track.addEventListener("ended"',
    'track.addEventListener("mute"',
    'track.addEventListener("unmute"',
    'context.addEventListener("statechange"',
    'navigator.mediaDevices.addEventListener("devicechange"',
    "micGuard.classifyMicError",
    "micRecovery.next()",
    "window.churchOverlay.onMainNotice",
    "openLogsFolder",
  ]) {
    assert.ok(dashboard.includes(needle), `dashboard.js must contain ${needle}`)
  }
  // The old unconditional "mic active" must be gone: only renderMicCaptureState toggles it.
  assert.equal((dashboard.match(/micVisualEl\.classList\.add\("active"\)/g) ?? []).length, 0)
  assert.ok(dashboard.includes('micVisualEl.classList.toggle("active", state === "live")'))
  // The generic "permission denied" message is no longer used for every failure.
  assert.equal(dashboard.includes('t("log.micPermissionDenied"'), false)
})

test("index.html loads the guard before dashboard.js and has the status line and logs button", () => {
  const html = read("apps", "desktop", "renderer", "index.html")
  const guardAt = html.indexOf('<script src="./mic-capture-guard.js">')
  const dashboardAt = html.indexOf('<script src="./dashboard.js">')
  assert.ok(guardAt > 0 && dashboardAt > guardAt, "mic-capture-guard.js must load before dashboard.js")
  assert.ok(html.includes('id="mic-capture-status"'))
  assert.ok(html.includes('id="open-logs-btn"'))
})

test("i18n has an English and French line for every capture state and error kind", () => {
  const i18n = read("apps", "desktop", "renderer", "i18n.js")
  const keys = [
    ...["starting", "live", "muted", "suspended", "no-frames", "ended", "silent", "recovering", "gave-up"].map((state) => `mic.state.${state}`),
    ...["permission-denied", "not-found", "in-use", "overconstrained", "other"].map((kind) => `mic.error.${kind}`),
    ...["uncaught-exception", "unhandled-rejection", "services-failed", "startup-failed", "renderer-recovered", "renderer-unrecoverable", "renderer-unresponsive"].map((code) => `notice.main.${code}`),
    "session.openLogsButton",
  ]
  for (const key of keys) {
    const count = i18n.split(`"${key}":`).length - 1
    assert.equal(count, 2, `${key} must be defined once in English and once in French`)
  }
})

test("preload exposes the logs folder and notice bridge without generic ipc access", () => {
  const preload = read("apps", "desktop", "preload", "index.ts")
  assert.ok(preload.includes('ipcRenderer.invoke("open-logs-folder")'))
  assert.ok(preload.includes('ipcRenderer.invoke("get-main-notices")'))
  assert.ok(preload.includes('ipcRenderer.on("main-notice"'))
})
