import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"

// P1-4 (S-07) source guard: the Electron fuses are flipped at PACKAGING time
// by scripts/apply-fuses.cjs through an electron-builder afterPack hook — a
// place no test executes. Nothing would guard the hook itself against
// silent drift: a fuse flipped back to its permissive default, a value
// inverted, or the hook unhooked from the build config would pass the whole
// suite unnoticed. These tests read the shipped sources and pin the
// security-relevant parts: the hook is registered, flipFuses runs with
// FuseVersion.V1, and each hardened fuse keeps its intended value. The
// two deliberately-unflipped fuses are pinned too, with the reason they
// wait for the P2-1 signing pass — so "hardening them later" is a
// deliberate diff here, not an accident.

const REPO_ROOT = join(__dirname, "..", "..")
const HOOK_PATH = join(REPO_ROOT, "scripts", "apply-fuses.cjs")

test("apply-fuses: the afterPack hook is registered in the electron-builder config", () => {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"))
  assert.equal(pkg.build?.afterPack, "scripts/apply-fuses.cjs")
  assert.ok(
    pkg.devDependencies?.["@electron/fuses"],
    "@electron/fuses must stay a devDependency — the fuses are a packaging-time concern, never a runtime one"
  )
})

test("apply-fuses: the four hardened fuses are flipped with the intended values", () => {
  const source = readFileSync(HOOK_PATH, "utf8")
  // Match the ASSIGNMENT line (`[FuseV1Options.X]: value`), not the first
  // prose line that happens to mention the fuse's name.
  const fuseLine = (fuse: string): string => {
    const match = source.split("\n").find((line) => line.includes(`[FuseV1Options.${fuse}]:`))
    assert.ok(match, `the hook must flip [FuseV1Options.${fuse}] — its hardening was removed or renamed`)
    return match as string
  }
  // A repurposed Electron binary is a general-purpose Node runtime on the
  // operator's PC: never allowed.
  assert.ok(/\[FuseV1Options\.RunAsNode\]: false/.test(fuseLine("RunAsNode")))
  // The cookie store holds session state: encryption on.
  assert.ok(/\[FuseV1Options\.EnableCookieEncryption\]: true/.test(fuseLine("EnableCookieEncryption")))
  // NODE_OPTIONS / --inspect are code-injection doors on a token-holding service.
  assert.ok(/\[FuseV1Options\.EnableNodeOptionsEnvironmentVariable\]: false/.test(fuseLine("EnableNodeOptionsEnvironmentVariable")))
  assert.ok(/\[FuseV1Options\.EnableNodeCliInspectArguments\]: false/.test(fuseLine("EnableNodeCliInspectArguments")))
  // And the flips must actually reach a binary: flipFuses with the V1 wire format.
  assert.match(source, /flipFuses\(/)
  assert.match(source, /FuseVersion\.V1/)
})

test("apply-fuses: the two deferred fuses stay documented as deliberate, not forgotten", () => {
  const source = readFileSync(HOOK_PATH, "utf8")
  assert.match(
    source,
    /OnlyLoadAppFromAsar/,
    "OnlyLoadAppFromAsar is deferred to the P2-1 signing pass — keep the reason in the file while it is deferred"
  )
  assert.match(
    source,
    /EnableEmbeddedAsarIntegrityValidation/,
    "EnableEmbeddedAsarIntegrityValidation is deferred to the P2-1 signing pass — keep the reason in the file while it is deferred"
  )
})
