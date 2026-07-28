/**
 * ============================================================================
 * detector-compat.js — Compatibility wrapper for detector.js
 * ============================================================================
 * detector.js exports: { detect, normalize, numberWordsToDigits, detectTranslationSwitch, BOOKS }
 * My server.js expects: { detectBilingual, parseReference }
 * This wrapper bridges the two APIs without modifying detector.js.
 * ============================================================================
 */

'use strict';

const detector = require('./detector');

/**
 * detectBilingual — wrapper around detector.detect()
 * The original detect() handles French references. For English, we would
 * need detector-en.js, but for now we just delegate to detect().
 */
function detectBilingual(text) {
  return detector.detect(text);
}

/**
 * parseReference — try to parse a manual reference string like "Jean 3:16"
 * Uses detector.detect() which handles all the regex parsing.
 */
function parseReference(text) {
  return detector.detect(text);
}

module.exports = {
  detectBilingual,
  parseReference,
  // Also re-export original functions for compatibility
  detect: detector.detect,
  normalize: detector.normalize,
  numberWordsToDigits: detector.numberWordsToDigits,
  detectTranslationSwitch: detector.detectTranslationSwitch,
  BOOKS: detector.BOOKS,
};
