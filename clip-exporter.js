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
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');

const DEFAULT_CLIP_DURATION_SEC = 45;
const MIN_CLIP_DURATION_SEC = 15;
const MAX_CLIP_DURATION_SEC = 120;
const MAX_CLIPS_PER_EXPORT = 20; // garde-fou : un culte de 2h avec un temps fort toutes les 10s produirait des centaines d'extraits sinon.

// AJOUT (durcissement Social Clip Machine) : style d'incrustation .srt —
// sans-serif lisible, boîte semi-transparente (BorderStyle=3 + BackColour
// alpha 0x80) plutôt qu'un simple contour, plus lisible sur un fond vidéo
// changeant qu'une ombre seule. Alignment=2 (bas centré), MarginV=60 pour
// ne pas coller au bord inférieur (important en 9:16, souvent recouvert par
// l'UI des plateformes type Reels/TikTok/Shorts).
const SUBTITLE_STYLE =
  'FontName=Arial,FontSize=26,PrimaryColour=&H00FFFFFF,BorderStyle=3,BackColour=&H80000000,Outline=0,Shadow=0,MarginV=60,Alignment=2';

/**
 * Échappe un chemin de fichier pour l'utiliser comme valeur du filtre ffmpeg
 * 'subtitles'. Convertit les backslashes Windows en slashes (acceptés tels
 * quels par ffmpeg, y compris sous Windows), puis échappe le ':' du lecteur
 * avec DEUX backslashes littéraux (`\\:`), pas un seul.
 *
 * CORRECTIF trouvé en écrivant ce fichier, testé avec un vrai ffmpeg/libass
 * (pas supposé — 6 variantes essayées en argv direct via spawnSync, une
 * seule fonctionne) : la valeur de la chaîne `-vf` passe par DEUX passes de
 * dé-échappement avant d'atteindre le filtre 'subtitles' — celle du
 * filtergraph globale, puis celle du parseur d'options du filtre lui-même.
 * Un seul `\:` (voire le chemin entouré de quotes simples, essayé aussi)
 * survit à la PREMIÈRE passe seulement : le ':' redevient un séparateur nu
 * avant la seconde, tronquant la valeur après "C\" et décalant le reste
 * ("/Users/...") sur l'option positionnelle suivante ('original_size'),
 * faisant échouer tout le filtre. Deux backslashes (`\\:`) survivent la
 * première passe en un `\:` qui protège enfin le ':' à la seconde.
 * @param {string} filePath
 * @returns {string}
 */
function escapeSubtitlesPath(filePath) {
  return String(filePath).replace(/\\/g, '/').replace(/:/g, '\\\\:');
}

/**
 * Construit la chaîne de filtres vidéo ffmpeg (-vf) pour un extrait :
 * recadrage 9:16 optionnel, incrustation de sous-titres optionnelle. Pure —
 * ne touche ni au disque ni au réseau, testable indépendamment de ffmpeg.
 * @param {{ aspectRatio?: '16:9'|'9:16', subtitlesPath?: string|null }} [opts]
 * @returns {string[]} liste de filtres (déjà prêts à joindre par ',')
 */
function buildVideoFilters({ aspectRatio, subtitlesPath } = {}) {
  const filters = [];
  if (aspectRatio === '9:16') {
    // Recadrage CENTRÉ géométrique (pas de suivi de sujet/visage — un
    // recadrage réellement "intelligent" au sens détection d'action
    // nécessiterait un modèle de vision dédié, hors périmètre de ce
    // chantier ; compromis assumé, comme celui déjà documenté pour
    // bible-semantic-search.js). Largeur ramenée à 9/16 de la hauteur,
    // arrondie au nombre pair (contrainte libx264), centrée horizontalement.
    // min(iw,...) protège une source déjà plus étroite que 9:16 (rare, mais
    // éviterait sinon une largeur de crop négative).
    filters.push("crop=w='trunc(min(iw\\,ih*9/16)/2)*2':h='ih':x='(iw-out_w)/2':y='0'");
  }
  if (subtitlesPath) {
    filters.push(
      `subtitles=filename=${escapeSubtitlesPath(subtitlesPath)}:force_style='${SUBTITLE_STYLE}'`
    );
  }
  return filters;
}

/**
 * Construit les arguments ffmpeg complets pour découper UN extrait. Pure et
 * exportée séparément de cutOneClip() pour rester testable sans lancer de
 * vrai process (voir test-clip-exporter.js).
 * @param {{ sourcePath: string, outputPath: string, startSec: number, durationSec: number, aspectRatio?: string, subtitlesPath?: string|null }} params
 * @returns {string[]}
 */
function buildFfmpegArgs({
  sourcePath,
  outputPath,
  startSec,
  durationSec,
  aspectRatio,
  subtitlesPath,
}) {
  const args = [
    '-y', // écrase un fichier de sortie existant du même nom sans invite interactive
    '-ss',
    String(Math.max(0, startSec)),
    '-i',
    sourcePath,
    '-t',
    String(durationSec),
  ];
  const filters = buildVideoFilters({ aspectRatio, subtitlesPath });
  if (filters.length > 0) {
    args.push('-vf', filters.join(','));
  }
  args.push('-c:v', 'libx264', '-preset', 'veryfast', '-c:a', 'aac', outputPath);
  return args;
}

/**
 * Best-effort : abaisse la priorité CPU du process ffmpeg pour qu'un export
 * de clip (potentiellement long, plusieurs extraits réencodés à la suite)
 * ne dispute jamais le CPU à la capture audio/STT en direct pendant un
 * culte encore en cours. os.setPriority() est portable Windows
 * (SetPriorityClass) ET Unix (setpriority) — pas besoin de shell out vers
 * `nice`/`renice`. N'échoue jamais l'export si la plateforme/les
 * permissions refusent (même contrat best-effort que session-store.js).
 * @param {number} pid
 */
function lowerProcessPriority(pid) {
  try {
    os.setPriority(pid, os.constants.priority.PRIORITY_LOW);
  } catch (_err) {
    // Best-effort : environnement restreint (conteneur, permissions) ou pid
    // déjà terminé avant l'appel — l'export continue à priorité normale.
  }
}

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
 * @param {{ aspectRatio?: '16:9'|'9:16', subtitlesPath?: string|null }} [options]
 * @returns {Promise<void>}
 */
function cutOneClip(sourcePath, outputPath, startSec, durationSec, options = {}) {
  return new Promise((resolve, reject) => {
    const args = buildFfmpegArgs({
      sourcePath,
      outputPath,
      startSec,
      durationSec,
      aspectRatio: options.aspectRatio,
      subtitlesPath: options.subtitlesPath,
    });
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

/**
 * Découpe un extrait par temps fort retenu, dans outputDir.
 * @param {string} sourcePath - chemin de l'enregistrement vidéo source
 * @param {string} outputDir - dossier de destination (créé si absent)
 * @param {Array<object>} entries - lignes de sessionStore.getVerseHistorySince()
 * @param {number} sessionStartedAt - epoch ms du début du culte
 * @param {{ clipDurationSec?: number, aspectRatio?: '16:9'|'9:16', transcriptSegments?: Array<object>, onProgress?: (done:number, total:number) => void }} [options]
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
  const aspectRatio = options.aspectRatio === '9:16' ? '9:16' : '16:9';
  // AJOUT (SRT burn-in) : lignes de sessionStore.getTranscriptSegmentsSince()
  // — passées par l'appelant (même convention que `entries` ci-dessus), ce
  // module reste sans accès direct à session-store.js.
  const transcriptSegments = Array.isArray(options.transcriptSegments)
    ? options.transcriptSegments
    : [];

  const highlightExport = require('./highlight-export');
  const srtExport = require('./srt-export');
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
    // AJOUT (SRT burn-in) : fichier .srt TEMPORAIRE par extrait, avec ses
    // propres timestamps REBASÉS sur le début du CLIP (0 = début de
    // l'extrait), pas sur le début du culte. Nécessaire : ffmpeg (-ss AVANT
    // -i) réinitialise la timeline de sortie à ~0 pour la portion extraite —
    // brûler des sous-titres calés sur l'horodatage du culte entier les
    // afficherait au mauvais moment (ou jamais, pour un clip qui ne démarre
    // pas à 0). Supprimé après chaque extrait, que ffmpeg réussisse ou non.
    let subtitlesPath = null;
    try {
      if (transcriptSegments.length > 0) {
        const windowStartMs = entry.offsetMs;
        const windowEndMs = entry.offsetMs + clipDurationSec * 1000;
        const srt = srtExport.buildSrt(transcriptSegments, sessionStartedAt, {
          windowStartMs,
          windowEndMs,
        });
        if (srt) {
          subtitlesPath = path.join(
            os.tmpdir(),
            `churchoverlay-clip-srt-${Date.now()}-${Math.random().toString(36).slice(2)}.srt`
          );
          fs.writeFileSync(subtitlesPath, srt, 'utf8');
        }
      }
      await cutOneClip(sourcePath, outputPath, startSec, clipDurationSec, {
        aspectRatio,
        subtitlesPath,
      });
      clips.push({ file: fileName, reference: entry.reference, offsetSec: startSec });
    } catch (err) {
      errors.push({ reference: entry.reference, error: err.message });
    } finally {
      if (subtitlesPath) {
        try {
          fs.unlinkSync(subtitlesPath);
        } catch (_) {
          // Best-effort : un fichier temporaire orphelin dans %TEMP% n'a
          // aucun impact sur l'export lui-même.
        }
      }
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
  buildFfmpegArgs,
  buildVideoFilters,
  escapeSubtitlesPath,
  DEFAULT_CLIP_DURATION_SEC,
  MIN_CLIP_DURATION_SEC,
  MAX_CLIP_DURATION_SEC,
  MAX_CLIPS_PER_EXPORT,
};
