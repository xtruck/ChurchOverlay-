/**
 * ============================================================================
 * branding-store.js — Habillage caméra (logo + position), persisté
 * ----------------------------------------------------------------------------
 * AJOUT (demande explicite — logos/titres automatisés sur la diffusion
 * caméra, "mieux qu'OBS"). Contrairement à un habillage composé une fois
 * manuellement dans OBS (source image + source texte positionnées à la
 * main), ce module ne stocke QUE ce qui doit survivre entre deux cultes : le
 * fichier logo et sa position à l'écran. Le titre/sous-titre affichés en
 * direct (ex. nom du prédicateur, thème du jour) sont volontairement DE LA
 * SESSION EN COURS, pas persistés ici — voir session-state.js
 * (getBrandingText/setBrandingText) : un titre du culte précédent qui
 * réapparaîtrait tout seul au culte suivant serait plus gênant qu'utile.
 *
 * Même discipline que media-library.js : petit fichier JSON + un fichier
 * copié dans userData (jamais dans app.asar ni le dépôt git).
 * ============================================================================
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ALLOWED_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.svg']);
const POSITIONS = new Set(['top-left', 'top-right', 'bottom-left', 'bottom-right']);
const DEFAULT_POSITION = 'bottom-right';

let configPath = null;
let logoDir = null;

/**
 * @param {string} dir - Dossier utilisateur de l'app (hors app.asar)
 */
function setUserDataDir(dir) {
  configPath = path.join(dir, 'branding.json');
  logoDir = path.join(dir, 'branding');
}

function readConfig() {
  const fallback = { logoFilename: null, position: DEFAULT_POSITION };
  if (!configPath || !fs.existsSync(configPath)) return fallback;
  try {
    const data = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    return {
      logoFilename: typeof data.logoFilename === 'string' ? data.logoFilename : null,
      position: POSITIONS.has(data.position) ? data.position : DEFAULT_POSITION,
    };
  } catch (e) {
    console.warn('[branding-store] Lecture impossible, config ignorée:', e.message);
    return fallback;
  }
}

function writeConfig(config) {
  if (!configPath) return;
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
}

/**
 * @returns {{logoFilename: string|null, position: string}}
 */
function getConfig() {
  return readConfig();
}

function deleteLogoFile(filename) {
  if (!logoDir || !filename) return;
  try {
    fs.unlinkSync(path.join(logoDir, filename));
  } catch (_e) {
    // Fichier déjà absent : sans conséquence, la config reste la source de vérité.
  }
}

/**
 * Copie un fichier logo choisi par l'opérateur (chemin absolu, depuis le
 * même sélecteur natif que la médiathèque — 'pick-media-file') dans
 * <userData>/branding/. Remplace l'éventuel logo précédent.
 * @param {string} sourcePath
 * @returns {{logoFilename: string, position: string}}
 */
function setLogo(sourcePath) {
  if (!logoDir) throw new Error('branding-store: setUserDataDir() non appelé');
  if (!sourcePath || !fs.existsSync(sourcePath)) throw new Error('Fichier source introuvable');

  const ext = path.extname(sourcePath).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    throw new Error(`Type de fichier non supporté : ${ext || '(aucune extension)'}`);
  }

  const config = readConfig();
  if (config.logoFilename) deleteLogoFile(config.logoFilename);

  const filename = `logo-${crypto.randomUUID()}${ext}`;
  fs.mkdirSync(logoDir, { recursive: true });
  fs.copyFileSync(sourcePath, path.join(logoDir, filename));

  config.logoFilename = filename;
  writeConfig(config);
  return config;
}

/**
 * @returns {{logoFilename: null, position: string}}
 */
function clearLogo() {
  const config = readConfig();
  if (config.logoFilename) deleteLogoFile(config.logoFilename);
  config.logoFilename = null;
  writeConfig(config);
  return config;
}

/**
 * @param {string} position - 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'
 * @returns {{logoFilename: string|null, position: string}}
 */
function setPosition(position) {
  const config = readConfig();
  config.position = POSITIONS.has(position) ? position : DEFAULT_POSITION;
  writeConfig(config);
  return config;
}

module.exports = {
  setUserDataDir,
  getConfig,
  setLogo,
  clearLogo,
  setPosition,
  // Exposées pour tests unitaires (test-branding-store.js).
  ALLOWED_EXTENSIONS,
  POSITIONS,
  DEFAULT_POSITION,
};
