'use strict';
const fs = require('fs');
const path = require('path');

const THEMES_DIR = path.join(__dirname, 'config', 'themes');

/**
 * Charge un thème depuis JSON et retourne les CSS variables à injecter.
 * Aucun template imposé : chaque champ est utilisé UNIQUEMENT s'il est
 * défini dans le JSON. Les valeurs absentes retombent sur mesev-default.
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
  if (!theme.id || !/^[a-z0-9-_]+$/i.test(theme.id)) {
    throw new Error('ID de thème invalide (a-z, 0-9, -, _ uniquement)');
  }
  const file = path.join(THEMES_DIR, `${theme.id}.json`);
  fs.writeFileSync(file, JSON.stringify(theme, null, 2), 'utf8');
}

function deleteTheme(themeId) {
  if (themeId === 'mesev-default') {
    throw new Error('Le thème par défaut ne peut pas être supprimé.');
  }
  fs.unlinkSync(path.join(THEMES_DIR, `${themeId}.json`));
}

/**
 * Convertit un thème JSON en CSS variables + règles pour l'overlay.
 * Renvoyé au navigateur via WebSocket lors du changement de thème.
 */
function themeToCss(theme) {
  const c = theme.colors || {};
  const bg = c.background || {};
  let bgCss = 'transparent';
  if (bg.type === 'gradient' && Array.isArray(bg.stops)) {
    const stops = bg.stops.map(s => `${s.color} ${s.position}%`).join(', ');
    bgCss = `linear-gradient(${bg.angle || 165}deg, ${stops})`;
  } else if (bg.type === 'solid') {
    bgCss = bg.color;
  } else if (bg.type === 'image' && theme.backgroundImage?.source) {
    bgCss = `url("${theme.backgroundImage.source}") center/cover`;
  }

  return {
    variables: {
      '--bg': bgCss,
      '--accent': c.accent || '#D9BB6C',
      '--accent-bright': c.accentBright || '#F4E3A6',
      '--text': c.text || '#FFFFFF',
      '--reference-color': c.reference || c.accentBright || '#F4E3A6',
      '--verse-font': theme.typography?.verseFontFamily || 'Merriweather',
      '--verse-size': theme.typography?.verseFontSize || 'clamp(2.4rem, 4.6vw, 5.2rem)',
      '--verse-weight': theme.typography?.verseFontWeight || 700,
      '--ref-font': theme.typography?.referenceFontFamily || 'Manrope',
      '--ref-spacing': theme.typography?.referenceLetterSpacing || '0.14em',
      '--border-radius': theme.effects?.borderRadius || '28px',
      '--blur': theme.effects?.blurBackdrop || '26px',
    },
    effects: theme.effects || {},
    animations: theme.animations || {},
    background: theme.backgroundImage || {},
  };
}

module.exports = { loadTheme, listThemes, saveTheme, deleteTheme, themeToCss };
