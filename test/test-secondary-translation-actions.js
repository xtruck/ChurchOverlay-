/**
 * ============================================================================
 *  test-secondary-translation-actions.js — Actions WS "Multi-Bible côte à
 *  côte" (setSecondaryTranslation + showVerse)
 * ----------------------------------------------------------------------------
 *  server.js tourne réellement (comme test-rundown-actions.js), avec le VRAI
 *  session-state.js. bible-lookup-with-api.js est mocké — sa vraie logique
 *  (résolution de traduction par couple lang/code, concurrence LSG+Darby) est
 *  déjà verrouillée séparément par test-bible-lookup-dual-translation.js ;
 *  ce test-ci vérifie uniquement le CÂBLAGE server.js : validation du réglage
 *  contre listTranslations(), diffusion secondaryTranslationChanged, et
 *  l'attachement de secondaryText/secondaryLabel à showVerse quand une
 *  traduction secondaire est active — jamais en mode d'affichage 'both'.
 * ============================================================================
 */
'use strict';
const path = require('path');
const Module = require('module');
const assert = require('assert');

function injectFakeModule(relativePath, exportsObj) {
  const abs = require.resolve(path.join(__dirname, '..', relativePath));
  const fake = new Module(abs, null);
  fake.filename = abs;
  fake.loaded = true;
  fake.exports = exportsObj;
  require.cache[abs] = fake;
  return abs;
}

const FAKE_TRANSLATIONS = {
  fr: [
    { code: 'lsg', label: 'Louis Segond 1910', license: 'Domaine public', active: true },
    { code: 'darby', label: 'Darby', license: 'Domaine public', active: false },
  ],
  en: [{ code: 'kjv', label: 'King James Version', license: 'Domaine public', active: true }],
};

injectFakeModule('bible-lookup-with-api.js', {
  async getChapterVerses() {
    throw new Error('non utilisé dans ce test');
  },
  async getVerseMultilang(reference, langMode) {
    return {
      reference: `${reference.book} ${reference.chapter}:${reference.verseStart || 1}`,
      text: 'Texte factice (LSG mock)',
      text_fr: langMode === 'fr' || langMode === 'both' ? 'Texte factice (LSG mock)' : null,
      text_en: langMode === 'en' || langMode === 'both' ? 'Fake text (KJV mock)' : null,
      langMode,
    };
  },
  async getVerseDualTranslation(_reference, _primary, secondary) {
    return {
      reference: 'Jean 3:16',
      primary: {
        lang: _primary.lang,
        code: _primary.code,
        label: 'Louis Segond 1910',
        text: 'Texte factice (LSG mock)',
      },
      secondary: {
        lang: secondary.lang,
        code: secondary.code,
        label: secondary.lang === 'fr' ? 'Darby' : 'King James Version',
        text: 'Texte factice (traduction secondaire mock)',
      },
    };
  },
  listTranslations() {
    return FAKE_TRANSLATIONS;
  },
  buildReferenceLabel(reference) {
    return `${reference.book} ${reference.chapter}`;
  },
  resetFailedProviders() {},
  findByQuotedText() {
    return null;
  },
  setCacheDir() {},
  setTranslation() {
    return 'fra_lsg';
  },
  getTranslationId() {
    return 'fra_lsg';
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

process.env.PORT = process.env.PORT || '8778'; // distinct des autres tests
process.env.CHURCHOVERLAY_SKIP_BIBLE_DOWNLOAD = '1';
require('../server.js');
const sessionState = require('../session-state');

const WebSocket = require('ws');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

(async () => {
  let passed = 0,
    failed = 0;
  function check(name, cond, detail) {
    if (cond) {
      console.log(`✅ ${name}`);
      passed++;
    } else {
      console.log(`❌ ${name}${detail ? ' — ' + detail : ''}`);
      failed++;
    }
  }

  await sleep(300);

  const ws = new WebSocket(`ws://127.0.0.1:${process.env.PORT}`);
  const received = [];
  await new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });
  ws.on('message', (raw) => {
    try {
      received.push(JSON.parse(raw.toString()));
    } catch (_) {}
  });

  function waitForAction(action, timeoutMs = 1500) {
    const start = Date.now();
    return new Promise((resolve, reject) => {
      const check = () => {
        const found = received.find((m) => m.action === action);
        if (found) return resolve(found);
        if (Date.now() - start > timeoutMs) return reject(new Error(`timeout: ${action}`));
        setTimeout(check, 20);
      };
      check();
    });
  }

  try {
    console.log('\n=== Scénario : aucune traduction secondaire par défaut ===\n');
    assert.strictEqual(sessionState.getSecondaryTranslation(), null);
    console.log('✅ getSecondaryTranslation() === null au départ');
    passed++;

    console.log(
      '\n=== Scénario : setSecondaryTranslation() sur un code inconnu renvoie une erreur ===\n'
    );
    received.length = 0;
    ws.send(JSON.stringify({ action: 'setSecondaryTranslation', lang: 'fr', code: 'nope' }));
    await sleep(300);
    check(
      "un message d'erreur est renvoyé pour un code inconnu",
      received.some((m) => m.action === 'error')
    );
    check(
      'sessionState non modifié après un réglage invalide',
      sessionState.getSecondaryTranslation() === null
    );

    console.log('\n=== Scénario : setSecondaryTranslation() valide, diffuse et persiste ===\n');
    received.length = 0;
    ws.send(JSON.stringify({ action: 'setSecondaryTranslation', lang: 'fr', code: 'darby' }));
    const changedMsg = await waitForAction('secondaryTranslationChanged');
    check(
      'secondaryTranslationChanged diffusé avec lang/code corrects',
      changedMsg.lang === 'fr' && changedMsg.code === 'darby'
    );
    check(
      'sessionState reflète bien le réglage',
      JSON.stringify(sessionState.getSecondaryTranslation()) ===
        JSON.stringify({ lang: 'fr', code: 'darby' })
    );

    console.log(
      '\n=== Scénario : showVerse() attache secondaryText quand une traduction secondaire est active ===\n'
    );
    received.length = 0;
    ws.send(JSON.stringify({ action: 'showVerse', reference: 'Jean 3:16', text: 'placeholder' }));
    const showMsg = await waitForAction('showVerse');
    check(
      'secondaryText attaché à la diffusion showVerse',
      showMsg.secondaryText === 'Texte factice (traduction secondaire mock)'
    );
    check('secondaryLabel attaché', showMsg.secondaryLabel === 'Darby');
    check('secondaryLang attaché', showMsg.secondaryLang === 'fr');

    console.log(
      '\n=== Scénario : setSecondaryTranslation() sans lang/code désactive la comparaison ===\n'
    );
    received.length = 0;
    ws.send(JSON.stringify({ action: 'setSecondaryTranslation' }));
    const clearedMsg = await waitForAction('secondaryTranslationChanged');
    check(
      'secondaryTranslationChanged diffusé avec lang=null/code=null',
      clearedMsg.lang === null && clearedMsg.code === null
    );
    check(
      'sessionState.getSecondaryTranslation() === null après désactivation',
      sessionState.getSecondaryTranslation() === null
    );

    console.log(
      '\n=== Scénario : showVerse() ne ré-attache PAS secondaryText une fois désactivé ===\n'
    );
    received.length = 0;
    ws.send(JSON.stringify({ action: 'showVerse', reference: 'Jean 3:16', text: 'placeholder' }));
    const showMsg2 = await waitForAction('showVerse');
    check(
      'secondaryText absent une fois la comparaison désactivée',
      showMsg2.secondaryText === undefined
    );

    console.log(
      "\n=== Scénario : mode d'affichage 'both' n'attache jamais secondaryText, même réactivé ===\n"
    );
    ws.send(JSON.stringify({ action: 'setSecondaryTranslation', lang: 'fr', code: 'darby' }));
    await waitForAction('secondaryTranslationChanged');
    ws.send(JSON.stringify({ action: 'setLanguage', language: 'both' }));
    await sleep(200);
    received.length = 0;
    ws.send(JSON.stringify({ action: 'showVerse', reference: 'Jean 3:16', text: 'placeholder' }));
    const showMsg3 = await waitForAction('showVerse');
    check(
      "secondaryText absent en mode 'both' (déjà 2 textes, pas de 3e)",
      showMsg3.secondaryText === undefined
    );
    check(
      'text_fr/text_en toujours présents en mode both',
      !!showMsg3.text_fr && !!showMsg3.text_en
    );
  } finally {
    sessionState.setSecondaryTranslation(null, null);
    sessionState.setDisplayLanguage('fr');
    ws.close();
  }

  console.log(
    `\n=== Résultat actions traduction secondaire : ${passed} passés, ${failed} échoués ===`
  );
  process.exit(failed > 0 ? 1 : 0);
})().catch((err) => {
  console.error("Erreur fatale dans le test d'intégration:", err);
  process.exit(1);
});
