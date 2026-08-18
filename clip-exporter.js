'use strict';
/**
 * ============================================================================
 *  clip-exporter.js — Extraits vidéo courts autour des temps forts d'un culte
 * ----------------------------------------------------------------------------
 *  AJOUT (chantier 4.6 — cahier des charges, catégorie concurrente "clip
 *  auto" type Choppity/Clypse/Pulpit AI). highlight-export.js sait déjà
 *  produire des horodatages (chapitres YouTube, CSV) à partir de
 *  l'historique persistant, mais ne découpe jamais la vidéo elle-même —
 *  c'est le rôle de ce fichier, via ffmpeg (ffmpeg-static, binaire
 *  précompilé embarqué avec l'app, décision prise en session le
 *  2026-08-18 — voir JOURNAL-MISSION.md pour le compromis taille
 *  installeur/zéro dépendance système).
 *
 *  PORTÉE (v1, délibérément limitée) : découpe un extrait de durée fixe
 *  démarrant à chaque temps fort retenu par highlightExport.prepareEntries()
 *  (déjà filtré à 10s d'écart minimum). PAS de sous-titres incrustés dans
 *  cette première version — brûler un texte avec ffmpeg (filtre drawtext)
 *  nécessite une police déclarée, une dépendance supplémentaire non
 *  triviale sur Windows sans police système garantie ; le texte de
 *  référence/étiquette reste disponible séparément (nom de fichier, liste
 *  retournée) pour un montage manuel ou un ajout futur. Voir
 *  JOURNAL-MISSION.md pour ce compromis explicite.
 *
 *  CORRECTIF (trouvé en écrivant ce fichier — testé avec un vrai binaire
 *  ffmpeg, pas supposé) : la première version utilisait `-ss` AVANT `-i`
 *  (seek rapide) + `-c copy` (recopie sans réencodage, en théorie quasi
 *  instantanée). En pratique, `-c copy` ne peut couper que sur une
 *  keyframe — sur un enregistrement dont l'intervalle de keyframes est
 *  large (constaté avec un flux de test généré par ffmpeg lui-même :
 *  intervalle de plusieurs secondes), l'extrait obtenu dépassait largement
 *  la durée demandée (15s obtenues pour 3s demandées lors du test réel).
 *  `-ss` reste AVANT `-i` (seek rapide, approximatif) mais la SORTIE est
 *  réencodée (pas de `-c copy`) : `-t` est alors respecté au frame près,
 *  quel que soit l'espacement des keyframes de la source. Plus lent qu'une
 *  recopie pure, mais chaque extrait ne dure que 15-90s (MIN/MAX_CLIP_
 *  DURATION_SEC ci-dessous) — un réencodage x264 preset "veryfast" reste
 *  largement plus rapide que la durée de l'extrait lui-même sur un poste
 *  de bureau récent.
 * ============================================================================
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');

const DEFAULT_CLIP_DURATION_SEC = 45;
const MIN_CLIP_DURATION_SEC = 15;
const MAX_CLIP_DURATION_SEC = 120;
const MAX_CLIPS_PER_EXPORT = 20; // garde-fou : un culte de 2h avec un temps fort toutes les 10s produirait des centaines d'extraits sinon.

function sanitizeFilenamePart(str) {
  return String(str || 'extrait')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .toLowerCase();
}

/**
 * Découpe UN extrait via ffmpeg. Résout/rejette selon le code de sortie du
 * process — jamais de throw synchrone, toujours une Promise.
 * @param {string} sourcePath
 * @param {string} outputPath
 * @param {number} startSec
 * @param {number} durationSec
 * @returns {Promise<void>}
 */
function cutOneClip(sourcePath, outputPath, startSec, durationSec) {
  return new Promise((resolve, reject) => {
    const args = [
      '-y', // écrase un fichier de sortie existant du même nom sans invite interactive
      '-ss',
      String(Math.max(0, startSec)),
      '-i',
      sourcePath,
      '-t',
      String(durationSec),
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-c:a',
      'aac',
      outputPath,
    ];
    const proc = spawn(ffmpegPath, args, { windowsHide: true });
    let stderr = '';
    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`ffmpeg a échoué (code ${code}) : ${stderr.slice(-500)}`));
      }
    });
  });
}

/**
 * Découpe un extrait par temps fort retenu, dans outputDir.
 * @param {string} sourcePath - chemin de l'enregistrement vidéo source
 * @param {string} outputDir - dossier de destination (créé si absent)
 * @param {Array<object>} entries - lignes de sessionStore.getVerseHistorySince()
 * @param {number} sessionStartedAt - epoch ms du début du culte
 * @param {{ clipDurationSec?: number, onProgress?: (done:number, total:number) => void }} [options]
 * @returns {Promise<{ ok: boolean, clips: Array<{file: string, reference: string, offsetSec: number}>, errors: Array<{reference: string, error: string}> }>}
 */
async function exportClips(sourcePath, outputDir, entries, sessionStartedAt, options = {}) {
  if (!sourcePath || !fs.existsSync(sourcePath)) {
    throw new Error('Fichier vidéo source introuvable : ' + sourcePath);
  }
  const clipDurationSec = Math.min(
    MAX_CLIP_DURATION_SEC,
    Math.max(MIN_CLIP_DURATION_SEC, Number(options.clipDurationSec) || DEFAULT_CLIP_DURATION_SEC)
  );

  const highlightExport = require('./highlight-export');
  const prepared = highlightExport
    .prepareEntries(entries, sessionStartedAt)
    .slice(0, MAX_CLIPS_PER_EXPORT);

  if (prepared.length === 0) {
    return { ok: true, clips: [], errors: [] };
  }

  fs.mkdirSync(outputDir, { recursive: true });

  const clips = [];
  const errors = [];
  let done = 0;
  for (const entry of prepared) {
    const startSec = entry.offsetMs / 1000;
    const namePart = sanitizeFilenamePart(entry.reference);
    const fileName = `${String(Math.round(startSec)).padStart(5, '0')}s-${namePart}.mp4`;
    const outputPath = path.join(outputDir, fileName);
    try {
      await cutOneClip(sourcePath, outputPath, startSec, clipDurationSec);
      clips.push({ file: fileName, reference: entry.reference, offsetSec: startSec });
    } catch (err) {
      errors.push({ reference: entry.reference, error: err.message });
    }
    done++;
    if (typeof options.onProgress === 'function') {
      options.onProgress(done, prepared.length);
    }
  }

  return { ok: errors.length === 0, clips, errors };
}

module.exports = {
  exportClips,
  cutOneClip,
  sanitizeFilenamePart,
  DEFAULT_CLIP_DURATION_SEC,
  MIN_CLIP_DURATION_SEC,
  MAX_CLIP_DURATION_SEC,
  MAX_CLIPS_PER_EXPORT,
};
