/** A non-null, non-array object — the shape of a parsed JSON object. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** True for a Node fs error whose code is ENOENT (the file or directory does not exist). */
export function isNotFoundError(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code: unknown }).code === "ENOENT"
}
/**
 * A lookup table with NO prototype. Tables keyed by transcribed text must not
 * resolve "constructor", "toString", "__proto__" or "hasOwnProperty" to
 * Object.prototype members (AUDIT TS-06): on a plain object literal
 * `table["constructor"]` is a function, not undefined.
 */
export function nullProto<T extends object>(table: T): T {
  return Object.assign(Object.create(null) as object, table) as T
}
