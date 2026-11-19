/**
 * Unauthenticated liveness payload for supervisors and load balancers.
 * Deliberately contains no tokens, keys or configuration: anyone who can
 * reach the port can read it.
 */
export interface HealthPayload {
  readonly status: "ok" | "starting"
  readonly uptimeSeconds: number
}

export function buildHealthPayload(startedAtMs: number, nowMs: number, coreRunning: boolean): HealthPayload {
  return {
    status: coreRunning ? "ok" : "starting",
    uptimeSeconds: Math.max(0, Math.floor((nowMs - startedAtMs) / 1000)),
  }
}
