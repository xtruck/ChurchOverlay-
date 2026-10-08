import type { TextCompleter } from "./claude-client"
import type { SessionEntry } from "../core/session-recorder"

/**
 * AI feature 4 (ARCHITECTURE.md section 126): post-service extras on top of the
 * one-shot service summary (section 93): a French + English recap, AI-selected
 * quote cards, and a notes export.
 *
 * Everything here is derived ONLY from data that already passed validation: the
 * verses actually shown this session and the sermon notes already generated.
 * The model selects and summarizes; code checks every selection against that
 * data, so a card can never carry a verse that was not shown or a "note" line
 * that is not in the notes.
 */

export const MAX_EXTRAS_VERSES = 60
export const MAX_EXTRAS_VERSE_CHARS = 300
export const MAX_EXTRAS_NOTES_CHARS = 6_000
export const MAX_RECAP_CHARS = 1_200
export const MAX_VERSE_CARDS = 3
export const MAX_NOTE_CARDS = 2
export const MAX_NOTE_QUOTE_CHARS = 160

export type ServiceQuoteCard =
  | { readonly kind: "verse"; readonly entry: SessionEntry }
  | { readonly kind: "note"; readonly text: string }

export type ServiceExtras = {
  readonly recap: { readonly fr: string; readonly en: string }
  readonly cards: readonly ServiceQuoteCard[]
}

export const SERVICE_EXTRAS_SYSTEM_PROMPT = [
  "You prepare the post-service material of a church service for the pastor and operator, from verified data only: the numbered Bible verses shown on screen, and the sermon notes generated during the service.",
  "Answer with JSON only, no prose: {\"recapFr\":\"...\",\"recapEn\":\"...\",\"verseCards\":[<numbers>],\"noteQuotes\":[\"...\"]}",
  "recapFr and recapEn: the same warm 2-4 sentence recap, once in French and once in English. Use only what is in the verses and notes. Never invent a verse, reference or quote.",
  "verseCards: the numbers (from the list) of up to 3 shown verses that would make the strongest quote cards. Use only listed numbers.",
  "noteQuotes: up to 2 short, strong sentences copied WORD FOR WORD from the sermon notes (max 160 characters each). Copy exactly, do not rephrase. Use [] if the notes have nothing quotable.",
  "If nothing was shown, use [] for verseCards. If there are no notes, use [] for noteQuotes.",
].join("\n")

export function buildServiceExtrasInput(entries: readonly SessionEntry[], notesText: string): string {
  const shown = entries.slice(-MAX_EXTRAS_VERSES)
  const verses =
    shown.length > 0
      ? "Verses shown during the service (verified):\n" +
        shown
          .map((entry, i) => `[${i + 1}] ${entry.reference.book} ${entry.reference.chapter}:${entry.reference.verse}: "${entry.text.slice(0, MAX_EXTRAS_VERSE_CHARS)}"`)
          .join("\n")
      : "No verses were shown during this service."
  const notes = notesText.trim().slice(-MAX_EXTRAS_NOTES_CHARS)
  return `${verses}\n\n${notes ? "Sermon notes generated during the service:\n" + notes : "No sermon notes were generated during this service."}`
}

function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null
  // eslint-disable-next-line no-control-regex
  const text = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim()
  return text ? text.slice(0, max) : null
}

/** Whitespace-, case- and list-marker-insensitive form used to prove a quote really is in the notes. */
export function normalizeForQuoteCheck(text: string): string {
  return text
    .replace(/^\s*[-*•]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
}

/**
 * Strict parsing. A missing or empty recap in either language is an error (the
 * operator is told, nothing is invented); card selections that fail their check
 * are dropped one by one.
 */
export function parseServiceExtras(answer: string, entries: readonly SessionEntry[], notesText: string): ServiceExtras {
  const start = answer.indexOf("{")
  const end = answer.lastIndexOf("}")
  if (start < 0 || end <= start) throw new Error("The model's answer could not be read.")
  let parsed: Record<string, unknown>
  try {
    const value: unknown = JSON.parse(answer.slice(start, end + 1))
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("not an object")
    parsed = value as Record<string, unknown>
  } catch {
    throw new Error("The model's answer could not be read.")
  }

  const fr = cleanText(parsed.recapFr, MAX_RECAP_CHARS)
  const en = cleanText(parsed.recapEn, MAX_RECAP_CHARS)
  if (!fr || !en) throw new Error("The model's answer did not include both the French and the English recap.")

  const shown = entries.slice(-MAX_EXTRAS_VERSES)
  const cards: ServiceQuoteCard[] = []
  const usedNumbers = new Set<number>()
  if (Array.isArray(parsed.verseCards)) {
    for (const number of parsed.verseCards) {
      if (cards.length >= MAX_VERSE_CARDS) break
      if (!Number.isInteger(number) || (number as number) < 1 || (number as number) > shown.length) continue
      if (usedNumbers.has(number as number)) continue
      usedNumbers.add(number as number)
      cards.push({ kind: "verse", entry: shown[(number as number) - 1] as SessionEntry })
    }
  }

  const normalizedNotes = normalizeForQuoteCheck(notesText)
  let noteCards = 0
  if (Array.isArray(parsed.noteQuotes)) {
    for (const quote of parsed.noteQuotes) {
      if (noteCards >= MAX_NOTE_CARDS) break
      const text = cleanText(quote, MAX_NOTE_QUOTE_CHARS)
      if (!text || text.length < 8) continue
      if (!normalizedNotes.includes(normalizeForQuoteCheck(text))) continue
      cards.push({ kind: "note", text })
      noteCards += 1
    }
  }

  return { recap: { fr, en }, cards }
}

export class ServiceExtrasGenerator {
  constructor(private readonly completer: TextCompleter) {}

  async generate(entries: readonly SessionEntry[], notesText: string): Promise<ServiceExtras> {
    const answer = await this.completer.complete({
      system: SERVICE_EXTRAS_SYSTEM_PROMPT,
      user: buildServiceExtrasInput(entries, notesText),
      maxTokens: 1_200,
      timeoutMs: 30_000,
    })
    return parseServiceExtras(answer, entries, notesText)
  }
}

function formatReference(entry: SessionEntry): string {
  const book = entry.reference.book.replace(/\b\w/g, (c) => c.toUpperCase())
  return `${book} ${entry.reference.chapter}:${entry.reference.verse}`
}

function elapsed(entry: SessionEntry, first: SessionEntry): string {
  const total = Math.max(0, Math.floor((entry.timestamp - first.timestamp) / 1000))
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`
}

export type ServiceNotesMarkdownInput = {
  readonly title: string
  /** Already formatted by the caller (keeps this function deterministic). */
  readonly date: string
  readonly extras: ServiceExtras
  readonly entries: readonly SessionEntry[]
  readonly notesText: string
  /** File names of the exported card images, in `extras.cards` order. */
  readonly cardFiles: readonly string[]
}

/** The notes export: a plain Markdown file, bilingual, with the AI-generated parts labelled as such. */
export function buildServiceNotesMarkdown(input: ServiceNotesMarkdownInput): string {
  const { extras, entries } = input
  const lines: string[] = []
  lines.push(`# ${input.title} - ${input.date}`, "")
  lines.push("> AI-generated recap, notes and card selection. Not verified content. The verses listed under \"Scripture shown\" were verified and displayed during the service.", "")
  lines.push("## Recap (Français)", "", extras.recap.fr, "")
  lines.push("## Recap (English)", "", extras.recap.en, "")
  lines.push("## Scripture shown", "")
  if (entries.length === 0) {
    lines.push("No verses were shown during this service.", "")
  } else {
    const first = entries[0] as SessionEntry
    for (const entry of entries) {
      lines.push(`- ${elapsed(entry, first)} ${formatReference(entry)} (${entry.translation}): ${entry.text}`)
    }
    lines.push("")
  }
  lines.push("## Sermon notes (AI)", "", input.notesText.trim() || "No sermon notes were generated during this service.", "")
  lines.push("## Quote cards", "")
  if (extras.cards.length === 0) {
    lines.push("No cards were selected.", "")
  } else {
    extras.cards.forEach((card, i) => {
      const file = input.cardFiles[i] ?? ""
      lines.push(
        card.kind === "verse"
          ? `- ${file}: ${formatReference(card.entry)} (${card.entry.translation})`
          : `- ${file}: Sermon note (AI): "${card.text}"`,
      )
    })
    lines.push("")
  }
  return lines.join("\n")
}
