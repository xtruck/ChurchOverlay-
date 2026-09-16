import type {
  TranscriptResult,
  VerseDetector,
  VerseIndex,
  VerseReference,
} from "../../../packages/contracts"
import { passesTranscriptGate } from "./transcript-gate"
import { detectValidatedReferences } from "./detect-and-validate"

/**
 * The Application Core pipeline implemented so far (ARCHITECTURE.md
 * section 23), from a raw transcript up through the known-valid index:
 *
 *   TranscriptResult
 *         v
 *   Transcript Gate       (reject anything but a final transcript)
 *         v
 *   RegexDetector          (candidate references, purely syntactic)
 *         v
 *   KnownValidVerseIndex   (the hallucination guard)
 *         v
 *   VerseReference[]       (validated — safe for a caller to act on)
 *
 * This intentionally stops here. The next stage in ARCHITECTURE.md section
 * 23 is VerseSource (fetching actual verse text), which requires choosing
 * and integrating a real Bible API — a product/vendor decision, not
 * something to invent unprompted (AGENTS.md section 58).
 *
 * Also usable directly for ARCHITECTURE.md section 44's dry-run mode: feed
 * a synthetic final TranscriptResult in and exercise detection + the
 * hallucination guard without a microphone or a live ASR provider.
 */
export function processTranscript(
  transcript: TranscriptResult,
  detector: VerseDetector,
  index: VerseIndex
): VerseReference[] {
  if (!passesTranscriptGate(transcript)) return []
  return detectValidatedReferences(detector, index, transcript.text)
}
