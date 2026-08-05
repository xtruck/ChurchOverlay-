'use strict';
/**
 * ai-modules-loader.js — Chargement et câblage des modules IA optionnels
 *
 * Extrait de server.js (chantier de découpage du 2026-08-05) : ce bloc ne
 * dépend d'aucun état de session mutable (displayLanguage, verseHistory,
 * etc.), il se contente de require() chaque module IA optionnel et de le
 * construire, en continuant proprement (mode dégradé) si un module manque
 * ou échoue à charger. Comportement identique à l'original — aucun
 * changement de logique, seulement un déplacement de code.
 *
 * @param {object} opts
 * @param {object} opts.groq - le wrapper groq-wrapper.js déjà chargé
 * @param {string} opts.appRoot - APP_ROOT, pour localiser config/plugins
 * @returns {{
 *   semanticDetector: object|null,
 *   detectCommand: Function|null,
 *   corrector: object|null,
 *   semanticSearch: object|null,
 *   plugins: object|null,
 *   themeGenerator: object|null,
 *   aiEnricher: object|null,
 *   aiLoadErrors: string[],
 *   groqHasChatCompletion: boolean,
 * }}
 */
function loadAIModules({ groq, appRoot }) {
  const path = require('path');
  const fs = require('fs');

  let semanticDetector = null;
  let detectCommand = null;
  let corrector = null;
  let semanticSearch = null;
  let plugins = null;
  let themeGenerator = null;
  let aiEnricher = null;

  const aiLoadErrors = [];
  const groqHasChatCompletion = typeof groq.chatCompletion === 'function';

  try {
    const { SemanticDetector } = require('./semantic-detector');
    if (groqHasChatCompletion) {
      semanticDetector = new SemanticDetector(groq);
      console.log('[server] ✓ SemanticDetector loaded');
    } else {
      aiLoadErrors.push('SemanticDetector: groq.chatCompletion not available');
    }
  } catch (e) {
    aiLoadErrors.push('SemanticDetector: ' + e.message);
    console.warn('[server] SemanticDetector disabled:', e.message);
  }

  try {
    const mod = require('./voice-commands');
    detectCommand = mod.detectCommand;
    console.log('[server] ✓ Voice commands loaded');
  } catch (e) {
    aiLoadErrors.push('VoiceCommands: ' + e.message);
    console.warn('[server] Voice commands disabled:', e.message);
  }

  try {
    const { TranscriptionCorrector } = require('./transcription-corrector');
    if (groqHasChatCompletion) {
      corrector = new TranscriptionCorrector(groq);
      console.log('[server] ✓ TranscriptionCorrector loaded');
    } else {
      aiLoadErrors.push(
        'TranscriptionCorrector: groq.chatCompletion not available (tests use mock)'
      );
      corrector = new TranscriptionCorrector(null);
      console.log('[server] ✓ TranscriptionCorrector loaded (fast mode only)');
    }
  } catch (e) {
    aiLoadErrors.push('TranscriptionCorrector: ' + e.message);
    console.warn('[server] TranscriptionCorrector disabled:', e.message);
  }

  try {
    const { BibleSemanticSearch } = require('./bible-semantic-search');
    semanticSearch = new BibleSemanticSearch();
    semanticSearch.loadIndex().catch(() => {});
    console.log('[server] ✓ BibleSemanticSearch loaded');
  } catch (e) {
    aiLoadErrors.push('BibleSemanticSearch: ' + e.message);
    console.warn('[server] BibleSemanticSearch disabled:', e.message);
  }

  try {
    const { PluginSystem } = require('./plugin-system');
    plugins = new PluginSystem();
    const pluginsDir = path.join(appRoot, 'config', 'plugins');
    if (fs.existsSync(pluginsDir)) {
      plugins.loadFromDirectory(pluginsDir);
    }
    console.log('[server] ✓ PluginSystem loaded');
  } catch (e) {
    aiLoadErrors.push('PluginSystem: ' + e.message);
    console.warn('[server] PluginSystem disabled:', e.message);
  }

  try {
    const { AIThemeGenerator } = require('./ai-theme-generator');
    if (groqHasChatCompletion) {
      themeGenerator = new AIThemeGenerator(groq);
      console.log('[server] ✓ AIThemeGenerator loaded');
    } else {
      themeGenerator = new AIThemeGenerator(null);
      console.log('[server] ✓ AIThemeGenerator loaded (rule-based only)');
    }
  } catch (e) {
    aiLoadErrors.push('AIThemeGenerator: ' + e.message);
    console.warn('[server] AIThemeGenerator disabled:', e.message);
  }

  try {
    aiEnricher = require('./ai-enricher');
    console.log('[server] ✓ AI Enricher loaded');
  } catch (e) {
    aiLoadErrors.push('AIEnricher: ' + e.message);
    console.warn('[server] AIEnricher disabled:', e.message);
  }

  if (aiLoadErrors.length > 0) {
    console.log('[server] ⚠ ' + aiLoadErrors.length + ' AI feature(s) in limited mode.');
  }

  return {
    semanticDetector,
    detectCommand,
    corrector,
    semanticSearch,
    plugins,
    themeGenerator,
    aiEnricher,
    aiLoadErrors,
    groqHasChatCompletion,
  };
}

module.exports = { loadAIModules };
