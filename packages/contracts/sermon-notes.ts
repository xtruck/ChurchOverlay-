/**
 * Payload for the "sermonNotes:update" WS event (ARCHITECTURE.md section
 * 65.7) — dashboard-only, never sent to the overlay/audience. Explicitly
 * AI-generated, never verified content: this is a strictly separate side
 * channel from the hallucination-guarded verse-detection pipeline, and
 * nothing here is ever treated as validated.
 */
export type SermonNotesPayload = {
  readonly notes: string
}
