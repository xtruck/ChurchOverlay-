/*
  ARCHITECTURE.md section 129: the "fire" animated backdrop of the overlay.

  Procedural, no dependency, no network, no asset: a classic low-resolution fire
  simulation (a heat grid that rises and cools) painted into a small <canvas> that
  CSS scales up and softens. It is a viewer-side visual only: it reads nothing
  from the server except the name "fire" the overlay already validated, and it
  never sends anything.

  Cost control (this runs inside OBS next to live video):
    - 96x54 cells, about 5k per step, capped at 30 steps per second;
    - it runs only while a verse is visible in the full-screen layout
      (start()/stop() are driven by overlay.js), never in the background;
    - prefers-reduced-motion renders one still frame instead of animating.

  Written as a plain script (the overlay has no bundler) that also exports its
  pure parts for node tests.
*/
;(function (root) {
  "use strict"

  var WIDTH = 96
  var HEIGHT = 54
  /* Most heat a cell can lose on its way up one row (a random 0..decay, so ~11 on average):
     22 gives flames up to about half the frame (the upper part faint), and a lucky column cannot reach the top. */
  var DEFAULT_DECAY = 22
  var FRAME_MS = 1000 / 30
  var WARMUP_STEPS = 40

  function createFire(random, decay) {
    var rnd = typeof random === "function" ? random : Math.random
    var cool = typeof decay === "number" ? decay : DEFAULT_DECAY
    var heat = new Uint8Array(WIDTH * HEIGHT)

    function step() {
      // The fuel: a flickering line of heat along the bottom edge.
      var base = (HEIGHT - 1) * WIDTH
      for (var x = 0; x < WIDTH; x++) heat[base + x] = 200 + Math.floor(rnd() * 56)
      // Every cell hands its heat to a cell one row up, drifting left, straight or right,
      // and loses some on the way.
      for (var y = 1; y < HEIGHT; y++) {
        for (var cx = 0; cx < WIDTH; cx++) {
          var p = heat[y * WIDTH + cx]
          var r = Math.floor(rnd() * 3)
          var dx = cx - r + 1
          if (dx < 0) dx = 0
          else if (dx >= WIDTH) dx = WIDTH - 1
          var loss = Math.floor(rnd() * (cool + 1))
          heat[(y - 1) * WIDTH + dx] = p > loss ? p - loss : 0
        }
      }
    }

    return { width: WIDTH, height: HEIGHT, heat: heat, step: step }
  }

  /* Black -> red -> orange -> yellow-white; cold cells are transparent so the backdrop shows through. */
  function paint(heat, rgba) {
    for (var i = 0, o = 0; i < heat.length; i++, o += 4) {
      var h = heat[i]
      var g = (h - 70) * 2.2
      var b = (h - 200) * 4
      rgba[o] = h * 3 > 255 ? 255 : h * 3
      rgba[o + 1] = g < 0 ? 0 : g > 255 ? 255 : g
      rgba[o + 2] = b < 0 ? 0 : b > 255 ? 255 : b
      var a = h * 2.2
      rgba[o + 3] = a > 255 ? 255 : a
    }
  }

  function attach(canvas) {
    if (!canvas || typeof canvas.getContext !== "function") return null
    canvas.width = WIDTH
    canvas.height = HEIGHT
    var ctx = canvas.getContext("2d")
    if (!ctx) return null
    var image = ctx.createImageData(WIDTH, HEIGHT)
    var fire = createFire()
    var reduced = typeof root.matchMedia === "function" && root.matchMedia("(prefers-reduced-motion: reduce)").matches
    var frameId = 0
    var last = 0
    var running = false

    function draw() {
      paint(fire.heat, image.data)
      ctx.putImageData(image, 0, 0)
    }

    function tick(now) {
      if (!running) return
      frameId = root.requestAnimationFrame(tick)
      if (now - last < FRAME_MS) return
      last = now
      fire.step()
      draw()
    }

    return {
      start: function () {
        if (running) return
        running = true
        for (var i = 0; i < WARMUP_STEPS; i++) fire.step()
        draw()
        // Reduced motion: one still frame, no loop.
        if (reduced) return
        last = 0
        frameId = root.requestAnimationFrame(tick)
      },
      stop: function () {
        running = false
        if (frameId) root.cancelAnimationFrame(frameId)
        frameId = 0
        ctx.clearRect(0, 0, WIDTH, HEIGHT)
        fire.heat.fill(0)
      },
      isRunning: function () {
        return running
      },
    }
  }

  var api = { WIDTH: WIDTH, HEIGHT: HEIGHT, DEFAULT_DECAY: DEFAULT_DECAY, createFire: createFire, paint: paint, attach: attach }
  root.OverlayFire = api
  if (typeof module !== "undefined" && module.exports) module.exports = api
})(typeof window !== "undefined" ? window : globalThis)
