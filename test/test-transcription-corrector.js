'use strict';
/**
 * Tests unitaires pour transcription-corrector.js — correctFast(), TranscriptionCorrector.
 * Couvre : corrections FR courantes, casse, stats, mode fast-only, groq manquant.
 */
const assert = require('assert');
const {
  TranscriptionCorrector,
  CORRECTIONS,
  correctFast,
  // AJOUT (Axe 3, phase 2 — hydratation dynamique).
  hydrateDynamicDictionary,
  clearDynamicDictionary,
  getDynamicDictionarySize,
  correctDynamicFuzzy,
} = require('../transcription-corrector');

let passed = 0;
let failed = 0;
function check(name, cond) {
  if (cond) {
    console.log('[TEST] ✓', name);
    passed++;
  } else {
    console.error('[TEST] ✗', name);
    failed++;
  }
}

console.log('=== Tests transcription-corrector.js ===');

// --- correctFast: corrections simples (casse préservée) ---
check(
  'jesus → jésus (lowercase in → lowercase out)',
  correctFast('jesus a parle') === 'jésus a parle'
);
check(
  'jean le baptiseur → jean-baptiste (lowercase)',
  correctFast('jean le baptiseur est dans le desert') === 'jean-baptiste est dans le desert'
);
check(
  'jean baptist → jean-baptiste (lowercase)',
  correctFast('jean baptist a baptisé') === 'jean-baptiste a baptisé'
);
check(
  'moise → moïse (lowercase)',
  correctFast('moise a conduit le peuple') === 'moïse a conduit le peuple'
);

// --- Casse uppercase → uppercase ---
check('JESUS → JÉSUS (tout majuscule)', correctFast('JESUS a parle') === 'JÉSUS a parle');
// --- Casse Capitalized → Capitalized ---
check(
  'Jesus → Jésus (première lettre majuscule)',
  correctFast('Jesus a parle') === 'Jésus a parle'
);
check(
  'Marie Madeleine est present → lowercase (casse du match)',
  correctFast('marie madeleine est present') === 'marie madeleine est present'
);
check(
  'Marie Madeleine (capitalized) → Marie Madeleine (capitalized)',
  correctFast('Marie Madeleine est present') === 'Marie Madeleine est present'
);

// --- Texte sans corrections ---
check(
  'texte neutre inchangé',
  correctFast('bonjour tout le monde comment allez vous') ===
    'bonjour tout le monde comment allez vous'
);

// --- Dictionnaire ---
check('dictionnaire non vide', Object.keys(CORRECTIONS).length > 100);

// --- Tests async ---
async function runAsyncTests() {
  // --- Texte trop court (await requis — correct() est async) ---
  const tc = new TranscriptionCorrector(null);
  check('texte < 3 chars retourne tel quel', (await tc.correct('ab')) === 'ab');
  check('texte vide retourne tel quel', (await tc.correct('')) === '');
  check('null retourne null', (await tc.correct(null)) === null);

  // --- Mode fast-only (groq manquant) ---
  const c1 = new TranscriptionCorrector(null);
  const r1 = await c1.correct('jesus a parle de jean', 'auto');
  check('fast-only: correction appliquée', r1 === 'jésus a parle de jean');
  check('fast-only: smartCorrections = 0', c1.getStats().smartCorrections === 0);
  check('fast-only: fastCorrections = 1', c1.getStats().fastCorrections === 1);

  // --- Groq wrapper invalide ---
  const c2 = new TranscriptionCorrector({ notAFunction: true });
  const r2 = await c2.correct('jesus et jean discutent');
  check('groq invalide: pas de crash', r2 === 'jésus et jean discutent');

  // --- Stats reset ---
  const c3 = new TranscriptionCorrector(null);
  await c3.correct('jesus a parle');
  c3.resetStats();
  const s = c3.getStats();
  check('reset: fastCorrections = 0', s.fastCorrections === 0);
  check('reset: smartCorrections = 0', s.smartCorrections === 0);
  check('reset: skipped = 0', s.skipped === 0);

  // --- Texte sans mot biblique (skipped) ---
  const c4 = new TranscriptionCorrector(null);
  const r4 = await c4.correct('il fait beau aujourd hui');
  check('texte neutre: skipped = 1', c4.getStats().skipped === 1);
  check('texte neutre: inchangé', r4 === 'il fait beau aujourd hui');

  // --- SMART mode: texte avec mot biblique qui passe le regex ---
  // calculateSimilarity() compare les mots en lowercase (Jaccard sur les
  // sets) : une simple correction de casse ("christ" -> "Christ") sur un
  // texte par ailleurs identique donne donc une similarite de 1.0, bien
  // au-dessus du seuil de rejet (0.7).
  const mockGroq = {
    chatCompletion: async () => ({
      text: 'Christ a beaucoup souffert',
      model: 'test',
      usage: {},
    }),
  };
  const c5 = new TranscriptionCorrector(mockGroq);
  const r5 = await c5.correct('christ a beaucoup souffert', 'smart');
  check('smart mode: texte corrigé par LLM', r5 === 'Christ a beaucoup souffert');
  check('smart mode: smartCorrections = 1', c5.getStats().smartCorrections === 1);

  // --- SMART mode: rejet si similarité trop basse ---
  const mockGroqBad = {
    chatCompletion: async () => ({
      text: 'Un verset totalement different',
      model: 'test',
      usage: {},
    }),
  };
  const c6 = new TranscriptionCorrector(mockGroqBad);
  const r6 = await c6.correct('christ a beaucoup souffert', 'smart');
  check(
    'smart rejeté (similarité basse): texte inchangé après FAST',
    r6 === 'christ a beaucoup souffert'
  );
  check('smart rejeté: smartCorrections = 0', c6.getStats().smartCorrections === 0);

  // --- SMART mode: erreur LLM → texte inchangé, mais onError notifié ---
  // AJOUT (A.2 — visibilité des échecs IA) : jusqu'ici uniquement un
  // console.warn invisible côté opérateur.
  const mockGroqError = {
    chatCompletion: async () => {
      throw new Error('rate limited');
    },
  };
  const c7 = new TranscriptionCorrector(mockGroqError);
  let c7ErrorMessage = null;
  c7.onError = (message) => {
    c7ErrorMessage = message;
  };
  const r7 = await c7.correct('christ a beaucoup souffert', 'smart');
  check(
    'erreur LLM: texte inchangé (repli identique à avant)',
    r7 === 'christ a beaucoup souffert'
  );
  check('erreur LLM: onError notifié', c7ErrorMessage === 'rate limited');
  check('erreur LLM: getStats().errors incrémenté', c7.getStats().errors === 1);

  // ==========================================================================
  // AJOUT (Axe 3, phase 2 — hydratation dynamique du correcteur) : simule un
  // conducteur (rundown-store.js#listCues) avec un nom propre difficile
  // ("Jean-Pierre") et un chant (song-library.js#getSong, forme COMPLÈTE
  // avec sections) portant un mot-clé/une phrase déclencheuse rares, puis
  // vérifie qu'une transcription bruitée est redressée — exactement le
  // scénario demandé.
  // ==========================================================================
  console.log('\n--- Hydratation dynamique (Axe 3, phase 2) ---');

  const fakeCues = [
    { id: 'c1', type: 'media', label: 'Intro par Jean-Pierre Dupont', addedAt: '2026-01-01' },
    {
      id: 'c2',
      type: 'verse',
      label: 'Jean 3:16',
      reference: 'Jean 3:16',
      addedAt: '2026-01-01',
    },
  ];
  const fakeSongs = [
    {
      id: 's1',
      title: 'Grâce Infinie',
      artist: '',
      sections: [
        {
          type: 'verse',
          label: 'Couplet 1',
          text: 'Ta grâce infinie coule sur nous, ô Rédempteur magnifique',
        },
      ],
      triggerPhrases: ['grace infinie'],
    },
  ];

  const hydrateResult = hydrateDynamicDictionary(fakeCues, fakeSongs);
  check('hydratation : retourne un compte de termes non nul', hydrateResult.termCount > 0);
  check(
    'hydratation : getDynamicDictionarySize() reflète le résultat',
    getDynamicDictionarySize() === hydrateResult.termCount
  );

  check(
    'nom propre du conducteur : "Jean Piere" (trait d\'union disparu) → "Jean-Pierre"',
    correctDynamicFuzzy('bonjour a tous, Jean Piere va nous parler') ===
      'bonjour a tous, Jean-Pierre va nous parler'
  );
  check(
    'nom propre du conducteur : "Jan-Pierre" (voyelle déformée) → "Jean-Pierre"',
    correctDynamicFuzzy('merci Jan-Pierre pour ce message') === 'merci Jean-Pierre pour ce message'
  );
  check(
    'nom propre du conducteur : casse préservée (majuscule initiale)',
    /Jean-Pierre/.test(correctDynamicFuzzy('Jean Piere est present'))
  );
  check(
    'mot-clé de chant : phrase déclencheuse "grace infini" (accent manquant) → "grâce infinie"',
    correctDynamicFuzzy('chantons ensemble grace infini pour tous') ===
      'chantons ensemble grâce infinie pour tous'
  );
  check(
    'mot rare des paroles : "redempteur" (accents manquants, correspondance ' +
      'EXACTE une fois normalisé — pas juste floue) → "rédempteur" (casse ' +
      "d'origine du transcript préservée, comme correctFast le fait déjà)",
    correctDynamicFuzzy('merci pour le redempteur magnifique') ===
      'merci pour le rédempteur magnifique'
  );
  check(
    'texte neutre sans rapport : inchangé (pas de faux positif)',
    correctDynamicFuzzy('il fait beau ce matin pour le culte') ===
      'il fait beau ce matin pour le culte'
  );

  // --- Intégration bout-en-bout via TranscriptionCorrector.correct() ---
  const c8 = new TranscriptionCorrector(null);
  const r8 = await c8.correct('bonjour, Jean Piere va nous parler ce matin');
  check(
    'correct() bout-en-bout : nom propre dynamique redressé',
    r8 === 'bonjour, Jean-Pierre va nous parler ce matin'
  );
  check(
    'correct() bout-en-bout : dynamicCorrections incrémenté',
    c8.getStats().dynamicCorrections === 1
  );

  // --- clearDynamicDictionary() : plus aucune correction dynamique après ---
  clearDynamicDictionary();
  check('clearDynamicDictionary() : taille ramenée à 0', getDynamicDictionarySize() === 0);
  check(
    'clearDynamicDictionary() : correctDynamicFuzzy() redevient un no-op',
    correctDynamicFuzzy('Jean Piere va nous parler') === 'Jean Piere va nous parler'
  );
}

runAsyncTests().then(() => {
  console.log(`\n=== Résultat transcription-corrector : ${passed}/${passed + failed} ===`);
  if (failed > 0) process.exit(1);
});
