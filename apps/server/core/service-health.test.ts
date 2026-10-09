import { test } from "node:test"
import assert from "node:assert/strict"
import { ServiceHealthLog, buildServiceHealthReport } from "./service-health"
import type { SessionEntry } from "./session-recorder"

const NO_LATENCY = { count: 0, lastMs: null, p50Ms: null, p95Ms: null, maxMs: null }
const clock = (ms: number) => `t${ms}`

function entry(chapter: number, verse: number, timestamp: number): SessionEntry {
  return { reference: { book: "john", chapter, verse }, text: "...", translation: "LSG", timestamp }
}

test("ServiceHealthLog: counts dropped transcripts by kind and keeps only a short preview", () => {
  const log = new ServiceHealthLog()
  log.recordDrop(10, "foreign-script", "x".repeat(200))
  log.recordDrop(20, "third-language", "buenos dias hermanos")
  log.recordDrop(30, "third-language", "gracias a dios")
  const snapshot = log.snapshot()
  assert.equal(snapshot.foreignScriptDrops, 1)
  assert.equal(snapshot.thirdLanguageDrops, 2)
  assert.equal(snapshot.droppedSamples[0]?.preview.length, 40)
})

test("ServiceHealthLog: a run of no-signal readings is ONE mic dropout, closed when the signal returns", () => {
  const log = new ServiceHealthLog()
  log.observeMicState(1000, "ok")
  log.observeMicState(2000, "no-signal")
  log.observeMicState(3000, "no-signal")
  log.observeMicState(5000, "listening")
  log.observeMicState(9000, "no-signal")
  const dropouts = log.snapshot().micDropouts
  assert.deepEqual(dropouts, [
    { startedAt: 2000, endedAt: 5000 },
    { startedAt: 9000, endedAt: null },
  ])
})

test("ServiceHealthLog: stopping the mic closes an open dropout instead of leaving it open forever", () => {
  const log = new ServiceHealthLog()
  log.observeMicState(2000, "no-signal")
  log.closeMic(4000)
  assert.deepEqual(log.snapshot().micDropouts, [{ startedAt: 2000, endedAt: 4000 }])
})

test("ServiceHealthLog: samples and events are bounded", () => {
  const log = new ServiceHealthLog()
  for (let i = 0; i < 500; i++) {
    log.recordDrop(i, "foreign-script", "x")
    log.recordEcho(i, "repeated-sentence")
  }
  const snapshot = log.snapshot()
  assert.equal(snapshot.foreignScriptDrops, 500)
  assert.equal(snapshot.droppedSamples.length, 50)
  assert.equal(snapshot.echoWarnings.length, 200)
})

test("ServiceHealthLog: snapshot is a copy, later events do not change an export in progress", () => {
  const log = new ServiceHealthLog()
  log.observeMicState(1, "no-signal")
  const before = log.snapshot()
  log.observeMicState(2, "ok")
  assert.equal(before.micDropouts[0]?.endedAt, null)
})

test("buildServiceHealthReport: lists verses with times, drops, dropouts, latency and echo warnings in JSON and in French then English", () => {
  const log = new ServiceHealthLog()
  log.recordDrop(1, "foreign-script", "foreign")
  log.recordDrop(2, "third-language", "hola hermanos")
  log.observeMicState(100, "no-signal")
  log.observeMicState(2500, "ok")
  log.recordEcho(300, "media-loud")
  const report = buildServiceHealthReport({
    entries: [entry(3, 16, 1000), entry(1, 1, 2000)],
    health: log.snapshot(),
    latency: { count: 4, lastMs: 80, p50Ms: 70, p95Ms: 120, maxMs: 130 },
    formatTime: clock,
  })
  assert.deepEqual(report.json.verses, [
    { at: 1000, reference: "john 3:16", translation: "LSG" },
    { at: 2000, reference: "john 1:1", translation: "LSG" },
  ])
  assert.equal(report.json.droppedTranscripts.foreignScript, 1)
  assert.equal(report.json.droppedTranscripts.thirdLanguage, 1)
  assert.equal(report.json.micDropouts[0]?.durationMs, 2400)
  assert.equal(report.json.echoWarnings.length, 1)

  const [french, english] = report.text.split("----------------------------------------")
  assert.ok(french?.includes("RAPPORT DE SANTÉ DU CULTE"))
  assert.ok(french?.includes("t1000  john 3:16 (LSG)"))
  assert.ok(french?.includes("Transcriptions écartées (espagnol, portugais ou autre alphabet) : 2"))
  assert.ok(french?.includes("Coupures du micro : 1"))
  assert.ok(french?.includes("70 / 120 / 130 ms sur 4 mesures"))
  assert.ok(french?.includes("Avertissements d'écho : 1"))
  assert.ok(english?.includes("SERVICE HEALTH REPORT"))
  assert.ok(english?.includes("Dropped transcripts (Spanish, Portuguese or another script): 2"))
  assert.ok(english?.includes("Mic dropouts: 1"))
  assert.ok(english?.includes("2.4 s"))
  assert.ok(english?.includes("Echo warnings: 1"))
})

test("buildServiceHealthReport: an empty service reports zeros and 'no measurement', never invented numbers", () => {
  const report = buildServiceHealthReport({ entries: [], health: new ServiceHealthLog().snapshot(), latency: NO_LATENCY, formatTime: clock })
  assert.ok(report.text.includes("Verses shown: 0"))
  assert.ok(report.text.includes("Mic dropouts: 0"))
  assert.ok(report.text.includes("Processing latency: no measurement"))
  assert.ok(report.text.includes("Délai du traitement : aucune mesure"))
})

test("buildServiceHealthReport: a dropout still open is reported as not ended", () => {
  const log = new ServiceHealthLog()
  log.observeMicState(100, "no-signal")
  const report = buildServiceHealthReport({ entries: [], health: log.snapshot(), latency: NO_LATENCY, formatTime: clock })
  assert.equal(report.json.micDropouts[0]?.durationMs, null)
  assert.ok(report.text.includes("not ended"))
  assert.ok(report.text.includes("non terminée"))
})
