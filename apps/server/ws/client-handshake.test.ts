import { test } from "node:test"
import assert from "node:assert/strict"
import { readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"

/**
 * Guards the handshake contract between the WS server and every browser page
 * this repo ships (SECURITY.md item 13, ARCHITECTURE.md section 106).
 *
 * Why a static-source test instead of a browser test: the failure mode this
 * covers is otherwise invisible to `npm test`. A page opening
 * `new WebSocket(url)` with NO subprotocol still gets a working 101 response
 * from `ws`, was previously admitted as an unauthenticated viewer, and only
 * started being terminated once `ChurchOverlayWsServer` re-checked
 * `socket.protocol` — the change that silently broke the Stage Display and
 * Live Companion pages precisely because nothing tested page-to-server
 * handshakes. Real browser execution isn't automatable here (TESTING.md,
 * "Not automated in this repository"), so the source is asserted directly:
 * deterministic, no network, no secrets.
 *
 * The server side of the same contract (viewer token accepted, unknown token
 * refused, tokenless connection terminated) is exercised against a real
 * socket in `server.test.ts`.
 */

// This compiled file lives at dist/apps/server/ws/, so four levels up is the
// repo root — the same REPO_ROOT pattern
// apps/server/verse/offline-verse-source.ts and apps/desktop/main/index.ts
// already use for shipped non-TypeScript assets.
const REPO_ROOT = join(__dirname, "..", "..", "..", "..")

/**
 * Every directory whose .js is shipped to a browser and may open a
 * WebSocket: the four served static pages and the operator dashboard
 * renderer (loaded into the dashboard BrowserWindow).
 * `apps/overlay/dev-preview/` is deliberately absent — it is never packaged
 * or served (SECURITY.md item 7).
 */
const SHIPPED_CLIENT_DIRS = [
  join("apps", "overlay", "public"),
  join("apps", "remote", "public"),
  join("apps", "stage", "public"),
  join("apps", "live", "public"),
  join("apps", "desktop", "renderer"),
]

/**
 * The pages expected to open a WebSocket, repo-relative. Asserted below so
 * that renaming or moving a page fails this test loudly instead of silently
 * voiding the guard.
 */
const EXPECTED_CLIENT_FILES = [
  join("apps", "desktop", "renderer", "dashboard.js"),
  join("apps", "live", "public", "live.js"),
  join("apps", "overlay", "public", "overlay.js"),
  join("apps", "remote", "public", "remote.js"),
  join("apps", "stage", "public", "stage.js"),
]

function jsFilesUnder(dir: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...jsFilesUnder(full))
    else if (entry.isFile() && entry.name.endsWith(".js")) found.push(full)
  }
  return found
}

/**
 * Returns the argument-list text of every `new WebSocket(...)` call in
 * `source`. Small hand-rolled scanner (no parser dependency, AGENTS.md
 * section 40): tracks quotes and bracket depth so a comma or paren inside a
 * string literal can't end an argument early.
 */
function webSocketCallArgs(source: string): string[] {
  const marker = "new WebSocket("
  const found: string[] = []
  let from = 0

  for (;;) {
    const start = source.indexOf(marker, from)
    if (start === -1) break
    const argsStart = start + marker.length
    let depth = 1
    let quote: string | null = null
    let i = argsStart

    for (; i < source.length; i++) {
      const ch = source.charAt(i)
      if (quote !== null) {
        if (ch === "\\") {
          i++
          continue
        }
        if (ch === quote) quote = null
        continue
      }
      if (ch === '"' || ch === "'" || ch === "`") {
        quote = ch
        continue
      }
      if (ch === "(" || ch === "[" || ch === "{") {
        depth++
        continue
      }
      if (ch === ")" || ch === "]" || ch === "}") {
        depth--
        if (depth === 0) break
      }
    }

    found.push(source.slice(argsStart, i))
    from = i
  }

  return found
}

/** Splits an argument list on its top-level commas only. */
function splitTopLevelArgs(args: string): string[] {
  const parts: string[] = []
  let depth = 0
  let quote: string | null = null
  let current = ""

  for (let i = 0; i < args.length; i++) {
    const ch = args.charAt(i)
    if (quote !== null) {
      current += ch
      if (ch === "\\") {
        current += args.charAt(i + 1)
        i++
        continue
      }
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch
      current += ch
      continue
    }
    if (ch === "(" || ch === "[" || ch === "{") depth++
    if (ch === ")" || ch === "]" || ch === "}") depth--
    if (ch === "," && depth === 0) {
      parts.push(current)
      current = ""
      continue
    }
    current += ch
  }

  parts.push(current)
  return parts.map((part) => part.trim())
}

/** True only for a non-empty `[...]` protocols array in the second argument. */
function isProtocolsArray(protocolArg: string | undefined): boolean {
  if (protocolArg === undefined) return false
  return protocolArg.startsWith("[") && protocolArg.endsWith("]") && protocolArg.length > 2
}

/**
 * Heuristic, deliberately not data-flow analysis: every shipped page builds
 * its WS URL once into a `const`, so when the first argument is a bare
 * identifier the declaration expression is what has to be inspected for a
 * token. An identifier this can't resolve is left as-is — the subprotocol
 * assertion above is the one that actually enforces authentication; this
 * check catches the URL-parameter habit AGENTS.md section 18 forbids.
 */
function urlSourceFor(source: string, urlArg: string): string {
  if (!/^[A-Za-z_$][\w$]*$/.test(urlArg)) return urlArg
  const declaration = new RegExp(`(?:const|let|var)\\s+${urlArg}\\s*=\\s*([^;\\n]+)`)
  return declaration.exec(source)?.[1] ?? urlArg
}

test("every shipped browser page authenticates its WebSocket with Sec-WebSocket-Protocol, never a URL parameter", () => {
  const violations: string[] = []
  const filesWithCalls: string[] = []

  for (const dir of SHIPPED_CLIENT_DIRS) {
    for (const file of jsFilesUnder(join(REPO_ROOT, dir))) {
      const label = relative(REPO_ROOT, file)
      const source = readFileSync(file, "utf8")
      const calls = webSocketCallArgs(source)
      if (calls.length === 0) continue
      filesWithCalls.push(label)

      for (const args of calls) {
        const parts = splitTopLevelArgs(args)
        const urlArg = parts[0] ?? ""

        if (/token=/i.test(urlSourceFor(source, urlArg))) {
          violations.push(
            `${label}: new WebSocket(${args}) puts a token in the connection URL — AGENTS.md section 18 requires Sec-WebSocket-Protocol instead`
          )
        }
        if (!isProtocolsArray(parts[1])) {
          violations.push(
            `${label}: new WebSocket(${args}) presents no subprotocol, so the server terminates it as unauthenticated`
          )
        }
      }
    }
  }

  assert.deepEqual(violations, [], "shipped WS clients that the server handshake would refuse")
  assert.deepEqual(
    filesWithCalls.slice().sort(),
    EXPECTED_CLIENT_FILES.slice().sort(),
    "the set of shipped pages opening a WebSocket changed — update this test deliberately if a page was added or removed"
  )
})
