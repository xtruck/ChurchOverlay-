const UINT32_MODULUS = 0x1_0000_0000
const UINT32_HALF_RANGE = 0x8000_0000
const MAX_COUNT = Number.MAX_SAFE_INTEGER

export type AudioFrameSequenceStats = {
  readonly framesObserved: number
  readonly gapEvents: number
  readonly missingFrames: number
  readonly outOfOrderFrames: number
}

export type AudioFrameSequenceObservation = {
  readonly kind: "in-order" | "gap" | "out-of-order"
  readonly expectedSequence: number | null
  readonly receivedSequence: number
  readonly missingFrames: number
  readonly stats: AudioFrameSequenceStats
}

/** Tracks uint32 frame ordering for one microphone session, including wraparound. */
export class AudioFrameSequenceTracker {
  private lastSequence: number | null = null
  private framesObserved = 0
  private gapEvents = 0
  private missingFrames = 0
  private outOfOrderFrames = 0

  reset(): void {
    this.lastSequence = null
    this.framesObserved = 0
    this.gapEvents = 0
    this.missingFrames = 0
    this.outOfOrderFrames = 0
  }

  observe(sequence: number): AudioFrameSequenceObservation {
    if (!Number.isInteger(sequence) || sequence < 0 || sequence >= UINT32_MODULUS) {
      throw new RangeError("audio frame sequence must be a uint32")
    }

    this.framesObserved = incrementBounded(this.framesObserved)
    if (this.lastSequence === null) {
      this.lastSequence = sequence
      return this.observation("in-order", null, sequence, 0)
    }

    const expectedSequence = (this.lastSequence + 1) % UINT32_MODULUS
    if (sequence === expectedSequence) {
      this.lastSequence = sequence
      return this.observation("in-order", expectedSequence, sequence, 0)
    }

    const distance = (sequence - expectedSequence + UINT32_MODULUS) % UINT32_MODULUS
    if (distance < UINT32_HALF_RANGE) {
      this.lastSequence = sequence
      this.gapEvents = incrementBounded(this.gapEvents)
      this.missingFrames = addBounded(this.missingFrames, distance)
      return this.observation("gap", expectedSequence, sequence, distance)
    }

    this.outOfOrderFrames = incrementBounded(this.outOfOrderFrames)
    return this.observation("out-of-order", expectedSequence, sequence, 0)
  }

  snapshot(): AudioFrameSequenceStats {
    return {
      framesObserved: this.framesObserved,
      gapEvents: this.gapEvents,
      missingFrames: this.missingFrames,
      outOfOrderFrames: this.outOfOrderFrames,
    }
  }

  private observation(
    kind: AudioFrameSequenceObservation["kind"],
    expectedSequence: number | null,
    receivedSequence: number,
    missingFrames: number
  ): AudioFrameSequenceObservation {
    return { kind, expectedSequence, receivedSequence, missingFrames, stats: this.snapshot() }
  }
}

function incrementBounded(value: number): number {
  return value < MAX_COUNT ? value + 1 : value
}

function addBounded(value: number, increment: number): number {
  return Math.min(MAX_COUNT, value + increment)
}
