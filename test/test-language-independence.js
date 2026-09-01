/**
 * ============================================================================
 *  test-language-independence.js — transcriptionLanguage × displayLanguage
 * ----------------------------------------------------------------------------
 *  AJOUT (support bilingue FR/EN, lot 14 — clôture du plan) : preuve
 *  automatisée, bout en bout, de la règle centrale du cahier des charges
 *  bilingue — transcriptionLanguage (ce que le prédicateur parle,
 *  décodé par l'ASR) et displayLanguage (ce qui est affiché à l'écran) sont
 *  COMPLÈTEMENT INDÉPENDANTS et ne doivent JAMAIS se coupler silencieusement.
 *
 *  Scénarios nommés du cahier des charges :
 *    - Sermon EN + affichage bilingue : le prédicateur parle anglais, mais
 *      l'affichage doit quand même montrer FR + EN (text_fr ET text_en).
 *    - Sermon FR + affichage EN seul : le prédicateur parle français, mais
 *      l'affichage reste en anglais SEUL (text_en, text_fr à null) — la
 *      langue de sermon ne "fuit" jamais vers l'affichage.
 *
 *  Même approche que integration-quote-match.js/integration-session-stats.js :
 *  server.js tourne réellement (détection bilingue RÉELLE, voir
 *  bilingual-matcher.js du lot 11b), seuls le réseau (API biblique, Groq) et
 *  le micro sont mockés — au niveau groq-wrapper.js (ASR) et
 *  bible-lookup-with-api.js (getVerseMultilang), pas à celui de
 *  detector-compat.js : la vraie détection FR/EN doit rester dans la boucle.
 *
 *  Complété par un CONTRÔLE STATIQUE (grep sur le code source, pas
 *  d'exécution) : aucun chemin de code déclenché par
 *  setTranscriptionLanguage n'appelle sessionState.setDisplayLanguage, et
 *  inversement — la garantie structurelle derrière ce test comportemental.
 * ============================================================================
 */
'use strict';
const fs = require('fs');
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

// ── Contrôle statique (aucune exécution) : le code source lui-même garantit
// la séparation, pas seulement le comportement observé au runtime. ──
function staticCouplingCheck() {
  const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

  const voiceHandlerMatch = serverSrc.match(
    /case 'setTranscriptionLanguage':\s*\{[\s\S]*?\n\s*break;\s*\n\s*\}/
  );
  assert.ok(voiceHandlerMatch, "case 'setTranscriptionLanguage' introuvable dans server.js");
  assert.ok(
    !voiceHandlerMatch[0].includes('setDisplayLanguage'),
    'le handler setTranscriptionLanguage ne doit JAMAIS appeler sessionState.setDisplayLanguage'
  );

  const voiceLangMatch = serverSrc.match(/case 'setLanguage':\s*\{[\s\S]*?\n\s*break;\s*\n\s*\}/);
  assert.ok(voiceLangMatch, "case 'setLanguage' introuvable dans server.js");
  assert.ok(
    !voiceLangMatch[0].includes('setTranscriptionLanguage'),
    'le handler setLanguage (affichage) ne doit JAMAIS appeler sessionState.setTranscriptionLanguage'
  );

  // CORRECTIF (Phase 2 — modularisation du dispatch WS) : le handler WS
  // manuel 'setLanguage' a été extrait vers core-verse-ws-handlers.js (même
  // chantier que media-ws-handlers.js), avec une forme syntaxique différente
  // (handlers.set('setLanguage', async (...) => {...}) plutôt qu'un
  // `if (sanitized.action === ...) {...}` inline) — le contrôle statique
  // porte donc maintenant sur ce fichier, pas server.js, avec un motif
  // adapté à cette forme.
  const coreVerseSrc = fs.readFileSync(
    path.join(__dirname, '..', 'core-verse-ws-handlers.js'),
    'utf8'
  );
  const manualLangMatch = coreVerseSrc.match(
    /handlers\.set\('setLanguage',\s*async[\s\S]*?\n {2}\}\);/
  );
  assert.ok(
    manualLangMatch,
    "handler WS manuel 'setLanguage' introuvable dans core-verse-ws-handlers.js"
  );
  assert.ok(
    !manualLangMatch[0].includes('setTranscriptionLanguage'),
    'le handler WS manuel setLanguage ne doit JAMAIS appeler sessionState.setTranscriptionLanguage'
  );
}

// ── Fixtures réseau (mockées) — getVerseMultilang reflète FIDÈLEMENT le
// langMode qu'on lui passe, pour prouver que c'est bien sessionState
// .getDisplayLanguage() (pas la langue du sermon) qui pilote ce paramètre. ──
const getVerseMultilangCalls = [];
injectFakeModule('bible-lookup-with-api.js', {
  async getChapterVerses() {
    throw new Error('non utilisé dans ce test');
  },
  async getVerseMultilang(reference, langMode) {
    getVerseMultilangCalls.push({ reference: { ...reference }, langMode });
    if (langMode === 'both') {
      return {
        reference: 'Jean 3:16 · John 3:16',
        text: 'Car Dieu a tant aime le monde (FR)',
        text_fr: 'Car Dieu a tant aime le monde (FR)',
        text_en: 'For God so loved the world (EN)',
        langMode: 'both',
        provider: 'fake-provider',
      };
    }
    if (langMode === 'en') {
      return {
        reference: 'John 3:16',
        text: 'For God so loved the world (EN)',
        text_fr: null,
        text_en: 'For God so loved the world (EN)',
        langMode: 'en',
        provider: 'fake-provider',
      };
    }
    return {
      reference: 'Jean 3:16',
      text: 'Car Dieu a tant aime le monde (FR)',
      text_fr: 'Car Dieu a tant aime le monde (FR)',
      text_en: null,
      langMode: 'fr',
      provider: 'fake-provider',
    };
  },
  buildReferenceLabel(reference, lang) {
    return lang === 'en' ? `John ${reference.chapter}` : `Jean ${reference.chapter}`;
  },
  resetFailedProviders() {},
  findByQuotedText() {
    return null; // non utilisé dans ce test — on passe par la détection de référence explicite
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

const transcriptQueue = [];
injectFakeModule('groq-wrapper.js', {
  async transcribeFile() {
    throw new Error('non utilisé dans ce test');
  },
  async transcribeWithFallback() {
    return { text: transcriptQueue.shift() || '', source: 'fake-groq' };
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

let onAudioSegment = null;
injectFakeModule('audio-capture.js', {
  startBrowserCapture() {},
  feedPcmChunk() {},
  stopRecording() {},
  cleanupTempFiles() {},
  isRecording() {
    return false;
  },
  on(callbacks) {
    onAudioSegment = callbacks.onAudioSegment;
  },
});

process.env.PORT = process.env.PORT || '8768'; // distinct des autres tests
process.env.CHURCHOVERLAY_SKIP_BIBLE_DOWNLOAD = '1'; // pas de téléchargement biblique en test (crash libuv à l'arrêt sinon)
require('../server.js');
const sessionState = require('../session-state');

const WebSocket = require('ws');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function simulateSegment(text) {
  transcriptQueue.push(text);
  await onAudioSegment(`/tmp/fake-lang-independence-${Date.now()}-${Math.random()}.wav`);
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

  console.log(
    '\n=== Contrôle statique : aucun couplage transcriptionLanguage/displayLanguage ===\n'
  );
  try {
    staticCouplingCheck();
    check('aucun couplage détecté dans le code source de server.js', true);
  } catch (err) {
    check('aucun couplage détecté dans le code source de server.js', false, err.message);
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

  console.log('\n=== Scénario 1 : sermon en ANGLAIS + affichage BILINGUE ===\n');
  sessionState.setTranscriptionLanguage('en');
  sessionState.setDisplayLanguage('both');
  check(
    'état de session : transcriptionLanguage=en, displayLanguage=both',
    sessionState.getTranscriptionLanguage() === 'en' && sessionState.getDisplayLanguage() === 'both'
  );

  received.length = 0;
  getVerseMultilangCalls.length = 0;
  await simulateSegment('John chapter 3 verse 16');
  await sleep(400);

  const shown1 = received.find((m) => m.action === 'showVerse');
  check(
    "la référence anglaise ('John chapter 3 verse 16') est bien détectée malgré displayLanguage=both",
    !!shown1,
    JSON.stringify(shown1)
  );
  check(
    "getVerseMultilang a été appelé avec langMode='both' (sessionState.getDisplayLanguage(), PAS la langue du sermon)",
    getVerseMultilangCalls.length > 0 && getVerseMultilangCalls[0].langMode === 'both',
    JSON.stringify(getVerseMultilangCalls)
  );
  check(
    "l'affichage contient TEXTE FR ET TEXTE EN (bilingue), bien que le sermon soit en anglais",
    !!shown1 && !!shown1.text_fr && !!shown1.text_en,
    JSON.stringify(shown1)
  );

  console.log('\n=== Scénario 2 : sermon en FRANÇAIS + affichage ANGLAIS SEUL ===\n');
  sessionState.setTranscriptionLanguage('fr');
  sessionState.setDisplayLanguage('en');
  check(
    'état de session : transcriptionLanguage=fr, displayLanguage=en',
    sessionState.getTranscriptionLanguage() === 'fr' && sessionState.getDisplayLanguage() === 'en'
  );

  received.length = 0;
  getVerseMultilangCalls.length = 0;
  // Référence DIFFÉRENTE du scénario 1 (Jean 3:16) — sinon la suppression de
  // doublon de server.js (fenêtre de 30s sur le même book:chapter:verse)
  // empêcherait ce second verset de s'afficher, indépendamment de tout
  // couplage transcriptionLanguage/displayLanguage.
  await simulateSegment('Romains chapitre 8 verset 28');
  await sleep(400);

  const shown2 = received.find((m) => m.action === 'showVerse');
  check(
    "la référence française ('Romains chapitre 8 verset 28') est bien détectée malgré displayLanguage=en",
    !!shown2,
    JSON.stringify(shown2)
  );
  check(
    "getVerseMultilang a été appelé avec langMode='en' (sessionState.getDisplayLanguage(), PAS la langue du sermon 'fr')",
    getVerseMultilangCalls.length > 0 && getVerseMultilangCalls[0].langMode === 'en',
    JSON.stringify(getVerseMultilangCalls)
  );
  check(
    "l'affichage reste EN SEUL (text_en peuplé, text_fr à null) bien que le sermon soit en français",
    !!shown2 && !!shown2.text_en && !shown2.text_fr,
    JSON.stringify(shown2)
  );

  console.log(
    '\n=== Scénario 3 : changement de displayLanguage ne modifie JAMAIS transcriptionLanguage (et inversement) ===\n'
  );
  sessionState.setTranscriptionLanguage('en');
  sessionState.setDisplayLanguage('fr');
  check(
    "displayLanguage réglé sur 'fr' sans toucher transcriptionLanguage (resté 'en')",
    sessionState.getDisplayLanguage() === 'fr' && sessionState.getTranscriptionLanguage() === 'en'
  );
  sessionState.setDisplayLanguage('both');
  sessionState.setTranscriptionLanguage('fr');
  check(
    "transcriptionLanguage réglé sur 'fr' sans toucher displayLanguage (resté 'both')",
    sessionState.getTranscriptionLanguage() === 'fr' && sessionState.getDisplayLanguage() === 'both'
  );

  // Nettoyage — ne pas laisser fuiter d'état vers d'autres processus de test.
  sessionState.setTranscriptionLanguage(null);
  sessionState.setDisplayLanguage('fr');

  ws.close();
  console.log(
    `\n=== Résultat indépendance transcriptionLanguage/displayLanguage : ${passed} passés, ${failed} échoués ===`
  );
  process.exit(failed > 0 ? 1 : 0);
})().catch((err) => {
  console.error("Erreur fatale dans le test d'intégration:", err);
  process.exit(1);
});
