import { normalizeBibleTerms } from "./bible-terms"
import { normalizePunctuation } from "./punctuation"
import { normalizeTranscript } from "./normalize"

export function postprocessTranscript(text: string): string {
  return normalizeBibleTerms(normalizePunctuation(normalizeTranscript(text)))
}
