'use strict';
const fs = require('fs');
const path = require('path');

const featuresStore = require('./features-store');
// CORRECTIF (chantier durcissement v1.0 — principe "flat file", écriture
// atomique systématique) : saveTheme() écrivait directement via
// fs.writeFileSync(), seul store JSON du projet encore hors du pattern
// tmp+fsync+rename partagé (voir persistence/atomic-json-store.js et son
// en-tête, qui liste déjà tous les autres stores migrés). Un crash pendant
// l'écriture d'un thème personnalisé pouvait laisser un .json tronqué,
// relu comme invalide au prochain chargement.
const { writeJsonAtomic } = require('./persistence/atomic-json-store');

const THEMES_DIR = path.join(__dirname, 'config', 'themes');
// CORRECTIF (Studio Clair — nouveau thème par défaut à l'installation) :
// 'nuit' reste un thème système parfaitement sélectionnable, juste plus le
// réglage de sortie de boîte — voir config/themes/studio-clair-ivoire.json.
// CORRECTIF (chantier "Mission Control", direction retenue) : le défaut
// repasse en régie sombre, cohérent avec le tableau de bord opérateur —
// MÊME principe qu'au-dessus : 'studio-clair-ivoire' et les six autres
// thèmes système restent entièrement sélectionnables, seul le réglage de
// sortie de boîte change. Cette constante sert AUSSI de source de repli
// champ par champ dans themeToCss() ci-dessous : vérifié que les sept
// thèmes existants définissent la totalité de colors/typography/effects,
// aucun ne dépend donc d'un champ hérité du défaut (rien ne régresse).
const DEFAULT_THEME_ID = 'mission-control';

// CORRECTIF (audit round 5) : les thèmes livrés vivent dans app.asar, en
// lecture seule une fois l'app packagée — créer/dupliquer/supprimer un
// thème depuis le tableau de bord y échouait toujours. Les thèmes créés
// par l'utilisateur sont donc écrits dans <userData>/themes, et lus en
// priorité sur ceux livrés avec l'app. Sans setUserDataDir() (tests,
// standalone), le comportement historique est conservé.
let userThemesDir = null;

/** @param {string} dir - app.getPath('userData') côté Electron */
function setUserDataDir(dir) {
  userThemesDir = dir ? path.join(dir, 'themes') : null;
  featuresStore.setUserDataDir(dir);
}

/** Dossier où écrire un thème utilisateur (userData si dispo, sinon app). */
function writableThemesDir() {
  if (!userThemesDir) return THEMES_DIR;
  fs.mkdirSync(userThemesDir, { recursive: true });
  return userThemesDir;
}

/** Chemin du fichier d'un thème, thèmes utilisateur prioritaires. */
function themeFile(themeId) {
  if (userThemesDir) {
    const userPath = path.join(userThemesDir, `${themeId}.json`);
    if (fs.existsSync(userPath)) return userPath;
  }
  return path.join(THEMES_DIR, `${themeId}.json`);
}

function themeExists(themeId) {
  return fs.existsSync(themeFile(themeId));
}

function listThemeIds() {
  const ids = new Set();
  for (const dir of [THEMES_DIR, userThemesDir].filter(Boolean)) {
    let entries;
    try {
      entries = fs.readdirSync(dir);
    } catch (_) {
      continue; // dossier utilisateur pas encore créé
    }
    for (const f of entries) {
      if (f.endsWith('.json')) ids.add(f.replace(/\.json$/, ''));
    }
  }
  return [...ids];
}

/**
 * Charge un thème depuis JSON et retourne les CSS variables à injecter.
 * Aucun template imposé : chaque champ est utilisé UNIQUEMENT s'il est
 * défini dans le JSON. Les valeurs absentes retombent sur le thème par
 * défaut (nuit) au moment de la conversion CSS (voir themeToCss).
 */
function loadTheme(themeId) {
  const file = themeFile(themeId);
  if (!fs.existsSync(file)) {
    throw new Error(`Thème introuvable : ${themeId}`);
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function listThemes() {
  return listThemeIds().map((id) => {
    const t = loadTheme(id);
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
  const existing = themeExists(theme.id) ? loadTheme(theme.id) : null;
  if (existing && existing.readonly) {
    throw new Error(
      `Le thème par défaut (${theme.id}) est en lecture seule et ne peut pas être écrasé.`
    );
  }
  const file = path.join(writableThemesDir(), `${theme.id}.json`);
  writeJsonAtomic(file, theme);
}

function deleteTheme(themeId) {
  const theme = loadTheme(themeId);
  if (theme.readonly) {
    throw new Error(`Le thème par défaut (${themeId}) ne peut pas être supprimé.`);
  }
  fs.unlinkSync(themeFile(themeId));
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
  if (themeExists(newId)) {
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
  const features = featuresStore.readFeatures();
  const id = features.design && features.design.activeTheme;
  if (id && themeExists(id)) return id;
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
  const features = featuresStore.readFeatures();
  features.design = features.design || {};
  features.design.activeTheme = themeId;
  featuresStore.writeFeatures(features);
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
    const stops = bg.stops.map((s) => `${s.color} ${s.position}%`).join(', ');
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
      '--reference-color':
        c.reference || c.accentBright || fc.reference || fc.accentBright || '#F4E3A6',
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
  setUserDataDir, // AJOUT (audit round 5) : thèmes/config inscriptibles hors app.asar
  loadTheme,
  listThemes,
  saveTheme,
  deleteTheme,
  duplicateTheme,
  getActiveTheme,
  setActiveTheme,
  themeToCss,
};
