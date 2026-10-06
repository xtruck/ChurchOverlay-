// CI dependency gate: `npm audit` for production dependencies, failing on
// high/critical advisories EXCEPT the explicitly allowlisted ones below.
//
// Why a script instead of `npm audit --audit-level=high`: npm has no ignore
// list, and two advisories currently have no patched release anywhere, so the
// plain command fails every build regardless of what a change touches. Every
// other high/critical advisory (including any new one) still fails the build.
//
// Each entry needs a reason and a way out. Remove an entry as soon as a patch
// exists (`npm audit` will then report "fix available").
import { spawnSync } from "node:child_process"

const ALLOWED = {
  "GHSA-vfj7-8cjw-p6xm": {
    package: "braces",
    reason:
      "braces <=3.0.3 stack exhaustion on deeply nested patterns; 3.0.3 is the latest release. Reached only through the OPTIONAL NDI module (@stagetimerio/grandiose -> shelljs -> fast-glob -> micromatch) globbing local build files, never untrusted input.",
  },
}

const result = spawnSync("npm", ["audit", "--omit=dev", "--json"], { encoding: "utf8", shell: process.platform === "win32", maxBuffer: 64 * 1024 * 1024 })
let report
try {
  report = JSON.parse(result.stdout)
} catch {
  console.error("audit-gate: could not parse `npm audit --json` output")
  console.error(result.stdout || result.stderr)
  process.exit(2)
}
if (report.error) {
  console.error("audit-gate: npm audit failed:", report.error.summary ?? JSON.stringify(report.error))
  process.exit(2)
}

const blocking = []
const allowed = new Set()
for (const [name, vuln] of Object.entries(report.vulnerabilities ?? {})) {
  if (vuln.severity !== "high" && vuln.severity !== "critical") continue
  // `via` strings point at other vulnerable packages (judged on their own
  // entry); objects are the advisories that apply to this package itself.
  for (const via of vuln.via) {
    if (typeof via === "string") continue
    const id = String(via.url ?? "").split("/").pop() ?? ""
    if (via.severity !== "high" && via.severity !== "critical") continue
    if (ALLOWED[id]) allowed.add(`${name}: ${id} (${ALLOWED[id].reason})`)
    else blocking.push(`${name}: ${via.title ?? "advisory"} - ${via.url ?? "no url"}`)
  }
}

for (const line of allowed) console.log(`audit-gate: allowed  ${line}`)
if (blocking.length > 0) {
  console.error("\naudit-gate: FAILING - high/critical advisories that are not allowlisted:")
  for (const line of blocking) console.error(`  - ${line}`)
  process.exit(1)
}
console.log("audit-gate: no un-allowlisted high/critical advisories in production dependencies")
