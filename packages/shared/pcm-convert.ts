/**
 * Converts Web Audio API samples (Float32, range [-1, 1]) to the
 * canonical PCM16 format the ASR boundary requires (ARCHITECTURE.md
 * section 8.1). This is the one piece of the browser-side audio capture
 * path that is pure computation with no DOM/Web Audio dependency, so it
 * is the one piece of that path this codebase can actually unit-test —
 * the rest (getUserMedia, AudioContext, AudioWorklet) needs a real
 * browser runtime this environment cannot provide.
 *
 * Values are clamped to [-1, 1] before scaling: an upstream node (gain,
 * a worklet, or a buggy input) could technically produce a slightly
 * out-of-range float, and scaling that without clamping would wrap
 * around into a garbage sample rather than just saturating like real
 * audio hardware would.
 *
 * Rounded explicitly rather than left to the implicit truncation
 * Int16Array assignment performs (ToInt16 truncates toward zero, it does
 * not round) — found while writing this file's tests: truncation alone
 * introduces a small systematic bias toward zero on every single sample,
 * which is exactly the kind of accumulated, silent quality loss worth
 * avoiding for something as central as the audio actually being
 * transcribed.
 */
export function float32ToInt16(samples: Float32Array): Int16Array {
  const output = new Int16Array(samples.length)
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i] as number))
    output[i] = Math.round(clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff)
  }
  return output
}
