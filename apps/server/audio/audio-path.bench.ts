/**
 * Micro-benchmark of the per-frame audio hot path (not a test: the file name
 * does not match node --test patterns). Run after `npm run build`:
 *
 *   node dist/apps/server/audio/audio-path.bench.js
 *
 * Frames are 128 samples (the AudioWorklet block: 8 ms at 16 kHz, 125 frames
 * per second), the size the desktop capture actually delivers. Each stage is
 * reported as microseconds per frame and as the share of one CPU core needed
 * to process live audio (cost of 1 s of audio / 1000 ms). Numbers depend on
 * the machine; compare stages with each other, not with another computer.
 */
import { AdaptiveGain } from "./adaptive-gain"
import { MicHealthMonitor } from "./mic-health"
import { SanctuaryDsp } from "./sanctuary-dsp"
import { SilenceGate } from "./silence-gate"
import { mix, rng, speechLike, toFrames, whiteNoise, SAMPLE_RATE } from "./synthetic-audio"
import { encodeAudioFrame, decodeAudioFrame } from "../../../packages/shared/audio-frame-codec"
import type { AudioFrame } from "../../../packages/contracts"

const FRAME_SAMPLES = 128
const SECONDS = 20
const random = rng(42)
const signal = mix(speechLike(1500, 0, SAMPLE_RATE * SECONDS), whiteNoise(200, SAMPLE_RATE * SECONDS, random))
const frames: AudioFrame[] = toFrames(signal, FRAME_SAMPLES)

function time(name: string, work: (frame: AudioFrame, index: number) => void, rounds = 5): void {
  for (const frame of frames.slice(0, 500)) work(frame, 0) // warm-up (JIT)
  let best = Infinity
  for (let round = 0; round < rounds; round++) {
    const start = process.hrtime.bigint()
    for (let i = 0; i < frames.length; i++) work(frames[i] as AudioFrame, i)
    const ns = Number(process.hrtime.bigint() - start)
    best = Math.min(best, ns)
  }
  const perFrameUs = best / frames.length / 1000
  const coreShare = (best / 1e9 / SECONDS) * 100
  console.log(`${name.padEnd(34)} ${perFrameUs.toFixed(2).padStart(8)} us/frame  ${coreShare.toFixed(3).padStart(7)} % of one core`)
}

const fixedGate = new SilenceGate({ threshold: 150 })
const robustGate = new SilenceGate({ threshold: 150, robust: true })
const gain = new AdaptiveGain()
const health = new MicHealthMonitor()
const dsp = new SanctuaryDsp()
const scratch = new Int16Array(FRAME_SAMPLES)

console.log(`frames: ${frames.length} x ${FRAME_SAMPLES} samples (${SECONDS} s synthetic speech + noise)`)
time("SilenceGate (fixed threshold)", (f) => void fixedGate.process(f))
time("SilenceGate (robust: band + floor)", (f) => void robustGate.process(f))
time("AdaptiveGain.process", (f) => void gain.process(f, 1500, true))
time("MicHealth.observe", (f) => health.observe(f, 1500, true))
let snapshots = 0
time("MicHealth.snapshot (once per second)", (_f, i) => {
  if (i % 125 === 0) {
    health.snapshot()
    snapshots++
  }
})
time("SanctuaryDsp.process (not wired)", (f) => {
  scratch.set(f.samples)
  dsp.process(scratch)
})
time("encode+decode WS audio frame", (f) => void decodeAudioFrame(new Uint8Array(encodeAudioFrame(f))))
void snapshots
