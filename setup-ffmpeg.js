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
  try {
    if (fs.statSync(FFMPEG_EXE).isFile() && fs.statSync(FFMPEG_EXE).size > 0) return FFMPEG_EXE;
  } catch (_) { /* n'existe pas ou inaccessible : on continue vers les autres options */ }
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  return 'ffmpeg';
}

/**
 * Supprime les restes d'une tentative précédente interrompue (téléchargement
 * coupé, extraction interrompue par un antivirus, double-clic sur
 * "Actualiser" pendant qu'une installation était déjà en cours, etc.).
 *
 * BUG CORRIGÉ : sans ce nettoyage préalable, un dossier ffmpeg/_extract_tmp
 * ou un fichier ffmpeg/_ffmpeg-win64.zip laissé dans un état incohérent par
 * une tentative avortée provoquait, à la tentative suivante, une erreur
 * Node « ENOTDIR: not a directory » (un des éléments du chemin n'était plus
 * du tout ce que le code attendait) — et comme rien ne le nettoyait jamais,
 * l'app restait bloquée sur cette même erreur à chaque nouvel essai, sans
 * moyen de s'en sortir autrement qu'en supprimant le dossier à la main.
 * Si `fs.rmSync` échoue malgré tout (fichier verrouillé par l'antivirus,
 * permissions), on avale l'erreur ici : la suite de l'installation le
 * détectera et échouera avec un message clair plutôt que de planter cette
 * fonction de nettoyage elle-même.
 */
function cleanStaleArtifacts() {
  const zipPath = path.join(FFMPEG_DIR, '_ffmpeg-win64.zip');
  const extractTmpDir = path.join(FFMPEG_DIR, '_extract_tmp');
  for (const p of [zipPath, extractTmpDir]) {
    try {
      fs.rmSync(p, { recursive: true, force: true });
    } catch (_) { /* non-fatal : au pire la tentative suivante échouera avec un message clair */ }
  }
}

// CORRECTIF : ensureFfmpegInstalled() est appelée depuis deux endroits
// indépendants (le handler IPC ensure-ffmpeg-ready, déclenché à l'ouverture
// de l'écran de configuration, ET save-setup, déclenché au clic sur
// "Enregistrer et démarrer"). Si l'utilisateur clique "Enregistrer" pendant
// que le scan initial tourne encore, les deux appels lançaient chacun leur
// propre téléchargement/extraction de ffmpeg.exe EN PARALLÈLE — deux
// process PowerShell d'extraction se disputant le même fichier de
// destination, avec un risque réel de ffmpeg.exe corrompu ou tronqué selon
// l'ordre d'écriture. On sérialise maintenant tous les appels concurrents
// sur une seule installation en cours, partagée : le premier appelant la
// déclenche, tout appelant suivant pendant qu'elle tourne reçoit la MÊME
// promesse (et sa propre callback onProgress est quand même notifiée).
let inFlightInstall = null;
const progressListeners = new Set();

function broadcastProgress(msg) {
  for (const listener of progressListeners) {
    try { listener(msg); } catch (_) { /* un listener ne doit jamais faire échouer l'install */ }
  }
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
function ensureFfmpegInstalled(opts = {}) {
  if (opts.onProgress) progressListeners.add(opts.onProgress);

  if (inFlightInstall) {
    // Une installation est déjà en cours (déclenchée par un autre appelant) :
    // on s'y raccroche au lieu d'en démarrer une seconde.
    return inFlightInstall.finally(() => {
      if (opts.onProgress) progressListeners.delete(opts.onProgress);
    });
  }

  inFlightInstall = ensureFfmpegInstalledImpl(broadcastProgress)
    .finally(() => {
      inFlightInstall = null;
      progressListeners.clear();
    });

  return inFlightInstall;
}

async function ensureFfmpegInstalledImpl(onProgress) {
  const report = (msg) => { log(msg); onProgress(msg); };

  if (process.platform !== 'win32') {
    report(
      'Plateforme non-Windows détectée : installation automatique de FFmpeg ' +
      'ignorée (installe-le via ton gestionnaire de paquets et pointe ' +
      '$env:FFMPEG_PATH dessus si besoin).'
    );
    return { installed: false, skipped: true };
  }

  // CORRECTIF : `existsSync` seul ne garantit pas que FFMPEG_EXE est un
  // fichier valide (il pourrait s'agir d'un dossier ou d'un fichier
  // corrompu/tronqué laissé par une tentative précédente) — dans ce cas on
  // le retire et on réinstalle plutôt que de faussement le considérer prêt.
  if (fs.existsSync(FFMPEG_EXE)) {
    let isValidFile = false;
    try { isValidFile = fs.statSync(FFMPEG_EXE).isFile() && fs.statSync(FFMPEG_EXE).size > 0; } catch (_) {}
    if (isValidFile) {
      report('ffmpeg.exe déjà présent dans ffmpeg/, téléchargement ignoré.');
      return { installed: true, skipped: false };
    }
    report('ffmpeg.exe présent mais invalide (dossier ou fichier vide) — réinstallation.');
    try { fs.rmSync(FFMPEG_EXE, { recursive: true, force: true }); } catch (_) {}
  }

  // CORRECTIF : si FFMPEG_DIR lui-même existe déjà comme un FICHIER (et non
  // un dossier) — par exemple suite à une corruption externe — mkdirSync
  // recursive échoue avec EEXIST au lieu de simplement "déjà là". On
  // normalise avant de continuer.
  if (fs.existsSync(FFMPEG_DIR) && !fs.statSync(FFMPEG_DIR).isDirectory()) {
    try { fs.rmSync(FFMPEG_DIR, { force: true }); } catch (_) {}
  }
  fs.mkdirSync(FFMPEG_DIR, { recursive: true });

  // Nettoie tout reste d'une tentative précédente avortée AVANT de
  // commencer — c'est ce qui manquait et causait l'erreur ENOTDIR en boucle.
  cleanStaleArtifacts();

  const zipPath = path.join(FFMPEG_DIR, '_ffmpeg-win64.zip');
  const extractTmpDir = path.join(FFMPEG_DIR, '_extract_tmp');

  try {
    report('Téléchargement de FFmpeg (build Windows x64 statique)...');
    await download(FFMPEG_ZIP_URL, zipPath, onProgress);

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
      throw new Error(`ffmpeg.exe introuvable dans l'archive extraite (${sourceDir})`);
    }
    fs.copyFileSync(sourceExe, FFMPEG_EXE);
  } catch (err) {
    // Quel que soit l'échec (réseau, extraction, archive inattendue...), on
    // nettoie systématiquement pour que la PROCHAINE tentative reparte d'un
    // état propre au lieu d'accumuler des restes qui la feraient échouer
    // différemment (c'était la source du bug ENOTDIR répété).
    cleanStaleArtifacts();
    throw new Error(
      `Échec de l'installation de FFmpeg (${err.message}). ` +
      'Les fichiers temporaires ont été nettoyés — cliquez sur Actualiser pour réessayer.'
    );
  }

  cleanStaleArtifacts();
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
