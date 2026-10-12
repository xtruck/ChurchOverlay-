import { test } from "node:test"
import assert from "node:assert/strict"
import { RegexDetector } from "./regex-detector"
import { KnownValidVerseIndex } from "../verse/known-valid-verse-index"

/**
 * Replay corpus: FINAL transcripts exactly as the ASR produced them in a real
 * French service (live log 2026-10-12), run through detector -> known-valid
 * index with no microphone, ASR or network (AGENTS.md sections 31, 32).
 *
 * `shown` is what the pipeline may go on to look up. A reference the detector
 * finds but the index rejects (Isaiah 4:8: the chapter has 6 verses) is listed
 * separately under `rejected`, because that rejection IS the hallucination
 * guard working. Add new real mishearings here rather than only fixing the
 * detector, so the next change cannot silently regress them.
 */

type ReplayCase = {
  readonly text: string
  readonly shown: readonly string[]
  readonly rejected?: readonly string[]
  readonly note: string
}

const CASES: readonly ReplayCase[] = [
  { text: "Donc, allons qu'on a vu dans Esaïe 4, le verset 8, pour pouvoir comprendre", shown: [], rejected: ["isaiah 4:8"], note: "Isaiah 4 has 6 verses: detected, then rejected by the index" },
  { text: "Dans Esaïe 4 le verset 8, Dans Esaïe 4, le verset 8. La régie Esaïe chapitre 4, verset 8.", shown: [], rejected: ["isaiah 4:8"], note: "repeated phrasing still yields one rejected reference" },
  { text: "dans nombre un, le verset 2,", shown: ["numbers 1:2"], note: "ASR dropped the plural: 'nombre' for 'Nombres'" },
  { text: "Dans nombre un, le verset 2,", shown: ["numbers 1:2"], note: "same, capitalised" },
  { text: "Allons-y dans, Esther un, verset 2.", shown: ["esther 1:2"], note: "heard as Esther; the index accepts it, the operator sees it as a detected reference" },
  { text: "ils sont envoyésdans Psaume 119, verset 110.", shown: ["psalm 119:110"], note: "glued words from the ASR" },
  // Typographic and phrasing variants an ASR / smart-formatter can emit for one reference.
  { text: "Jean 3 : 16", shown: ["john 3:16"], note: "French typographic space around the colon" },
  { text: "Jean 3\u00a0:\u00a016", shown: ["john 3:16"], note: "no-break spaces around the colon" },
  { text: "Jean 3\u202f:\u202f16", shown: ["john 3:16"], note: "narrow no-break spaces around the colon" },
  { text: "Jean 3\uff1a16", shown: ["john 3:16"], note: "full-width colon" },
  { text: "Jean 3:\u200b16", shown: ["john 3:16"], note: "zero-width space inside the reference" },
  { text: "« Jean 3:16 »", shown: ["john 3:16"], note: "guillemets" },
  { text: "d’Ésaïe 4:6", shown: ["isaiah 4:6"], note: "curly apostrophe before the book" },
  { text: "Jean 3 versets 16", shown: ["john 3:16"], note: "plural 'versets'" },
  { text: "Jean chapitre 3 versets 16 à 18", shown: ["john 3:16"], note: "plural 'versets' with a range" },
  // Fragments with no reference at all: nothing may be proposed.
  { text: "Verset 8.", shown: [], note: "bare verse is a navigation command, not a reference" },
  { text: "Va au verset 8.", shown: [], note: "navigation command" },
  { text: "Noval verses cinq.", shown: [], note: "garbled; no book" },
  { text: "Verset suivant.", shown: [], note: "navigation command" },
  { text: "Allons-y, versetsuivant.", shown: [], note: "glued navigation command" },
  { text: "Puis j'avais dit que depuis, n'oublions pas", shown: [], note: "ordinary speech" },
  { text: "les bienfaits deDieu et le nom du", shown: [], note: "ordinary speech" },
  { text: "Tes tes préceptions couvent toujours", shown: [], note: "ordinary speech" },
  { text: "lui et comprendreles bienfaits de Jésus de notre vie.", shown: [], note: "ordinary speech" },
  // The 'nombre' alias must not turn ordinary counting into a Bible reference.
  { text: "un grand nombre 12 14 personnes", shown: [], note: "bare two numbers after 'nombre' is not a reference" },
  { text: "le nombre 666 est", shown: [], note: "a single number" },
]

const detector = new RegexDetector()
const index = new KnownValidVerseIndex()
const label = (r: { book: string; chapter: number; verse: number }): string => `${r.book} ${r.chapter}:${r.verse}`

for (const entry of CASES) {
  test(`replay: ${JSON.stringify(entry.text)} (${entry.note})`, () => {
    const found = detector.detect(entry.text)
    assert.deepEqual(found.filter((r) => index.exists(r)).map(label), entry.shown)
    assert.deepEqual(found.filter((r) => !index.exists(r)).map(label), entry.rejected ?? [])
  })
}
