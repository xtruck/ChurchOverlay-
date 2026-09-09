'use strict';
/**
 * ============================================================================
 *  srt-export.js — Sous-titres .srt à partir des segments STT du culte
 * ----------------------------------------------------------------------------
 *  AJOUT (durcissement Social Clip Machine — clip-exporter.js). Même
 *  conception que highlight-export.js : module PUR (aucun accès disque/
 *  réseau), qui met en forme des données déjà persistées par
 *  session-store.js#recordTranscriptSegment — aucune nouvelle collecte ici.
 *
 *  PRÉCISION DES TIMESTAMPS (honnête, pas fabriquée — voir latency-tracker.js) :
 *  le DÉBUT d'un segment est celui du tout premier indice de voix (VAD
 *  onset, tracker.marks[0] posé par audio-capture.js#markVadOnset) — réel et
 *  précis. La FIN est le moment où la transcription est arrivée côté serveur
 *  (asrFinal) : légèrement APRÈS la fin réelle de la parole (aller-retour
 *  STT inclus), jamais avant. Aucun mark "fin de parole" dédié n'existe
 *  aujourd'hui dans le pipeline ; on ajoute une marge (SUBTITLE_END_PADDING_MS)
 *  plutôt que de prétendre à une précision inexistante.
 *
 *  FENÊTRAGE PAR CLIP : buildSrt() accepte un windowStartMs/windowEndMs
 *  optionnel pour ne garder QUE les segments qui chevauchent la fenêtre d'un
 *  extrait vidéo donné, et REBASER leurs timestamps sur le DÉBUT DE CETTE
 *  FENÊTRE (0 = début de l'extrait). Nécessaire pour l'incrustation : un
 *  extrait ffmpeg coupé avec `-ss` avant `-i` a sa propre timeline de sortie
 *  qui redémarre à ~0, pas celle du culte entier.
 * ============================================================================
 */

// Un segment sans `ended_at` exploitable (chemin non instrumenté) reste
// affiché au moins cette durée — reste lisible même pour un mot isolé.
const MIN_SUBTITLE_DURATION_MS = 800;
// Un segment ne reste jamais affiché plus longtemps que ceci, même si le
// suivant tarde beaucoup — évite un sous-titre "figé" à l'écran.
const MAX_SUBTITLE_DURATION_MS = 7000;
// Marge ajoutée après `ended_at` (asrFinal) — laisse le temps de lire la fin
// du texte avant que le sous-titre suivant ne le remplace.
const SUBTITLE_END_PADDING_MS = 400;
// Écart minimal laissé entre deux sous-titres consécutifs pour ne jamais les
// faire se chevaucher à l'écran.
const SUBTITLE_GAP_MS = 50;

function pad(n, len = 2) {
  return String(n).padStart(len, '0');
}

/**
 * @param {number} ms - offset depuis le début de la référence (culte ou clip), >= 0
 * @returns {string} "HH:MM:SS,mmm" (format SRT standard)
 */
function formatSrtTimestamp(ms) {
  const clamped = Math.max(0, Math.round(ms));
  const hours = Math.floor(clamped / 3_600_000);
  const minutes = Math.floor((clamped % 3_600_000) / 60_000);
  const seconds = Math.floor((clamped % 60_000) / 1000);
  const millis = clamped % 1000;
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)},${pad(millis, 3)}`;
}

/**
 * Construit un fichier .srt à partir des segments STT enregistrés.
 * @param {Array<{text:string, started_at:number, ended_at?:number}>} segments
 *   - lignes de sessionStore.getTranscriptSegmentsSince() (colonnes SQLite
 *   snake_case, même convention que highlight-export.js#prepareEntries avec
 *   `shown_at`).
 * @param {number} sessionStartedAt - epoch ms du début du culte
 * @param {{ windowStartMs?: number, windowEndMs?: number }} [options] -
 *   fenêtre optionnelle (en ms depuis le début du culte) : ne garder que les
 *   segments qui la chevauchent, et rebaser leurs timestamps sur
 *   windowStartMs (0 = début de la fenêtre). Sans fenêtre, les timestamps
 *   restent relatifs au début du culte (sous-titres pour l'enregistrement
 *   complet).
 * @returns {string} contenu .srt ; chaîne vide si rien à exporter
 */
function buildSrt(segments, sessionStartedAt, options = {}) {
  if (!Array.isArray(segments) || !sessionStartedAt) return '';
  const windowStartMs = typeof options.windowStartMs === 'number' ? options.windowStartMs : 0;
  const windowEndMs = typeof options.windowEndMs === 'number' ? options.windowEndMs : Infinity;

  const sorted = [...segments]
    .filter((s) => s && s.text && typeof s.started_at === 'number')
    .sort((a, b) => a.started_at - b.started_at);

  const blocks = [];
  for (let i = 0; i < sorted.length; i++) {
    const seg = sorted[i];
    const startOffsetMs = seg.started_at - sessionStartedAt;
    if (startOffsetMs < 0) continue;

    const naturalEndOffsetMs =
      typeof seg.ended_at === 'number' && seg.ended_at > seg.started_at
        ? seg.ended_at - sessionStartedAt + SUBTITLE_END_PADDING_MS
        : startOffsetMs + MIN_SUBTITLE_DURATION_MS;

    const next = sorted[i + 1];
    const nextStartOffsetMs = next ? next.started_at - sessionStartedAt : Infinity;

    let endOffsetMs = Math.min(naturalEndOffsetMs, startOffsetMs + MAX_SUBTITLE_DURATION_MS);
    if (Number.isFinite(nextStartOffsetMs)) {
      endOffsetMs = Math.min(endOffsetMs, nextStartOffsetMs - SUBTITLE_GAP_MS);
    }
    // Plancher de lisibilité — l'emporte même si cela chevauche légèrement
    // le segment suivant (rare : suppose deux énoncés à <1s d'écart) ; un
    // léger chevauchement visuel reste préférable à un sous-titre illisible.
    endOffsetMs = Math.max(endOffsetMs, startOffsetMs + MIN_SUBTITLE_DURATION_MS);

    if (endOffsetMs <= windowStartMs || startOffsetMs >= windowEndMs) continue; // hors fenêtre du clip

    const rebasedStart = Math.max(0, startOffsetMs - windowStartMs);
    const rebasedEnd = Math.min(endOffsetMs, windowEndMs) - windowStartMs;
    if (rebasedEnd <= rebasedStart) continue;

    blocks.push(
      `${blocks.length + 1}\n${formatSrtTimestamp(rebasedStart)} --> ${formatSrtTimestamp(rebasedEnd)}\n${seg.text.trim()}\n`
    );
  }
  return blocks.join('\n');
}

module.exports = {
  formatSrtTimestamp,
  buildSrt,
  MIN_SUBTITLE_DURATION_MS,
  MAX_SUBTITLE_DURATION_MS,
  SUBTITLE_END_PADDING_MS,
  SUBTITLE_GAP_MS,
};
