import { nullProto } from "../../../../packages/shared/type-guards"

const BIBLE_TERM_ALIASES: Readonly<Record<string, string>> = nullProto({
  "saint-esprit": "Saint-Esprit",
  "saint esprit": "Saint-Esprit",
  "jésus": "Jésus",
  "jesus": "Jésus",
  "évangile": "Évangile",
  "evangile": "Évangile",
  "psaume": "Psaume",
})

// PERF + CORRECTIF (2026-11-15): the patterns used to be compiled inside
// normalizeBibleTerms() — seven `new RegExp` per transcript, partials
// included (detection-path.bench.ts: ~3.5 us/transcript, almost all of it
// compilation). They are now built once at module load.
//
// The boundaries are Unicode letter/digit lookarounds instead of `\b`:
// JS `\b` is ASCII-word-based, so there is no boundary before "é" of
// "évangile" after a space, an apostrophe or any other non-\w character —
// the accented aliases ("évangile", and "jésus" after an apostrophe or a
// dash) could never match the ordinary phrases they exist for ("l'évangile
// de Jean", "au nom de jésus"). Same fix RegexDetector's own patterns got
// (see its class doc comment); the lookarounds also keep a compound like
// "archévangile" from matching mid-word, exactly as \b did.
const BIBLE_TERM_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = Object.entries(
  BIBLE_TERM_ALIASES
).map(([alias, canonical]) => [
  new RegExp(`(?<![\\p{L}\\d])${escapeRegExp(alias)}(?![\\p{L}\\d])`, "giu"),
  canonical,
])

/** Applies only exact, known term casing; it does not infer references. */
export function normalizeBibleTerms(text: string): string {
  let result = text
  for (const [pattern, canonical] of BIBLE_TERM_PATTERNS) {
    result = result.replace(pattern, canonical)
  }
  return result
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
