/**
 * Validation for the operator-supplied custom Bible API base URL.
 *
 * The URL is requested from the main process, so it must not be an easy way
 * to reach the local machine or the LAN (SSRF), and it must not carry
 * credentials. Literal addresses are checked here; a hostname that later
 * resolves to a private address (DNS rebinding) is NOT detected, which is why
 * the verse source also checks every response against the requested verse.
 */

export type CustomBibleUrlResult = { ok: true; url: string } | { ok: false; reason: string }

const BLOCKED_HOST_SUFFIXES = [".localhost", ".local", ".internal", ".lan", ".home.arpa"]

function isPrivateIpv4(host: string): boolean {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (!match) return false
  const [a, b] = [Number(match[1]), Number(match[2])]
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  )
}

function isPrivateIpv6(host: string): boolean {
  const bare = host.replace(/^\[|\]$/g, "").toLowerCase()
  if (!bare.includes(":")) return false
  if (bare === "::" || bare === "::1") return true
  if (bare.startsWith("fe8") || bare.startsWith("fe9") || bare.startsWith("fea") || bare.startsWith("feb")) return true
  if (bare.startsWith("fc") || bare.startsWith("fd")) return true
  const mapped = /^::ffff:(.+)$/.exec(bare)
  return mapped ? isPrivateIpv4(mapped[1] as string) || /^[0-9a-f]{1,4}:[0-9a-f]{1,4}$/.test(mapped[1] as string) : false
}

export function validateCustomBibleApiUrl(input: string): CustomBibleUrlResult {
  let parsed: URL
  try {
    parsed = new URL(input.trim())
  } catch {
    return { ok: false, reason: "Custom Bible API URL is not a valid URL" }
  }
  if (parsed.protocol !== "https:") return { ok: false, reason: "Custom Bible API URL must start with https://" }
  if (parsed.username || parsed.password) return { ok: false, reason: "Custom Bible API URL must not contain credentials" }
  if (parsed.search || parsed.hash) return { ok: false, reason: "Custom Bible API URL must not contain a query string or fragment" }

  const host = parsed.hostname.toLowerCase()
  if (host === "localhost" || BLOCKED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    return { ok: false, reason: "Custom Bible API URL must not point at this machine or a local network name" }
  }
  if (isPrivateIpv4(host) || isPrivateIpv6(host)) {
    return { ok: false, reason: "Custom Bible API URL must not point at a private or loopback address" }
  }
  if (!host.includes(".") && !host.includes(":")) {
    return { ok: false, reason: "Custom Bible API URL must use a fully qualified host name" }
  }
  return { ok: true, url: parsed.toString().replace(/\/+$/, "") }
}
