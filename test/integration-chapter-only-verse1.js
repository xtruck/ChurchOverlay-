/**
 * ============================================================================
 *  integration-chapter-only-verse1.js — Détection auto sans verset → verset 1
 * ----------------------------------------------------------------------------
 *  RÉGRESSION COUVERTE (audit) : quand la transcription automatique ne
 *  capture pas de numéro de verset (ex. "Jean chapitre 3" sans "verset X" —
 *  cas fréquent quand la STT rate un mot dans le bruit ambiant), detector.js
 *  retourne une référence "chapitre seul" (verseStart undefined).
 *  bible-lookup-with-api.js traite délibérément ce cas comme "renvoyer tout
 *  le chapitre" — voulu pour une lecture de chapitre explicite, mais un
 *  dump de chapitre entier sur l'overlay surprend/submerge l'écran quand ce
 *  n'était pas l'intention. server.js doit désormais afficher le verset 1
 *  par défaut pour ce chemin de détection AUTOMATIQUE (pas la saisie
 *  manuelle, non couverte ici).
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
        text: 'TEXTE_CHAPITRE_ENTIER (BUG si affiché depuis une détection vocale automatique)',
        provider: 'fake',
        lang: 'fr',
        text_fr: 'TEXTE_CHAPITRE_ENTIER',
        text_en: null,
        langMode: 'fr',
      };
    }
    return {
      reference: `Jean ${reference.chapter}:${reference.verseStart}`,
      text: 'TEXTE_VERSET_1_SEUL',
      provider: 'fake',
      lang: 'fr',
      text_fr: 'TEXTE_VERSET_1_SEUL',
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

  const shown = received.find((m) => m.action === 'showVerse');
  check('un verset a bien été diffusé', !!shown, JSON.stringify(received));
  check(
    'le texte affiché est celui du verset 1, PAS le chapitre entier',
    !!shown && shown.text === 'TEXTE_VERSET_1_SEUL',
    JSON.stringify(shown)
  );

  ws.close();
  console.log(`\n=== Résultat chapitre-seul → verset 1 : ${passed} passés, ${failed} échoués ===`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((err) => {
  console.error("Erreur fatale dans le test d'intégration:", err);
  process.exit(1);
});
