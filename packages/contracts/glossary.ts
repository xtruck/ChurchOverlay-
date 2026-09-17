/**
 * Payload for the "definition:show" WS event (ARCHITECTURE.md section
 * 65.5) — a momentary aside, not a persistent scene the operator manages,
 * hence no announcement-style manual clear command; the server clears it
 * on its own fixed timer.
 */
export type DefinitionShowPayload = {
  readonly term: string
  readonly definition: string
}
