/**
 * Operator-entered Anthropic key: shape check only (never a network call, never logged).
 * The key used to be enterable only on the first-run setup screen, so a church that skipped
 * the optional field could never add it later. This is the validation for the Settings field.
 *
 * "Looks like an Anthropic key" is deliberately loose (prefix + length + no whitespace): the real
 * check is the operator's "Test connection" button. A pasted key with a stray space, newline or
 * surrounding quotes is cleaned, not rejected.
 */
export type AnthropicKeyInput =
  | { readonly ok: true; readonly key: string }
  | { readonly ok: false; readonly error: "empty" | "format" }

const MIN_KEY_LENGTH = 30
const MAX_KEY_LENGTH = 400

export function normalizeAnthropicKeyInput(raw: unknown): AnthropicKeyInput {
  if (typeof raw !== "string") return { ok: false, error: "format" }
  const key = raw.trim().replace(/^["'`]+|["'`]+$/g, "").trim()
  if (key === "") return { ok: false, error: "empty" }
  if (!key.startsWith("sk-ant-") || /\s/.test(key) || key.length < MIN_KEY_LENGTH || key.length > MAX_KEY_LENGTH) {
    return { ok: false, error: "format" }
  }
  // Header-safe: printable ASCII only (a smart-quote or zero-width char would make fetch throw later).
  if (!/^[\x21-\x7e]+$/.test(key)) return { ok: false, error: "format" }
  return { ok: true, key }
}

/**
 * Groq key (also the transcription key, so it is replace-only: there is no "remove" path that
 * could leave the app without ASR). Same loose shape check: `gsk_` prefix, printable ASCII.
 */
export function normalizeGroqKeyInput(raw: unknown): AnthropicKeyInput {
  if (typeof raw !== "string") return { ok: false, error: "format" }
  const key = raw.trim().replace(/^["'`]+|["'`]+$/g, "").trim()
  if (key === "") return { ok: false, error: "empty" }
  if (!key.startsWith("gsk_") || key.length < 20 || key.length > MAX_KEY_LENGTH || !/^[\x21-\x7e]+$/.test(key)) {
    return { ok: false, error: "format" }
  }
  return { ok: true, key }
}
