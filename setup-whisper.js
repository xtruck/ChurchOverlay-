/**
 * ============================================================================
 *  setup-whisper.js — Installe automatiquement whisper-server.exe + le
 *  modèle Whisper nécessaires à la transcription (Windows uniquement).
 * ----------------------------------------------------------------------------
 *  Le dépôt ne contient pas whisper-server.exe ni les modèles .bin (trop
 *  volumineux / binaires précompilés) : SETUP.md et README.md mentionnent
 *  déjà `npm run setup-whisper` comme solution, ce script l'implémente.
 *
 *  Ce qu'il fait :
 *    1. Télécharge le binaire Windows x64 CPU officiel de whisper.cpp
 *       (release GitHub ggml-org/whisper.cpp) et en extrait whisper-server.exe
 *       + les .dll requises dans whisper/.
 *    2. Télécharge le modèle configuré (ggml-base.bin par défaut, ou la
 *       valeur de $env:WHISPER_MODEL — doit rester cohérent avec
 *       whisper-wrapper.js et config-validator.js) dans whisper/models/.
 *
 *  Usage :
 *    npm run setup-whisper
 *    # ou pour un autre modèle (ex: plus rapide mais moins précis) :
 *    $env:WHISPER_MODEL = 'ggml-tiny.bin'; npm run setup-whisper
 *
 *  Modèles disponibles (du plus rapide/moins précis au plus lent/précis) :
 *    ggml-tiny.bin (~75 Mo) < ggml-base.bin (~142 Mo) < ggml-small.bin (~466 Mo)
 * ============================================================================
 */

'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const { execFileSync } = require('child_process');

const WHISPER_DIR = path.join(__dirname, 'whisper');
const MODELS_DIR = path.join(WHISPER_DIR, 'models');
const MODEL_FILE = process.env.WHISPER_MODEL || 'ggml-base.bin';

// Release whisper.cpp connue et testée au moment de l'écriture de ce script.
// whisper-bin-x64.zip = build CPU officiel (pas de GPU requis, fonctionne
// partout). Si ce lien casse un jour (nouvelle release qui renomme l'asset),
// va voir https://github.com/ggml-org/whisper.cpp/releases pour l'asset
// Windows x64 le plus récent et mets à jour WHISPER_CPP_ZIP_URL ci-dessous.
const WHISPER_CPP_ZIP_URL =
  'https://github.com/ggml-org/whisper.cpp/releases/download/v1.9.1/whisper-bin-x64.zip';

const MODEL_URL = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${MODEL_FILE}`;

function log(msg) {
  console.log(`[setup-whisper] ${msg}`);
}

function download(url, destPath) {
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
          const file = fs.createWriteStream(destPath);
          res.on('data', (chunk) => {
            downloaded += chunk.length;
            if (total) {
              const pct = ((downloaded / total) * 100).toFixed(0);
              process.stdout.write(`\r[setup-whisper] Téléchargement... ${pct}%`);
            }
          });
          res.pipe(file);
          file.on('finish', () => {
            file.close(() => {
              process.stdout.write('\n');
              resolve();
            });
          });
          file.on('error', reject);
        })
        .on('error', reject);
    };
    doRequest(url, 5);
  });
}

function extractZipWindows(zipPath, destDir) {
  // Expand-Archive est disponible nativement dans PowerShell depuis Windows
  // 10 / Server 2016 — aucune dépendance externe à installer.
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

async function main() {
  if (process.platform !== 'win32') {
    log(
      'Ce script télécharge des binaires .exe Windows : il ne sert que sur ' +
        'Windows (là où tourne réellement ChurchOverlay packagé). Sur ' +
        'Linux/Mac, la transcription Whisper locale reste indisponible, ' +
        'mais le reste de l\'app (recherche de versets, overlay, contrôle ' +
        'manuel) fonctionne normalement.'
    );
    process.exitCode = 1;
    return;
  }

  fs.mkdirSync(WHISPER_DIR, { recursive: true });
  fs.mkdirSync(MODELS_DIR, { recursive: true });

  const whisperExePath = path.join(WHISPER_DIR, 'whisper-server.exe');
  if (fs.existsSync(whisperExePath)) {
    log('whisper-server.exe déjà présent, téléchargement du binaire ignoré.');
  } else {
    const zipPath = path.join(WHISPER_DIR, '_whisper-bin-x64.zip');
    log(`Téléchargement de whisper.cpp (build Windows x64 CPU) depuis ${WHISPER_CPP_ZIP_URL}`);
    await download(WHISPER_CPP_ZIP_URL, zipPath);

    const extractTmpDir = path.join(WHISPER_DIR, '_extract_tmp');
    log('Extraction de l\'archive...');
    extractZipWindows(zipPath, extractTmpDir);

    // L'archive contient un dossier Release/ avec whisper-server.exe + les
    // .dll requises (ggml*.dll, SDL2.dll...) : on copie tout à côté de
    // whisper-server.exe, dans whisper/, comme l'attendent
    // whisper-wrapper.js et config-validator.js.
    const releaseDir = path.join(extractTmpDir, 'Release');
    const sourceDir = fs.existsSync(releaseDir) ? releaseDir : extractTmpDir;
    for (const entry of fs.readdirSync(sourceDir)) {
      const src = path.join(sourceDir, entry);
      const dst = path.join(WHISPER_DIR, entry);
      fs.copyFileSync(src, dst);
    }

    fs.rmSync(extractTmpDir, { recursive: true, force: true });
    fs.rmSync(zipPath, { force: true });
    log('whisper-server.exe et ses dépendances (.dll) installés dans whisper/.');
  }

  const modelPath = path.join(MODELS_DIR, MODEL_FILE);
  if (fs.existsSync(modelPath)) {
    log(`Modèle ${MODEL_FILE} déjà présent, téléchargement ignoré.`);
  } else {
    log(`Téléchargement du modèle ${MODEL_FILE} depuis Hugging Face...`);
    await download(MODEL_URL, modelPath);
    log(`Modèle installé : whisper/models/${MODEL_FILE}`);
  }

  log('Terminé. Lance `npm test` puis `npm start` pour vérifier que tout est détecté.');
}

main().catch((err) => {
  console.error(`[setup-whisper] Échec : ${err.message}`);
  process.exitCode = 1;
});
