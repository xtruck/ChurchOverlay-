// Development-only verse card gallery (ARCHITECTURE.md section 133) — NOT part
// of the shipped application and never served by it.
//
// Builds a self-contained folder (default: card-gallery/, git-ignored) with:
//   overlay-sim.html  the REAL overlay page (apps/overlay/public/index.html,
//                     verse-motion.js, overlay.js, fonts inlined as data URIs),
//                     with a fake in-page WebSocket so it can be driven without a
//                     server. The product files are copied verbatim, not edited.
//   index.html        a gallery: every card design side by side (short and long
//                     verse), palette / layout / transition / background pickers,
//                     and Replay buttons for the enter, verse-to-verse and exit
//                     choreography. No network: open it straight from disk.
//
// Usage (after `npm run build`, which compiles the palette catalogue it reads):
//   node scripts/card-gallery.mjs [outDir]
import { readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const OUT = resolve(process.argv[2] || join(ROOT, "card-gallery"))
const require = createRequire(import.meta.url)
const { PALETTES } = require(join(ROOT, "dist", "apps", "server", "overlay", "palettes.js"))
const { OVERLAY_CARD_DESIGNS, OVERLAY_TRANSITIONS } = require(join(ROOT, "dist", "packages", "contracts", "overlay-style.js"))

const PUB = join(ROOT, "apps", "overlay", "public")
const read = (...p) => readFileSync(join(PUB, ...p), "utf8")

// ---- fonts: fonts.css with every url() turned into a data URI ----
const fontsCss = read("fonts", "fonts.css").replace(/url\("([^"]+\.woff2)"\)/g, (_m, file) => {
  const b64 = readFileSync(join(PUB, "fonts", file)).toString("base64")
  return `url("data:font/woff2;base64,${b64}")`
})

// ---- the fake socket + driver, injected before the overlay's own scripts ----
const SHIM = String.raw`
;(function () {
  // Gallery-only stand-in for the server: overlay.js opens "a WebSocket",
  // gets this object, and receives exactly the protocol messages the real
  // server would send. Nothing is ever sent back (overlay.js never sends).
  var sockets = []
  function FakeSocket() {
    var self = this
    this.listeners = {}
    sockets.push(this)
    setTimeout(function () { self.emit("open", {}) }, 0)
  }
  FakeSocket.prototype.addEventListener = function (t, f) { (this.listeners[t] = this.listeners[t] || []).push(f) }
  FakeSocket.prototype.emit = function (t, e) { (this.listeners[t] || []).forEach(function (f) { f(e) }) }
  FakeSocket.prototype.send = function () {}
  FakeSocket.prototype.close = function () {}
  window.WebSocket = FakeSocket

  var revision = 1
  var VERSES = __VERSES__
  var PALETTES = __PALETTES__
  var SCENES = {
    stage: "radial-gradient(26% 42% at 28% 30%, rgba(255,206,140,.55), transparent 70%), radial-gradient(22% 36% at 74% 26%, rgba(150,180,255,.35), transparent 70%), repeating-linear-gradient(90deg, rgba(0,0,0,.18) 0 3vw, transparent 3vw 13vw), linear-gradient(180deg, #2a2e39 0%, #4b4038 58%, #1a1615 100%)",
    bright: "radial-gradient(40% 50% at 30% 30%, #ffffff, transparent 70%), linear-gradient(180deg, #e9e4d8 0%, #cfc6b4 60%, #9c907c 100%)",
    none: "transparent"
  }
  function send(type, payload) {
    var data = JSON.stringify({ type: type, payload: payload })
    sockets.forEach(function (s) { s.emit("message", { data: data }) })
  }
  function style(card, paletteId, transition) {
    var p = PALETTES.filter(function (x) { return x.id === paletteId })[0] || PALETTES[0]
    revision += 1
    send("overlay:style", {
      revision: revision, paletteId: p.id, card: card, transition: transition || "cinematic",
      brand: { name: { visible: false, text: "", font: "sans", size: 28, weight: 600, plate: true, x: 90, y: 5, scale: 1, rotation: 0, opacity: 0.85 }, logo: { visible: false, version: 0, x: 6, y: 9, scale: 1, rotation: 0, opacity: 1 } },
      colors: p.colors
    })
  }
  window.__sim = {
    setup: function (o) {
      document.documentElement.style.background = SCENES[o.scene || "stage"] || SCENES.stage
      send("layout:update", { layout: o.layout === "fullscreen" ? "fullscreen" : "lower-third" })
      style(o.card || "classic", o.palette || "gilt-night", o.transition)
    },
    show: function (key) { send("verse:show", VERSES[key] || VERSES.long) },
    clear: function () { send("verse:clear", {}) },
    verses: Object.keys(VERSES)
  }
  window.addEventListener("message", function (e) {
    var d = e.data
    if (!d || d.gallery !== 1) return
    if (d.op === "setup") window.__sim.setup(d)
    else if (d.op === "show") window.__sim.show(d.verse)
    else if (d.op === "clear") window.__sim.clear()
  })
})()
`

// Public-domain texts: KJV (1769) and Louis Segond (1910).
const VERSES = {
  short: { reference: { book: "psalm", chapter: 23, verse: 1 }, text: "The LORD is my shepherd; I shall not want.", translation: "kjv" },
  long: {
    reference: { book: "isaiah", chapter: 40, verse: 31 },
    text: "But they that wait upon the LORD shall renew their strength; they shall mount up with wings as eagles; they shall run, and not be weary; and they shall walk, and not faint.",
    translation: "kjv",
  },
  bilingual: {
    reference: { book: "john", chapter: 3, verse: 16 },
    text: "Car Dieu a tant aimé le monde qu'il a donné son Fils unique, afin que quiconque croit en lui ne périsse point, mais qu'il ait la vie éternelle.",
    translation: "ls1910",
    secondary: { text: "For God so loved the world, that he gave his only begotten Son, that whosoever believeth in him should not perish, but have everlasting life.", translation: "kjv" },
  },
  next: {
    reference: { book: "john", chapter: 14, verse: 6 },
    text: "Jesus saith unto him, I am the way, the truth, and the life: no man cometh unto the Father, but by me.",
    translation: "kjv",
  },
}

const palettes = PALETTES.map((p) => ({ id: p.id, label: p.label.en, group: p.group, colors: p.colors }))
const shim = SHIM.replace("__VERSES__", JSON.stringify(VERSES)).replace("__PALETTES__", JSON.stringify(palettes))

let html = read("index.html")
html = html.replace(/<meta\s+http-equiv="Content-Security-Policy"[\s\S]*?\/>/, "<!-- CSP removed for the offline gallery copy only -->")
html = html.replace('<link href="fonts/fonts.css" rel="stylesheet" />', `<style>${fontsCss}</style>`)
const inline = (src) => `<script>${src.replace(/<\/script/gi, "<\\/script")}</script>`
html = html.replace('<script src="verse-motion.js"></script>', inline(shim) + "\n  " + inline(read("verse-motion.js")))
html = html.replace('<script src="overlay.js"></script>', inline(read("overlay.js")))
if (/src="(verse-motion|overlay)\.js"/.test(html)) throw new Error("script tags not replaced: index.html changed shape")

const DESIGN_NAMES = {
  classic: "Classic", banner: "Banner", minimal: "Minimal", elegant: "Elegant", glass: "Glass", ribbon: "Ribbon",
  cinema: "Cinema (new)", manuscript: "Manuscript (new)", stained: "Stained glass (new)", poster: "Poster (new)", split: "Split (new)", bold: "Bold (new)",
}

const gallery = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Verse Card Gallery</title>
<style>
  :root { --bg: #0e1014; --panel: #171a21; --line: #2a2f3a; --text: #e8eaf0; --muted: #9aa1b2; --accent: #e6c27a; }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.4 "Segoe UI", system-ui, sans-serif; }
  header { position: sticky; top: 0; z-index: 5; display: flex; flex-wrap: wrap; gap: 12px 18px; align-items: center; padding: 12px 16px; background: rgba(14,16,20,.94); border-bottom: 1px solid var(--line); backdrop-filter: blur(8px); }
  header h1 { font-size: 16px; margin: 0 8px 0 0; letter-spacing: .02em; }
  label { display: inline-flex; gap: 6px; align-items: center; color: var(--muted); }
  select, button { font: inherit; color: var(--text); background: var(--panel); border: 1px solid var(--line); border-radius: 6px; padding: 5px 9px; }
  button { cursor: pointer; }
  button:hover { border-color: var(--accent); }
  main { display: grid; gap: 18px; padding: 16px; grid-template-columns: repeat(auto-fill, minmax(min(100%, 760px), 1fr)); }
  section { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px 12px; }
  section h2 { display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 15px; margin: 0 0 8px; }
  .row { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  .frame { position: relative; width: 100%; aspect-ratio: 16 / 9; overflow: hidden; border-radius: 6px; border: 1px solid var(--line); }
  .frame iframe { position: absolute; top: 0; left: 0; width: 1920px; height: 1080px; border: 0; transform-origin: 0 0; }
  .cap { color: var(--muted); font-size: 12px; margin-top: 4px; }
  .btns { display: flex; gap: 6px; flex-wrap: wrap; }
  .btns button { padding: 3px 8px; font-size: 12px; }
</style>
</head>
<body>
<header>
  <h1>Verse card gallery</h1>
  <label>Palette <select id="palette"></select></label>
  <label>Layout <select id="layout"><option value="lower-third">Lower third</option><option value="fullscreen">Fullscreen</option></select></label>
  <label>Transition <select id="transition"></select></label>
  <label>Background <select id="scene"><option value="stage">Stage (dark)</option><option value="bright">Bright</option><option value="none">Transparent</option></select></label>
  <label>Second tile <select id="second"><option value="long">Long verse</option><option value="bilingual">Bilingual</option></select></label>
  <div class="btns">
    <button id="all-enter">Replay all: enter</button>
    <button id="all-swap">Replay all: verse to verse</button>
    <button id="all-exit">Replay all: exit</button>
  </div>
</header>
<main id="grid"></main>
<script>
(function () {
  var DESIGNS = ${JSON.stringify(OVERLAY_CARD_DESIGNS)}
  var NAMES = ${JSON.stringify(DESIGN_NAMES)}
  var TRANSITIONS = ${JSON.stringify(OVERLAY_TRANSITIONS)}
  var PALETTES = ${JSON.stringify(palettes.map((p) => ({ id: p.id, label: p.label, group: p.group })))}
  var $ = function (id) { return document.getElementById(id) }
  PALETTES.forEach(function (p) { var o = document.createElement("option"); o.value = p.id; o.textContent = p.label + " (" + p.group + ")"; $("palette").appendChild(o) })
  TRANSITIONS.forEach(function (t) { var o = document.createElement("option"); o.value = t; o.textContent = t; $("transition").appendChild(o) })
  var tiles = []
  function post(frame, msg) { msg.gallery = 1; frame.contentWindow.postMessage(msg, "*") }
  function opts() { return { op: "setup", palette: $("palette").value, layout: $("layout").value, transition: $("transition").value, scene: $("scene").value } }
  function fit() { tiles.forEach(function (t) { var w = t.frame.parentNode.clientWidth; t.frame.style.transform = "scale(" + (w / 1920) + ")" }) }
  function setupTile(t) { var o = opts(); o.card = t.card; post(t.frame, o) }
  function enter(t) { post(t.frame, { op: "clear" }); setTimeout(function () { post(t.frame, { op: "show", verse: t.verse() }) }, 650) }
  function swap(t) { t.flip = !t.flip; post(t.frame, { op: "show", verse: t.flip ? "next" : t.verse() }) }
  function exit(t) { post(t.frame, { op: "clear" }) }
  DESIGNS.forEach(function (card) {
    var s = document.createElement("section")
    var h = document.createElement("h2")
    var name = document.createElement("span"); name.textContent = NAMES[card] || card
    var btns = document.createElement("div"); btns.className = "btns"
    h.append(name, btns); s.appendChild(h)
    var row = document.createElement("div"); row.className = "row"; s.appendChild(row)
    var mine = []
    ;["short", "second"].forEach(function (kind) {
      var cell = document.createElement("div")
      var fr = document.createElement("div"); fr.className = "frame"
      var iframe = document.createElement("iframe"); iframe.src = "overlay-sim.html#token=gallery"; iframe.setAttribute("tabindex", "-1"); iframe.title = card + " " + kind
      fr.appendChild(iframe); cell.appendChild(fr)
      var cap = document.createElement("div"); cap.className = "cap"; cap.textContent = kind === "short" ? "Short verse" : "Long / bilingual verse (see header)"
      cell.appendChild(cap); row.appendChild(cell)
      var t = { card: card, frame: iframe, verse: function () { return kind === "short" ? "short" : $("second").value } }
      iframe.addEventListener("load", function () { setupTile(t); setTimeout(function () { post(iframe, { op: "show", verse: t.verse() }) }, 1700) })
      tiles.push(t); mine.push(t)
    })
    ;[["Enter", enter], ["Verse to verse", swap], ["Exit", exit]].forEach(function (b) {
      var btn = document.createElement("button"); btn.textContent = b[0]
      btn.addEventListener("click", function () { mine.forEach(b[1]) })
      btns.appendChild(btn)
    })
    $("grid").appendChild(s)
  })
  ;["palette", "layout", "transition", "scene"].forEach(function (id) { $(id).addEventListener("change", function () { tiles.forEach(setupTile) }) })
  $("second").addEventListener("change", function () { tiles.forEach(function (t) { post(t.frame, { op: "show", verse: t.verse() }) }) })
  $("all-enter").addEventListener("click", function () { tiles.forEach(enter) })
  $("all-swap").addEventListener("click", function () { tiles.forEach(swap) })
  $("all-exit").addEventListener("click", function () { tiles.forEach(exit) })
  window.addEventListener("resize", fit)
  fit()
})()
</script>
</body>
</html>
`

mkdirSync(OUT, { recursive: true })
writeFileSync(join(OUT, "overlay-sim.html"), html)
writeFileSync(join(OUT, "index.html"), gallery)
console.log("Verse card gallery written to " + OUT)
console.log("Open " + join(OUT, "index.html") + " in a browser (no server needed).")
