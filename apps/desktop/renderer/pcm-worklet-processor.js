// AudioWorkletProcessor runs on the audio rendering thread, isolated from
// the main renderer thread — it can only communicate back via port
// messages, which is why this file is separate from dashboard.js.
//
// ARCHITECTURE.md section 8.1's canonical format is 16kHz mono PCM16;
// this processor's job stops at handing back raw Float32 blocks (the
// native Web Audio format) tagged with a sequence number — the actual
// Float32 -> Int16 conversion happens in dashboard.js, using the same
// logic as packages/shared/pcm-convert.ts (duplicated there deliberately;
// see that file's comment in dashboard.js for why).
class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.sequence = 0
  }

  process(inputs) {
    const input = inputs[0]
    const channel = input && input[0]
    if (channel && channel.length > 0) {
      // .slice() copies out of the audio thread's reused buffer before
      // posting it — without this, the underlying data could be
      // overwritten by the next audio block before the message is read.
      this.port.postMessage({ samples: channel.slice(), sequence: this.sequence })
      this.sequence += 1
    }
    return true // returning true keeps this processor alive for the next block
  }
}

registerProcessor("pcm-capture-processor", PcmCaptureProcessor)
