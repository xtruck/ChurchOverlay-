/**
 * The words the operator is shown next to a pending verse ("Heard: ...").
 * Display-only text taken from the already-final transcript; bounded so a
 * long utterance cannot bloat the pending message (AGENTS.md section 36).
 * It keeps the END of a long utterance, where the reference usually is.
 */
export const HEARD_SNIPPET_MAX_CHARS = 160

export function heardSnippet(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim()
  if (flat.length <= HEARD_SNIPPET_MAX_CHARS) return flat
  return "…" + flat.slice(flat.length - (HEARD_SNIPPET_MAX_CHARS - 1)).trimStart()
}
