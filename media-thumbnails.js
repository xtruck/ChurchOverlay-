'use strict';
/**
 * ============================================================================
 *  media-thumbnails.js — Génération de vignettes (médiathèque)
 * ----------------------------------------------------------------------------
 *  AJOUT (chantier overlay/composeur multimédia — optimisation médiathèque).
 *  Réutilise ffmpeg-static, déjà une dépendance vetée de ce dépôt pour
 *  clip-exporter.js (export d'extraits vidéo) — PAS une nouvelle
 *  dépendance, et pas une violation de la contrainte d'architecture
 *  immuable #1 (« pas de FFmpeg pour la capture/transcription audio ») :
 *  ceci ne touche ni au micro ni au pipeline ASR, seulement à des fichiers
 *  déjà sur disque, exactement comme clip-exporter.js.
 *
 *  Fonctionne pour les IMAGES ET les VIDÉOS avec le MÊME appel ffmpeg
 *  (`-frames:v 1`, une seule image de sortie) plutôt que d'ajouter une
 *  dépendance de redimensionnement d'image séparée pour les deux tiers
 *  "image" de la médiathèque.
 *
 *  Toujours en arrière-plan (voir media-ws-handlers.js#addMediaItem) :
 *  jamais attendu avant de répondre à l'opérateur qui vient d'ajouter un
 *  média — même discipline "jamais ralentir le chemin critique" que
 *  caption-translator.js/ai-theme-generator.js.
 * ============================================================================
 */

const { spawn } = require('child_process');
const os = require('os');
const ffmpegPath = require('ffmpeg-static');

const THUMBNAIL_WIDTH = 320;
// Un instant après le tout début (jamais 0:00 pile, souvent un frame noir/
// de transition sur beaucoup d'exports vidéo) — sans effet sur les images
// fixes (ffmpeg ignore -ss pour une entrée image unique).
const VIDEO_THUMBNAIL_SEEK = '00:00:00.5';

/**
 * Même best-effort que clip-exporter.js#lowerProcessPriority : une vignette
 * n'a jamais besoin de passer avant la capture audio/STT en direct.
 * @param {number} pid
 */
function lowerProcessPriority(pid) {
  try {
    os.setPriority(pid, os.constants.priority.PRIORITY_LOW);
  } catch (_err) {
    // Best-effort — voir clip-exporter.js pour le détail des cas où ceci échoue sans conséquence.
  }
}

/**
 * Génère une vignette JPEG (largeur fixe, hauteur proportionnelle) à partir
 * d'une image ou d'une vidéo déjà sur disque.
 * @param {string} sourcePath - fichier média déjà copié dans <userData>/media/
 * @param {string} destPath - chemin de sortie (.jpg)
 * @param {'image'|'video'} mediaType
 * @returns {Promise<void>} rejette si ffmpeg échoue — l'appelant décide du repli (voir addMediaItem)
 */
function generateThumbnail(sourcePath, destPath, mediaType) {
  return new Promise((resolve, reject) => {
    const args = ['-y'];
    if (mediaType === 'video') {
      args.push('-ss', VIDEO_THUMBNAIL_SEEK);
    }
    args.push('-i', sourcePath, '-frames:v', '1', '-vf', `scale=${THUMBNAIL_WIDTH}:-1`, destPath);
    const proc = spawn(ffmpegPath, args, { windowsHide: true });
    lowerProcessPriority(proc.pid);
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

module.exports = { generateThumbnail, THUMBNAIL_WIDTH };
