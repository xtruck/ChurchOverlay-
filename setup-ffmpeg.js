/**
 * ============================================================================
 *  setup-ffmpeg.js — Installe un binaire FFmpeg (Windows uniquement) et
 *  fournit sa résolution de chemin pour le reste de l'app.
 * ----------------------------------------------------------------------------
 *  Le dépôt ne contient pas ffmpeg.exe (binaire tiers, ~140 Mo une fois
 *  extrait — CORRECTIF audit : la doc disait auparavant "quelques dizaines
 *  de Mo", très sous-estimé) : jusqu'ici l'app supposait FFmpeg déjà présent
 *  dans le PATH système ou pointé via $env:FFMPEG_PATH (voir
 *  QUICKSTART-WINDOWS.md). Sur le poste d'un volontaire non-technique, rien
 *  ne l'installait : detectAudioDevices() et audio-capture.js échouaient
 *  silencieusement (spawn ENOENT).
 *
 *  DÉCISION (audit) — installation au BUILD plutôt qu'au premier lancement :
 *  Télécharger ~140 Mo sur le poste de l'utilisateur final au premier
 *  lancement s'est révélé peu fiable (réseaux d'église restreints,
 *  antivirus, proxy, coupures). Le téléchargement/l'extraction eux-mêmes
 *  fonctionnent correctement (vérifié) — le vrai risque est l'environnement
 *  réseau imprévisible de chaque utilisateur final, qu'on ne maîtrise pas.
 *  `npm run dist` (voir package.json, script "predist") appelle donc
 *  maintenant ce module AVANT electron-builder, sur la machine du
 *  développeur : ffmpeg.exe est déjà présent dans ffmpeg/ et empaqueté tel
 *  quel dans le .exe distribué (voir build.files dans package.json, qui
 *  inclut déjà ffmpeg/**\/*). Aucun téléchargement n'est plus nécessaire sur
 *  le poste de l'utilisateur final.
 *  Le flux runtime (ensureFfmpegInstalled() appelé depuis main.js à
 *  l'ouverture de l'assistant de configuration) reste en place comme filet
 *  de sécurité pur : sur un build correctement packagé, il ne fait jamais
 *  rien (ffmpeg.exe est déjà là, fs.existsSync court-circuite tout) ; il ne
 *  se déclenche que si quelqu'un lance l'app non-packagée (`npm start`)
 *  sans avoir exécuté `npm run setup-ffmpeg`/`npm run dist` au moins une
 *  fois.
 *
 *  Ce qu'il fait :
 *    1. Télécharge le build statique Windows x64 officiel de BtbN
 *       (ffmpeg-master-latest-win64-gpl) et en extrait ffmpeg.exe dans
 *       ffmpeg/.
 *    2. Expose resolveFfmpegPath(), utilisée partout où l'app avait
 *       auparavant `process.env.FFMPEG_PATH || 'ffmpeg'` en dur.
 *
 *  Usage :
 *    npm run setup-ffmpeg   (manuel, une fois)
 *    npm run dist           (l'exécute automatiquement via "predist")
 * ============================================================================
 */

'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const { execFileSync } = require('child_process');

/**
 * CORRECTIF (audit — cause racine du bug "aucun microphone détecté" qui a
 * survécu à tous les correctifs précédents) : `asar: true` a été activé
 * dans package.json avec `asarUnpack: ["ffmpeg/**\/*"]`, qui copie bien
 * ffmpeg.exe en dehors de l'archive à la construction — mais SANS que ce
 * fichier ne soit mis à jour pour pointer vers ce chemin réel.
 *
 * Dans une app empaquetée, __dirname vaut ici quelque chose comme
 * "...\resources\app.asar" : `path.join(__dirname, 'ffmpeg')` calculait donc
 * "...\resources\app.asar\ffmpeg\ffmpeg.exe", un chemin À L'INTÉRIEUR de
 * l'archive. `fs.existsSync()` répondait "true" sur ce chemin (Electron lit
 * de façon transparente à travers app.asar, y compris pour les fichiers
 * "asarUnpack"), donc ensureFfmpegInstalled() ne se déclenchait jamais et
 * tout semblait normal — SAUF que `child_process.spawn()`, contrairement à
 * `fs.*`, ne passe PAS par la couche de lecture transparente d'Electron : il
 * appelle directement l'API Windows (CreateProcess), qui ne sait rien
 * d'app.asar et ne peut PAS exécuter un binaire "situé" dedans. Le spawn
 * échouait donc silencieusement à chaque tentative de détection de micro OU
 * de capture audio, quel que soit l'état du parsing ou du cache — d'où
 * l'échec systématique malgré tous les autres correctifs.
 *
 * On calcule donc explicitement le chemin RÉEL post-extraction
 * (app.asar.unpacked, à côté de app.asar) quand on tourne depuis une
 * archive. Ce fichier est aussi exécuté en CLI pur (`npm run setup-ffmpeg`,
 * sur la machine du développeur, avant tout empaquetage) : dans ce cas
 * __dirname ne contient jamais "app.asar" et la logique ci-dessous ne change
 * rien, comme attendu.
 */
function resolveAppRoot() {
  // CORRECTIF (robustesse) : on vérifie les deux séparateurs possibles
  // ('/' et '\'), pas seulement path.sep du système courant — certains
  // outils de packaging normalisent parfois les chemins avec des '/' même
  // sur Windows, et ce fichier tourne aussi bien en CLI Node classique qu'à
  // l'intérieur d'Electron.
  for (const sep of ['\\', '/']) {
    const marker = `${sep}app.asar`;
    const idx = __dirname.indexOf(marker);
    if (idx !== -1 && __dirname[idx + marker.length] !== '.') { // évite de re-matcher ".unpacked" lui-même
      return __dirname.slice(0, idx) + `${marker}.unpacked` + __dirname.slice(idx + marker.length);
    }
  }
  return __dirname; // dev / CLI hors app.asar : rien à changer
}

const APP_ROOT = resolveAppRoot();
const FFMPEG_DIR = path.join(APP_ROOT, 'ffmpeg');
const FFMPEG_EXE = path.join(FFMPEG_DIR, 'ffmpeg.exe');

// Délai maximum sans octet reçu avant d'abandonner le téléchargement.
// CORRECTIF (audit) : aucun timeout n'existait auparavant — une connexion
// qui stagne (réseau d'église capricieux, proxy silencieux) pouvait bloquer
// le téléchargement indéfiniment SANS jamais lever d'erreur ni de message,
// ce qui rendait le problème impossible à diagnostiquer côté utilisateur
// ("j'ai essayé plein de fois, rien ne se passe"). Un délai d'inactivité
// (et non un délai total, puisque ~140 Mo peut légitimement prendre
// plusieurs minutes sur une connexion lente mais stable) permet de détecter
// un blocage réel et d'afficher une erreur claire.
const STALL_TIMEOUT_MS = 30000;

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
// CORRECTIF (audit) : ajout d'un timeout d'INACTIVITÉ (STALL_TIMEOUT_MS,
// pas un timeout total — ~140 Mo peut légitimement prendre plusieurs
// minutes sur une connexion lente mais stable). Si aucun octet n'arrive
// pendant ce délai (connexion établie mais réponse gelée — proxy
// silencieux, coupure réseau), le téléchargement est annulé avec une
// erreur claire au lieu de rester bloqué indéfiniment sans retour.
function download(url, destPath, onProgress = () => {}) {
  return new Promise((resolve, reject) => {
    const doRequest = (currentUrl, redirectsLeft) => {
      const req = https
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
          let settled = false;
          const file = fs.createWriteStream(destPath);

          let stallTimer;
          const resetStallTimer = () => {
            clearTimeout(stallTimer);
            stallTimer = setTimeout(() => {
              if (settled) return;
              settled = true;
              res.destroy();
              file.close(() => {
                fs.unlink(destPath, () => {});
              });
              reject(new Error(
                `Téléchargement interrompu : aucune donnée reçue depuis ${STALL_TIMEOUT_MS / 1000}s ` +
                '(connexion instable, proxy/pare-feu bloquant, ou réseau trop lent). ' +
                'Vérifiez votre connexion internet et réessayez.'
              ));
            }, STALL_TIMEOUT_MS);
          };
          resetStallTimer();

          res.on('data', (chunk) => {
            resetStallTimer();
            downloaded += chunk.length;
            if (total) {
              const pct = Math.floor((downloaded / total) * 100);
              if (pct !== lastPct) {
                lastPct = pct;
                // CORRECTIF (audit) : le pourcentage est maintenant transmis
                // en second argument (numérique), en plus du message texte,
                // pour que l'UI (setup.html) puisse afficher une vraie barre
                // de progression sans avoir à re-parser "X%" dans le texte.
                onProgress(`Téléchargement... ${pct}%`, pct);
              }
            }
          });
          res.pipe(file);
          file.on('finish', () => {
            clearTimeout(stallTimer);
            if (settled) return;
            settled = true;
            file.close(() => resolve());
          });
          file.on('error', (err) => {
            clearTimeout(stallTimer);
            if (settled) return;
            settled = true;
            reject(err);
          });
        })
        .on('error', reject);

      // Timeout de connexion initiale (le serveur ne répond pas du tout,
      // avant même de recevoir un statusCode) — distinct du stall timer
      // ci-dessus qui couvre le corps de la réponse une fois commencée.
      req.setTimeout(STALL_TIMEOUT_MS, () => {
        req.destroy(new Error(
          `Connexion à ${currentUrl} sans réponse après ${STALL_TIMEOUT_MS / 1000}s.`
        ));
      });
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
 * si un FFmpeg système est disponible — inutile de retélécharger ~140 Mo si
 * l'utilisateur en a déjà un.
 *
 * @param {Object} [opts]
 * @param {(msg: string, percent?: number) => void} [opts.onProgress] -
 *   percent est fourni (0-100) uniquement pendant la phase de
 *   téléchargement ; absent pour les autres étapes (extraction, etc.).
 * @returns {Promise<{ installed: boolean, skipped: boolean }>}
 */
async function ensureFfmpegInstalled(opts = {}) {
  const onProgress = opts.onProgress || (() => {});
  const report = (msg, percent) => { log(msg); onProgress(msg, percent); };

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
  report('Téléchargement de FFmpeg (build Windows x64 statique)...', 0);
  await download(FFMPEG_ZIP_URL, zipPath, onProgress);

  const extractTmpDir = path.join(FFMPEG_DIR, '_extract_tmp');
  report('Extraction de l\'archive...', 100);
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
