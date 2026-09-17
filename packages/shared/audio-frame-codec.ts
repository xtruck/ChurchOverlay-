import type { AudioFrame } from "../contracts"

const SAMPLE_RATE = 16000
const SEQUENCE_BYTES = 4

/**
 * Binary wire format for audio frames sent over the WebSocket.
 * ARCHITECTURE.md section 8.2's pipeline diagram shows "Audio Frames ->
 * WebSocket -> Server Audio Ingest", but nowhere specifies a byte-level
 * encoding — audio doesn't fit the JSON command/event protocol from
 * section 30 (a small, fixed set of infrequent control messages, not a
 * high-throughput binary media channel), so it necessarily travels as
 * raw binary WebSocket frames, multiplexed with JSON WsMessages on the
 * same connection and told apart by the WebSocket frame's own binary/text
 * flag. This is that missing wire format, kept as small as possible: a
 * 4-byte little-endian sequence number, followed by raw little-endian
 * PCM16 samples at the fixed canonical 16kHz mono format (section 8.1).
 * The sample rate itself isn't encoded per frame because it's constant,
 * not per-frame data.
 *
 * Both the browser-side audio capture code and the server's WS message
 * handler must agree on this exact layout, so it lives here in
 * packages/shared rather than in either one alone.
 */
export function encodeAudioFrame(frame: AudioFrame): Uint8Array<ArrayBuffer> {
  const buffer = new ArrayBuffer(SEQUENCE_BYTES + frame.samples.length * 2)
  const view = new DataView(buffer)

  view.setUint32(0, frame.sequence, true)
  for (let i = 0; i < frame.samples.length; i++) {
    view.setInt16(SEQUENCE_BYTES + i * 2, frame.samples[i] as number, true)
  }

  return new Uint8Array(buffer)
}

export function decodeAudioFrame(bytes: Uint8Array): AudioFrame {
  if (bytes.length < SEQUENCE_BYTES || (bytes.length - SEQUENCE_BYTES) % 2 !== 0) {
    throw new Error("decodeAudioFrame: malformed audio frame (unexpected byte length)")
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const sequence = view.getUint32(0, true)
  const sampleCount = (bytes.length - SEQUENCE_BYTES) / 2

  const samples = new Int16Array(sampleCount)
  for (let i = 0; i < sampleCount; i++) {
    samples[i] = view.getInt16(SEQUENCE_BYTES + i * 2, true)
  }

  return { samples, sampleRate: SAMPLE_RATE, sequence }
}
