import { test } from "node:test"
import assert from "node:assert/strict"
import { Logger } from "./logger"

function captureLogger(options: Partial<ConstructorParameters<typeof Logger>[0]> = {}) {
  const lines: string[] = []
  const logger = new Logger({ now: () => 1_700_000_000_000, ...options, write: (line) => lines.push(line) })
  return { logger, lines }
}

test("Logger: info() emits one JSON line with the required fields", () => {
  const { logger, lines } = captureLogger()
  logger.info({ component: "verse-source", event: "lookup.success" })

  assert.equal(lines.length, 1)
  const record = JSON.parse(lines[0] as string)
  assert.equal(record.level, "info")
  assert.equal(record.component, "verse-source")
  assert.equal(record.event, "lookup.success")
  assert.equal(record.timestamp, new Date(1_700_000_000_000).toISOString())
})

test("Logger: optional fields are included when provided and omitted when not", () => {
  const { logger, lines } = captureLogger()
  logger.info({
    component: "core",
    event: "pipeline.step",
    correlationId: "01CORR",
    messageId: "01MSG",
    sequence: 3,
    durationMs: 142,
  })
  const withFields = JSON.parse(lines[0] as string)
  assert.equal(withFields.correlationId, "01CORR")
  assert.equal(withFields.messageId, "01MSG")
  assert.equal(withFields.sequence, 3)
  assert.equal(withFields.durationMs, 142)

  logger.info({ component: "core", event: "pipeline.step" })
  const withoutFields = JSON.parse(lines[1] as string)
  assert.equal("correlationId" in withoutFields, false)
  assert.equal("messageId" in withoutFields, false)
  assert.equal("sequence" in withoutFields, false)
  assert.equal("durationMs" in withoutFields, false)
})

test("Logger: error field is included on error()", () => {
  const { logger, lines } = captureLogger()
  logger.error({ component: "asr", event: "request.failed", error: "network down" })
  const record = JSON.parse(lines[0] as string)
  assert.equal(record.level, "error")
  assert.equal(record.error, "network down")
})

test("Logger: minLevel filters out lower-priority calls", () => {
  const { logger, lines } = captureLogger({ minLevel: "warn" })
  logger.error({ component: "x", event: "e1" })
  logger.warn({ component: "x", event: "e2" })
  logger.info({ component: "x", event: "e3" })
  logger.debug({ component: "x", event: "e4" })
  logger.trace({ component: "x", event: "e5" })

  assert.equal(lines.length, 2)
  assert.equal(JSON.parse(lines[0] as string).event, "e1")
  assert.equal(JSON.parse(lines[1] as string).event, "e2")
})

test("Logger: the default minLevel is info (debug/trace are suppressed by default)", () => {
  const { logger, lines } = captureLogger()
  logger.info({ component: "x", event: "shown" })
  logger.debug({ component: "x", event: "hidden" })
  logger.trace({ component: "x", event: "hidden" })
  assert.equal(lines.length, 1)
})

test("Logger: redacts metadata values whose key name signals a secret", () => {
  const { logger, lines } = captureLogger()
  logger.info({
    component: "config",
    event: "loaded",
    metadata: { apiKey: "gsk_realvalue", wsToken: "abc123", normalField: "fine" },
  })
  const record = JSON.parse(lines[0] as string)
  assert.equal(record.metadata.apiKey, "[REDACTED]")
  assert.equal(record.metadata.wsToken, "[REDACTED]")
  assert.equal(record.metadata.normalField, "fine")
})

test("Logger: redacts a metadata value that looks like a credential, even under an innocuous key name", () => {
  const { logger, lines } = captureLogger()
  logger.info({
    component: "http",
    event: "request",
    metadata: {
      authHeader: "Bearer some.jwt.value",
      note: "gsk_should_still_be_redacted_here",
      description: "a perfectly normal sentence",
    },
  })
  const record = JSON.parse(lines[0] as string)
  assert.equal(record.metadata.authHeader, "[REDACTED]")
  assert.equal(record.metadata.note, "[REDACTED]")
  assert.equal(record.metadata.description, "a perfectly normal sentence")
})

test("Logger: redacts a secret nested inside an object-valued metadata field, not just top-level keys", () => {
  const { logger, lines } = captureLogger()
  logger.info({
    component: "config",
    event: "loaded",
    metadata: { config: { groqApiKey: "gsk_realvalue", microphoneId: "device-1" } },
  })
  const record = JSON.parse(lines[0] as string)
  assert.equal(record.metadata.config.groqApiKey, "[REDACTED]")
  assert.equal(record.metadata.config.microphoneId, "device-1")
})

test("Logger: redacts a secret inside an array of objects in metadata", () => {
  const { logger, lines } = captureLogger()
  logger.info({
    component: "config",
    event: "loaded",
    metadata: { entries: [{ token: "abc123" }, { normalField: "fine" }] },
  })
  const record = JSON.parse(lines[0] as string)
  assert.equal(record.metadata.entries[0].token, "[REDACTED]")
  assert.equal(record.metadata.entries[1].normalField, "fine")
})

test("Logger: metadata is omitted entirely when not provided", () => {
  const { logger, lines } = captureLogger()
  logger.info({ component: "x", event: "e" })
  const record = JSON.parse(lines[0] as string)
  assert.equal("metadata" in record, false)
})

test("scrubSecrets: redacts credentials embedded in free-form text", async () => {
  const { scrubSecrets } = await import("./logger")
  const hex = "a".repeat(40)
  const scrubbed = scrubSecrets(
    `401 for gsk_abcdefgh12345678 Authorization: Bearer abc.def-ghi, GET https://x.test/v1?api_key=SECRET123&a=1 token ${hex}`
  )
  assert.ok(!scrubbed.includes("gsk_abcdefgh12345678"))
  assert.ok(!scrubbed.includes("abc.def-ghi"))
  assert.ok(!scrubbed.includes("SECRET123"))
  assert.ok(!scrubbed.includes(hex))
  assert.ok(scrubbed.includes("api_key=[REDACTED]&a=1"))
  assert.ok(scrubbed.includes("401"))
})

test("scrubSecrets: leaves plain messages intact and bounds very long ones", async () => {
  const { scrubSecrets } = await import("./logger")
  assert.equal(scrubSecrets("Rate limit reached, retry in 12s"), "Rate limit reached, retry in 12s")
  assert.ok(scrubSecrets("x ".repeat(1000)).length <= 301)
})

test("Logger: the error field is scrubbed of embedded credentials", () => {
  const { logger, lines } = captureLogger()
  logger.error({ component: "asr", event: "transcript.failed", error: "bad key gsk_abcdefgh12345678" })
  const record = JSON.parse(lines[0] as string)
  assert.ok(!String(record.error).includes("gsk_abcdefgh12345678"))
})
