import type { TranscriptResult } from "../../../packages/contracts"

/**
 * Transcript Gate (ARCHITECTURE.md section 5 high-level diagram, section
 * 8 "Transcript Rules", section 10.3 "Partial transcript rule").
 *
 * Enforces Invariant 1 (ARCHITECTURE.md section 47) and AGENTS.md section
 * 8's "Critical rule": partial transcripts must NEVER trigger verse
 * detection. This is a pure predicate — it does not buffer, log, or
 * transform transcripts, and it does not decide whether a partial
 * transcript may be displayed elsewhere (AGENTS.md section 8 explicitly
 * allows that; it only gates entry into the detection pipeline).
 *
 * Fails closed: only a transcript whose state is exactly "final" passes.
 * Anything else — including a value that should be impossible under the
 * TranscriptResult type but could still arrive if an upstream adapter is
 * buggy or untrusted — is rejected.
 */
export function passesTranscriptGate(transcript: TranscriptResult): boolean {
  return transcript.state === "final"
}
