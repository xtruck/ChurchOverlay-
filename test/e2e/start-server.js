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

// Utilisé par le sélecteur de version biblique (translation-picker.js) —
// mêmes champs (code/label/active) et mêmes langues que
// AVAILABLE_TRANSLATIONS dans le vrai bible-lookup-with-api.js, en
// miniature. Mutable par setTranslation() ci-dessous, comme la vraie
// implémentation.
const FAKE_TRANSLATIONS = {
  fr: [
    { code: 'lsg', label: 'Louis Segond 1910', active: true },
    { code: 'darby', label: 'Darby', active: false },
  ],
  en: [
    { code: 'kjv', label: 'King James Version', active: true },
    { code: 'web', label: 'World English Bible (moderne)', active: false },
  ],
};

// Chapitre factice pour le mode lecture (readingMode.getChapterVerses ->
// bibleLookup.getChapterVersesMultilang côté server.js), même contenu que
// test/test-reading-mode-ws-actions.js.
const FAKE_JEAN_3 = [
  { num: 1, text: 'Il y avait parmi les pharisiens un homme nomme Nicodeme.' },
  { num: 2, text: 'Cet homme vint de nuit trouver Jesus.' },
  { num: 3, text: 'Jesus lui repondit en verite en verite je te le dis.' },
];

injectFakeModule('bible-lookup-with-api.js', {
  async getChapterVerses() {
    throw new Error('non utilisé dans ce test');
  },
  async getChapterVersesMultilang(book, chapter) {
    // Voir buildReferenceLabel plus bas : detector.parseReference()
    // normalise le nom du livre en minuscules.
    if (String(book).toLowerCase() === 'jean' && chapter === 3) return FAKE_JEAN_3;
    return [];
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
  // AJOUT (Multi-Bible côte à côte, e2e) : utilisé par showVerse (server.js)
  // quand une traduction secondaire est configurée — même discipline que
  // getVerseMultilang ci-dessus, un texte factice générique suffit.
  async getVerseDualTranslation(reference, primary, secondary) {
    const label =
      FAKE_TRANSLATIONS[secondary.lang]?.find((t) => t.code === secondary.code)?.label ||
      secondary.code;
    return {
      reference: this.buildReferenceLabel(reference),
      primary: { ...primary, text: 'Texte de verset factice (e2e).' },
      secondary: { ...secondary, label, text: `Texte secondaire factice (e2e, ${label}).` },
    };
  },
  resetFailedProviders() {},
  findByQuotedText() {
    return null;
  },
  setCacheDir() {},
  setTranslation(lang, code) {
    const list = FAKE_TRANSLATIONS[lang];
    if (!list) throw new Error(`Langue inconnue: ${lang}`);
    if (!list.some((t) => t.code === code)) {
      throw new Error(`Traduction inconnue pour ${lang}: ${code}`);
    }
    list.forEach((t) => {
      t.active = t.code === code;
    });
    return code;
  },
  listTranslations() {
    return FAKE_TRANSLATIONS;
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
// CORRECTIF (débogage e2e) : le limiteur de débit (rate-limiter.js) compte
// par IP cliente — TOUTES les connexions Playwright de TOUTE la suite
// e2e (un seul processus serveur partagé pour tous les fichiers .spec.js,
// voir playwright.config.js > webServer) partagent donc le même quota
// 127.0.0.1, cumulé sur toute la durée de la suite, pas par test. Avec la
// limite par défaut (60/min), un test qui tourne après plusieurs autres
// peut se faire silencieusement rejeter ses messages WS sans qu'aucune
// erreur ne remonte côté page — repéré exactement ainsi (le test de
// sélecteur de version biblique passait seul, échouait dans la suite
// complète). Limite relevée uniquement pour cet environnement de test.
process.env.MAX_MESSAGES_PER_MINUTE = process.env.MAX_MESSAGES_PER_MINUTE || '1000';
process.env.CHURCHOVERLAY_SKIP_BIBLE_DOWNLOAD = '1'; // pas de téléchargement biblique en test (crash libuv à l'arrêt sinon)

require('../../server.js');
