import type { SessionEntry } from "./session-recorder"
import type { LatencySnapshot } from "./latency-tracker"
import type { EchoReason } from "./echo-warning"

/**
 * ARCHITECTURE.md section 132: what went wrong (or nearly) during a service,
 * collected passively for the post-service export. Nothing here changes what
 * the pipeline does; it only remembers events AppCore already knows about.
 * In memory, bounded (AGENTS.md section 36), one fresh log per app start,
 * like SessionRecorder.
 */
export type DropKind = "foreign-script" | "third-language"

export type DroppedTranscript = {
  readonly at: number
  readonly kind: DropKind
  /** First characters only, so the report never carries a whole transcript. */
  readonly preview: string
}

export type MicDropout = {
  readonly startedAt: number
  /** null while the signal is still missing (or the mic was stopped mid-dropout and not yet closed). */
  readonly endedAt: number | null
}

export type EchoEvent = { readonly at: number; readonly reason: EchoReason }

export type ServiceHealthSnapshot = {
  readonly foreignScriptDrops: number
  readonly thirdLanguageDrops: number
  readonly droppedSamples: readonly DroppedTranscript[]
  readonly micDropouts: readonly MicDropout[]
  readonly echoWarnings: readonly EchoEvent[]
}

const MAX_DROP_SAMPLES = 50
const MAX_EVENTS = 200
const PREVIEW_CHARS = 40

export class ServiceHealthLog {
  private foreignScriptDrops = 0
  private thirdLanguageDrops = 0
  private droppedSamples: DroppedTranscript[] = []
  private micDropouts: { startedAt: number; endedAt: number | null }[] = []
  private echoWarnings: EchoEvent[] = []

  recordDrop(now: number, kind: DropKind, text: string): void {
    if (kind === "foreign-script") this.foreignScriptDrops += 1
    else this.thirdLanguageDrops += 1
    this.droppedSamples.push({ at: now, kind, preview: text.slice(0, PREVIEW_CHARS) })
    if (this.droppedSamples.length > MAX_DROP_SAMPLES) this.droppedSamples.shift()
  }

  /** Fed with every mic:health state. A "no-signal" run is one dropout. */
  observeMicState(now: number, state: string): void {
    const open = this.micDropouts.at(-1)
    const isOpen = open !== undefined && open.endedAt === null
    if (state === "no-signal") {
      if (!isOpen) {
        this.micDropouts.push({ startedAt: now, endedAt: null })
        if (this.micDropouts.length > MAX_EVENTS) this.micDropouts.shift()
      }
    } else if (isOpen) {
      open.endedAt = now
    }
  }

  /** The mic was stopped on purpose: a dropout still open ends here, it is not a live one. */
  closeMic(now: number): void {
    this.observeMicState(now, "stopped")
  }

  recordEcho(now: number, reason: EchoReason): void {
    this.echoWarnings.push({ at: now, reason })
    if (this.echoWarnings.length > MAX_EVENTS) this.echoWarnings.shift()
  }

  snapshot(): ServiceHealthSnapshot {
    return {
      foreignScriptDrops: this.foreignScriptDrops,
      thirdLanguageDrops: this.thirdLanguageDrops,
      droppedSamples: [...this.droppedSamples],
      micDropouts: this.micDropouts.map((dropout) => ({ ...dropout })),
      echoWarnings: [...this.echoWarnings],
    }
  }
}

export type ServiceHealthInput = {
  readonly entries: readonly SessionEntry[]
  readonly health: ServiceHealthSnapshot
  readonly latency: LatencySnapshot
  /** Local clock formatting; injectable so tests do not depend on the machine's time zone. */
  readonly formatTime?: (ms: number) => string
}

export type ServiceHealthReport = {
  /** Merged into service-report.json under "health", plus the timed verse list. */
  readonly json: {
    readonly verses: readonly { readonly at: number; readonly reference: string; readonly translation: string }[]
    readonly droppedTranscripts: {
      readonly foreignScript: number
      readonly thirdLanguage: number
      readonly samples: readonly DroppedTranscript[]
    }
    readonly micDropouts: readonly (MicDropout & { readonly durationMs: number | null })[]
    readonly latency: LatencySnapshot
    readonly echoWarnings: readonly EchoEvent[]
  }
  /** service-health.txt: French first, then English. */
  readonly text: string
}

function referenceLabel(entry: SessionEntry): string {
  return `${entry.reference.book} ${entry.reference.chapter}:${entry.reference.verse}`
}

function seconds(ms: number): string {
  return `${Math.round(ms / 100) / 10}`
}

export function buildServiceHealthReport(input: ServiceHealthInput): ServiceHealthReport {
  const { entries, health, latency } = input
  const time = input.formatTime ?? ((ms: number) => new Date(ms).toLocaleTimeString())
  const dropouts = health.micDropouts.map((dropout) => ({
    ...dropout,
    durationMs: dropout.endedAt === null ? null : dropout.endedAt - dropout.startedAt,
  }))
  const verses = entries.map((entry) => ({ at: entry.timestamp, reference: referenceLabel(entry), translation: entry.translation }))
  const dropped = health.foreignScriptDrops + health.thirdLanguageDrops

  const json: ServiceHealthReport["json"] = {
    verses,
    droppedTranscripts: { foreignScript: health.foreignScriptDrops, thirdLanguage: health.thirdLanguageDrops, samples: health.droppedSamples },
    micDropouts: dropouts,
    latency,
    echoWarnings: health.echoWarnings,
  }

  const fr: string[] = ["RAPPORT DE SANTÉ DU CULTE", ""]
  const en: string[] = ["SERVICE HEALTH REPORT", ""]

  fr.push(`Versets affichés : ${verses.length}`)
  en.push(`Verses shown: ${verses.length}`)
  for (const verse of verses) {
    fr.push(`  ${time(verse.at)}  ${verse.reference} (${verse.translation})`)
    en.push(`  ${time(verse.at)}  ${verse.reference} (${verse.translation})`)
  }

  fr.push("", `Transcriptions écartées (espagnol, portugais ou autre alphabet) : ${dropped}`)
  en.push("", `Dropped transcripts (Spanish, Portuguese or another script): ${dropped}`)
  if (dropped > 0) {
    fr.push(`  autre alphabet : ${health.foreignScriptDrops}, autre langue latine : ${health.thirdLanguageDrops}`)
    en.push(`  other script: ${health.foreignScriptDrops}, other Latin-alphabet language: ${health.thirdLanguageDrops}`)
  }

  fr.push("", `Coupures du micro : ${dropouts.length}`)
  en.push("", `Mic dropouts: ${dropouts.length}`)
  for (const dropout of dropouts) {
    const when = time(dropout.startedAt)
    fr.push(`  ${when}  ${dropout.durationMs === null ? "non terminée" : `${seconds(dropout.durationMs)} s`}`)
    en.push(`  ${when}  ${dropout.durationMs === null ? "not ended" : `${seconds(dropout.durationMs)} s`}`)
  }

  if (latency.count === 0) {
    fr.push("", "Délai du traitement : aucune mesure")
    en.push("", "Processing latency: no measurement")
  } else {
    fr.push("", `Délai du traitement (médiane / 95e centile / max) : ${latency.p50Ms} / ${latency.p95Ms} / ${latency.maxMs} ms sur ${latency.count} mesures`)
    en.push("", `Processing latency (median / 95th percentile / max): ${latency.p50Ms} / ${latency.p95Ms} / ${latency.maxMs} ms over ${latency.count} measurements`)
  }

  fr.push("", `Avertissements d'écho : ${health.echoWarnings.length}`)
  en.push("", `Echo warnings: ${health.echoWarnings.length}`)
  for (const warning of health.echoWarnings) {
    fr.push(`  ${time(warning.at)}  ${warning.reason === "media-loud" ? "micro actif pendant une vidéo ou un chant" : "même phrase transcrite deux fois"}`)
    en.push(`  ${time(warning.at)}  ${warning.reason === "media-loud" ? "mic at speech level during a video or song" : "same sentence transcribed twice"}`)
  }

  return { json, text: `${fr.join("\n")}\n\n----------------------------------------\n\n${en.join("\n")}\n` }
}
