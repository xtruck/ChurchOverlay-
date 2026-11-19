// Helper for tools/quote_tuner.py: runs the REAL built QuoteMatcher over many queries and parameter sets.
//
//   stdin : {"grid": [{"shingle":5,"minRuns":4,"minCoverage":0.35,"dominance":2}, ...],
//            "queries": [{"id": 0, "text": "..."}, ...]}
//   stdout: {"results": [[{"id":0,"match": "john 3:16" | null}, ...], ...]}   one list per grid entry
//
// Needs `npm run build` first (it loads dist/). The Bible text is the bundled LSG 1910 file.
const fs = require("node:fs")
const path = require("node:path")

const repo = path.resolve(__dirname, "..", "..")
let QuoteMatcher
try {
  ;({ QuoteMatcher } = require(path.join(repo, "dist", "apps", "server", "detector", "quote-matcher.js")))
} catch (error) {
  console.error("Cannot load dist/ - run `npm run build` first. (" + error.message + ")")
  process.exit(2)
}
const data = JSON.parse(fs.readFileSync(path.join(repo, "apps", "server", "verse", "data", "fra_lsg.json"), "utf8"))

let input = ""
process.stdin.setEncoding("utf8")
process.stdin.on("data", (chunk) => (input += chunk))
process.stdin.on("end", () => {
  const { grid, queries } = JSON.parse(input)
  const results = grid.map((options) => {
    const matcher = new QuoteMatcher(data, options)
    return queries.map((q) => {
      const m = matcher.match(q.text)
      return { id: q.id, match: m ? `${m.reference.book} ${m.reference.chapter}:${m.reference.verse}` : null }
    })
  })
  process.stdout.write(JSON.stringify({ results }))
})
