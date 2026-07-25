'use strict';
const fs = require('fs');
const path = require('path');

const THEMES_DIR = path.join(__dirname, 'config', 'themes');
const FEATURES_FILE = path.join(__dirname, 'config', 'features.json');
const DEFAULT_THEME_ID = 'nuit';

/**
 * Charge un thème depuis JSON et retourne les CSS variables à injecter.
 * Aucun template imposé : chaque champ est utilisé UNIQUEMENT s'il est
 * défini dans le JSON. Les valeurs absentes retombent sur le thème par
 * défaut (nuit) au moment de la conversion CSS (voir themeToCss).
 */
function loadTheme(themeId) {
  const file = path.join(THEMES_DIR, `${themeId}.json`);
  if (!fs.existsSync(file)) {
    throw new Error(`Thème introuvable : ${themeId}`);
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function listThemes() {
  return fs.readdirSync(THEMES_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      const t = loadTheme(f.replace('.json', ''));
      return { id: t.id, name: t.name, author: t.author };
    });
}

function saveTheme(theme) {
  if (!theme || !theme.id || !/^[a-z0-9-_]+$/i.test(theme.id)) {
    throw new Error('ID de thème invalide (a-z, 0-9, -, _ uniquement)');
  }
  if (!theme.name || !String(theme.name).trim()) {
    throw new Error('Nom de thème requis (non vide).');
  }
  const existing = fs.existsSync(path.join(THEMES_DIR, `${theme.id}.json`))
    ? loadTheme(theme.id)
    : null;
  if (existing && existing.readonly) {
    throw new Error(`Le thème par défaut (${theme.id}) est en lecture seule et ne peut pas être écrasé.`);
  }
  const file = path.join(THEMES_DIR, `${theme.id}.json`);
  fs.writeFileSync(file, JSON.stringify(theme, null, 2), 'utf8');
}

function deleteTheme(themeId) {
  const theme = loadTheme(themeId);
  if (theme.readonly) {
    throw new Error(`Le thème par défaut (${themeId}) ne peut pas être supprimé.`);
  }
  fs.unlinkSync(path.join(THEMES_DIR, `${themeId}.json`));
}

/**
 * Duplique un thème existant sous un nouvel id, avec un nouveau nom.
 * Le duplicata n'est jamais readonly (même si l'original l'est), pour
 * qu'il soit immédiatement éditable/supprimable par l'utilisateur.
 */
function duplicateTheme(sourceId, newId, newName) {
  if (!newId || !/^[a-z0-9-_]+$/i.test(newId)) {
    throw new Error('ID de thème invalide (a-z, 0-9, -, _ uniquement)');
  }
  if (fs.existsSync(path.join(THEMES_DIR, `${newId}.json`))) {
    throw new Error(`Un thème avec l'id "${newId}" existe déjà.`);
  }
  const source = loadTheme(sourceId);
  const dup = {
    ...source,
    id: newId,
    name: newName || `${source.name} (copie)`,
    author: 'user',
    readonly: false,
  };
  saveTheme(dup);
  return dup;
}

/** Renvoie l'id du thème actif configuré dans config/features.json. */
function getActiveThemeId() {
  try {
    const features = JSON.parse(fs.readFileSync(FEATURES_FILE, 'utf8'));
    const id = features.design && features.design.activeTheme;
    if (id && fs.existsSync(path.join(THEMES_DIR, `${id}.json`))) {
      return id;
    }
  } catch (_) {
    // features.json absent/corrompu : fallback silencieux ci-dessous.
  }
  return DEFAULT_THEME_ID;
}

/** Renvoie le thème actif complet (jamais d'erreur : fallback sur DEFAULT_THEME_ID). */
function getActiveTheme() {
  const id = getActiveThemeId();
  try {
    return loadTheme(id);
  } catch (_) {
    return loadTheme(DEFAULT_THEME_ID);
  }
}

/** Change le thème actif (persisté dans config/features.json). */
function setActiveTheme(themeId) {
  loadTheme(themeId); // lève si le thème n'existe pas
  let features;
  try {
    features = JSON.parse(fs.readFileSync(FEATURES_FILE, 'utf8'));
  } catch (e) {
    throw new Error(`Impossible de lire config/features.json : ${e.message}`);
  }
  features.design = features.design || {};
  features.design.activeTheme = themeId;
  fs.writeFileSync(FEATURES_FILE, JSON.stringify(features, null, 2), 'utf8');
  return getActiveTheme();
}

/**
 * Convertit un thème JSON en CSS variables + règles pour l'overlay.
 * Renvoyé au navigateur via WebSocket lors du changement de thème.
 * Les champs manquants du thème donné retombent sur le thème par défaut
 * (nuit), pas sur des constantes en dur, pour que "hériter du défaut"
 * suive automatiquement toute future modification de nuit.json.
 */
function themeToCss(theme) {
  let fallback;
  try {
    fallback = theme.id === DEFAULT_THEME_ID ? theme : loadTheme(DEFAULT_THEME_ID);
  } catch (_) {
    fallback = {};
  }
  const c = theme.colors || {};
  const fc = fallback.colors || {};
  const bg = c.background || fc.background || {};
  let bgCss = 'transparent';
  if (bg.type === 'gradient' && Array.isArray(bg.stops)) {
    const stops = bg.stops.map(s => `${s.color} ${s.position}%`).join(', ');
    bgCss = `linear-gradient(${bg.angle || 165}deg, ${stops})`;
  } else if (bg.type === 'solid') {
    bgCss = bg.color;
  } else if (bg.type === 'image' && theme.backgroundImage?.source) {
    bgCss = `url("${theme.backgroundImage.source}") center/cover`;
  }

  const typo = theme.typography || {};
  const ftypo = fallback.typography || {};
  const fx = theme.effects || {};
  const ffx = fallback.effects || {};

  return {
    variables: {
      '--bg': bgCss,
      '--accent': c.accent || fc.accent || '#D9BB6C',
      '--accent-bright': c.accentBright || fc.accentBright || '#F4E3A6',
      '--text': c.text || fc.text || '#FFFFFF',
      '--reference-color': c.reference || c.accentBright || fc.reference || fc.accentBright || '#F4E3A6',
      '--verse-font': typo.verseFontFamily || ftypo.verseFontFamily || 'Merriweather',
      '--verse-size': typo.verseFontSize || ftypo.verseFontSize || 'clamp(2.4rem, 4.6vw, 5.2rem)',
      '--verse-weight': typo.verseFontWeight || ftypo.verseFontWeight || 700,
      '--ref-font': typo.referenceFontFamily || ftypo.referenceFontFamily || 'Manrope',
      '--ref-spacing': typo.referenceLetterSpacing || ftypo.referenceLetterSpacing || '0.14em',
      '--border-radius': fx.borderRadius ?? ffx.borderRadius ?? '28px',
      '--blur': fx.blurBackdrop ?? ffx.blurBackdrop ?? '26px',
    },
    effects: { ...ffx, ...fx },
    animations: theme.animations || fallback.animations || {},
    background: theme.backgroundImage || fallback.backgroundImage || {},
  };
}

module.exports = {
  loadTheme,
  listThemes,
  saveTheme,
  deleteTheme,
  duplicateTheme,
  getActiveTheme,
  setActiveTheme,
  themeToCss,
};
