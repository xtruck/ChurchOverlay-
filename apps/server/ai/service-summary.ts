import type { SessionEntry } from "../core/session-recorder"

/**
 * ARCHITECTURE.md section 93: the post-service AI copilot summary — a
 * strictly one-shot, operator-triggered, read-only digest, NOT a live
 * agent. Deliberately narrow: it only ever summarizes data that already
 * passed through the full validation pipeline (verses actually shown,
 * per SessionEntry — the same already-verified data export-rehearsal/
 * export-session already use) plus sermon notes text the dashboard
 * already accumulated client-side from sermonNotes:update broadcasts.
 * It never calls a Bible source, never validates a new reference, and
 * never runs during the service — only on explicit operator request,
 * after the fact.
 */
export const SERVICE_SUMMARY_SYSTEM_PROMPT =
  "You write a short, warm 2-4 sentence recap of a church service for the pastor/operator's own records, given the exact Bible verses shown on screen (already verified) and the sermon notes already generated during the service. Do not invent any Bible verse, reference, or quote beyond what is explicitly listed below — if nothing was shown or noted, say so briefly. Write in the same language as the sermon notes text (or the verse text if there are no notes). Output plain prose, no headers, no bullet lists."

/**
 * Pure and independently testable (no network call) — builds the exact
 * text handed to the LLM from already-validated data only.
 */
export function buildServiceSummaryInput(entries: readonly SessionEntry[], sermonNotesText: string): string {
  const versesSection =
    entries.length > 0
      ? "Verses shown during the service:\n" +
        entries.map((entry) => `- ${entry.reference.book} ${entry.reference.chapter}:${entry.reference.verse}: "${entry.text}"`).join("\n")
      : "No verses were shown during this service."

  const trimmedNotes = sermonNotesText.trim()
  const notesSection = trimmedNotes
    ? "Sermon notes generated during the service:\n" + trimmedNotes
    : "No sermon notes were generated during this service."

  return `${versesSection}\n\n${notesSection}`
}
