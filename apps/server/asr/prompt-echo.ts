/**
 * Prompt-echo guard for the local Whisper engines (ARCHITECTURE.md section 117).
 *
 * Whisper treats its prompt as the text spoken just before the audio. Fed
 * silence, noise or a very short clip, it sometimes "continues" by repeating
 * the prompt itself ("Lecture biblique : Jean chapitre 3 verset 16, Psaume
 * 23..."), which would then reach the detector as if the preacher had said it.
 *
 * Pure and deterministic. The caller decides what to do with an echo (the
 * provider retries the same audio once without a prompt, so a sentence the
 * preacher genuinely spoke is never lost to a coincidental match).
 */

/** Shorter transcripts are never called an echo: "Jean chapitre 3 verset 16" is real speech far more often. */
export const PROMPT_ECHO_MIN_WORDS = 6
/** Share of the transcript's words that must form one contiguous run of the prompt. */
export const PROMPT_ECHO_MIN_SHARE = 0.8

export function echoWords(text: string): string[] {
  return text
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 0)
}

/** Length of the longest run of words appearing contiguously, in order, in both lists. */
function longestCommonRun(a: readonly string[], b: readonly string[]): number {
  let best = 0
  let previous = new Array<number>(b.length + 1).fill(0)
  for (let i = 1; i <= a.length; i++) {
    const current = new Array<number>(b.length + 1).fill(0)
    for (let j = 1; j <= b.length; j++) {
      if (a[i - 1] === b[j - 1]) {
        current[j] = (previous[j - 1] as number) + 1
        if ((current[j] as number) > best) best = current[j] as number
      }
    }
    previous = current
  }
  return best
}

/**
 * True when the transcript is (mostly) a verbatim stretch of the prompt:
 * at least PROMPT_ECHO_MIN_WORDS words, and at least 80% of them form one
 * contiguous run of the prompt's words. Accents, case and punctuation are ignored.
 */
export function isPromptEcho(transcript: string, prompt: string): boolean {
  const spoken = echoWords(transcript)
  if (spoken.length < PROMPT_ECHO_MIN_WORDS) return false
  const prompted = echoWords(prompt)
  if (prompted.length === 0) return false
  return longestCommonRun(spoken, prompted) >= Math.ceil(spoken.length * PROMPT_ECHO_MIN_SHARE)
}
