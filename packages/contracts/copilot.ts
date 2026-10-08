import type { Verse } from "./verse"

/**
 * Payload of the "copilot:suggestions" WS event (ARCHITECTURE.md section 125):
 * operator-only suggestions from the optional live sermon copilot. Server-only
 * sender, never delivered to viewer-role clients, never displayed by the
 * overlay. `relatedVerses` were validated (KnownValidVerseIndex) and fetched
 * from the VerseSource; `keyPoint` is plain AI text, not verified content.
 */
export type CopilotKeyPoint = {
  readonly caption: string
  readonly slide: readonly string[]
}

export type CopilotSuggestionsPayload = {
  readonly id: string
  readonly relatedVerses: readonly Verse[]
  readonly keyPoint: CopilotKeyPoint | null
}
