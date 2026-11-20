import type { AsrStatusPayload } from "../../../packages/contracts"
import type { AiAvailability } from "../ai/guarded-text-completer"
import { GATE_CLOSED_LOUD_WARN_MS } from "../audio/mic-diagnostics"
import type { MicHealthState } from "../audio/mic-health"
import { MIC_NO_AUDIO_MS, withTimeout, type AppCoreTimers } from "../audio/mic-audio-watchdog"

/**
 * Pre-service "Ready check" (architecture-notes/ready-check.md): one ordered
 * green / amber / red checklist the operator runs before a service.
 *
 * Pure and deterministic: the caller (the Electron main process) hands in a
 * snapshot of statuses it already owns plus small probe functions; this module
 * never imports a provider, a socket or the filesystem, so it is unit-tested
 * without network. Probes run concurrently and each one is bounded by the same
 * timeout, so a whole run can never take longer than that timeout (plus
 * scheduling).
 *
 * Output is codes, never text: `detail` and `fixHint` are fixed identifiers the
 * dashboard translates (EN/FR), and `params` holds only finite numbers or
 * values from fixed enums. A probe's thrown error is never copied into the
 * result, so neither an API key nor a provider error body can leak into the
 * dashboard or the diagnostics export (AGENTS.md sections 24, 28).
 *
 * A check that cannot be verified says so ("unknown"), it is never shown green
 * (AGENTS.md section 45). Checks that do not apply (AI helpers off, offline
 * ASR off, phone remote off) are left out of the list rather than shown green.
 */

export type ReadyCheckStatus = "ok" | "warn" | "fail" | "unknown"

export type ReadyCheckId =
  | "mic"
  | "asr"
  | "ai"
  | "verse-source"
  | "french-fallback"
  | "offline-model"
  | "viewers"
  | "remote"
  | "logs"
  | "clock"

export type ReadyCheckParams = Readonly<Record<string, number | string>>

export type ReadyCheckLine = {
  readonly id: ReadyCheckId
  readonly status: ReadyCheckStatus
  /** Fixed code, translated by the dashboard as `readyCheck.detail.<code>`. */
  readonly detail: string
  readonly params?: ReadyCheckParams
  /** Fixed code (`readyCheck.fix.<code>`), null when nothing needs doing. */
  readonly fixHint: string | null
}

export type ReadyCheckReport = {
  readonly startedAt: number
  readonly durationMs: number
  readonly overall: ReadyCheckStatus
  readonly lines: readonly ReadyCheckLine[]
}

export type AsrProviderLabel = "groq" | "deepgram" | "local"

export type ReadyCheckSnapshot = {
  readonly mic: {
    readonly running: boolean
    readonly calibrating: boolean
    /** Wall-clock ms since the last audio frame (or since mic:start when none arrived yet); null when not running. */
    readonly msSinceLastFrame: number | null
    readonly state: MicHealthState | null
    readonly framesReceived: number
    readonly framesForwarded: number
    /** Consecutive ms of loud input the silence gate kept rejecting. */
    readonly loudClosedMs: number
  }
  readonly asr: {
    readonly health: AsrStatusPayload["asrHealth"]
    /** The provider at the head of the failover chain. */
    readonly primary: AsrProviderLabel
  }
  /** Any optional AI helper switched on; `ready` = the selected provider has its key. */
  readonly ai: { readonly enabled: boolean; readonly ready: boolean }
  readonly frenchTranslation: string
  readonly offlineAsrEnabled: boolean
  readonly clients: {
    readonly operators: number
    readonly viewers: number
    /** Viewer connections the app opens itself (the dashboard's preview, the NDI window). */
    readonly internalViewers: number
  }
  readonly remoteEnabled: boolean
}

/** "reachable": the provider answered a request authenticated with the key (no audio sent). */
export type AsrProbeResult = "reachable" | "auth" | "unknown"
export type VerseProbeResult = { readonly found: boolean; readonly offline: boolean }
export type FallbackProbeResult = "ok" | "missing" | "not-applicable"
export type LogsProbeResult = { readonly writable: boolean; readonly writeFailures: number }

export type ReadyCheckProbes = {
  /** Absent: no safe probe exists for this provider, reported as "cannot verify". */
  readonly asrRoundTrip?: () => Promise<AsrProbeResult>
  /** The existing, completion-free checkAvailability() of the AI completer. Absent: no completer (no key). */
  readonly aiAvailability?: () => Promise<AiAvailability>
  readonly verseLookup: () => Promise<VerseProbeResult>
  readonly frenchFallbackLookup: () => Promise<FallbackProbeResult>
  readonly offlineModelPresent: () => Promise<boolean>
  readonly logsWritable: () => Promise<LogsProbeResult>
}

export type ReadyCheckOptions = {
  readonly now?: () => number
  /** Per-probe bound; probes run concurrently, so this also bounds the whole run. */
  readonly probeTimeoutMs?: number
  readonly timers?: AppCoreTimers
}

export const READY_CHECK_PROBE_TIMEOUT_MS = 6_000
/** A wall clock before this (2025-01-01T00:00:00Z) or after 2100 is wrong: certificates and logs break. */
const MIN_SANE_CLOCK_MS = Date.UTC(2025, 0, 1)
const MAX_SANE_CLOCK_MS = Date.UTC(2100, 0, 1)

const STATUS_RANK: Readonly<Record<ReadyCheckStatus, number>> = { ok: 0, unknown: 1, warn: 2, fail: 3 }

/** Every detail and fix code this module can emit (the dashboard i18n tables are tested against it). */
export const READY_CHECK_DETAIL_CODES = [
  "mic.ok",
  "mic.notRunning",
  "mic.calibrating",
  "mic.noFrames",
  "mic.noSignal",
  "mic.gateStuckClosed",
  "mic.gateNeverOpened",
  "asr.reachable",
  "asr.cannotVerify",
  "asr.error",
  "asr.rateLimited",
  "asr.throttled",
  "asr.failover",
  "asr.authRejected",
  "asr.noAnswer",
  "ai.ok",
  "ai.noKey",
  "ai.auth",
  "ai.modelUnavailable",
  "ai.noAnswer",
  "verse.ok",
  "verse.offlineServing",
  "verse.notFound",
  "fallback.ok",
  "fallback.missing",
  "fallback.notForTranslation",
  "offlineModel.ok",
  "offlineModel.missing",
  "viewers.ok",
  "viewers.none",
  "viewers.onlyInternal",
  "remote.ok",
  "remote.none",
  "logs.ok",
  "logs.notWritable",
  "logs.writeFailures",
  "clock.ok",
  "clock.wrong",
  "probe.timeout",
  "probe.error",
] as const

export const READY_CHECK_FIX_CODES = [
  "mic.start",
  "mic.wait",
  "mic.checkDevice",
  "mic.checkMute",
  "mic.noiseMode",
  "mic.speak",
  "asr.checkKeyNetwork",
  "asr.wait",
  "asr.returnPrimary",
  "asr.replaceKey",
  "ai.addKey",
  "ai.replaceKey",
  "ai.provider",
  "network.check",
  "verse.reinstall",
  "fallback.ls1910",
  "offlineModel.install",
  "viewers.openObs",
  "remote.openOnPhone",
  "logs.checkDisk",
  "clock.fix",
] as const

type DetailCode = (typeof READY_CHECK_DETAIL_CODES)[number]
type FixCode = (typeof READY_CHECK_FIX_CODES)[number]

function line(id: ReadyCheckId, status: ReadyCheckStatus, detail: DetailCode, fixHint: FixCode | null, params?: ReadyCheckParams): ReadyCheckLine {
  return params ? { id, status, detail, params, fixHint } : { id, status, detail, fixHint }
}

/** Only finite, non-negative whole numbers leave this module as numeric params. */
function count(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.round(value) : 0
}

const ASR_LABELS: readonly AsrProviderLabel[] = ["groq", "deepgram", "local"]
const KNOWN_TRANSLATIONS: readonly string[] = ["ls1910", "darby"]

/** Runs one probe under the timeout. Never rejects; a thrown error is reduced to a code. */
async function settle<T>(probe: () => Promise<T>, timeoutMs: number, timers: AppCoreTimers): Promise<{ ok: true; value: T } | { ok: false; timedOut: boolean }> {
  try {
    const value = await withTimeout(Promise.resolve().then(probe), timeoutMs, "ready-check probe", timers)
    return { ok: true, value }
  } catch (error) {
    // Deliberately not inspected beyond the timeout marker: the message may carry provider text.
    const timedOut = error instanceof Error && error.message.startsWith("ready-check probe did not finish")
    return { ok: false, timedOut }
  }
}

function probeFailure(id: ReadyCheckId, outcome: { timedOut: boolean }, timeoutMs: number, fix: FixCode | null, errorStatus: ReadyCheckStatus): ReadyCheckLine {
  return outcome.timedOut
    ? line(id, "unknown", "probe.timeout", fix, { seconds: Math.round(timeoutMs / 1000) })
    : line(id, errorStatus, "probe.error", fix)
}

export function checkMic(mic: ReadyCheckSnapshot["mic"]): ReadyCheckLine {
  if (!mic.running) return line("mic", "warn", "mic.notRunning", "mic.start")
  if (mic.msSinceLastFrame === null || mic.msSinceLastFrame >= MIC_NO_AUDIO_MS) {
    return line("mic", "fail", "mic.noFrames", "mic.checkDevice", { seconds: Math.round(count(mic.msSinceLastFrame ?? 0) / 1000) })
  }
  if (mic.calibrating) return line("mic", "unknown", "mic.calibrating", "mic.wait")
  if (mic.state === "no-signal") return line("mic", "fail", "mic.noSignal", "mic.checkMute")
  if (mic.loudClosedMs >= GATE_CLOSED_LOUD_WARN_MS) {
    return line("mic", "warn", "mic.gateStuckClosed", "mic.noiseMode", { seconds: Math.round(count(mic.loudClosedMs) / 1000) })
  }
  const params = { received: count(mic.framesReceived), forwarded: count(mic.framesForwarded) }
  if (mic.framesForwarded === 0) return line("mic", "warn", "mic.gateNeverOpened", "mic.speak", params)
  return line("mic", "ok", "mic.ok", null, params)
}

function asrHealthLine(health: ReadyCheckSnapshot["asr"]["health"]): ReadyCheckLine | null {
  switch (health) {
    case "error":
      return line("asr", "fail", "asr.error", "asr.checkKeyNetwork")
    case "rate-limited":
      return line("asr", "fail", "asr.rateLimited", "asr.wait")
    case "throttled":
      return line("asr", "warn", "asr.throttled", "asr.wait")
    case "failover":
      return line("asr", "warn", "asr.failover", "asr.returnPrimary")
    default:
      return null
  }
}

function asrProbeLine(primary: AsrProviderLabel, result: AsrProbeResult): ReadyCheckLine {
  const params = { provider: primary }
  if (result === "reachable") return line("asr", "ok", "asr.reachable", null, params)
  if (result === "auth") return line("asr", "fail", "asr.authRejected", "asr.replaceKey", params)
  return line("asr", "unknown", "asr.noAnswer", "network.check", params)
}

function aiLine(result: AiAvailability): ReadyCheckLine {
  if (result === "ok") return line("ai", "ok", "ai.ok", null)
  if (result === "auth") return line("ai", "fail", "ai.auth", "ai.replaceKey")
  if (result === "model-unavailable") return line("ai", "fail", "ai.modelUnavailable", "ai.provider")
  return line("ai", "unknown", "ai.noAnswer", "network.check")
}

function verseLine(result: VerseProbeResult): ReadyCheckLine {
  if (!result.found) return line("verse-source", "fail", "verse.notFound", "network.check")
  if (result.offline) return line("verse-source", "warn", "verse.offlineServing", "network.check")
  return line("verse-source", "ok", "verse.ok", null)
}

function fallbackLine(result: FallbackProbeResult, translation: string): ReadyCheckLine {
  if (result === "ok") return line("french-fallback", "ok", "fallback.ok", null)
  if (result === "missing") return line("french-fallback", "fail", "fallback.missing", "verse.reinstall")
  const known = KNOWN_TRANSLATIONS.includes(translation) ? translation : "other"
  return line("french-fallback", "warn", "fallback.notForTranslation", "fallback.ls1910", { translation: known })
}

function viewersLine(clients: ReadyCheckSnapshot["clients"]): ReadyCheckLine {
  const viewers = count(clients.viewers)
  const internal = count(clients.internalViewers)
  const params = { viewers, internal }
  if (viewers === 0) return line("viewers", "fail", "viewers.none", "viewers.openObs", params)
  if (viewers <= internal) return line("viewers", "warn", "viewers.onlyInternal", "viewers.openObs", params)
  return line("viewers", "ok", "viewers.ok", null, { ...params, external: viewers - internal })
}

function remoteLine(operators: number): ReadyCheckLine {
  // The dashboard itself is one operator connection; anything beyond it is a phone remote.
  const phones = Math.max(0, count(operators) - 1)
  if (phones === 0) return line("remote", "warn", "remote.none", "remote.openOnPhone")
  return line("remote", "ok", "remote.ok", null, { count: phones })
}

function logsLine(result: LogsProbeResult): ReadyCheckLine {
  if (!result.writable) return line("logs", "fail", "logs.notWritable", "logs.checkDisk")
  if (result.writeFailures > 0) return line("logs", "warn", "logs.writeFailures", "logs.checkDisk", { count: count(result.writeFailures) })
  return line("logs", "ok", "logs.ok", null)
}

export function checkClock(nowMs: number): ReadyCheckLine {
  if (!Number.isFinite(nowMs) || nowMs < MIN_SANE_CLOCK_MS || nowMs >= MAX_SANE_CLOCK_MS) return line("clock", "fail", "clock.wrong", "clock.fix")
  return line("clock", "ok", "clock.ok", null)
}

export function overallStatus(lines: readonly ReadyCheckLine[]): ReadyCheckStatus {
  let worst: ReadyCheckStatus = "ok"
  for (const entry of lines) if (STATUS_RANK[entry.status] > STATUS_RANK[worst]) worst = entry.status
  return worst
}

/**
 * Runs every applicable check and returns them in a fixed order. Never rejects:
 * a failing or hanging probe becomes that line's fail / unknown.
 */
export async function runReadyCheck(snapshot: ReadyCheckSnapshot, probes: ReadyCheckProbes, options: ReadyCheckOptions = {}): Promise<ReadyCheckReport> {
  const now = options.now ?? Date.now
  const timers = options.timers ?? {}
  const timeoutMs = options.probeTimeoutMs ?? READY_CHECK_PROBE_TIMEOUT_MS
  const startedAt = now()
  const primary: AsrProviderLabel = ASR_LABELS.includes(snapshot.asr.primary) ? snapshot.asr.primary : "groq"

  const asrTask = async (): Promise<ReadyCheckLine> => {
    const health = asrHealthLine(snapshot.asr.health)
    if (health) return health
    if (!probes.asrRoundTrip) return line("asr", "unknown", "asr.cannotVerify", null, { provider: primary })
    const outcome = await settle(probes.asrRoundTrip, timeoutMs, timers)
    return outcome.ok ? asrProbeLine(primary, outcome.value) : probeFailure("asr", outcome, timeoutMs, "network.check", "unknown")
  }

  const aiTask = async (): Promise<ReadyCheckLine | null> => {
    if (!snapshot.ai.enabled) return null
    if (!snapshot.ai.ready || !probes.aiAvailability) return line("ai", "fail", "ai.noKey", "ai.addKey")
    const outcome = await settle(probes.aiAvailability, timeoutMs, timers)
    return outcome.ok ? aiLine(outcome.value) : probeFailure("ai", outcome, timeoutMs, "network.check", "unknown")
  }

  const verseTask = async (): Promise<ReadyCheckLine> => {
    const outcome = await settle(probes.verseLookup, timeoutMs, timers)
    return outcome.ok ? verseLine(outcome.value) : probeFailure("verse-source", outcome, timeoutMs, "network.check", "fail")
  }

  const fallbackTask = async (): Promise<ReadyCheckLine> => {
    const outcome = await settle(probes.frenchFallbackLookup, timeoutMs, timers)
    return outcome.ok ? fallbackLine(outcome.value, snapshot.frenchTranslation) : probeFailure("french-fallback", outcome, timeoutMs, "verse.reinstall", "fail")
  }

  const offlineModelTask = async (): Promise<ReadyCheckLine | null> => {
    if (!snapshot.offlineAsrEnabled) return null
    const outcome = await settle(probes.offlineModelPresent, timeoutMs, timers)
    if (!outcome.ok) return probeFailure("offline-model", outcome, timeoutMs, "offlineModel.install", "fail")
    return outcome.value ? line("offline-model", "ok", "offlineModel.ok", null) : line("offline-model", "fail", "offlineModel.missing", "offlineModel.install")
  }

  const logsTask = async (): Promise<ReadyCheckLine> => {
    const outcome = await settle(probes.logsWritable, timeoutMs, timers)
    return outcome.ok ? logsLine(outcome.value) : probeFailure("logs", outcome, timeoutMs, "logs.checkDisk", "fail")
  }

  const [asr, ai, verse, fallback, offlineModel, logs] = await Promise.all([
    asrTask(),
    aiTask(),
    verseTask(),
    fallbackTask(),
    offlineModelTask(),
    logsTask(),
  ])

  const lines: ReadyCheckLine[] = [checkMic(snapshot.mic), asr]
  if (ai) lines.push(ai)
  lines.push(verse, fallback)
  if (offlineModel) lines.push(offlineModel)
  lines.push(viewersLine(snapshot.clients))
  if (snapshot.remoteEnabled) lines.push(remoteLine(snapshot.clients.operators))
  lines.push(logs)
  const finishedAt = now()
  lines.push(checkClock(finishedAt))
  return { startedAt, durationMs: Math.max(0, finishedAt - startedAt), overall: overallStatus(lines), lines }
}
