// Helper for tools/log_to_replay.py: runs the REAL built detector over a list of texts.
//
//   stdin : JSON array of strings
//   stdout: JSON array of {"shown": ["john 3:16"], "rejected": ["isaiah 4:8"]}, one per input
//
// Needs `npm run build` first (it loads dist/). "shown" are references the known-valid index
// accepts; "rejected" are references the detector found but the index refused (the hallucination
// guard working), exactly the split apps/server/detector/sermon-replay.test.ts asserts.
const path = require("node:path")

const root = path.resolve(__dirname, "..", "..", "dist", "apps", "server")
let RegexDetector, KnownValidVerseIndex
try {
  ;({ RegexDetector } = require(path.join(root, "detector", "regex-detector.js")))
  ;({ KnownValidVerseIndex } = require(path.join(root, "verse", "known-valid-verse-index.js")))
} catch (error) {
  console.error("Cannot load dist/ - run `npm run build` first. (" + error.message + ")")
  process.exit(2)
}

const detector = new RegexDetector()
const index = new KnownValidVerseIndex()
const label = (r) => `${r.book} ${r.chapter}:${r.verse}`

let input = ""
process.stdin.setEncoding("utf8")
process.stdin.on("data", (chunk) => (input += chunk))
process.stdin.on("end", () => {
  const texts = JSON.parse(input)
  const out = texts.map((text) => {
    const found = detector.detect(text)
    return {
      shown: found.filter((r) => index.exists(r)).map(label),
      rejected: found.filter((r) => !index.exists(r)).map(label),
    }
  })
  process.stdout.write(JSON.stringify(out))
})
