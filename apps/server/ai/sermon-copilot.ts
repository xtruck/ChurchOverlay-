import type { TextCompleter } from "./claude-client"
import { coerceReference, type RepairedReference } from "./reference-repairer"

/**
 * AI feature 3 (ARCHITECTURE.md section 125): operator-only suggestions drawn
 * from the recent validated transcript: related verses and a key-point
 * caption / slide text. NOT a chat agent: one fixed prompt, no operator input.
 *
 * The related verses are CANDIDATES (AppCore validates and fetches them like any
 * proposal); the caption and slide lines are plain AI text, bounded here.
 */

export const MAX_RELATED_VERSES = 3
export const MAX_CAPTION_CHARS = 140
export const MAX_SLIDE_LINES = 4
export const MAX_SLIDE_LINE_CHARS = 70

export type CopilotDraft = {
  readonly relatedVerses: readonly RepairedReference[]
  readonly keyPoint: { readonly caption: string; readonly slide: readonly string[] } | null
}

const SYSTEM_PROMPT = [
  "You assist the operator of a church service, privately, while the pastor preaches (French or English, sometimes both).",
  "From the recent sermon text, suggest: (1) up to 3 Bible verses that relate to what is being preached and that the operator might want to show, and (2) the current key point as a short caption and up to 4 short slide lines.",
  "Answer with JSON only, no prose: {\"relatedVerses\":[{\"book\":\"<name>\",\"chapter\":<int>,\"verse\":<int>}],\"keyPoint\":{\"caption\":\"<max 140 chars>\",\"slide\":[\"<max 70 chars>\"]}}",
  "Write the caption and slide in the language of the sermon. Never invent what the pastor said. Do not suggest verses already listed as shown.",
  "If there is nothing useful yet, answer {\"relatedVerses\":[],\"keyPoint\":null}.",
].join("\n")

export class SermonCopilot {
  constructor(private readonly completer: TextCompleter) {}

  async suggest(recentText: string, shown: readonly string[]): Promise<CopilotDraft | null> {
    const shownLine = shown.length > 0 ? `\nAlready shown: ${shown.slice(-8).join("; ")}.` : ""
    const answer = await this.completer.complete({
      system: SYSTEM_PROMPT,
      user: `Recent sermon text:\n${recentText.slice(-3_000)}${shownLine}`,
      maxTokens: 400,
      timeoutMs: 15_000,
    })
    return parseCopilotAnswer(answer)
  }
}

function cleanLine(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null
  // eslint-disable-next-line no-control-regex
  const text = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim()
  return text ? text.slice(0, max) : null
}

/** Strict, bounded parsing; anything unusable yields null or is dropped field by field. */
export function parseCopilotAnswer(answer: string): CopilotDraft | null {
  const start = answer.indexOf("{")
  const end = answer.lastIndexOf("}")
  if (start < 0 || end <= start) return null
  let parsed: Record<string, unknown>
  try {
    const value: unknown = JSON.parse(answer.slice(start, end + 1))
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null
    parsed = value as Record<string, unknown>
  } catch {
    return null
  }

  const relatedVerses: RepairedReference[] = []
  if (Array.isArray(parsed.relatedVerses)) {
    for (const item of parsed.relatedVerses.slice(0, MAX_RELATED_VERSES)) {
      if (typeof item !== "object" || item === null) continue
      const reference = coerceReference(item as Record<string, unknown>)
      if (reference) relatedVerses.push(reference)
    }
  }

  let keyPoint: CopilotDraft["keyPoint"] = null
  const rawPoint = parsed.keyPoint
  if (typeof rawPoint === "object" && rawPoint !== null && !Array.isArray(rawPoint)) {
    const point = rawPoint as Record<string, unknown>
    const caption = cleanLine(point.caption, MAX_CAPTION_CHARS)
    const slide = Array.isArray(point.slide)
      ? point.slide
          .slice(0, MAX_SLIDE_LINES)
          .map((line) => cleanLine(line, MAX_SLIDE_LINE_CHARS))
          .filter((line): line is string => line !== null)
      : []
    if (caption || slide.length > 0) keyPoint = { caption: caption ?? slide[0] ?? "", slide }
  }

  if (relatedVerses.length === 0 && keyPoint === null) return null
  return { relatedVerses, keyPoint }
}
