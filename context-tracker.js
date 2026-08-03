/** Évite les doublons créés par le chevauchement des segments audio. */
'use strict';

function createContextTracker({ cooldownMs = 45000 } = {}) {
  let lastKey = null;
  let lastAt = 0;
  function keyOf(reference) {
    return `${reference.book}:${reference.chapter}:${reference.verseStart || ''}-${reference.verseEnd || ''}`;
  }
  return {
    shouldProcess(reference, now = Date.now()) {
      const key = keyOf(reference);
      if (key === lastKey && now - lastAt < cooldownMs) return false;
      lastKey = key;
      lastAt = now;
      return true;
    },
    reset() {
      lastKey = null;
      lastAt = 0;
    },
  };
}

module.exports = { createContextTracker };
