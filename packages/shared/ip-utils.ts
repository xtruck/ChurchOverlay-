/**
 * Client-address helpers shared by the two rate-limiting entry points
 * (the WS handshake limiter in apps/server/ws and the /api limiter in
 * apps/web/api-auth). One definition, deliberately small: both limiters
 * must agree on what "loopback" and "one client" mean, or the two
 * protections drift apart exactly like the duplicated book tables did.
 */

/**
 * Node reports IPv4-mapped IPv6 clients as "::ffff:a.b.c.d"; both
 * limiters must bucket the SAME client under ONE key, and loopback has
 * to be recognized whether it arrives as "127.0.0.1" or
 * "::ffff:127.0.0.1". Returns the trimmed address, IPv4-unmapped.
 */
export function normalizeRemoteAddress(address: string | undefined): string {
  const trimmed = (address ?? "").trim()
  if (trimmed.toLowerCase().startsWith("::ffff:")) return trimmed.slice("::ffff:".length)
  return trimmed || "unknown"
}

/** Loopback only: the same machine running this server. Never "the LAN". */
export function isLoopbackAddress(address: string | undefined): boolean {
  const normalized = normalizeRemoteAddress(address).toLowerCase()
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "localhost"
}
