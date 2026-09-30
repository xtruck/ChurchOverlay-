import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

// Compiled to dist/apps/web/ — three levels up is the repo root (same pattern
// as apps/server/ws/client-handshake.test.ts).
const REPO_ROOT = join(__dirname, "..", "..", "..")

/**
 * The four browser pages, and where Web Server Mode mounts each one
 * (apps/web/index.ts: /overlay, /remote, /stage, /live). The desktop app
 * serves each page from the root of its own server instead.
 */
const PAGES = ["overlay", "remote", "stage", "live"]

/** Local (non-URL) src/href values in a page's HTML. */
function localAssets(html: string): string[] {
  const values = [...html.matchAll(/\b(?:src|href)="([^"]+)"/g)].map((m) => m[1] as string)
  return values.filter((value) => !/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(value))
}

for (const page of PAGES) {
  const dir = join(REPO_ROOT, "apps", page, "public")
  const html = readFileSync(join(dir, "index.html"), "utf8")

  test(`${page} page: local scripts and styles are relative, so they load from both the desktop root and Web Server Mode's /${page}/ mount`, () => {
    // A leading "/" resolves against the site root: fine on the desktop server
    // (page at "/"), but /overlay.js 404s when the page is mounted at /overlay/.
    const rootRelative = localAssets(html).filter((value) => value.startsWith("/"))
    assert.deepEqual(rootRelative, [])
  })

  test(`${page} page: every local script and style it references exists next to it`, () => {
    for (const asset of localAssets(html)) {
      const file = join(dir, asset.split(/[?#]/)[0] as string)
      assert.ok(existsSync(file), `${page}/index.html references ${asset}, but ${file} does not exist`)
    }
  })
}
