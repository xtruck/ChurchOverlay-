/**
 * Micro-benchmark of the per-transcript detection hot path (not a test: the
 * file name does not match node --test patterns). Run after `npm run build`:
 *
 *   node dist/apps/server/detector/detection-path.bench.js
 *
 * Measures the synchronous work AppCore runs per transcript (partials AND
 * finals): RegexDetector.detect(), compactOnlyReferenceKeys(),
 * NavigationCommandDetector.detect(), correctTranscription() and
 * normalizeBibleTerms(). Fixtures are realistic service speech — French and
 * English, digit-free partials and reference-bearing finals — so the numbers
 * answer "what does one more transcript cost the event loop", not a synthetic
 * worst case. Numbers depend on the machine; compare runs on the same one.
 */
import { RegexDetector, compactOnlyReferenceKeys } from "./regex-detector"
import { NavigationCommandDetector } from "./navigation-command-detector"
import { correctTranscription } from "../asr/transcription-corrector"
import { normalizeBibleTerms } from "../asr/postprocess/bible-terms"

const TEXTS = [
  // Digit-free partials — the most common transcripts in a live service.
  "et donc nous voyons que la grâce de Dieu a été répandue",
  "so what Paul is saying here in this passage is very clear",
  "nous allons prier ensemble avant de continuer",
  // Book mentions without numbers (near-miss candidate shape).
  "Dans l'évangile de Jean ce matin nous lirons ensemble",
  // Reference-bearing finals, the forms both detectors must parse.
  "Turn with me to John 3:16 this morning",
  "Jean chapitre 3, verset 16, dit que Dieu a tant aimé le monde",
  "First Samuel chapter sixteen and verse seven says",
  "lisez avec moi Psaumes chapitre 23 et verset 1",
  // A longer sermon sentence with a reference buried mid-text.
  "et comme il est écrit au livre d'Ésaïe chapitre 53, verset 5, il a été blessé pour nos transgressions",
]

// The digit-free subset: what the detector's early-out targets (every
// pattern needs two digit groups, so these can never match).
const DIGIT_FREE_TEXTS = TEXTS.slice(0, 4)

const detector = new RegexDetector()
const navDetector = new NavigationCommandDetector()

function time(name: string, work: (text: string) => void, rounds = 7, texts: readonly string[] = TEXTS): void {
  for (const text of texts) work(text) // warm-up (JIT)
  const iterations = 2000
  let best = Infinity
  for (let round = 0; round < rounds; round++) {
    const start = process.hrtime.bigint()
    for (let i = 0; i < iterations; i++) work(texts[i % texts.length] as string)
    const ns = Number(process.hrtime.bigint() - start)
    best = Math.min(best, ns)
  }
  const perCallUs = best / iterations / 1000
  console.log(`${name.padEnd(44)} ${perCallUs.toFixed(1).padStart(9)} us/transcript`)
}

console.log(`fixtures: ${TEXTS.length} transcript lines (mixed FR/EN, partials and finals)`)
time("RegexDetector.detect", (t) => void detector.detect(t))
time("RegexDetector.detect — digit-free partials", (t) => void detector.detect(t), 7, DIGIT_FREE_TEXTS)
time("RegexDetector.detectExplicit", (t) => void detector.detectExplicit(t))
time("compactOnlyReferenceKeys", (t) => void compactOnlyReferenceKeys(t))
time("NavigationCommandDetector.detect", (t) => void navDetector.detect(t))
time("correctTranscription", (t) => void correctTranscription(t).correctedText)
time("normalizeBibleTerms", (t) => void normalizeBibleTerms(t))
