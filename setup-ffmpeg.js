/**
 * ============================================================================
 *  setup-ffmpeg.js — Installe automatiquement un binaire FFmpeg (Windows
 *  uniquement) et fournit sa résolution de chemin pour le reste de l'app.
 * ----------------------------------------------------------------------------
 *  Le dépôt ne contient pas ffmpeg.exe (binaire tiers, plusieurs dizaines de
 *  Mo) : jusqu'ici l'app supposait FFmpeg déjà présent dans le PATH système
 *  ou pointé via $env:FFMPEG_PATH (voir QUICKSTART-WINDOWS.md). Sur le poste
 *  d'un volontaire non-technique, rien ne l'installait : detectAudioDevices()
 *  et audio-capture.js échouaient silencieusement (spawn ENOENT).
 *
 *  Ce qu'il fait :
 *    1. Télécharge le build statique Windows x64 officiel de BtbN
 *       (ffmpeg-master-latest-win64-gpl) et en extrait ffmpeg.exe dans
 *       ffmpeg/.
 *    2. Expose resolveFfmpegPath(), utilisée partout où l'app avait
 *       auparavant `process.env.FFMPEG_PATH || 'ffmpeg'` en dur.
 *
 *  Usage :
 *    npm run setup-ffmpeg
 * ============================================================================
 */

'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const { execFileSync } = require('child_process');

const FFMPEG_DIR = path.join(__dirname, 'ffmpeg');
const FFMPEG_EXE = path.join(FFMPEG_DIR, 'ffmpeg.exe');

// Tag "latest" de BtbN/FFmpeg-Builds : pointe toujours vers le build master
// le plus récent, donc pas de numéro de version à maintenir ici. Si ce lien
// casse un jour (dépôt renommé, asset renommé), va voir
// https://github.com/BtbN/FFmpeg-Builds/releases pour l'asset win64-gpl le
// plus récent et mets à jour FFMPEG_ZIP_URL ci-dessous.
const FFMPEG_ZIP_URL =
  'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip';

function log(msg) {
  console.log(`[setup-ffmpeg] ${msg}`);
}

// Logique de téléchargement avec suivi de progression, dédiée à FFmpeg
// (le téléchargement automatique de Whisper local a été retiré en v0.3.0).
function download(url, destPath, onProgress = () => {}) {
  return new Promise((resolve, reject) => {
    const doRequest = (currentUrl, redirectsLeft) => {
      https
        .get(currentUrl, (res) => {
          if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
            if (redirectsLeft <= 0) {
              reject(new Error('Trop de redirections'));
              return;
            }
            res.resume();
            doRequest(res.headers.location, redirectsLeft - 1);
            return;
          }
          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode} pour ${currentUrl}`));
            return;
          }
          const total = parseInt(res.headers['content-length'] || '0', 10);
          let downloaded = 0;
          let lastPct = -1;
          const file = fs.createWriteStream(destPath);
          res.on('data', (chunk) => {
            downloaded += chunk.length;
            if (total) {
              const pct = Math.floor((downloaded / total) * 100);
              if (pct !== lastPct) {
                lastPct = pct;
                onProgress(`Téléchargement... ${pct}%`);
              }
            }
          });
          res.pipe(file);
          file.on('finish', () => {
            file.close(() => resolve());
          });
          file.on('error', reject);
        })
        .on('error', reject);
    };
    doRequest(url, 5);
  });
}

function extractZipWindows(zipPath, destDir) {
  execFileSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      `Expand-Archive -Path "${zipPath}" -DestinationPath "${destDir}" -Force`,
    ],
    { stdio: 'inherit' }
  );
}

/**
 * Résout le chemin de l'exécutable FFmpeg à utiliser, par ordre de priorité :
 *   1. Le binaire installé par ensureFfmpegInstalled() dans ffmpeg/ (aucune
 *      config requise, fonctionne sur un poste vierge).
 *   2. $env:FFMPEG_PATH, pour un utilisateur qui préfère pointer vers sa
 *      propre installation (voir QUICKSTART-WINDOWS.md).
 *   3. 'ffmpeg' tel quel, en supposant qu'il est dans le PATH système.
 *
 * Remplace les occurrences en dur de `process.env.FFMPEG_PATH || 'ffmpeg'`
 * disséminées dans main.js, list-audio-devices.js, audio-capture.js et
 * config-validator.js.
 *
 * @returns {string}
 */
function resolveFfmpegPath() {
  if (fs.existsSync(FFMPEG_EXE)) return FFMPEG_EXE;
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  return 'ffmpeg';
}

/**
 * Télécharge et installe ffmpeg.exe s'il n'est pas déjà présent. Idempotent.
 * Ne fait rien si $env:FFMPEG_PATH pointe déjà vers un FFmpeg fonctionnel ou
 * si un FFmpeg système est disponible — inutile de retélécharger ~80 Mo si
 * l'utilisateur en a déjà un.
 *
 * @param {Object} [opts]
 * @param {(msg: string) => void} [opts.onProgress]
 * @returns {Promise<{ installed: boolean, skipped: boolean }>}
 */
async function ensureFfmpegInstalled(opts = {}) {
  const onProgress = opts.onProgress || (() => {});
  const report = (msg) => { log(msg); onProgress(msg); };

  if (process.platform !== 'win32') {
    report(
      'Plateforme non-Windows détectée : installation automatique de FFmpeg ' +
      'ignorée (installe-le via ton gestionnaire de paquets et pointe ' +
      '$env:FFMPEG_PATH dessus si besoin).'
    );
    return { installed: false, skipped: true };
  }

  if (fs.existsSync(FFMPEG_EXE)) {
    report('ffmpeg.exe déjà présent dans ffmpeg/, téléchargement ignoré.');
    return { installed: true, skipped: false };
  }

  fs.mkdirSync(FFMPEG_DIR, { recursive: true });

  const zipPath = path.join(FFMPEG_DIR, '_ffmpeg-win64.zip');
  report('Téléchargement de FFmpeg (build Windows x64 statique)...');
  await download(FFMPEG_ZIP_URL, zipPath, onProgress);

  const extractTmpDir = path.join(FFMPEG_DIR, '_extract_tmp');
  report('Extraction de l\'archive...');
  extractZipWindows(zipPath, extractTmpDir);

  // L'archive contient un dossier versionné (ex.
  // ffmpeg-master-latest-win64-gpl/bin/ffmpeg.exe) dont le nom exact change
  // à chaque build : on le retrouve dynamiquement plutôt que de le coder en
  // dur, puis on ne copie que ffmpeg.exe (ffplay.exe/ffprobe.exe ne sont pas
  // utilisés par cette app, inutile d'alourdir le paquet).
  const topLevelEntries = fs.readdirSync(extractTmpDir);
  const versionedDir = topLevelEntries.length === 1
    ? path.join(extractTmpDir, topLevelEntries[0])
    : extractTmpDir;
  const binDir = path.join(versionedDir, 'bin');
  const sourceDir = fs.existsSync(binDir) ? binDir : versionedDir;
  const sourceExe = path.join(sourceDir, 'ffmpeg.exe');

  if (!fs.existsSync(sourceExe)) {
    fs.rmSync(extractTmpDir, { recursive: true, force: true });
    fs.rmSync(zipPath, { force: true });
    throw new Error(`ffmpeg.exe introuvable dans l'archive extraite (${sourceDir})`);
  }
  fs.copyFileSync(sourceExe, FFMPEG_EXE);

  fs.rmSync(extractTmpDir, { recursive: true, force: true });
  fs.rmSync(zipPath, { force: true });
  report('ffmpeg.exe installé dans ffmpeg/.');

  return { installed: true, skipped: false };
}

module.exports = { ensureFfmpegInstalled, resolveFfmpegPath };

// Usage en ligne de commande : `npm run setup-ffmpeg`
if (require.main === module) {
  ensureFfmpegInstalled().catch((err) => {
    console.error(`[setup-ffmpeg] Échec : ${err.message}`);
    process.exitCode = 1;
  });
}
