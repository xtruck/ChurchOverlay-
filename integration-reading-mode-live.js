/**
 * ============================================================================
 *  integration-reading-mode-live.js — Test d'intégration bout-en-bout
 * ----------------------------------------------------------------------------
 *  Objectif : vérifier que le Reading Mode fonctionne réellement une fois
 *  branché dans server.js, en rejouant un scénario de culte réaliste à
 *  travers TOUT le pipeline (buffer glissant → détection FR/EN → reading
 *  mode → diffusion WebSocket), pas juste reading-mode.js isolé.
 *
 *  Les seules choses mockées sont celles qui nécessitent un accès réseau
 *  indisponible depuis ce sandbox (API bibliques bible.helloao.org /
 *  api.getbible.net) ou du matériel réel (micro, Groq/Deepgram) :
 *    - bible-lookup-with-api.js  → chapitre факtice en mémoire
 *    - groq-wrapper.js           → transcription simulée, texte fourni au fil du test
 *    - audio-capture.js          → segments audio simulés (déclenchés à la main)
 *
 *  server.js lui-même, detector.js, sentence-buffer.js, reading-mode.js,
 *  context-tracker.js, etc. tournent SANS AUCUNE modification.
 * ============================================================================
 */
'use strict';
const path = require('path');
const assert = require('assert');
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

// --- Chapitre factice : Jean 3, versets 1 à 6 --------------------------
const FAKE_JEAN_3 = [
  { num: 1, text: 'Il y avait parmi les pharisiens un homme nomme Nicodeme, un chef des Juifs.' },
  {
    num: 2,
    text: 'Cet homme vint de nuit trouver Jesus, et lui dit: Rabbi, nous savons que tu es un docteur venu de Dieu.',
  },
  {
    num: 3,
    text: 'Jesus lui repondit: En verite, en verite, je te le dis, si un homme ne nait de nouveau, il ne peut voir le royaume de Dieu.',
  },
  {
    num: 4,
    text: 'Nicodeme lui dit: Comment un homme peut-il naitre quand il est vieux? Peut-il rentrer dans le sein de sa mere et naitre?',
  },
  {
    num: 5,
    text: "Jesus repondit: En verite, en verite, je te le dis, si un homme ne nait d'eau et d'Esprit, il ne peut entrer dans le royaume de Dieu.",
  },
  { num: 6, text: "Ce qui est ne de la chair est chair, et ce qui est ne de l'Esprit est esprit." },
];
const FAKE_JEAN_4 = [
  {
    num: 1,
    text: "Le Seigneur sut que les pharisiens avaient appris qu'il faisait et baptisait plus de disciples que Jean.",
  },
  { num: 2, text: "Toutefois Jesus lui-meme ne baptisait pas, mais c'etaient ses disciples." },
];

// --- Mock bible-lookup-with-api.js --------------------------------------
const bibleLookupCalls = { getChapterVerses: [], getVerseMultilang: [] };
injectFakeModule('bible-lookup-with-api.js', {
  async getChapterVerses(book, chapter) {
    bibleLookupCalls.getChapterVerses.push({ book, chapter });
    if (book === 'jean' && chapter === 3) return FAKE_JEAN_3;
    if (book === 'jean' && chapter === 4) return FAKE_JEAN_4;
    throw new Error(`Chapitre factice non défini pour le test: ${book} ${chapter}`);
  },
  async getVerseMultilang(reference, langMode) {
    bibleLookupCalls.getVerseMultilang.push({ reference, langMode });
    // CORRECTIF : le mock ignorait reference.book et renvoyait toujours
    // "Jean X:Y", même pour une référence résolue vers un autre livre
    // (ex. correspondance floue "Filipiens" -> "philippiens"). Le libellé
    // doit refléter le livre réellement détecté.
    const bookLabel =
      reference.book === 'jean'
        ? 'Jean'
        : reference.book.charAt(0).toUpperCase() + reference.book.slice(1);
    const verse = FAKE_JEAN_3.find((v) => v.num === reference.verseStart) || FAKE_JEAN_3[0];
    return {
      reference: `${bookLabel} ${reference.chapter}:${reference.verseStart || verse.num}`,
      text: verse.text,
      text_fr: verse.text,
      text_en: null,
      langMode: 'fr',
      provider: 'fake-provider',
    };
  },
  buildReferenceLabel(reference) {
    return `Jean ${reference.chapter}${reference.verseStart ? ':' + reference.verseStart : ''}`;
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

// --- Mock groq-wrapper.js : file d'attente de transcriptions simulées --
const transcriptQueue = [];
injectFakeModule('groq-wrapper.js', {
  async transcribeFile() {
    throw new Error('non utilisé dans ce test');
  },
  async transcribeWithFallback() {
    if (transcriptQueue.length === 0) return { text: '', source: 'fake-groq' };
    return { text: transcriptQueue.shift(), source: 'fake-groq' };
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

// --- Mock audio-capture.js : segments déclenchés manuellement -----------
let capturedOnAudioSegment = null;
injectFakeModule('audio-capture.js', {
  startBrowserCapture() {},
  feedPcmChunk() {},
  stopRecording() {},
  cleanupTempFiles() {},
  isRecording() {
    return false;
  },
  on(callbacks) {
    capturedOnAudioSegment = callbacks.onAudioSegment;
  },
});

// -------------------------------------------------------------------------
// Démarrage du serveur réel (avec les mocks ci-dessus déjà en cache)
// -------------------------------------------------------------------------
process.env.PORT = process.env.PORT || '8766'; // évite le conflit avec une instance déjà lancée sur 8765
require('../server.js');

const WebSocket = require('ws');

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function simulateSegment(text) {
  transcriptQueue.push(text);
  await capturedOnAudioSegment(`/tmp/fake-segment-${Date.now()}-${Math.random()}.wav`);
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

  await sleep(300); // laisser le serveur WS s'initialiser complètement

  const port = process.env.PORT;
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
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

  console.log('\n=== Scénario : citation explicite puis lecture continue (Jean 3) ===\n');

  // 1) Citation explicite : "Jean chapitre 3, verset 1" -> doit afficher le
  //    verset 1 ET activer le reading mode sur Jean 3.
  await simulateSegment('Jean chapitre 3, verset 1');
  await sleep(400);

  const showVerse1 = received.filter((m) => m.action === 'showVerse');
  check(
    'verset 1 affiché après la citation explicite',
    showVerse1.length >= 1 && /Jean\s*3:1/.test(showVerse1[0].reference || ''),
    JSON.stringify(showVerse1[0])
  );
  check(
    'getChapterVerses appelé pour activer le reading mode',
    bibleLookupCalls.getChapterVerses.some((c) => c.book === 'jean' && c.chapter === 3)
  );

  // 2) Le prédicateur continue de lire à voix haute SANS répéter la
  //    référence : le verset 2, puis le verset 3, mot pour mot (le cas
  //    d'usage central de la fonctionnalité).
  received.length = 0;
  await simulateSegment(
    'Cet homme vint de nuit trouver Jesus, et lui dit Rabbi nous savons que tu es un docteur venu de Dieu'
  );
  await sleep(400);
  const advance1 = received.find((m) => m.action === 'showVerse');
  check(
    'avancée automatique au verset 2 (lecture continue, sans citer la référence)',
    !!advance1 && /2$/.test(advance1.reference || ''),
    JSON.stringify(advance1)
  );
  check('le payload est bien marqué readingMode:true', !!advance1 && advance1.readingMode === true);

  received.length = 0;
  await simulateSegment(
    'Jesus lui repondit en verite en verite je te le dis si un homme ne nait de nouveau il ne peut voir le royaume de Dieu'
  );
  await sleep(400);
  const advance2 = received.find((m) => m.action === 'showVerse');
  check(
    'avancée automatique au verset 3',
    !!advance2 && /3$/.test(advance2.reference || ''),
    JSON.stringify(advance2)
  );

  // 3) Saut manuel par numéro de verset dit seul (sans "verset") : "6".
  received.length = 0;
  await simulateSegment('6');
  await sleep(400);
  const jump = received.find((m) => m.action === 'showVerse');
  check(
    'numéro de verset dit seul ("6") saute directement au bon verset',
    !!jump && /6$/.test(jump.reference || ''),
    JSON.stringify(jump)
  );

  // 4) "chapitre suivant" doit charger Jean 4 et afficher son verset 1.
  received.length = 0;
  await simulateSegment('chapitre suivant');
  await sleep(400);
  const nextChap = received.find((m) => m.action === 'showVerse');
  check(
    '"chapitre suivant" charge Jean 4 et affiche le verset 1',
    !!nextChap && /Jean\s*4:1/.test(nextChap.reference || ''),
    JSON.stringify(nextChap)
  );
  check(
    'getChapterVerses appelé pour Jean 4',
    bibleLookupCalls.getChapterVerses.some((c) => c.book === 'jean' && c.chapter === 4)
  );

  // 5) Un fragment totalement hors sujet ne doit RIEN afficher (pas de faux positif).
  received.length = 0;
  await simulateSegment('Merci beaucoup, prenons un temps de louange ensemble maintenant');
  await sleep(400);
  const spurious = received.find((m) => m.action === 'showVerse');
  check(
    'un fragment hors sujet ne déclenche AUCUNE diffusion de verset',
    !spurious,
    JSON.stringify(spurious)
  );

  // 6) Correspondance floue (Levenshtein) : citation d'un AUTRE livre mal
  //    transcrite doit quand même être détectée et reprendre la main sur
  //    le reading mode (nouvelle activation).
  received.length = 0;
  await simulateSegment('Filipiens chapitre 2, verset 5');
  await sleep(400);
  const fuzzy = received.find((m) => m.action === 'candidateVerse');
  check(
    'correspondance floue ("Filipiens" -> "Philippiens") détectée malgré l\'erreur de transcription',
    !!fuzzy && fuzzy.reference && fuzzy.reference.book === 'philippiens',
    JSON.stringify(fuzzy)
  );

  ws.close();

  console.log(`\n=== Résultat intégration live : ${passed} passés, ${failed} échoués ===`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((err) => {
  console.error("Erreur fatale dans le test d'intégration:", err);
  process.exit(1);
});
