/**
 * ============================================================================
 *  highlight-export.js — Export des temps forts d'un culte
 * ----------------------------------------------------------------------------
 *  AJOUT (demande explicite — repérer facilement les moments clés dans
 *  l'enregistrement vidéo d'un culte, sans IA de montage). Réutilise
 *  l'historique déjà persistant (session-store.js/verse_history) : versets,
 *  chants ET médias déclenchés y sont tous enregistrés (voir pushHistory()/
 *  recordVerseShown() dans server.js) — ce module ne fait qu'y METTRE EN
 *  FORME ce qui existe déjà, aucune nouvelle donnée collectée ici.
 *
 *  Module pur (aucun accès disque/réseau) : prend en entrée les lignes déjà
 *  lues via sessionStore.getVerseHistorySince(), les met en forme en deux
 *  formats immédiatement utiles :
 *    - "Chapitres YouTube" : format texte à coller directement dans la
 *      description d'une vidéo YouTube (00:00 Titre, un par ligne) —
 *      gratuit, zéro intégration, workflow déjà répandu chez les églises qui
 *      publient leurs cultes.
 *    - CSV : timestamp epoch, mm:ss, type, libellé — importable dans la
 *      plupart des logiciels de montage comme liste de marqueurs/chapitres.
 * ============================================================================
 */
'use strict';

// YouTube exige au moins 10s entre deux chapitres (sinon ils sont fusionnés/
// ignorés côté YouTube) — on filtre donc les entrées trop rapprochées plutôt
// que de produire une liste que YouTube rejettera partiellement.
const MIN_CHAPTER_GAP_MS = 10_000;

/**
 * @param {number} ms - durée écoulée depuis le début du culte (>= 0)
 * @returns {string} "m:ss" ou "h:mm:ss" (format accepté par YouTube)
 */
function formatTimestamp(ms) {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const ss = String(seconds).padStart(2, '0');
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${ss}`;
  }
  return `${minutes}:${ss}`;
}

/**
 * Trie par horodatage croissant et ne garde que les entrées survenues
 * après le début du culte, en filtrant celles trop rapprochées de la
 * précédente conservée (voir MIN_CHAPTER_GAP_MS).
 * @param {Array<{reference: string, shown_at: number}>} entries
 * @param {number} sessionStartedAt
 * @returns {Array<{reference: string, offsetMs: number}>}
 */
function prepareEntries(entries, sessionStartedAt) {
  if (!Array.isArray(entries) || !sessionStartedAt) return [];
  const sorted = [...entries]
    .filter((e) => e && e.reference && typeof e.shown_at === 'number')
    .sort((a, b) => a.shown_at - b.shown_at);

  const prepared = [];
  let lastKeptMs = -Infinity;
  for (const entry of sorted) {
    const offsetMs = entry.shown_at - sessionStartedAt;
    if (offsetMs < 0) continue;
    if (offsetMs - lastKeptMs < MIN_CHAPTER_GAP_MS) continue;
    prepared.push({ reference: entry.reference.trim(), offsetMs });
    lastKeptMs = offsetMs;
  }
  return prepared;
}

/**
 * Construit un bloc "Chapitres YouTube" prêt à coller dans une description
 * de vidéo. Le premier chapitre est forcé à 0:00 (exigence YouTube) si le
 * premier temps fort survient après le tout début du culte.
 * @param {Array<object>} entries - lignes de sessionStore.getVerseHistorySince()
 * @param {number} sessionStartedAt - epoch ms du début du culte
 * @returns {string} bloc de texte, une ligne par chapitre ; chaîne vide si rien à exporter
 */
function buildYoutubeChapters(entries, sessionStartedAt) {
  const prepared = prepareEntries(entries, sessionStartedAt);
  if (prepared.length === 0) return '';

  const lines = prepared.map((e) => `${formatTimestamp(e.offsetMs)} ${e.reference}`);
  if (prepared[0].offsetMs > 0) {
    lines.unshift('0:00 Début du culte');
  }
  return lines.join('\n');
}

function csvEscape(value) {
  const str = String(value == null ? '' : value);
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

/**
 * Construit un export CSV (horodatage epoch, mm:ss, libellé) — une ligne
 * par temps fort, sans le filtre "10s minimum" des chapitres YouTube (un
 * export brut complet, utile pour un import dans un logiciel de montage).
 * @param {Array<object>} entries - lignes de sessionStore.getVerseHistorySince()
 * @param {number} sessionStartedAt - epoch ms du début du culte
 * @returns {string} CSV avec en-tête ; ne contient que l'en-tête si rien à exporter
 */
function buildCsv(entries, sessionStartedAt) {
  const header = 'shown_at_epoch_ms,timestamp,label';
  if (!Array.isArray(entries) || entries.length === 0) return header;

  const sorted = [...entries]
    .filter((e) => e && e.reference && typeof e.shown_at === 'number')
    .sort((a, b) => a.shown_at - b.shown_at);

  const rows = sorted.map((entry) => {
    const offsetMs = sessionStartedAt ? Math.max(0, entry.shown_at - sessionStartedAt) : 0;
    return [entry.shown_at, formatTimestamp(offsetMs), csvEscape(entry.reference.trim())].join(',');
  });
  return [header, ...rows].join('\n');
}

module.exports = {
  formatTimestamp,
  buildYoutubeChapters,
  buildCsv,
};
