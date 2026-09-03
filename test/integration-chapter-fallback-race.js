/**
 * ============================================================================
 *  integration-chapter-fallback-race.js — Course repli chapitre vs
 *  confirmation opérateur en attente (CORRECTIF)
 * ----------------------------------------------------------------------------
 *  Bug réel signalé en usage réel (mode 'semi-auto') : un fragment "chapitre
 *  seul" ("Jean chapitre 3 verset", tronqué) arme un timer de repli
 *  (scheduleChapterFallback, voir integration-chapter-fallback-delay.js).
 *  Si un verset EXACT du MÊME livre:chapitre est ensuite détecté avant que
 *  le timer expire, il n'était annulé (cancelChapterFallback) qu'à
 *  l'intérieur de finalizeDisplay — qui, en 'semi-auto'/'manual', n'est
 *  appelée qu'APRÈS confirmation opérateur (setPendingVerse). Pendant la
 *  fenêtre d'attente, le timer de repli chapitre pouvait donc encore se
 *  déclencher et afficher le CHAPITRE ENTIER par-dessus le verset en
 *  attente de confirmation — exactement le symptôme rapporté ("il affiche
 *  parfois tout un chapitre").
 *
 *  Ce test prouve que cancelChapterFallback() est désormais appelé dès que
 *  le verset EXACT est connu, pas seulement une fois confirmé : le repli
 *  chapitre ne doit JAMAIS s'afficher une fois qu'un verset précis du même
 *  livre:chapitre est en attente de confirmation, et le verset confirmé
 *  ensuite doit bien être le verset EXACT (pas le chapitre).
 *
 *  Même approche que integration-chapter-fallback-delay.js : server.js
 *  tourne réellement, seuls le réseau (API biblique, Groq), le micro et la
 *  config sont mockés.
 * ============================================================================
 */
'use strict';
const path = require('path');
const Module = require('module');

function injectFakeModule(relativePath, exportsObj) {
  const abs = require.resolve(path.join(__dirname, '..', relativePath));
  const fake = new Module(abs, null);
  fake.filename = abs;
  fake.loaded = true;
  fake.exports = exportsObj;
  require.cache[abs] = fake;
  return abs;
}

// Voir integration-chapter-fallback-delay.js pour le raisonnement complet
// sur ce délai (marge vs vrai aller-retour réseau du corrector, non mocké).
const FALLBACK_DELAY_MS = 300;
injectFakeModule('features-store.js', {
  setUserDataDir() {},
  readFeatures() {
    return { display: { chapterFallbackDelayMs: FALLBACK_DELAY_MS } };
  },
  writeFeatures() {},
  getWritableFile() {
    return null;
  },
});

injectFakeModule('bible-lookup-with-api.js', {
  async getChapterVerses() {
    throw new Error('non utilisé dans ce test');
  },
  async getChapterVersesMultilang() {
    throw new Error('non simulé dans ce test');
  },
  async getVerseMultilang(reference) {
    // Distingue l'appel du repli chapitre (jamais de verseStart) de l'appel
    // du verset EXACT (verseStart défini) — les deux passent par cette
    // même fonction avec le même `reference.book`/`chapter`.
    if (reference.verseStart) {
      return {
        reference: `Jean ${reference.chapter}:${reference.verseStart}`,
        text: 'TEXTE_VERSET_EXACT',
        provider: 'fake',
        lang: 'fr',
        text_fr: 'TEXTE_VERSET_EXACT',
        text_en: null,
        langMode: 'fr',
      };
    }
    return {
      reference: `Jean ${reference.chapter}`,
      text: 'TEXTE_CHAPITRE_ENTIER_VIA_REPLI',
      provider: 'fake',
      lang: 'fr',
      text_fr: 'TEXTE_CHAPITRE_ENTIER_VIA_REPLI',
      text_en: null,
      langMode: 'fr',
    };
  },
  buildReferenceLabel(reference) {
    return reference.verseStart
      ? `Jean ${reference.chapter}:${reference.verseStart}`
      : `Jean ${reference.chapter}`;
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

process.env.PORT = process.env.PORT || '8792'; // distinct des autres tests
process.env.CHURCHOVERLAY_SKIP_BIBLE_DOWNLOAD = '1';
require('../server.js');

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

  console.log(
    '\n=== Scénario : repli chapitre armé, puis verset EXACT détecté avant expiration, en mode semi-auto ===\n'
  );

  ws.send(JSON.stringify({ action: 'setTrustMode', mode: 'semi-auto' }));
  await sleep(50);

  // Étape 1 : fragment "chapitre seul" — arme le timer de repli (voir
  // integration-chapter-fallback-delay.js pour la mécanique exacte).
  ws.send(JSON.stringify({ action: 'transcript', text: 'Jean chapitre 3 verset' }));
  await sleep(50);

  // Étape 2 : un verset EXACT du MÊME livre:chapitre arrive avant que le
  // timer n'expire (300ms) — doit annuler le repli immédiatement, pas
  // seulement après confirmation opérateur.
  ws.send(JSON.stringify({ action: 'transcript', text: 'Jean chapitre 3 verset 16' }));
  await sleep(100);

  const pendingMsg = received.find((m) => m.action === 'pendingVerseConfirmation');
  check(
    'le verset EXACT attend bien confirmation (mode semi-auto)',
    !!pendingMsg,
    JSON.stringify(received.map((m) => m.action))
  );

  // Étape 3 : on laisse largement passer le délai du repli SANS confirmer
  // — le repli chapitre ne doit JAMAIS s'afficher (c'est le bug corrigé).
  await sleep(FALLBACK_DELAY_MS + 2000);
  const chapterFallbackShown = received.find(
    (m) => m.action === 'showVerse' && m.detectedBy === 'chapter-fallback'
  );
  check(
    "le repli chapitre ne s'est PAS déclenché pendant l'attente de confirmation (course corrigée)",
    !chapterFallbackShown,
    JSON.stringify(received.filter((m) => m.action === 'showVerse'))
  );
  // CORRECTIF (trouvé en écrivant ce test — sans lui, le bug passait
  // INAPERÇU de la vérification ci-dessus, voir en-tête) : en 'semi-auto',
  // scheduleChapterFallback() ne diffuse PAS un showVerse immédiat quand il
  // expire — il appelle lui aussi setPendingVerse(), qui REMPLACE
  // silencieusement le verset EXACT déjà en attente (pendingVerse est un
  // singleton globale, "la dernière détection gagne", voir server.js). Le
  // symptôme réel n'est donc pas un showVerse immédiat mais une SECONDE
  // pendingVerseConfirmation pour le CHAPITRE, qui écrase la première.
  const pendingConfirmations = received.filter((m) => m.action === 'pendingVerseConfirmation');
  check(
    'la confirmation en attente reste celle du verset EXACT (pas remplacée par le repli chapitre)',
    pendingConfirmations.length === 1 && pendingConfirmations[0].reference === 'Jean 3:16',
    JSON.stringify(pendingConfirmations)
  );

  // Étape 4 : confirmation opérateur — le verset EXACT (pas le chapitre)
  // doit maintenant s'afficher.
  ws.send(JSON.stringify({ action: 'confirmPendingVerse' }));
  await sleep(150);
  const shown = received.find((m) => m.action === 'showVerse');
  check(
    'après confirmation, le verset EXACT (pas le chapitre) est affiché',
    !!shown && shown.text === 'TEXTE_VERSET_EXACT',
    JSON.stringify(shown)
  );

  ws.close();
  console.log(
    `\n=== Résultat course repli chapitre / confirmation en attente : ${passed} passés, ${failed} échoués ===`
  );
  process.exit(failed > 0 ? 1 : 0);
})().catch((err) => {
  console.error("Erreur fatale dans le test d'intégration:", err);
  process.exit(1);
});
