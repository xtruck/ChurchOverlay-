export type LogLevel = "error" | "warn" | "info" | "debug" | "trace"

export type LogFields = {
  readonly component: string
  readonly event: string
  readonly correlationId?: string
  readonly messageId?: string
  readonly sequence?: number
  readonly durationMs?: number
  readonly error?: string
  readonly metadata?: Record<string, unknown>
}

export type LoggerOptions = {
  readonly minLevel?: LogLevel
  readonly now?: () => number
  readonly write?: (line: string) => void
}

const LEVEL_ORDER: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3, trace: 4 }

// Defense in depth against AGENTS.md section 24 / ARCHITECTURE.md section
// 41's "never log" list. Not exhaustive — no pattern list can guarantee
// that — but it catches the two most likely accidents: a field whose
// *name* signals a secret (redact regardless of value), and a value that
// *looks* like a credential regardless of what it was called (a Groq key
// literally has the "gsk_" prefix this session handled directly; a raw
// "Bearer ..." string is unambiguously always a credential in an HTTP
// header). Metadata is the only place a caller-supplied value could slip
// a secret in — the fixed top-level fields never carry free-form data.
const SECRET_KEY_PATTERN = /key|token|secret|password|credential|authoriz/i
const SECRET_VALUE_PATTERN = /^(gsk_|sk-|Bearer\s)/i
const REDACTED = "[REDACTED]"

/**
 * Structured logger (ARCHITECTURE.md sections 40-41). Emits one JSON line
 * per call with the recommended fields. Callers pass a short, fixed
 * `event` label plus explicit fields — there is no raw free-text message
 * parameter — so log output stays predictable and greppable instead of
 * becoming ad hoc prose.
 */
export class Logger {
  private readonly minLevel: LogLevel
  private readonly now: () => number
  private readonly write: (line: string) => void

  constructor(options: LoggerOptions = {}) {
    this.minLevel = options.minLevel ?? "info"
    this.now = options.now ?? Date.now
    this.write = options.write ?? ((line) => console.log(line))
  }

  error(fields: LogFields): void {
    this.log("error", fields)
  }
  warn(fields: LogFields): void {
    this.log("warn", fields)
  }
  info(fields: LogFields): void {
    this.log("info", fields)
  }
  debug(fields: LogFields): void {
    this.log("debug", fields)
  }
  trace(fields: LogFields): void {
    this.log("trace", fields)
  }

  private log(level: LogLevel, fields: LogFields): void {
    if (LEVEL_ORDER[level] > LEVEL_ORDER[this.minLevel]) return

    const record: Record<string, unknown> = {
      timestamp: new Date(this.now()).toISOString(),
      level,
      component: fields.component,
      event: fields.event,
    }
    if (fields.correlationId !== undefined) record.correlationId = fields.correlationId
    if (fields.messageId !== undefined) record.messageId = fields.messageId
    if (fields.sequence !== undefined) record.sequence = fields.sequence
    if (fields.durationMs !== undefined) record.durationMs = fields.durationMs
    if (fields.error !== undefined) record.error = fields.error
    if (fields.metadata !== undefined) record.metadata = redactSecrets(fields.metadata)

    this.write(JSON.stringify(record))
  }
}

function redactSecrets(metadata: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(metadata)) {
    if (SECRET_KEY_PATTERN.test(key)) {
      result[key] = REDACTED
    } else if (typeof value === "string" && SECRET_VALUE_PATTERN.test(value)) {
      result[key] = REDACTED
    } else {
      result[key] = value
    }
  }
  return result
}
