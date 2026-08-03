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
let detectorEn = null;
try {
  detectorEn = require('./detector-en');
} catch (_e) {
  // English detector optional
}

/**
 * detectBilingual — tries exact matches first (FR then EN), then fuzzy matches (FR then EN).
 */
function detectBilingual(text) {
  // Step 1: Exact FR match
  const frExact = detector.detectExact ? detector.detectExact(text) : null;
  if (frExact) return frExact;

  // Step 2: Exact EN match
  const enExact = detectorEn && detectorEn.detectExact ? detectorEn.detectExact(text) : null;
  if (enExact) return enExact;

  // Step 3: Fuzzy FR match
  const frFuzzy = detector.detect(text);
  if (frFuzzy) return frFuzzy;

  // Step 4: Fuzzy EN match
  if (detectorEn) {
    const enFuzzy = detectorEn.detect(text);
    if (enFuzzy) return enFuzzy;
  }

  return null;
}

/**
 * parseReference — try to parse a manual reference string in FR or EN.
 */
function parseReference(text) {
  return detectBilingual(text);
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
