/**
 * ============================================================================
 *  integration-chapter-fallback-delay.js — Délai du repli chapitre
 * ----------------------------------------------------------------------------
 *  AJOUT (Chantier A.5 — mission autonome, "arbitrage couverture/latence
 *  explicite") : le repli chapitre (server.js#scheduleChapterFallback,
 *  Chantier 3) affiche le CHAPITRE ENTIER quand un fragment ne livre que
 *  livre+chapitre — mesuré comme la seule variable de latence ayant changé
 *  entre les deux runs de référence (62,2% p50=671ms -> 75,7% p50=1949ms,
 *  voir BASELINE_CHANTIER_1.md). CHAPTER_FALLBACK_MS était jusqu'ici une
 *  constante figée (3000) ; server.js#getChapterFallbackDelayMs() la rend
 *  réglable, MÊME PRIORITÉ que getTranscriptionConfidenceThreshold() déjà en
 *  place (config/features.json > variable d'env CHAPTER_FALLBACK_MS >
 *  défaut mesuré). Aucun test n'existait jusqu'ici pour ce timer du tout
 *  (gap préexistant, comblé ici).
 *
 *  features-store.js est mocké (pas la variable d'env CHAPTER_FALLBACK_MS)
 *  parce que config/features.json — le fichier LIVRÉ avec le dépôt, toujours
 *  lu en premier — définit déjà display.chapterFallbackDelayMs (voir ce
 *  fichier) : sur une installation fraîche, cette valeur livrée l'emporte
 *  TOUJOURS sur la variable d'env, exactement comme pour
 *  transcriptionConfidenceThreshold déjà en place — la variable d'env n'est
 *  un vrai repli que pour une config utilisateur qui aurait explicitement
 *  retiré la clé. Ce test vérifie donc le chemin qui compte réellement en
 *  usage normal (config/features.json), sans toucher au vrai fichier du
 *  poste de développement (mock, pas d'écriture disque).
 *
 *  Même approche que integration-quote-match.js/integration-chapter-only-verse1.js :
 *  server.js tourne réellement, seuls le réseau (API biblique, Groq), le
 *  micro et la config sont mockés.
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

// CORRECTIF (trouvé en écrivant ce test) : 150ms était trop court en
// pratique — le corrector IA (Groq/Gemini, PAS mocké dans ce test) tente un
// vrai appel réseau avant d'échouer (401, clé absente/invalide en test) —
// délai réseau réel et variable, AVANT même que le timer ne soit programmé.
// 300ms donne une marge confortable tout en restant très en-dessous du
// défaut production (3000ms) — objectif du test (prouver la
// configurabilité), pas mesurer une latence de production précise.
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
    // Distingue explicitement l'appel de préchauffage (chapitre seul, voir
    // le commentaire "Chantier 1 — latence chemin fusion" dans server.js)
    // de l'appel réel du repli chapitre — les deux passent par ici avec le
    // même `reference` (book+chapter, jamais de verseStart), donc rien à
    // distinguer : le texte renvoyé identifie sans ambiguïté "chapitre
    // entier" si ce test échoue en affichant autre chose.
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

process.env.PORT = process.env.PORT || '8791'; // distinct des autres tests
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
    `\n=== Scénario : "Jean chapitre 3 verset" (verset tronqué) — délai réglé à ${FALLBACK_DELAY_MS}ms via config/features.json ===\n`
  );

  // Le texte se termine par "verset" sans numéro : satisfait la condition
  // truncatedChapterOnly de server.js même via l'action WS 'transcript'
  // (qui ne renseigne jamais opts.source) — voir son commentaire "Chantier 1
  // — précision G1" pour le détail des sources reconnues.
  ws.send(JSON.stringify({ action: 'transcript', text: 'Jean chapitre 3 verset' }));

  // Avant l'expiration du délai : rien ne doit encore être affiché (le
  // repli chapitre est un TIMER, pas immédiat — sinon il n'y aurait plus
  // aucune fenêtre pour qu'un verset exact arrive avant lui). Fenêtre COURTE
  // (20ms, pas une fraction de FALLBACK_DELAY_MS) : le timer ne démarre
  // qu'après le traitement complet du transcript (détection + tentative du
  // corrector IA, non mocké ici — vrai aller-retour réseau avant son échec
  // 401), donc une fraction de FALLBACK_DELAY_MS serait elle-même sujette à
  // cette même variabilité réseau. 20ms est sûr dans tous les cas : même
  // sans aucun aller-retour réseau, le timer lui-même dure FALLBACK_DELAY_MS.
  await sleep(20);
  check(
    "rien n'est affiché juste après l'envoi (le repli est bien un timer, pas immédiat)",
    !received.some((m) => m.action === 'showVerse'),
    JSON.stringify(received.map((m) => m.action))
  );

  // Après l'expiration du délai configuré : le chapitre entier doit être
  // affiché. Marge généreuse au-delà de FALLBACK_DELAY_MS pour absorber le
  // vrai aller-retour réseau du corrector (voir plus haut) — objectif du
  // test : prouver la configurabilité (très en-dessous du défaut production
  // 3000ms), pas mesurer une latence précise.
  // CORRECTIF (flake constaté en session — timeout ~1 fois sur 3 avec la
  // marge précédente de 1200ms, jamais lié à ce chantier) : bible-lookup-
  // with-api.js est ici entièrement mocké (résolution instantanée, voir
  // injectFakeModule ci-dessus) donc ce n'est pas un vrai aller-retour
  // réseau qui manque de marge — plus probablement la précision de
  // setTimeout sous charge CPU (toute la suite de tests tourne en séquence).
  // 3000ms de marge (comme la valeur par défaut PRODUCTION du délai
  // lui-même) reste "très en-dessous" de rien en particulier ici — c'est
  // volontairement large, l'objectif du test étant comportemental (le repli
  // finit-il par se déclencher), pas une mesure de latence précise (voir
  // commentaire ci-dessus).
  await sleep(FALLBACK_DELAY_MS + 3000);
  const shown = received.find((m) => m.action === 'showVerse');
  check(
    `le repli chapitre s'est bien déclenché dans le délai configuré (${FALLBACK_DELAY_MS}ms)`,
    !!shown,
    JSON.stringify(received.map((m) => m.action))
  );
  check(
    "detectedBy: 'chapter-fallback' (pas un affichage par un autre chemin)",
    !!shown && shown.detectedBy === 'chapter-fallback'
  );
  check(
    'le texte affiché est celui du CHAPITRE ENTIER (comportement attendu du repli)',
    !!shown && shown.text === 'TEXTE_CHAPITRE_ENTIER_VIA_REPLI',
    JSON.stringify(shown)
  );

  ws.close();
  console.log(
    `\n=== Résultat délai du repli chapitre (Chantier A.5) : ${passed} passés, ${failed} échoués ===`
  );
  process.exit(failed > 0 ? 1 : 0);
})().catch((err) => {
  console.error("Erreur fatale dans le test d'intégration:", err);
  process.exit(1);
});
