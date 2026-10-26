import { test } from "node:test"
import assert from "node:assert/strict"
import { buildHealthPayload } from "./health"

test("buildHealthPayload: reports ok once the core is running, with whole-second uptime", () => {
  assert.deepEqual(buildHealthPayload(1_000, 6_900, true), { status: "ok", uptimeSeconds: 5 })
})

test("buildHealthPayload: reports starting before the core exists and never a negative uptime", () => {
  assert.deepEqual(buildHealthPayload(5_000, 1_000, false), { status: "starting", uptimeSeconds: 0 })
})

test("buildHealthPayload: exposes nothing but status and uptime", () => {
  assert.deepEqual(Object.keys(buildHealthPayload(0, 0, true)).sort(), ["status", "uptimeSeconds"])
})
