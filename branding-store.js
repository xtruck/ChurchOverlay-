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
const { writeJsonAtomic } = require('./persistence/atomic-json-store');

// AJOUT (demande explicite — "pas seulement des logos ou du texte, des
// masques, plein de fichiers différents, même vidéo, même GIF") : au-delà
// des images statiques, un logo peut être une vidéo (.mp4/.webm, lue en
// boucle silencieuse — même esprit qu'un GIF animé) ou un GIF animé
// classique. logoType (déduit de l'extension, voir setLogo()) dit à
// branding-overlay.html quel élément afficher (<img> ou <video>).
const ALLOWED_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.svg',
  '.gif',
  '.mp4',
  '.webm',
]);
const VIDEO_EXTENSIONS = new Set(['.mp4', '.webm']);
const POSITIONS = new Set(['top-left', 'top-right', 'bottom-left', 'bottom-right']);
const DEFAULT_POSITION = 'bottom-right';
// AJOUT (demande explicite — "plus de paramètres") : taille du logo à
// l'écran, en plus de sa position. Trois préréglages plutôt qu'un
// pourcentage libre — plus simple à choisir pour un opérateur non technique,
// et évite qu'un logo mal dimensionné envahisse tout le cadre par erreur.
const SIZES = new Set(['small', 'medium', 'large']);
const DEFAULT_SIZE = 'medium';

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
  const fallback = {
    logoFilename: null,
    logoType: 'image',
    position: DEFAULT_POSITION,
    size: DEFAULT_SIZE,
  };
  if (!configPath || !fs.existsSync(configPath)) return fallback;
  try {
    const data = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    return {
      logoFilename: typeof data.logoFilename === 'string' ? data.logoFilename : null,
      logoType: data.logoType === 'video' ? 'video' : 'image',
      position: POSITIONS.has(data.position) ? data.position : DEFAULT_POSITION,
      size: SIZES.has(data.size) ? data.size : DEFAULT_SIZE,
    };
  } catch (e) {
    console.warn('[branding-store] Lecture impossible, config ignorée:', e.message);
    return fallback;
  }
}

function writeConfig(config) {
  if (!configPath) return;
  writeJsonAtomic(configPath, config);
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
  config.logoType = VIDEO_EXTENSIONS.has(ext) ? 'video' : 'image';
  writeConfig(config);
  return config;
}

/**
 * @returns {{logoFilename: null, logoType: string, position: string, size: string}}
 */
function clearLogo() {
  const config = readConfig();
  if (config.logoFilename) deleteLogoFile(config.logoFilename);
  config.logoFilename = null;
  config.logoType = 'image';
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

/**
 * @param {string} size - 'small' | 'medium' | 'large'
 * @returns {{logoFilename: string|null, logoType: string, position: string, size: string}}
 */
function setSize(size) {
  const config = readConfig();
  config.size = SIZES.has(size) ? size : DEFAULT_SIZE;
  writeConfig(config);
  return config;
}

module.exports = {
  setUserDataDir,
  getConfig,
  setLogo,
  clearLogo,
  setPosition,
  setSize,
  // Exposées pour tests unitaires (test-branding-store.js).
  ALLOWED_EXTENSIONS,
  VIDEO_EXTENSIONS,
  POSITIONS,
  DEFAULT_POSITION,
  SIZES,
  DEFAULT_SIZE,
};
