// P1-4 (S-07): electron-builder afterPack hook — flips the Electron security
// fuses on the freshly packaged binary, so the installed app cannot be
// repurposed as a plain Node.js runtime (RunAsNode), have its cookie store
// read in cleartext (EnableCookieEncryption), or be driven through the
// NODE_OPTIONS / --inspect escape hatches that a hardened, token-holding
// service must not expose.
//
// Why a hook and not a post-build script: afterPack runs for BOTH
// `npm run package` (--dir) and `npm run dist`, directly on
// context.appOutDir — no path guessing, no second packaging pass.
//
// Fuses deliberately LEFT at their defaults (recorded for the P2-1 signing
// pass, where a real packaged run can be exercised end to end):
//   - OnlyLoadAppFromAsar: the grandiose native module ships via
//     asarUnpack, and this build chain has no packaged-run smoke test yet —
//     flipping it blind risks bricking every install for no measured gain.
//   - EnableEmbeddedAsarIntegrityValidation: meaningful once the installer
//     is signed (the fuse checks a signature-embedded hash); the signing
//     pass is exactly where it belongs.
//
// Everything here is build-time only: no runtime dependency, no change to
// the wire protocol, no change to the app's behaviour on a normal launch.

const { join } = require("node:path")
const { flipFuses, FuseVersion, FuseV1Options } = require("@electron/fuses")

function packagedBinaryPath(context) {
  const product = context.packager.appInfo.productFilename
  switch (context.electronPlatformName) {
    case "win32":
      return join(context.appOutDir, `${product}.exe`)
    case "darwin":
      return join(context.appOutDir, `${product}.app`, "Contents", "MacOS", product)
    default:
      return join(context.appOutDir, product)
  }
}

module.exports = async function afterPack(context) {
  const binary = packagedBinaryPath(context)
  await flipFuses(binary, {
    version: FuseVersion.V1,
    // The app never spawns child Electron processes as Node: a captured
    // "ELECTRON_RUN_AS_NODE=1 ./ChurchOverlay.exe script.js" must not turn
    // the installed app into a general-purpose runtime on the operator's PC.
    [FuseV1Options.RunAsNode]: false,
    // Encrypt the Chromium cookie store: the WS tokens and connection state
    // the renderer keeps must not sit in a plaintext Cookies SQLite file.
    [FuseV1Options.EnableCookieEncryption]: true,
    // NODE_OPTIONS could inject code into every future Electron child
    // process; the app launches nothing that needs it.
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    // --inspect opens a debug port on the running app: a remote debugger on
    // a service that holds operator tokens is exactly the surface S-07 closes.
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
  })
  // flipFuses throws on a malformed binary or a failed write — reaching this
  // line means the four fuses above are committed onto this build.
}
