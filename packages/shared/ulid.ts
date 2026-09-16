import { randomBytes } from "node:crypto"

/**
 * ULID generation (ARCHITECTURE.md section 39, AGENTS.md section 21):
 * sortable, compact, timestamp-aware, collision-resistant IDs. Message
 * IDs and correlation IDs must use these, never predictable incremental
 * integers.
 *
 * Format: 26 characters in Crockford's base32 alphabet (excludes I, L, O,
 * U to avoid visual ambiguity) — 10 characters encoding a 48-bit
 * millisecond timestamp (most significant first, so ULIDs sort
 * lexicographically by creation time), followed by 16 characters encoding
 * 80 bits of cryptographically random data from node:crypto (never
 * Math.random(), which is not a CSPRNG).
 *
 * This lives in packages/shared because both the server and the desktop
 * app will need it (any component that must mint a message ID or
 * correlation ID), not just one subsystem.
 */

const CROCKFORD_BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/

export function generateUlid(now: number = Date.now()): string {
  return encodeTime(now) + encodeRandomness()
}

export function isValidUlid(value: string): boolean {
  return ULID_PATTERN.test(value)
}

function encodeTime(timestampMs: number): string {
  if (!Number.isInteger(timestampMs) || timestampMs < 0) {
    throw new RangeError("timestampMs must be a non-negative integer")
  }

  let remaining = timestampMs
  let encoded = ""
  for (let i = 0; i < 10; i++) {
    const digit = remaining % 32
    encoded = CROCKFORD_BASE32[digit] + encoded
    remaining = Math.floor(remaining / 32)
  }
  return encoded
}

function encodeRandomness(): string {
  const bytes = randomBytes(10) // 80 bits

  let encoded = ""
  let buffer = 0
  let bufferBits = 0

  for (const byte of bytes) {
    buffer = (buffer << 8) | byte
    bufferBits += 8

    while (bufferBits >= 5) {
      bufferBits -= 5
      encoded += CROCKFORD_BASE32[(buffer >> bufferBits) & 0x1f]
    }
    // Keep only the bits not yet consumed, so `buffer` never accumulates
    // stale high bits from a previous byte (JS bitwise ops are 32-bit —
    // this keeps the working value small regardless of input length).
    buffer &= (1 << bufferBits) - 1
  }

  return encoded
}
