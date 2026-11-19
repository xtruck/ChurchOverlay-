import { learnedAliasProblem } from "./alias-proposal"

/**
 * Operator-approved correction memory, part 2: the bounded set of book-name words an
 * operator has approved ("nombre" -> Numbers). In memory only; persistence is a port
 * the desktop process owns (the detector and this class never touch the filesystem,
 * AGENTS.md section 12). Every entry is re-validated on the way in, so a hand-edited
 * file can never smuggle in a word the proposal rules would have refused.
 *
 * The detector uses it through `get(word)` and only in EXPLICIT forms (a colon, or
 * "verset"/"chapitre"), never the bare "word N M" form: a learned word may also be an
 * everyday word, and a false reference on screen is worse than a missed one.
 */

export type LearnedAlias = { readonly word: string; readonly book: string }

/** Hard ceiling (AGENTS.md section 36): a runaway approval loop cannot grow this without limit. */
export const MAX_LEARNED_ALIASES = 100

export type AddResult = { readonly ok: true; readonly added: boolean } | { readonly ok: false; readonly reason: string }

export class LearnedAliases {
  private readonly aliases = new Map<string, string>()

  constructor(initial: readonly LearnedAlias[] = []) {
    for (const entry of initial) this.add(entry.word, entry.book)
  }

  get size(): number {
    return this.aliases.size
  }

  get(word: string): string | undefined {
    return this.aliases.get(word)
  }

  list(): LearnedAlias[] {
    return [...this.aliases].map(([word, book]) => ({ word, book })).sort((a, b) => a.word.localeCompare(b.word))
  }

  add(word: string, book: string): AddResult {
    const problem = learnedAliasProblem(word, book)
    if (problem !== null) return { ok: false, reason: problem }
    if (this.aliases.get(word) === book) return { ok: true, added: false }
    if (!this.aliases.has(word) && this.aliases.size >= MAX_LEARNED_ALIASES) {
      return { ok: false, reason: `at most ${MAX_LEARNED_ALIASES} learned words` }
    }
    this.aliases.set(word, book)
    return { ok: true, added: true }
  }

  remove(word: string): boolean {
    return this.aliases.delete(word)
  }
}

export const LEARNED_ALIASES_FILE_VERSION = 1

/** Parse the persisted JSON. Anything that is not a well-formed entry is dropped and counted, never trusted. */
export function parseLearnedAliasesFile(parsed: unknown): { aliases: LearnedAlias[]; dropped: number } {
  const list = typeof parsed === "object" && parsed !== null ? (parsed as { aliases?: unknown }).aliases : undefined
  if (!Array.isArray(list)) return { aliases: [], dropped: 0 }
  const aliases: LearnedAlias[] = []
  let dropped = 0
  for (const entry of list) {
    const word = typeof entry === "object" && entry !== null ? (entry as { word?: unknown }).word : undefined
    const book = typeof entry === "object" && entry !== null ? (entry as { book?: unknown }).book : undefined
    if (typeof word === "string" && typeof book === "string" && learnedAliasProblem(word, book) === null && aliases.length < MAX_LEARNED_ALIASES) {
      aliases.push({ word, book })
    } else {
      dropped += 1
    }
  }
  return { aliases, dropped }
}
