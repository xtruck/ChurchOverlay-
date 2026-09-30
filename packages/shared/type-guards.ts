/** A non-null, non-array object — the shape of a parsed JSON object. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** True for a Node fs error whose code is ENOENT (the file or directory does not exist). */
export function isNotFoundError(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code: unknown }).code === "ENOENT"
}
