/**
 * ============================================================================
 *  sentence-buffer.js — Bufferisation de phrase entre segments audio
 * ----------------------------------------------------------------------------
 *  Accumule les transcriptions de segments audio successifs dans une fenêtre
 *  glissante (bornée en caractères), pour qu'une référence biblique à cheval
 *  sur deux segments ("Jean" en fin de segment N, "3:16" en début de
 *  segment N+1) soit toujours vue comme une seule chaîne par detector.js.
 *
 *  Extrait de server.js (chantier "sentence buffer") où cette logique
 *  existait déjà (transcriptBuffer/pushToBuffer/resetBuffer) mais souffrait
 *  d'un bug réel : le buffer était vidé À CHAQUE segment via une condition
 *  `result.source === 'groq' || result.source === 'deepgram'` qui est
 *  toujours vraie (transcribeWithFallback ne renvoie jamais autre chose),
 *  ce qui annulait complètement l'accumulation glissante.
 *
 *  Le reset n'a désormais lieu que si un vrai silence (gapMs) s'est écoulé
 *  entre deux segments — signe fiable d'un changement de phrase/sujet,
 *  d'autant plus qu'avec le VAD réel d'audio-capture.js, les segments de
 *  silence pur ne déclenchent même plus onAudioSegment.
 * ============================================================================
 */
'use strict';

/**
 * @param {Object} [options]
 * @param {number} [options.maxChars=500] - taille max de la fenêtre glissante
 * @param {number} [options.gapMs=4000] - au-delà de ce délai entre deux push, le buffer est vidé avant d'ajouter le nouveau texte
 * @returns {{ push: Function, reset: Function, value: Function }}
 */
function createSentenceBuffer({ maxChars = 500, gapMs = 4000 } = {}) {
  let buffer = '';
  let lastPushAt = 0;

  function reset() {
    buffer = '';
    lastPushAt = 0;
  }

  /**
   * Ajoute un nouveau texte de segment au buffer et retourne la fenêtre
   * courante. Vide d'abord le buffer si le délai depuis le dernier push
   * dépasse gapMs (nouvelle phrase/sujet après un silence).
   * @param {string} text - texte du nouveau segment transcrit
   * @param {number} [now=Date.now()] - horloge injectable pour les tests
   * @returns {string} le contenu courant du buffer (fenêtre glissante)
   */
  function push(text, now = Date.now()) {
    const gap = lastPushAt === 0 ? Infinity : now - lastPushAt;
    if (gap > gapMs) {
      buffer = '';
    }
    lastPushAt = now;

    if (!text) return buffer.trim();

    const isContinuation = buffer.length > 0 &&
                           !buffer.endsWith(' ') &&
                           !buffer.endsWith('.') &&
                           !buffer.endsWith(',');
    if (isContinuation) {
      buffer += ' ' + text;
    } else if (text.startsWith('.') || text.startsWith('!') || text.startsWith('?')) {
      buffer = text;
    } else {
      buffer = (buffer + ' ' + text).trim();
    }

    if (buffer.length > maxChars) {
      buffer = buffer.slice(-maxChars);
      const firstSpace = buffer.indexOf(' ');
      if (firstSpace > 0 && firstSpace < 50) {
        buffer = buffer.slice(firstSpace + 1);
      }
    }
    return buffer.trim();
  }

  return { push, reset, value: () => buffer, length: () => buffer.length };
}

module.exports = { createSentenceBuffer };
