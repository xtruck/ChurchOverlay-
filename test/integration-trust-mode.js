/**
 * ============================================================================
 *  integration-trust-mode.js — Mode confiance (Partie 2 : auto/semi-auto/manuel)
 * ----------------------------------------------------------------------------
 *  RÈGLE MISSION : un bénévole débutant doit pouvoir commencer en manuel et
 *  gagner en confiance progressivement (auto -> semi-auto -> manuel, ou
 *  l'inverse). En 'auto' (défaut, comportement HISTORIQUE inchangé), un
 *  verset détecté automatiquement s'affiche directement. En 'semi-auto'/
 *  'manual', il doit être retenu (candidateVerse-like) et n'apparaître QUE
 *  si l'opérateur confirme (barre d'espace côté dashboard -> action WS
 *  confirmPendingVerse).
 *
 *  Ce test vérifie, via un VRAI server.js (mêmes mocks réseau/micro que
 *  integration-chapter-only-verse1.js) :
 *   1. mode 'auto' (défaut) : showVerse immédiat, comme avant ce chantier.
 *   2. mode 'semi-auto' : PAS de showVerse immédiat, mais pendingVerseConfirmation
 *      diffusé ; confirmPendingVerse déclenche ENSUITE le vrai showVerse.
 *   3. dismissPendingVerse : le verset en attente est abandonné, jamais affiché.
 *   4. changer de mode pendant qu'un verset est en attente le rejette proprement
 *      (pendingVerseDismissed), au lieu de le laisser orphelin.
 *
 *  AJOUT (Axe 2 — Trust Mode prédictif à 3 niveaux, durcissement) :
 *   5. mode 'auto' + correspondance FLOUE (confidence='medium', nom de livre
 *      deviné) : NE s'affiche PLUS immédiatement malgré le mode 'auto' —
 *      attente de confirmation, comme si le mode était 'semi-auto' pour
 *      CETTE détection précise seulement (le mode global reste 'auto').
 *   6. mode 'auto' + correspondance par citation (findByQuotedText) : reste
 *      TOUJOURS exemptée du palier prédictif, même à faible score (0.6) —
 *      son échelle de recouvrement de mots n'est pas comparable à la
 *      confiance categorielle regex/sémantique ; comportement HISTORIQUE
 *      (affichage direct en mode 'auto') strictement préservé.
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

// AJOUT (Axe 2 — Trust Mode prédictif) : conservé dans une variable nommée
// (plutôt qu'un littéral anonyme) pour que le scénario de rejet à faible
// confiance, plus bas, puisse remplacer findByQuotedText() TEMPORAIREMENT
// pour un seul segment — c'est le MÊME objet que server.js détient déjà
// (injectFakeModule remplace le module entier avant le require('../server.js')
// ci-dessous), donc muter une de ses méthodes ici se répercute immédiatement.
const fakeBibleLookup = {
  async getChapterVerses() {
    throw new Error('non utilisé dans ce test');
  },
  async getChapterVersesMultilang() {
    throw new Error('non utilisé dans ce test');
  },
  async getVerseMultilang(reference) {
    return {
      reference: `Jean ${reference.chapter}:${reference.verseStart}`,
      text: 'Car Dieu a tant aimé le monde...',
      provider: 'fake',
      lang: 'fr',
      text_fr: 'Car Dieu a tant aimé le monde...',
      text_en: null,
      langMode: 'fr',
    };
  },
  buildReferenceLabel(reference) {
    return `Jean ${reference.chapter}:${reference.verseStart}`;
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
};
injectFakeModule('bible-lookup-with-api.js', fakeBibleLookup);

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

process.env.PORT = process.env.PORT || '8779'; // distinct des autres tests
process.env.CHURCHOVERLAY_SKIP_BIBLE_DOWNLOAD = '1';
require('../server.js');

const WebSocket = require('ws');

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function simulateSegment(text) {
  transcriptQueue.push(text);
  await onAudioSegment(`/tmp/fake-trust-mode-${Date.now()}-${Math.random()}.wav`);
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
  let received = [];
  await new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });
  ws.on('message', (raw) => {
    try {
      received.push(JSON.parse(raw.toString()));
    } catch (_) {}
  });
  function send(msg) {
    ws.send(JSON.stringify(msg));
  }

  // --- 1. Mode 'auto' (défaut) : comportement historique inchangé ---------
  console.log("\n=== Mode 'auto' (défaut) : showVerse immédiat ===\n");
  received = [];
  await simulateSegment('Jean chapitre 3 verset 16');
  await sleep(400);
  check(
    'auto : showVerse diffusé immédiatement (Jean 3:16)',
    received.some((m) => m.action === 'showVerse' && m.reference === 'Jean 3:16'),
    JSON.stringify(received)
  );
  check(
    'auto : aucun pendingVerseConfirmation en mode auto',
    !received.some((m) => m.action === 'pendingVerseConfirmation'),
    undefined
  );

  // --- 2. Mode 'semi-auto' : en attente, puis confirmé -------------------
  console.log("\n=== Mode 'semi-auto' : en attente puis confirmation ===\n");
  received = [];
  send({ action: 'setTrustMode', mode: 'semi-auto' });
  await sleep(100);
  check(
    'trustModeChanged diffusé après setTrustMode',
    received.some((m) => m.action === 'trustModeChanged' && m.trustMode === 'semi-auto'),
    JSON.stringify(received)
  );

  received = [];
  await simulateSegment('Jean chapitre 3 verset 16');
  await sleep(400);
  check(
    'semi-auto : PAS de showVerse immédiat (attend confirmation opérateur)',
    !received.some((m) => m.action === 'showVerse'),
    JSON.stringify(received)
  );
  const pending = received.find((m) => m.action === 'pendingVerseConfirmation');
  check(
    'semi-auto : pendingVerseConfirmation diffusé avec la bonne référence',
    !!pending && pending.reference === 'Jean 3:16' && pending.trustMode === 'semi-auto',
    JSON.stringify(pending)
  );

  received = [];
  send({ action: 'confirmPendingVerse' });
  await sleep(300);
  const confirmed = received.find((m) => m.action === 'showVerse');
  check(
    'semi-auto : confirmPendingVerse déclenche ENSUITE le vrai showVerse',
    !!confirmed && confirmed.reference === 'Jean 3:16',
    JSON.stringify(received)
  );

  // --- 3. dismissPendingVerse : jamais affiché -----------------------------
  console.log('\n=== dismissPendingVerse : verset en attente jamais affiché ===\n');
  received = [];
  await simulateSegment('Jean chapitre 3 verset 16');
  await sleep(400);
  check(
    'un nouveau verset est bien en attente avant le dismiss',
    received.some((m) => m.action === 'pendingVerseConfirmation'),
    JSON.stringify(received)
  );

  received = [];
  send({ action: 'dismissPendingVerse' });
  await sleep(300);
  check(
    'dismissPendingVerse : pendingVerseDismissed diffusé',
    received.some((m) => m.action === 'pendingVerseDismissed' && m.reference === 'Jean 3:16'),
    JSON.stringify(received)
  );
  check(
    'dismissPendingVerse : aucun showVerse ne suit jamais',
    !received.some((m) => m.action === 'showVerse'),
    JSON.stringify(received)
  );

  // --- 4. Changer de mode pendant une attente rejette proprement ----------
  console.log('\n=== Changement de mode avec un verset en attente ===\n');
  received = [];
  await simulateSegment('Jean chapitre 3 verset 16');
  await sleep(400);
  check(
    'un verset est de nouveau en attente avant le changement de mode',
    received.some((m) => m.action === 'pendingVerseConfirmation'),
    JSON.stringify(received)
  );

  received = [];
  send({ action: 'setTrustMode', mode: 'auto' });
  await sleep(300);
  check(
    'basculer vers auto avec un verset en attente le rejette (pendingVerseDismissed), ne le laisse pas orphelin',
    received.some((m) => m.action === 'pendingVerseDismissed' && m.reference === 'Jean 3:16'),
    JSON.stringify(received)
  );

  // --- 5. Mode 'auto' + correspondance FLOUE : attente malgré 'auto' -----
  console.log(
    "\n=== Mode 'auto' + correspondance floue (confidence='medium') : attente, pas d'affichage direct ===\n"
  );
  send({ action: 'setTrustMode', mode: 'auto' });
  await sleep(100);
  received = [];
  // "2 jeans" (typo ASR plausible) -> corrigé en "2 jean" par distance de
  // Levenshtein (voir detector.js) : confidence='medium' car le NOM DU LIVRE
  // lui-même reste une supposition, quel que soit le numéro de verset.
  await simulateSegment('2 jeans chapitre 1 verset 5');
  await sleep(400);
  check(
    'auto + flou : PAS de showVerse immédiat (confiance insuffisante pour CETTE détection)',
    !received.some((m) => m.action === 'showVerse'),
    JSON.stringify(received)
  );
  const fuzzyPending = received.find((m) => m.action === 'pendingVerseConfirmation');
  check(
    'auto + flou : pendingVerseConfirmation diffusé avec la confiance numérique attendue (75%)',
    !!fuzzyPending && fuzzyPending.trustMode === 'auto' && fuzzyPending.confidence === 0.75,
    JSON.stringify(fuzzyPending)
  );

  // Confirme quand même pour vérifier que le mode 'auto' reste pleinement
  // fonctionnel une fois la confirmation opérateur donnée (pas un dead-end).
  received = [];
  send({ action: 'confirmPendingVerse' });
  await sleep(300);
  check(
    'auto + flou : confirmPendingVerse déclenche bien le showVerse ensuite',
    received.some((m) => m.action === 'showVerse'),
    JSON.stringify(received)
  );

  // --- 6. Mode 'auto' + citation : TOUJOURS exemptée du palier prédictif -
  // Le score de recouvrement de mots (findByQuotedText) n'est pas calibré
  // sur la même échelle que la confiance categorielle regex/sémantique
  // (voir server.js, branche `reference.detectedBy === 'quote'`) : même un
  // score bas (0.6, sous le nouveau seuil de rejet 70%) doit continuer à
  // s'afficher directement en mode 'auto', comme AVANT ce chantier.
  console.log(
    "\n=== Mode 'auto' + citation à faible score de recouvrement (0.6) : exemptée, affichage direct quand même ===\n"
  );
  const originalFindByQuotedText = fakeBibleLookup.findByQuotedText;
  fakeBibleLookup.findByQuotedText = () => ({
    reference: 'Jean 3:16',
    score: 0.6, // >= 0.55 (pré-filtre existant), sous le seuil 70% du palier prédictif -> sans incidence pour une citation
    text: 'Car Dieu a tant aimé le monde...',
  });
  received = [];
  try {
    // Phrase sans motif "livre chapitre X verset Y" détectable par regex, ni
    // "chapitre seul" -> tombe jusqu'au repli citation (findByQuotedText).
    await simulateSegment("Dieu a tant aime le monde qu'il a donne son fils unique");
    await sleep(400);
  } finally {
    fakeBibleLookup.findByQuotedText = originalFindByQuotedText;
  }
  check(
    "auto + citation à faible score : showVerse quand même diffusé (citation exemptée du palier prédictif)",
    received.some((m) => m.action === 'showVerse' && m.reference === 'Jean 3:16'),
    JSON.stringify(received)
  );
  check(
    'auto + citation à faible score : aucun pendingVerseConfirmation (pas de mise en attente pour une citation)',
    !received.some((m) => m.action === 'pendingVerseConfirmation'),
    JSON.stringify(received)
  );

  // Restaure 'auto' pour ne pas polluer un run suivant sur le même process.
  send({ action: 'setTrustMode', mode: 'auto' });

  ws.close();
  console.log(`\n=== Résultat mode confiance : ${passed} passés, ${failed} échoués ===`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((err) => {
  console.error("Erreur fatale dans le test d'intégration:", err);
  process.exit(1);
});
