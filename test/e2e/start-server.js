/**
 * test/e2e/start-server.js — démarre server.js pour de vrai (mêmes modules
 * fictifs que test/test-ws-auth.js et test/integration-reading-mode-live.js :
 * seuls le réseau — API bibliques, Groq/Deepgram — et le micro sont mockés,
 * server.js/detector.js/reading-mode.js tournent sans aucune modification).
 *
 * Lancé par Playwright via `webServer.command` dans playwright.config.js —
 * pas un test en soi, juste le bootstrap réutilisé par tous les specs de
 * test/e2e/. WS_AUTH_TOKEN volontairement non défini : dashboard.html
 * n'a alors besoin d'aucun ?token= dans l'URL de test (comportement par
 * défaut pour un opérateur qui n'a pas configuré l'authentification).
 */
'use strict';
const path = require('path');
const Module = require('module');

function injectFakeModule(relativePath, exportsObj) {
  const abs = require.resolve(path.join(__dirname, '..', '..', relativePath));
  const fake = new Module(abs, null);
  fake.filename = abs;
  fake.loaded = true;
  fake.exports = exportsObj;
  require.cache[abs] = fake;
  return abs;
}

injectFakeModule('bible-lookup-with-api.js', {
  async getChapterVerses() {
    throw new Error('non utilisé dans ce test');
  },
  // CORRECTIF (débogage e2e) : l'action WS directe 'showVerse' (server.js)
  // n'échotoie pas simplement le payload reçu — elle reparse la référence
  // et appelle CE lookup pour le vrai texte, quel que soit ce que le
  // client a envoyé. Utilisé par plusieurs parcours e2e (clic "afficher
  // maintenant" de la recherche par thème, simulation showVerse directe) :
  // un texte factice générique suffit, le contenu biblique réel n'est pas
  // ce qui est testé ici.
  async getVerseMultilang(reference, langMode) {
    return {
      reference: this.buildReferenceLabel(reference),
      text: 'Texte de verset factice (e2e).',
      text_fr: 'Texte de verset factice (e2e).',
      text_en: null,
      langMode,
    };
  },
  buildReferenceLabel(reference) {
    // detector.parseReference() normalise le nom du livre en minuscules
    // ("jean", pas "Jean") — recapitalisé ici pour que le libellé affiché
    // ressemble à ce que produit le vrai bibleLookup en usage normal.
    const book = String(reference.book || '');
    const capitalized = book.charAt(0).toUpperCase() + book.slice(1);
    return `${capitalized} ${reference.chapter}:${reference.verseStart || 1}`;
  },
  resetFailedProviders() {},
  findByQuotedText() {
    return null;
  },
  setCacheDir() {},
  setTranslation() {},
  listTranslations() {
    return [];
  },
  getTranslationId() {
    return 'lsg';
  },
  getCacheSize() {
    return 0;
  },
  clearCache() {},
  getProviders() {
    return ['fake-provider'];
  },
});

injectFakeModule('groq-wrapper.js', {
  async transcribeFile() {
    throw new Error('non utilisé dans ce test');
  },
  async transcribeWithFallback() {
    return { text: '', source: 'fake-groq' };
  },
});

injectFakeModule('deepgram-wrapper.js', {
  isConfigured() {
    return false;
  },
  async transcribeFile() {
    throw new Error('non utilisé dans ce test');
  },
});

injectFakeModule('audio-capture.js', {
  startBrowserCapture() {},
  feedPcmChunk() {},
  stopRecording() {},
  cleanupTempFiles() {},
  isRecording() {
    return false;
  },
  on() {},
});

process.env.PORT = process.env.PORT || '8770'; // distinct des ports déjà utilisés par test/*.js
process.env.WS_HOST = '127.0.0.1';

require('../../server.js');
