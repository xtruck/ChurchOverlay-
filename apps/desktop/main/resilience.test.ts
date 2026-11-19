import { test } from "node:test"
import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import {
  awaitWithTimeout,
  describeError,
  installProcessGuards,
  isBenignRendererExit,
  isIgnorableLoadFailure,
  NoticeBoard,
  pickDialogLanguage,
  ReloadBudget,
  startupDialogText,
  STARTUP_DIALOGS,
  type MainNotice,
  type NewNotice,
} from "./resilience"
import type { LogFields } from "../../../packages/shared/logger"

function harness(overrides: { starting?: boolean; maxPerWindow?: number; throwingNotify?: boolean } = {}) {
  const proc = new EventEmitter()
  const logs: LogFields[] = []
  const notices: NewNotice[] = []
  const fatal: unknown[] = []
  let flushes = 0
  let clock = 0
  const guards = installProcessGuards({
    proc: proc as never,
    logger: { error: (fields) => logs.push(fields) },
    notify: (notice) => {
      if (overrides.throwingNotify) throw new Error("notify broke")
      notices.push(notice)
    },
    isStarting: () => overrides.starting ?? false,
    onFatalStartup: (error) => fatal.push(error),
    flushLogs: () => {
      flushes++
    },
    now: () => clock,
    ...(overrides.maxPerWindow !== undefined ? { maxPerWindow: overrides.maxPerWindow } : {}),
  })
  return { proc, logs, notices, fatal, guards, flushes: () => flushes, advance: (ms: number) => (clock += ms) }
}

test("uncaughtException is logged with its stack, reported as a non-blocking notice and does not exit", () => {
  const h = harness()
  h.proc.emit("uncaughtException", new Error("kaboom"), "uncaughtException")
  assert.equal(h.logs.length, 1)
  assert.equal(h.logs[0]?.event, "process.uncaught-exception")
  assert.equal(h.logs[0]?.error, "kaboom")
  assert.ok(typeof h.logs[0]?.metadata?.stack === "string" && (h.logs[0]?.metadata?.stack as string).includes("kaboom"))
  assert.deepEqual(h.notices, [{ level: "error", code: "uncaught-exception", detail: "kaboom" }])
  assert.equal(h.fatal.length, 0, "not fatal once the app is up")
  assert.equal(h.flushes(), 1)
})

test("unhandledRejection with a non-Error reason is reported too", () => {
  const h = harness()
  h.proc.emit("unhandledRejection", "plain string reason")
  assert.equal(h.logs[0]?.event, "process.unhandled-rejection")
  assert.equal(h.notices[0]?.code, "unhandled-rejection")
  assert.equal(h.notices[0]?.detail, "plain string reason")
})

test("during startup the same error is fatal and reaches onFatalStartup", () => {
  const h = harness({ starting: true })
  const error = new Error("services exploded")
  h.proc.emit("uncaughtException", error)
  assert.equal(h.notices[0]?.level, "fatal")
  assert.deepEqual(h.fatal, [error])
  assert.equal(h.logs[0]?.metadata?.fatal, true)
})

test("secrets in an error message or stack never reach the log or the notice", () => {
  const h = harness()
  const error = new Error("request to https://x.test/?key=TOPSECRET failed with Bearer abc123token")
  h.proc.emit("uncaughtException", error)
  const serialized = JSON.stringify([h.logs, h.notices])
  assert.ok(!serialized.includes("TOPSECRET"))
  assert.ok(!serialized.includes("abc123token"))
})

test("an error storm is rate limited: reported once, then counted, so it cannot loop", () => {
  const h = harness({ maxPerWindow: 3 })
  for (let i = 0; i < 50; i++) h.proc.emit("uncaughtException", new Error("again " + i))
  assert.equal(h.notices.length, 3)
  const suppressedEvents = h.logs.filter((log) => log.event === "process.errors-suppressed")
  assert.equal(suppressedEvents.length, 1)
  assert.equal(h.guards.suppressedCount(), 47)
  // A new window starts a fresh budget.
  h.advance(61_000)
  h.proc.emit("uncaughtException", new Error("later"))
  assert.equal(h.notices.length, 4)
})

test("an error raised while reporting is ignored instead of recursing", () => {
  const h = harness({ throwingNotify: true })
  assert.doesNotThrow(() => h.proc.emit("uncaughtException", new Error("first")))
  assert.equal(h.logs.length, 1, "the log line was written before the notify failure")
  // A handler that itself triggers another uncaught error mid-report:
  const proc = new EventEmitter()
  let calls = 0
  const logs: LogFields[] = []
  installProcessGuards({
    proc: proc as never,
    logger: {
      error: (fields) => {
        logs.push(fields)
        calls++
        if (calls < 100) proc.emit("uncaughtException", new Error("nested"))
      },
    },
    notify: () => {},
    isStarting: () => false,
    onFatalStartup: () => {},
  })
  proc.emit("uncaughtException", new Error("outer"))
  assert.equal(logs.length, 1)
})

test("uninstall removes the listeners", () => {
  const h = harness()
  assert.equal(h.proc.listenerCount("uncaughtException"), 1)
  h.guards.uninstall()
  assert.equal(h.proc.listenerCount("uncaughtException"), 0)
  assert.equal(h.proc.listenerCount("unhandledRejection"), 0)
})

test("describeError handles Errors, strings and objects", () => {
  assert.equal(describeError(new Error("x")).message, "x")
  assert.equal(describeError("y").message, "y")
  assert.equal(describeError({ a: 1 }).stack, undefined)
})

test("NoticeBoard keeps a bounded history, sends live, and hands resumeMic out exactly once", () => {
  const sent: MainNotice[] = []
  const board = new NoticeBoard((notice) => {
    sent.push(notice)
    return true
  }, 3, () => 42)
  board.push({ level: "warn", code: "renderer-recovered", detail: "gone", resumeMic: true })
  for (let i = 0; i < 4; i++) board.push({ level: "error", code: "services-failed", detail: String(i) })
  assert.equal(sent.length, 5)
  assert.equal(sent[0]?.id, 1)
  assert.equal(sent[0]?.at, 42)
  const snapshot = board.snapshot()
  assert.equal(snapshot.length, 3, "bounded to capacity")
  assert.deepEqual(snapshot.map((notice) => notice.detail), ["1", "2", "3"])

  const first = new NoticeBoard(() => false)
  first.push({ level: "warn", code: "renderer-recovered", resumeMic: true })
  assert.equal(first.snapshot()[0]?.resumeMic, true)
  assert.equal(first.snapshot()[0]?.resumeMic, undefined, "second dashboard load must not restart the mic again")
})

test("NoticeBoard survives a send that throws (dashboard mid-reload)", () => {
  const board = new NoticeBoard(() => {
    throw new Error("destroyed")
  })
  assert.doesNotThrow(() => board.push({ level: "error", code: "services-failed" }))
  assert.equal(board.snapshot().length, 1)
})

test("ReloadBudget: bounded reloads with backoff, refilled after the window", () => {
  let clock = 0
  const budget = new ReloadBudget(3, 60_000, 1000, () => clock)
  const first = budget.next()
  assert.deepEqual(first, { allowed: true, attempt: 1, delayMs: 1000 })
  assert.deepEqual(budget.next(), { allowed: true, attempt: 2, delayMs: 2000 })
  assert.deepEqual(budget.next(), { allowed: true, attempt: 3, delayMs: 4000 })
  assert.deepEqual(budget.next(), { allowed: false, attempts: 3 })
  clock = 61_000
  assert.deepEqual(budget.next(), { allowed: true, attempt: 1, delayMs: 1000 })
})

test("renderer exit and load-failure classification", () => {
  assert.equal(isBenignRendererExit("clean-exit"), true)
  assert.equal(isBenignRendererExit("crashed"), false)
  assert.equal(isBenignRendererExit("oom"), false)
  assert.equal(isIgnorableLoadFailure(-3, true), true)
  assert.equal(isIgnorableLoadFailure(-6, false), true, "sub-frame failures are not the dashboard")
  assert.equal(isIgnorableLoadFailure(-6, true), false)
})

test("awaitWithTimeout never waits longer than the bound and never rejects", async () => {
  assert.equal(await awaitWithTimeout(Promise.resolve(1), 1000), "done")
  assert.equal(await awaitWithTimeout(Promise.reject(new Error("x")), 1000), "failed")
  const started = Date.now()
  assert.equal(await awaitWithTimeout(new Promise(() => {}), 50), "timeout")
  assert.ok(Date.now() - started < 1000)
})

test("startup dialogs exist in English and French with actionable text", () => {
  assert.equal(pickDialogLanguage("fr-CA"), "fr")
  assert.equal(pickDialogLanguage("FR"), "fr")
  assert.equal(pickDialogLanguage("en-US"), "en")
  assert.equal(pickDialogLanguage(undefined), "en")
  for (const key of Object.keys(STARTUP_DIALOGS) as (keyof typeof STARTUP_DIALOGS)[]) {
    const en = startupDialogText(key, "en-US", "DETAIL")
    const fr = startupDialogText(key, "fr", "DETAIL")
    assert.ok(en.title && en.body && fr.title && fr.body)
    assert.notEqual(en.body, fr.body)
    assert.ok(!en.body.includes("{detail}") && !fr.body.includes("{detail}"))
  }
  assert.match(startupDialogText("safeStorageUnavailable", "en").body, /keychain|credential/i)
  assert.match(startupDialogText("safeStorageUnavailable", "fr").body, /trousseau|identifiants/i)
  assert.ok(startupDialogText("startupFailed", "en", "disk full").body.includes("disk full"))
  assert.ok(!startupDialogText("startupFailed", "en", "key=?key=SECRETVALUE1").body.includes("SECRETVALUE1"))
})
