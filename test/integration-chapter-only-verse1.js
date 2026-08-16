/**
 * ============================================================================
 *  integration-chapter-only-verse1.js — Chapitre seul → repli chapitre, jamais
 *  le verset 1
 * ----------------------------------------------------------------------------
 *  RÉGRESSION COUVERTE (audit) : quand la transcription automatique ne
 *  capture pas de numéro de verset (ex. "Jean chapitre 3" sans "verset X" —
 *  cas fréquent quand la STT rate un mot dans le bruit ambiant), detector.js
 *  retourne une référence "chapitre seul" (verseStart undefined).
 *
 *  RÈGLE MISSION (Chantier A.3) : « quand le numéro de verset n'est pas
 *  identifié avec certitude, ne jamais retomber sur le verset 1 — afficher le
 *  chapitre en repli explicite, ou ne rien afficher ». Le chemin
 *  segment/batch (source absente, ex. ASR Groq) retombait auparavant sur le
 *  verset 1 (ancien displayReference) — corrigé : TOUT chapitre seul issu du
 *  pipeline vocal (segment, partials, finals, saisie dashboard) passe par la
 *  garde « chapitre seul ambigu » → candidateVerse spéculative + repli
 *  chapitre entier après CHAPTER_FALLBACK_MS. Ce test vérifie donc :
 *   1. jamais d'affichage "verset 1" en détection automatique,
 *   2. candidateVerse spéculative diffusée immédiatement,
 *   3. showVerse du CHAPITRE ENTIER après le délai de repli.
 *
 *  La saisie manuelle ("Afficher un Verset") n'est pas couverte ici : elle
 *  passe par l'action WS showVerse (chemin distinct, comportement voulu).
 *
 *  Même approche que integration-quote-match.js : server.js tourne
 *  réellement, seuls le réseau (API biblique, Groq) et le micro sont mockés.
 *  Le mock getVerseMultilang distingue explicitement les deux cas
 *  (verseStart fourni ou non) pour que ce test échoue vraiment si le
 *  correctif est retiré.
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

injectFakeModule('bible-lookup-with-api.js', {
  async getChapterVerses() {
    throw new Error('non utilisé dans ce test');
  },
  async getChapterVersesMultilang() {
    // Le mode lecture n'est pas l'objet de ce test — on le laisse échouer
    // proprement (comportement dégradé déjà couvert par
    // integration-reading-mode-live.js) plutôt que de le simuler ici.
    throw new Error('non simulé dans ce test');
  },
  async getVerseMultilang(reference) {
    // Réplique la distinction réelle de bible-lookup-with-api.js : sans
    // verseStart, un vrai fournisseur renverrait tout le chapitre.
    if (!reference.verseStart) {
      return {
        reference: `Jean ${reference.chapter}`,
        text: 'TEXTE_CHAPITRE_ENTIER',
        provider: 'fake',
        lang: 'fr',
        text_fr: 'TEXTE_CHAPITRE_ENTIER',
        text_en: null,
        langMode: 'fr',
      };
    }
    return {
      reference: `Jean ${reference.chapter}:${reference.verseStart}`,
      text: 'TEXTE_VERSET_DU_REPLI (BUG si affiché depuis une détection vocale automatique)',
      provider: 'fake',
      lang: 'fr',
      text_fr: 'TEXTE_VERSET_DU_REPLI',
      text_en: null,
      langMode: 'fr',
    };
  },
  buildReferenceLabel(reference) {
    return `Jean ${reference.chapter}`;
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

// Repli chapitre accéléré (au lieu des 3000ms de config/features.json) pour
// que le test reste rapide — même mécanisme que integration-chapter-fallback-delay.js.
injectFakeModule('features-store.js', {
  setUserDataDir() {},
  readFeatures() {
    return { display: { chapterFallbackDelayMs: 1000 } };
  },
  writeFeatures() {},
  getWritableFile() {
    return null;
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

process.env.PORT = process.env.PORT || '8769'; // distinct des autres tests
process.env.CHURCHOVERLAY_SKIP_BIBLE_DOWNLOAD = '1'; // pas de téléchargement biblique en test (crash libuv à l'arrêt sinon)
require('../server.js');

const WebSocket = require('ws');

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function simulateSegment(text) {
  transcriptQueue.push(text);
  await onAudioSegment(`/tmp/fake-chapter-${Date.now()}-${Math.random()}.wav`);
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

  console.log('\n=== Scénario : "Jean chapitre 3" (sans verset) détecté automatiquement ===\n');

  // Pas de "verset X" dans cette phrase : detector.js renverra une
  // référence chapitre-seul (verseStart undefined).
  await simulateSegment('Jean chapitre 3');
  await sleep(400);

  const candidate = received.find((m) => m.action === 'candidateVerse' && m.speculative === true);
  check(
    'candidateVerse spéculative diffusée (référence ambiguë, jamais affichée aveuglément)',
    !!candidate && candidate.reference && candidate.reference.chapter === 3,
    JSON.stringify(received)
  );

  // Règle absolue : JAMAIS d'affichage verse 1 sur ce chemin automatique.
  const premature = received.find((m) => m.action === 'showVerse');
  check(
    'aucun showVerse immédiat (le chapitre seul ne doit pas déclencher un verset faux)',
    !premature,
    premature ? JSON.stringify(premature) : undefined
  );

  // Repli explicite : le chapitre entier s'affiche après CHAPTER_FALLBACK_MS.
  await sleep(2200);
  const fallback = received.find(
    (m) => m.action === 'showVerse' && m.detectedBy === 'chapter-fallback'
  );
  check(
    'repli chapitre entier affiché après le délai (detectedBy chapter-fallback)',
    !!fallback && fallback.text === 'TEXTE_CHAPITRE_ENTIER',
    JSON.stringify(fallback)
  );
  check(
    "aucun verset 1 n'a jamais été affiché (le texte du repli verse 1 est absent)",
    !received.some((m) => m.action === 'showVerse' && /VERSET_DU_REPLI/.test(m.text || '')),
    undefined
  );

  ws.close();
  console.log(
    `\n=== Résultat chapitre-seul → repli chapitre (jamais verset 1) : ${passed} passés, ${failed} échoués ===`
  );
  process.exit(failed > 0 ? 1 : 0);
})().catch((err) => {
  console.error("Erreur fatale dans le test d'intégration:", err);
  process.exit(1);
});
