'use strict';
/**
 * ============================================================================
 *  latency-tracker.js — mesure de latence par énoncé (§14 du cahier des
 *  charges), du bout en bout : détection VAD -> ASR (premier partial, final)
 *  -> détection biblique -> lookup Bible -> mise à jour OBS.
 * ----------------------------------------------------------------------------
 *  Chaque mark() pose un vrai Date.now() à l'endroit réel du pipeline (voir
 *  audio-capture.js pour 'vad'/'asrFirstPartial'/'asrFinal', server.js pour
 *  'scripture'/'bible'/'obs') — aucune valeur n'est ici estimée ou inventée,
 *  seulement calculée à partir de marques réellement posées. Un maillon non
 *  instrumenté (ex. chemin Groq/RMS classique, sans latence ASR granulaire)
 *  produit simplement moins de lignes dans le résumé, jamais une valeur
 *  fabriquée pour combler le vide.
 * ============================================================================
 */

// AJOUT (Chantier 1 — dédoublonnage par énoncé) : identifiant strictement
// croissant, unique par tracker (donc par énoncé : un tracker est créé au
// tout premier indice de voix VAD et refermé au final). C'est CETTE identité
// qui permet à server.js de distinguer « répétition du MÊME énoncé »
// (partial stable puis final officiel = UNE action) de « nouvelle intention »
// (un nouvel énoncé redit la même référence, ex. corpus A1→A5 : 5 énoncés
// distincts qui doivent tous afficher Jean 3:16).
let nextTrackerId = 1;

/**
 * @param {number} [startedAt] - Date.now() du point de départ (ex. VAD ayant
 *   détecté le début de la parole) ; par défaut Date.now() au moment de
 *   l'appel.
 */
function startTracker(startedAt) {
  const marks = [{ name: 'start', at: startedAt || Date.now() }];
  const id = nextTrackerId++;

  return {
    /** Identité de l'énoncé — voir le commentaire de nextTrackerId. */
    id,
    /** @param {string} name */
    mark(name) {
      marks.push({ name, at: Date.now() });
    },
    /** @returns {{ marks: Array<{name:string, at:number}>, deltas: Record<string, number>, totalMs: number }} */
    summary() {
      const deltas = {};
      for (let i = 1; i < marks.length; i++) {
        deltas[marks[i].name] = marks[i].at - marks[i - 1].at;
      }
      const totalMs = marks.length > 1 ? marks[marks.length - 1].at - marks[0].at : 0;
      return { marks: marks.slice(), deltas, totalMs };
    },
    /** @returns {string} format texte [PERF] du cahier des charges */
    format() {
      const { deltas, totalMs } = this.summary();
      const lines = ['[PERF]'];
      for (const [name, ms] of Object.entries(deltas)) {
        lines.push(`${name}: ${ms}ms`);
      }
      lines.push(`TOTAL: ${totalMs}ms`);
      return lines.join('\n');
    },
  };
}

module.exports = { startTracker };
