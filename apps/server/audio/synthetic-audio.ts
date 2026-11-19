/**
 * Deterministic synthetic PCM16 signals for tests and micro-benchmarks
 * (no recordings are committed; every generator is seeded and pure).
 */
import type { AudioFrame } from "../../../packages/contracts"

export const SAMPLE_RATE = 16000

/** Small deterministic PRNG (mulberry32): same seed, same signal. */
export function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function toInt16(value: number): number {
  return Math.max(-32768, Math.min(32767, Math.round(value)))
}

export function frameOf(samples: Int16Array, sequence: number): AudioFrame {
  return { samples, sampleRate: SAMPLE_RATE, sequence }
}

/** Sine tone with the given RMS. */
export function tone(freqHz: number, rms: number, startSample: number, length: number): Int16Array {
  const out = new Int16Array(length)
  const amp = rms * Math.SQRT2
  for (let i = 0; i < length; i++) out[i] = toInt16(amp * Math.sin((2 * Math.PI * freqHz * (startSample + i)) / SAMPLE_RATE))
  return out
}

/** White Gaussian-ish noise (sum of uniforms) scaled to the given RMS. */
export function whiteNoise(rms: number, length: number, random: () => number): Int16Array {
  const out = new Int16Array(length)
  for (let i = 0; i < length; i++) {
    const g = (random() + random() + random() + random() - 2) * Math.sqrt(3) // variance 1
    out[i] = toInt16(g * rms)
  }
  return out
}

/** Low-frequency heavy noise (leaky-integrated white noise) scaled to the RMS. Models rumble, HVAC, kick drum. */
export function rumble(rms: number, length: number, random: () => number): Int16Array {
  const raw = new Float64Array(length)
  let acc = 0
  let sumSq = 0
  for (let i = 0; i < length; i++) {
    acc = acc * 0.995 + (random() - 0.5)
    raw[i] = acc
    sumSq += acc * acc
  }
  const scale = rms / Math.sqrt(sumSq / Math.max(1, length))
  const out = new Int16Array(length)
  for (let i = 0; i < length; i++) out[i] = toInt16((raw[i] as number) * scale)
  return out
}

/**
 * Speech-like signal: a voiced source (fundamental + harmonics, slow pitch
 * drift) shaped by a ~4 Hz syllable envelope, scaled so its overall RMS equals
 * `rms`. Energy sits in 150-3000 Hz like real speech.
 */
export function speechLike(rms: number, startSample: number, length: number, f0 = 140): Int16Array {
  const out = new Int16Array(length)
  const harmonics = 14
  let power = 0
  for (let h = 1; h <= harmonics; h++) power += 1 / (h * h) / 2
  const gain = rms / Math.sqrt(power * 0.5) // the squared envelope averages 0.5
  for (let i = 0; i < length; i++) {
    const t = (startSample + i) / SAMPLE_RATE
    const env = 0.5 * (1 + Math.sin(2 * Math.PI * 4 * t))
    const f = f0 * (1 + 0.05 * Math.sin(2 * Math.PI * 0.7 * t))
    let v = 0
    for (let h = 1; h <= harmonics; h++) v += Math.sin(2 * Math.PI * f * h * t) / h
    out[i] = toInt16(v * Math.sqrt(env) * gain)
  }
  return out
}

/** Hard-clipped square-ish wave (loud distorted music): full-scale peaks. */
export function clippedSquare(freqHz: number, drive: number, startSample: number, length: number): Int16Array {
  const out = new Int16Array(length)
  for (let i = 0; i < length; i++) {
    const s = Math.sin((2 * Math.PI * freqHz * (startSample + i)) / SAMPLE_RATE)
    out[i] = toInt16(32767 * Math.max(-1, Math.min(1, s * drive)))
  }
  return out
}

export function mix(...signals: Int16Array[]): Int16Array {
  const length = Math.max(...signals.map((s) => s.length))
  const out = new Int16Array(length)
  for (let i = 0; i < length; i++) {
    let sum = 0
    for (const s of signals) sum += s[i] ?? 0
    out[i] = toInt16(sum)
  }
  return out
}

export function rmsOf(samples: Int16Array): number {
  let sum = 0
  for (let i = 0; i < samples.length; i++) sum += (samples[i] as number) ** 2
  return Math.sqrt(sum / Math.max(1, samples.length))
}

/** Splits a signal into consecutive frames of `frameSamples`. */
export function toFrames(signal: Int16Array, frameSamples: number, firstSequence = 0): AudioFrame[] {
  const frames: AudioFrame[] = []
  for (let offset = 0; offset + frameSamples <= signal.length; offset += frameSamples) {
    frames.push(frameOf(signal.subarray(offset, offset + frameSamples), firstSequence + frames.length))
  }
  return frames
}
