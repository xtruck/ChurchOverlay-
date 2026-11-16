import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"

// ARCHITECTURE.md section 146: three surfaces (dashboard, OBS overlay, phone
// remote) each carry their own copy of the French reference tables — the
// no-build-step codebase deliberately duplicates them (same precedent as the
// float32ToInt16 / reconnect-backoff copies), but a copy that silently
// DRIFTS shows the wrong book language on one surface only ("John 3:16" in
// the operator UI while the congregation reads "Jean 3:16"). "darby" was
// missing from the dashboard's translation list exactly that way. These
// guards lock the copies equal; change a table here AND in every surface in
// the same commit. P1-2 (section 149): the dashboard's copies moved to its
// own globalThis module (reference-format.js) — the guard follows them
// there; the surface that drifted is now only a diff of one file away.

const REPO_ROOT = join(__dirname, "..", "..", "..", "..")

const SURFACES = {
  dashboard: join(REPO_ROOT, "apps", "desktop", "renderer", "reference-format.js"),
  overlay: join(REPO_ROOT, "apps", "overlay", "public", "overlay.js"),
  remote: join(REPO_ROOT, "apps", "remote", "public", "remote.js"),
}

function sourceOf(name: keyof typeof SURFACES): string {
  return readFileSync(SURFACES[name], "utf8")
}

function frenchTranslationIds(source: string): string[] {
  const match = /FRENCH_TRANSLATIONS\s*=\s*new Set\(\[([^\]]*)\]\)/.exec(source)
  assert.ok(match, "FRENCH_TRANSLATIONS set literal not found")
  const ids = match[1]!
    .split(",")
    .map((entry) => entry.trim().replace(/^["']|["']$/g, ""))
    .filter((entry) => entry.length > 0)
  assert.ok(ids.length > 0, "FRENCH_TRANSLATIONS list is empty")
  return ids.sort()
}

function frenchBookTable(source: string): string {
  const start = source.indexOf("FRENCH_BOOK_NAMES = {")
  assert.ok(start >= 0, "FRENCH_BOOK_NAMES table not found")
  const openBrace = source.indexOf("{", start)
  let depth = 0
  let end = -1
  for (let i = openBrace; i < source.length; i++) {
    if (source[i] === "{") depth += 1
    else if (source[i] === "}") {
      depth -= 1
      if (depth === 0) {
        end = i
        break
      }
    }
  }
  assert.ok(end > openBrace, "FRENCH_BOOK_NAMES table is unbalanced")
  // Whitespace-normalized: the copies may format differently, but the
  // book->name mapping itself must be the same.
  return source.slice(openBrace + 1, end).replace(/\s+/g, " ").trim()
}

test("FRENCH_TRANSLATIONS is the same set in the dashboard, overlay and remote", () => {
  const dashboard = frenchTranslationIds(sourceOf("dashboard"))
  const overlay = frenchTranslationIds(sourceOf("overlay"))
  const remote = frenchTranslationIds(sourceOf("remote"))
  assert.deepEqual(dashboard, overlay, "dashboard's FRENCH_TRANSLATIONS drifted from the overlay's")
  assert.deepEqual(dashboard, remote, "dashboard's FRENCH_TRANSLATIONS drifted from the remote's")
  // The Darby translation is French text (section 146 fix): every surface
  // must treat it as such or one screen shows the wrong book language.
  assert.ok(dashboard.includes("darby"), "darby is missing from the French translation set")
})

test("FRENCH_BOOK_NAMES is the same table in the dashboard, overlay and remote", () => {
  const dashboard = frenchBookTable(sourceOf("dashboard"))
  const overlay = frenchBookTable(sourceOf("overlay"))
  const remote = frenchBookTable(sourceOf("remote"))
  assert.equal(dashboard, overlay, "dashboard's FRENCH_BOOK_NAMES drifted from the overlay's")
  assert.equal(dashboard, remote, "dashboard's FRENCH_BOOK_NAMES drifted from the remote's")
  // Spot-check the mapping actually contains entries (guards against an
  // emptied table passing the equality checks above).
  assert.ok(dashboard.includes('john: "Jean"'), "the table lost its John->Jean entry")
  assert.ok(dashboard.length > 500, "the table looks truncated")
})
