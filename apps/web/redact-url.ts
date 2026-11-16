/**
 * S-09: the startup console used to print the page URLs with their
 * tokens in full. Those lines end up in capture-everything sinks
 * (journald, docker logs, CI runs, a pasted "here is my log" issue), so
 * every URL this module renders keeps only a 4-character fingerprint of
 * the token — enough to tell two links apart, useless to authenticate
 * with. /api/status still returns the real URLs to a caller that
 * already authenticated; only the LOG path masks.
 *
 * The pages accept the token in the URL FRAGMENT (#token=...) and in
 * the legacy query form (?token=...); both are masked here, and the
 * masking never touches anything else in the URL.
 */

/** A 4-character fingerprint — one printable glyph per 8 token chars is not the goal; recognizability is. */
export function redactToken(value: string): string {
  if (value.length <= 4) return "…"
  return `${value.slice(0, 4)}…`
}

export function redactUrl(url: string): string {
  const fragment = url.replace(/(#token=)([^&]+)/gi, (_match, prefix: string, token: string) => `${prefix}${redactToken(token)}`)
  return fragment.replace(/([?&]token=)([^&]+)/gi, (_match, prefix: string, token: string) => `${prefix}${redactToken(token)}`)
}
