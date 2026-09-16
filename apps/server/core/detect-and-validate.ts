import type { VerseDetector, VerseIndex, VerseReference } from "../../../packages/contracts"

/**
 * Enforces ARCHITECTURE.md's hallucination-guard invariant (section 14,
 * section 47 Invariant 5): a detector match is a *candidate*, never a
 * trusted reference. This is the only sanctioned way to go from raw
 * transcript text to references anything downstream may act on.
 *
 * Forbidden (ARCHITECTURE.md section 14):
 *   detector.detect(text) -> overlay.show(reference)
 *
 * Correct path, implemented here:
 *   detector -> candidate references -> known-valid index -> validated references
 *
 * This function does not call a Bible API and does not send WebSocket
 * messages — it only narrows candidate references down to ones the known-
 * valid index confirms exist. Fetching verse text (VerseSource) and
 * presenting it are separate, later stages not implemented yet.
 */
export function detectValidatedReferences(
  detector: VerseDetector,
  index: VerseIndex,
  text: string
): VerseReference[] {
  return detector.detect(text).filter((reference) => index.exists(reference))
}
