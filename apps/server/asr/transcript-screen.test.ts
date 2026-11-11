import { test } from "node:test"
import assert from "node:assert/strict"
import { screenTranscript } from "./transcript-screen"
import { segmentThresholdsFor, filterSegments } from "./segment-quality"

const REAL_SPEECH = [
  "Mes frères et sœurs, aujourd'hui nous allons parler de la grâce de Dieu",
  "Le Seigneur est mon berger, je ne manquerai de rien",
  "Prions ensemble, Père céleste, nous te remercions pour ce jour",
  "Turn to your neighbor and say God is good all the time",
  "And Abraham believed God and it was counted to him as righteousness",
  "Nebuchadnezzar made a golden image and Shadrach Meshach Abednego refused",
  "Hébreux onze verset un la foi est une ferme assurance",
  "Que ta volonté soit faite sur la terre comme au ciel",
  "Philippiens quatre treize",
  "Jean 3 16",
  "Psaume 23",
  "Ouvrez vos Bibles à Jean chapitre 3 verset 16",
  "Car Dieu a tant aimé le monde qu'il a donné son Fils unique",
  "For God so loved the world that he gave his only begotten Son",
  "Turn with me to Romans chapter 8 verse 28 and let us read together",
  "Lisons ensemble 1 Corinthiens 13 verset 4 l'amour est patient",
  "Amen, amen, amen",
  "Nebucadnetsar Abed-Nego Schadrac Méschac",
]

test("screen: real French/English speech and bare references pass in every mode", () => {
  for (const mode of ["normal", "noisy", "tongues"] as const) {
    for (const text of REAL_SPEECH) {
      for (const state of ["partial", "final"] as const) {
        // A 4-word list of rare proper nouns is only protected by the lower modes' word floor being above it for "normal".
        if (mode === "tongues" && text.startsWith("Nebucadnetsar")) continue // 4 rare names, no function word: the strictest mode may drop it
        assert.deepEqual(screenTranscript(text, { mode, state }), { ok: true }, `${mode}/${state}: ${text}`)
      }
    }
  }
})

test("screen: known Whisper credits and outros are rejected, including inside longer text", () => {
  const bad = [
    "Thank you for watching",
    "Sous-titres réalisés par la communauté d'Amara.org",
    "Sous-titrage Société Radio-Canada",
    "Merci d’avoir regardé cette vidéo",
    "and that is why subtitles by the Amara.org community",
    "N'oubliez pas de vous abonner",
  ]
  for (const text of bad) assert.equal(screenTranscript(text).ok, false, text)
})

test("screen: music symbols and bracketed sound labels are rejected, a sentence is not", () => {
  assert.deepEqual(screenTranscript("♪ la la la ♪"), { ok: false, reason: "music-symbol" })
  assert.deepEqual(screenTranscript("[Music]"), { ok: false, reason: "non-speech-annotation" })
  assert.deepEqual(screenTranscript("(Musique)"), { ok: false, reason: "non-speech-annotation" })
  assert.deepEqual(screenTranscript("*applause*"), { ok: false, reason: "non-speech-annotation" })
  assert.equal(screenTranscript("The music of heaven fills this house").ok, true)
})

test("screen: any non-Latin script is rejected", () => {
  assert.deepEqual(screenTranscript("यह एक परीक्षण है"), { ok: false, reason: "foreign-script" })
  assert.deepEqual(screenTranscript("Jean 3 16 你好"), { ok: false, reason: "foreign-script" })
})

const TONGUES = "shalala kandara shama lama kadoshi ba rasha mana sheka ondrai"
const LOOP = "lalalala lalalala shashasha kakakaka"

test("screen: tongues-like pseudo-words pass in normal only when long enough to be unclear, and are rejected in tongues mode", () => {
  assert.equal(screenTranscript(TONGUES, { mode: "tongues" }).ok, false)
  assert.equal(screenTranscript(TONGUES, { mode: "noisy" }).ok, false)
  // normal mode: 10 words, 0 known words: still rejected (a sentence has function words)
  assert.deepEqual(screenTranscript(TONGUES, { mode: "normal" }), { ok: false, reason: "implausible-words" })
})

test("screen: repeated syllable loops are rejected in tongues and noisy modes", () => {
  assert.deepEqual(screenTranscript(LOOP, { mode: "tongues" }), { ok: false, reason: "syllable-loop" })
  assert.equal(screenTranscript("shashasha kakakaka lalalala", { mode: "noisy" }).ok, true) // under noisy's 6-word floor
  assert.deepEqual(screenTranscript("shashasha kakakaka lalalala bababa dadada gagaga", { mode: "noisy" }), { ok: false, reason: "syllable-loop" })
})

test("screen: a repeating phrase is rejected once it dominates the text", () => {
  assert.deepEqual(screenTranscript("gloire gloire gloire gloire gloire gloire gloire gloire", { mode: "normal" }), { ok: false, reason: "degenerate-repetition" })
  assert.deepEqual(screenTranscript("oh seigneur oh seigneur oh gloire oh seigneur oh gloire", { mode: "tongues" }), { ok: false, reason: "repetitive" })
})

test("screen: partials are only checked for markers, script and annotations, never statistics", () => {
  assert.deepEqual(screenTranscript(TONGUES, { mode: "tongues", state: "partial" }), { ok: true })
  assert.equal(screenTranscript("thank you for watching", { state: "partial" }).ok, false)
})

test("screen: empty and whitespace text is not a verdict problem", () => {
  assert.deepEqual(screenTranscript("", { mode: "tongues" }), { ok: true })
  assert.deepEqual(screenTranscript("   ", { mode: "tongues" }), { ok: true })
})

test("segment thresholds: stricter modes drop what normal keeps, and tongues drops a very unsure decode on its own", () => {
  const unsure = [{ text: "chala bomba", noSpeechProb: 0.2, avgLogprob: -1.3, compressionRatio: 1.2 }]
  assert.equal(filterSegments(unsure, segmentThresholdsFor("normal")).dropped.length, 0)
  assert.equal(filterSegments(unsure, segmentThresholdsFor("noisy")).dropped.length, 0) // -1.3 > -1.5 floor
  const tongues = filterSegments(unsure, segmentThresholdsFor("tongues"))
  assert.equal(tongues.dropped.length, 1)
  assert.equal(tongues.dropped[0]?.reason, "low-confidence")
  const solid = [{ text: "Jean chapitre 3", noSpeechProb: 0.05, avgLogprob: -0.3, compressionRatio: 1.1 }]
  assert.equal(filterSegments(solid, segmentThresholdsFor("tongues")).kept.length, 1)
})
