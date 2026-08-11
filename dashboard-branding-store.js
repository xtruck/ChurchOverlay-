/**
 * ============================================================================
 * dashboard-branding-store.js — Identité de marque du TABLEAU DE BORD
 *   (nom d'organisation, couleur d'accent, logo dans la barre latérale)
 * ----------------------------------------------------------------------------
 * AJOUT (demande explicite — revente de l'app à d'autres églises/entreprises
 * comme produit "clé en main", une installation par client). Distinct de
 * DEUX autres systèmes de marque déjà existants, volontairement non touchés
 * ici :
 *   - theme-loader.js : ce que la CONGRÉGATION voit (thème de l'overlay de
 *     projection — polices/couleurs/effets du verset affiché).
 *   - branding-store.js : le logo/habillage de la CAMÉRA (incrustation OBS,
 *     branding-overlay.html) — position/taille pensées pour un lower-third
 *     vidéo, sans rapport avec le tableau de bord lui-même.
 * Ici : ce que l'OPÉRATEUR voit en ouvrant son propre outil (barre latérale)
 * — nom d'organisation, couleur d'accent, logo. Même discipline que
 * branding-store.js : petit fichier JSON + fichier logo copié dans userData
 * (jamais dans app.asar ni le dépôt git) — fichier séparé plutôt qu'un ajout
 * de champs à branding-store.js pour ne pas mélanger deux domaines sans
 * recouvrement (aucun champ commun, aucun point de consommation commun).
 * ============================================================================
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ALLOWED_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.svg', '.gif']);
const DEFAULT_ACCENT_COLOR = '#7c8cf5';
const HEX_COLOR_RE = /^#[0-9a-f]{6}$/i;
const MAX_ORG_NAME_LENGTH = 60;

let configPath = null;
let logoDir = null;

/**
 * @param {string} dir - Dossier utilisateur de l'app (hors app.asar)
 */
function setUserDataDir(dir) {
  configPath = path.join(dir, 'dashboard-branding.json');
  logoDir = path.join(dir, 'dashboard-branding');
}

function readConfig() {
  const fallback = {
    organizationName: null,
    accentColor: null,
    logoFilename: null,
  };
  if (!configPath || !fs.existsSync(configPath)) return fallback;
  try {
    const data = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    return {
      organizationName:
        typeof data.organizationName === 'string' && data.organizationName.trim()
          ? data.organizationName.trim().slice(0, MAX_ORG_NAME_LENGTH)
          : null,
      accentColor: HEX_COLOR_RE.test(data.accentColor) ? data.accentColor : null,
      logoFilename: typeof data.logoFilename === 'string' ? data.logoFilename : null,
    };
  } catch (e) {
    console.warn('[dashboard-branding-store] Lecture impossible, config ignorée:', e.message);
    return fallback;
  }
}

function writeConfig(config) {
  if (!configPath) return;
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
}

/**
 * @returns {{organizationName: string|null, accentColor: string|null, logoFilename: string|null}}
 */
function getConfig() {
  return readConfig();
}

/**
 * @param {string} name
 * @returns {{organizationName: string|null, accentColor: string|null, logoFilename: string|null}}
 */
function setOrganizationName(name) {
  const config = readConfig();
  const trimmed = typeof name === 'string' ? name.trim() : '';
  config.organizationName = trimmed ? trimmed.slice(0, MAX_ORG_NAME_LENGTH) : null;
  writeConfig(config);
  return config;
}

/**
 * @param {string} color - couleur hexadécimale (ex. '#7c8cf5')
 * @returns {{organizationName: string|null, accentColor: string|null, logoFilename: string|null}}
 */
function setAccentColor(color) {
  if (!HEX_COLOR_RE.test(color)) {
    throw new Error(`Couleur invalide (attendu #rrggbb) : ${color}`);
  }
  const config = readConfig();
  config.accentColor = color;
  writeConfig(config);
  return config;
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
 * Copie un fichier logo choisi par l'opérateur (chemin absolu, même
 * sélecteur natif 'pick-media-file' que la médiathèque et l'habillage
 * caméra) dans <userData>/dashboard-branding/. Remplace le logo précédent.
 * @param {string} sourcePath
 * @returns {{organizationName: string|null, accentColor: string|null, logoFilename: string}}
 */
function setLogo(sourcePath) {
  if (!logoDir) throw new Error('dashboard-branding-store: setUserDataDir() non appelé');
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
 * @returns {{organizationName: string|null, accentColor: string|null, logoFilename: null}}
 */
function clearLogo() {
  const config = readConfig();
  if (config.logoFilename) deleteLogoFile(config.logoFilename);
  config.logoFilename = null;
  writeConfig(config);
  return config;
}

module.exports = {
  setUserDataDir,
  getConfig,
  setOrganizationName,
  setAccentColor,
  setLogo,
  clearLogo,
  // Exposées pour tests unitaires (test-dashboard-branding-store.js).
  ALLOWED_EXTENSIONS,
  DEFAULT_ACCENT_COLOR,
  HEX_COLOR_RE,
  MAX_ORG_NAME_LENGTH,
};
