import { test } from "node:test"
import assert from "node:assert/strict"
import { readdirSync, readFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { join } from "node:path"

// ARCHITECTURE.md section 146 (frontend pass): the five browser surfaces
// (dashboard, OBS overlay, live view, phone remote, stage monitor) each ship
// their own copy of the font set — the no-build-step codebase duplicates
// static assets per static root, and page-assets.test.ts already guards the
// HTML/CSS wiring. Nothing guarded the FILES: a font updated in one surface
// and not the others would silently render different typography per screen.
// Every copy must stay byte-identical; change them together, in one commit.

const REPO_ROOT = join(__dirname, "..", "..", "..", "..")

const FONT_DIRS = [
  join(REPO_ROOT, "apps", "desktop", "renderer", "fonts"),
  join(REPO_ROOT, "apps", "overlay", "public", "fonts"),
  join(REPO_ROOT, "apps", "live", "public", "fonts"),
  join(REPO_ROOT, "apps", "remote", "public", "fonts"),
  join(REPO_ROOT, "apps", "stage", "public", "fonts"),
]

const SURFACE_NAMES = ["dashboard", "overlay", "live", "remote", "stage"]

function fingerprint(dir: string): Map<string, string> {
  const hashes = new Map<string, string>()
  for (const entry of readdirSync(dir).sort()) {
    hashes.set(entry, createHash("sha256").update(readFileSync(join(dir, entry))).digest("hex"))
  }
  return hashes
}

test("the five font directories are byte-identical across surfaces", () => {
  const reference = fingerprint(FONT_DIRS[0]!)
  assert.ok(reference.size >= 5, "the font set looks truncated (fonts.css + 4 font files expected)")
  for (let i = 1; i < FONT_DIRS.length; i++) {
    const other = fingerprint(FONT_DIRS[i]!)
    assert.deepEqual(
      [...other.keys()],
      [...reference.keys()],
      `${SURFACE_NAMES[i]}'s fonts directory has a different file list than the dashboard's`
    )
    for (const [name, hash] of reference) {
      assert.equal(other.get(name), hash, `${SURFACE_NAMES[i]}'s fonts/${name} drifted from the dashboard's copy`)
    }
  }
})
