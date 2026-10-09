// Plain browser JS, no build step (same convention as overlay.js).
// ARCHITECTURE.md section 133: the pure, deterministic half of the verse card
// choreography. Nothing here touches the DOM, the network or the clock, so it
// is unit tested from apps/overlay/verse-motion.test.ts; overlay.js applies the
// numbers it returns (CSS custom properties, class names, timers).
// Loaded in the overlay page as a classic script (window.VerseMotion) and in
// Node as a CommonJS module.
;(function (root, factory) {
  const api = factory()
  if (typeof module === "object" && module && module.exports) module.exports = api
  else root.VerseMotion = api
})(typeof self !== "undefined" ? self : this, function () {
  "use strict"

  /** The closed list of operator transition styles (mirrors packages/contracts/overlay-style.ts). */
  const TRANSITIONS = ["cinematic", "gentle", "cut"]

  /**
   * A verse:show that lands this soon after the socket opened, while nothing is
   * on screen, is the server's connect-time resync (a late-joining OBS source or
   * a reconnect), not a new verse: it is shown with a short fade, never the full intro.
   */
  const LATE_JOIN_WINDOW_MS = 1500

  /** Above this many words the reveal drops per-word blur and the in-line ripple (OBS CEF cost). */
  const DENSE_WORDS = 60

  // Ordinary breaking white space only. No-break spaces (U+00A0, U+2007,
  // U+202F) are NOT split points: French typography uses them to keep ":" "!"
  // "\u00bb" attached to their word, and they must stay attached here too.
  const BREAKING_SPACE = /[ \t\n\r\f\v\u1680\u2000-\u2006\u2008-\u200a\u2028\u2029\u205f\u3000]+/
  // A token made only of closing punctuation is glued to the word before it,
  // a token made only of opening punctuation to the word after it, so a line
  // never starts with ":" or "\u00bb" or ends with "\u00ab" (common in French sources
  // that use a plain space before high punctuation).
  const CLOSING_ONLY = /^[:;!?\u00bb\u203a\u201d\u2019)\]}.,\u2026\u2014\u2013-]+$/
  const OPENING_ONLY = /^[\u00ab\u2039\u201c\u2018(\[{\u00bf\u00a1]+$/
  const NBSP = "\u00a0"

  /** Splits verse text into reveal units (words, with lone punctuation glued on). Joining with " " gives the displayed text. */
  function splitRevealUnits(text) {
    if (typeof text !== "string") return []
    const tokens = text.split(BREAKING_SPACE).filter((t) => t.length > 0)
    const units = []
    let pendingOpen = ""
    for (const token of tokens) {
      if (OPENING_ONLY.test(token)) {
        pendingOpen = pendingOpen ? pendingOpen + NBSP + token : token
        continue
      }
      const word = pendingOpen ? pendingOpen + NBSP + token : token
      pendingOpen = ""
      if (CLOSING_ONLY.test(word) && units.length > 0) units[units.length - 1] += NBSP + word
      else units.push(word)
    }
    if (pendingOpen) {
      if (units.length > 0) units[units.length - 1] += NBSP + pendingOpen
      else units.push(pendingOpen)
    }
    return units
  }

  /**
   * The illuminated initial for the manuscript design: leading opening
   * punctuation plus the first letter or digit. Null when the text does not
   * start with one (the design then simply shows no drop cap).
   */
  function splitDropCap(word) {
    if (typeof word !== "string") return null
    const m = /^([\u00ab\u2039\u201c\u2018"'(\[\u00bf\u00a1\u00a0\u202f]*)(\p{L}|\p{N})/u.exec(word)
    if (!m) return null
    const cap = m[0]
    return { cap, rest: word.slice(cap.length) }
  }

  /**
   * Line index of every reveal unit from its measured top offset (px). Units
   * are in reading order, so a new line starts whenever the top moves down by
   * more than the tolerance.
   */
  function groupLines(tops, tolerance) {
    const tol = typeof tolerance === "number" ? tolerance : 3
    const out = []
    let line = 0
    let lineTop = null
    for (const top of tops) {
      if (lineTop === null) lineTop = top
      else if (top > lineTop + tol) {
        line += 1
        lineTop = top
      }
      out.push(line)
    }
    return out
  }

  /**
   * Per-design choreography (milliseconds). textStart: when the first word
   * starts; lineStep/wordStep: stagger per line and per word inside a line;
   * maxSpread: cap on first-to-last word start, so a long verse is still fully
   * on screen in under a second; wordDur: each word's own animation;
   * secondaryGap/refGap: when the bilingual line and the reference start,
   * relative to the last word's start; swapOut: the outgoing phase of a
   * verse-to-verse change; swapTextStart: textStart when the card is already up.
   */
  const BASE_PROFILE = {
    textStart: 120,
    swapTextStart: 40,
    lineStep: 90,
    wordStep: 14,
    maxSpread: 300,
    wordDur: 560,
    secondaryGap: 40,
    refGap: 80,
    refDur: 520,
    swapOut: 300,
    // The reveal is never declared settled before the design's own card-level
    // layers (light sweep ~970 ms, cinema leak ~1160 ms, stained bloom 1200 ms)
    // have finished, or removing the classes would cut them mid-flight.
    settleFloor: 1000,
  }
  const PROFILES = {
    classic: {},
    banner: {},
    minimal: { textStart: 60 },
    elegant: { textStart: 160, wordDur: 640 },
    glass: { textStart: 140 },
    ribbon: {},
    // Film title: the letterbox closes first, then the words drift in slowly.
    cinema: { textStart: 240, lineStep: 110, wordStep: 20, maxSpread: 280, wordDur: 660, refGap: 60, refDur: 560, swapOut: 380, settleFloor: 1200 },
    // Ink settling: the initial blooms first, the lines follow with no travel.
    manuscript: { textStart: 220, lineStep: 110, wordStep: 8, maxSpread: 320, wordDur: 640, refGap: 100, swapOut: 340 },
    // Light through glass: the glow blooms before the words.
    stained: { textStart: 220, lineStep: 100, wordStep: 16, wordDur: 620, swapOut: 340, settleFloor: 1260 },
    // Editorial: line by line, no in-line ripple.
    poster: { textStart: 180, lineStep: 120, wordStep: 0, maxSpread: 320, wordDur: 680, refGap: 60 },
    // Two columns opening from the rule.
    split: { textStart: 200, lineStep: 80, wordStep: 12, wordDur: 560, refStart: 120 },
    // High energy: quick, tight, with overshoot.
    bold: { textStart: 120, swapTextStart: 30, lineStep: 60, wordStep: 18, maxSpread: 240, wordDur: 420, refGap: 40, refDur: 420, swapOut: 220 },
  }

  function profileFor(card) {
    const own = Object.prototype.hasOwnProperty.call(PROFILES, card) ? PROFILES[card] : {}
    return Object.assign({}, BASE_PROFILE, own)
  }

  /**
   * Start delay of every unit plus when the bilingual line and the reference
   * start and when the whole reveal has settled (all ms from the reveal start).
   */
  function revealPlan(lines, card, options) {
    const opts = options || {}
    const p = profileFor(card)
    const dense = lines.length > DENSE_WORDS
    const wordStep = dense ? 0 : p.wordStep
    const start = opts.swap ? p.swapTextStart : p.textStart
    const raw = []
    let prevLine = -1
    let inLine = 0
    for (const line of lines) {
      if (line !== prevLine) {
        inLine = 0
        prevLine = line
      } else {
        inLine += 1
      }
      raw.push(line * p.lineStep + inLine * wordStep)
    }
    const maxRaw = raw.length ? Math.max.apply(null, raw) : 0
    const scale = maxRaw > p.maxSpread ? p.maxSpread / maxRaw : 1
    const delays = raw.map((r) => start + Math.round(r * scale))
    const spread = Math.round(maxRaw * scale)
    const lastStart = start + spread
    const secondaryDelay = Math.max(0, lastStart + p.secondaryGap)
    // refStart (absolute) puts the reference before the text (split design).
    const refDelay = typeof p.refStart === "number" ? p.refStart : Math.max(0, lastStart + p.refGap)
    const settleMs = Math.max(lastStart + p.wordDur + 60, secondaryDelay + p.wordDur + 60, refDelay + p.refDur + 60, p.settleFloor)
    return { delays, secondaryDelay, refDelay, settleMs, dense, wordDur: p.wordDur, refDur: p.refDur }
  }

  /** Duration of the outgoing phase of a verse-to-verse change for this design. */
  function swapOutMs(card) {
    return profileFor(card).swapOut
  }

  /**
   * Which choreography a verse:show gets.
   *   enter      full cinematic intro (nothing was on screen)
   *   swap       old verse leaves, new one is revealed, card stays
   *   resync     late join / reconnect: short fade, no intro
   *   fade       short fade in (gentle style or reduced motion)
   *   fade-swap  short cross-fade between verses
   *   cut        no animation at all
   */
  function pickVerseTransition(input) {
    const i = input || {}
    const motion = TRANSITIONS.includes(i.motion) ? i.motion : "cinematic"
    if (motion === "cut") return "cut"
    if (!i.wasVisible && typeof i.msSinceConnect === "number" && i.msSinceConnect >= 0 && i.msSinceConnect < LATE_JOIN_WINDOW_MS) return "resync"
    if (i.reducedMotion || motion === "gentle") return i.wasVisible ? "fade-swap" : "fade"
    return i.wasVisible ? "swap" : "enter"
  }

  /**
   * Size limits for the auto-fit (overlay.js fitVerseText), per layout and
   * design: the cinema letterbox bars take frame height, the poster and bold
   * designs want bigger type.
   */
  function fitLimits(isFullscreen, card) {
    const l = isFullscreen
      ? { maxWidthFraction: 0.9, maxHeightFraction: 0.9, maxFontPx: 120, minFontPx: 18 }
      : { maxWidthFraction: 0.9, maxHeightFraction: 0.84, maxFontPx: 44, minFontPx: 14 }
    if (card === "cinema") {
      // The card is a full-width band (its width never shrinks with the
      // type), so only the height may drive the fit.
      l.maxHeightFraction = isFullscreen ? 0.7 : 0.64
      l.maxWidthFraction = 1
    } else if (card === "manuscript") {
      // A page, not a billboard: keep fullscreen type book-like.
      if (isFullscreen) l.maxFontPx = 96
    } else if (card === "poster") {
      l.maxFontPx = isFullscreen ? 136 : 60
    } else if (card === "bold") {
      l.maxFontPx = isFullscreen ? 112 : 46
    } else if (card === "split") {
      l.maxWidthFraction = isFullscreen ? 0.92 : 0.94
    }
    return l
  }

  return {
    TRANSITIONS,
    LATE_JOIN_WINDOW_MS,
    DENSE_WORDS,
    splitRevealUnits,
    splitDropCap,
    groupLines,
    profileFor,
    revealPlan,
    swapOutMs,
    pickVerseTransition,
    fitLimits,
  }
})
