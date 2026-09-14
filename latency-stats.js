'use strict';
/**
 * ============================================================================
 *  latency-stats.js — agrégation glissante (p50/p95) par-dessus les marques
 *  brutes de latency-tracker.js.
 * ----------------------------------------------------------------------------
 *  latency-tracker.js mesure UN énoncé (deltas + total). Ce module accumule
 *  ces mesures énoncé après énoncé dans un ring buffer borné (pas de fuite
 *  mémoire sur un culte de plusieurs heures) et calcule des percentiles à la
 *  demande — assez peu coûteux (tri O(n log n) sur RING_SIZE éléments max)
 *  pour rester actif en permanence en production, pas seulement derrière un
 *  flag debug.
 *
 *  Deux métriques suivies (voir passe perf) :
 *    - sttFirstToken      : onset VAD -> premier partiel STT (Deepgram
 *                           streaming uniquement — un énoncé transcrit en
 *                           mode batch pur, sans partiel, n'alimente
 *                           simplement pas cette métrique : jamais de valeur
 *                           fabriquée, même discipline que latency-tracker.js).
 *    - verseDetectedToOverlay : référence détectée ('scripture') -> broadcast
 *                           WebSocket envoyé ('obs'). Mesure le pipeline
 *                           serveur ; n'inclut pas le rendu réel côté overlay
 *                           (aucun accusé de réception du navigateur
 *                           n'existe actuellement) — voir overlay.js pour le
 *                           coût de rendu réel (négligeable, transform/
 *                           opacity uniquement).
 * ============================================================================
 */

const RING_SIZE = 500;

function createRing(size) {
  const values = [];
  return {
    push(value) {
      values.push(value);
      if (values.length > size) values.shift();
    },
    percentile(p) {
      if (values.length === 0) return null;
      const sorted = values.slice().sort((a, b) => a - b);
      const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
      return sorted[idx];
    },
    get count() {
      return values.length;
    },
  };
}

const rings = {
  sttFirstToken: createRing(RING_SIZE),
  verseDetectedToOverlay: createRing(RING_SIZE),
};

/**
 * @param {Array<{name: string, at: number}>} marks - tel que renvoyé par
 *   tracker.summary().marks (voir latency-tracker.js).
 */
function recordFromMarks(marks) {
  if (!Array.isArray(marks) || marks.length === 0) return;
  const at = {};
  for (const m of marks) {
    if (!(m.name in at)) at[m.name] = m.at; // première occurrence de chaque étape
  }
  if (typeof at.vad === 'number' && typeof at.asrFirstPartial === 'number') {
    rings.sttFirstToken.push(at.asrFirstPartial - at.vad);
  }
  if (typeof at.scripture === 'number' && typeof at.obs === 'number') {
    rings.verseDetectedToOverlay.push(at.obs - at.scripture);
  }
}

function summarizeRing(ring) {
  return { p50: ring.percentile(50), p95: ring.percentile(95), count: ring.count };
}

function getStats() {
  return {
    sttFirstToken: summarizeRing(rings.sttFirstToken),
    verseDetectedToOverlay: summarizeRing(rings.verseDetectedToOverlay),
  };
}

function formatMetric(label, metric) {
  return metric.count === 0
    ? `${label}: (pas encore de donnée)`
    : `${label}: p50=${metric.p50}ms p95=${metric.p95}ms (n=${metric.count})`;
}

function formatStats() {
  const stats = getStats();
  return [
    '[PERF-STATS]',
    formatMetric('sttFirstToken', stats.sttFirstToken),
    formatMetric('verseDetectedToOverlay', stats.verseDetectedToOverlay),
  ].join('\n');
}

// AJOUT test — permet à test-latency-stats.js de repartir d'un état propre
// entre deux scénarios sans dépendre de l'ordre d'exécution du fichier.
function _reset() {
  rings.sttFirstToken = createRing(RING_SIZE);
  rings.verseDetectedToOverlay = createRing(RING_SIZE);
}

module.exports = { recordFromMarks, getStats, formatStats, _reset, RING_SIZE };
