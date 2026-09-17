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

test("Logger: metadata is omitted entirely when not provided", () => {
  const { logger, lines } = captureLogger()
  logger.info({ component: "x", event: "e" })
  const record = JSON.parse(lines[0] as string)
  assert.equal("metadata" in record, false)
})
