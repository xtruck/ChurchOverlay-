/**
 * ============================================================================
 *  test-reading-mode.js — Tests pour reading-mode.js
 * ----------------------------------------------------------------------------
 *  reading-mode.js (AJOUT audit — inspiré de Rhema, "Reading Mode") existait
 *  déjà mais n'était branché nulle part (aucun require() dans server.js) et
 *  n'avait aucun test. Ce fichier couvre :
 *   - le démarrage (start) et le chargement du chapitre
 *   - l'avancement automatique par chevauchement de mots
 *   - la commande "chapitre suivant"
 *   - un numéro de verset dit seul ("17", "verset 17")
 *   - la désactivation (stop)
 *  Utilise un faux getChapterVerses() (pas d'appel réseau réel : les API
 *  bibliques ne sont de toute façon pas joignables depuis cet environnement
 *  de test) pour rester rapide et déterministe.
 * ============================================================================
 */
'use strict';
const assert = require('assert');
const { ReadingMode } = require('../reading-mode');

console.log('=== Test Reading Mode ===\n');

// Chapitre factice à 5 versets, réutilisé par plusieurs tests.
const FAKE_CHAPTERS = {
  'jean:3': [
    { num: 1, text: 'Il y avait parmi les pharisiens un homme nomme Nicodeme.' },
    { num: 2, text: 'Cet homme vint de nuit trouver Jesus.' },
    { num: 3, text: 'Jesus lui repondit en verite en verite je te le dis.' },
    { num: 4, text: 'Nicodeme lui dit comment un homme peut il naitre quand il est vieux.' },
    { num: 5, text: 'Jesus repondit en verite en verite je te le dis.' },
  ],
  'jean:4': [
    { num: 1, text: 'Le Seigneur sut que les pharisiens avaient appris cela.' },
    { num: 2, text: 'Toutefois Jesus lui meme ne baptisait pas mais ses disciples.' },
  ],
};

function makeReadingMode(overrides = {}) {
  const calls = { getChapterVerses: [], onVerseAdvance: [] };
  const rm = new ReadingMode({
    getChapterVerses: async (book, chapter) => {
      calls.getChapterVerses.push({ book, chapter });
      const key = `${book}:${chapter}`;
      if (!FAKE_CHAPTERS[key]) throw new Error(`Chapitre inconnu (test): ${key}`);
      return FAKE_CHAPTERS[key];
    },
    onVerseAdvance: (verse) => calls.onVerseAdvance.push(verse),
    ...overrides,
  });
  return { rm, calls };
}

(async () => {
  let passed = 0;
  let failed = 0;
  function check(name, fn) {
    try {
      fn();
      console.log(`✅ ${name}`);
      passed++;
    } catch (err) {
      console.log(`❌ ${name}\n   ${err.message}`);
      failed++;
    }
  }
  async function checkAsync(name, fn) {
    try {
      await fn();
      console.log(`✅ ${name}`);
      passed++;
    } catch (err) {
      console.log(`❌ ${name}\n   ${err.message}`);
      failed++;
    }
  }

  // Test 1 : start() charge le chapitre et se positionne sur le bon verset.
  await checkAsync('start() charge le chapitre et positionne le verset de départ', async () => {
    const { rm } = makeReadingMode();
    const verse = await rm.start('jean', 3, 3);
    assert.strictEqual(rm.active, true);
    assert.strictEqual(rm.book, 'jean');
    assert.strictEqual(rm.chapter, 3);
    assert.strictEqual(verse.num, 3);
    assert.strictEqual(rm.currentIndex, 2);
  });

  // Test 2 : verset de départ inconnu -> repli sur le premier verset (index 0),
  // au lieu de planter (cas d'une citation "Jean 3" sans numéro de verset).
  await checkAsync('start() sans verset connu retombe sur le premier verset', async () => {
    const { rm } = makeReadingMode();
    const verse = await rm.start('jean', 3, undefined);
    assert.strictEqual(rm.currentIndex, 0);
    assert.strictEqual(verse.num, 1);
  });

  // Test 3 : avancement automatique par chevauchement de mots — le fragment
  // transcrit ressemble au verset SUIVANT (pas au verset courant) : le mode
  // doit avancer et appeler onVerseAdvance.
  await checkAsync(
    'avance automatiquement quand le fragment ressemble au verset suivant',
    async () => {
      const { rm, calls } = makeReadingMode();
      await rm.start('jean', 3, 1);
      // Fragment proche du verset 2 : "Cet homme vint de nuit trouver Jesus."
      const result = rm.processFragment('cet homme vint de nuit trouver jesus');
      assert.ok(result, 'processFragment aurait du retourner un resultat');
      assert.strictEqual(result.num, 2);
      assert.strictEqual(rm.currentIndex, 1);
      assert.strictEqual(
        calls.onVerseAdvance.length,
        1,
        'onVerseAdvance aurait du etre appele une fois'
      );
      assert.strictEqual(calls.onVerseAdvance[0].num, 2);
    }
  );

  // Test 4 : un fragment sans rapport avec les versets suivants ne fait pas
  // avancer le mode et ne déclenche pas onVerseAdvance.
  await checkAsync('un fragment sans rapport ne fait pas avancer le mode', async () => {
    const { rm, calls } = makeReadingMode();
    await rm.start('jean', 3, 1);
    const result = rm.processFragment('bonjour tout le monde comment allez vous aujourdhui');
    assert.strictEqual(result, null);
    assert.strictEqual(rm.currentIndex, 0, 'ne devrait pas avoir avance');
    assert.strictEqual(calls.onVerseAdvance.length, 0);
  });

  // Test 5 : "chapitre suivant" renvoie une commande dédiée SANS avancer
  // lui-même (c'est à l'appelant, ici server.js, de recharger le chapitre
  // suivant via start() — reading-mode.js reste agnostique du provider).
  check('"chapitre suivant" renvoie {command: "nextChapter"}', () => {
    const { rm } = makeReadingMode();
    rm.active = true; // pas besoin d'un vrai chapitre chargé pour ce test
    rm.book = 'jean';
    rm.chapter = 3;
    rm.verses = FAKE_CHAPTERS['jean:3'];
    rm.currentIndex = 4;
    const result = rm.processFragment('chapitre suivant');
    assert.deepStrictEqual(result, { command: 'nextChapter' });
  });

  // Test 6 : un numéro de verset dit seul ("17" ou "verset 17") saute
  // directement à ce verset — cas d'usage explicite de la fonctionnalité
  // Rhema d'origine ("il gère même un numéro de verset dit seul").
  await checkAsync('un numéro de verset dit seul ("verset 4") saute au bon verset', async () => {
    const { rm, calls } = makeReadingMode();
    await rm.start('jean', 3, 1);
    const result = rm.processFragment('verset 4');
    assert.ok(result);
    assert.strictEqual(result.num, 4);
    assert.strictEqual(rm.currentIndex, 3);
    assert.strictEqual(calls.onVerseAdvance.length, 1);
  });

  await checkAsync('un numéro seul ("4") saute aussi au bon verset', async () => {
    const { rm } = makeReadingMode();
    await rm.start('jean', 3, 1);
    const result = rm.processFragment('4');
    assert.ok(result);
    assert.strictEqual(result.num, 4);
    assert.strictEqual(rm.currentIndex, 3);
  });

  // Test 7 : stop() désactive proprement et réinitialise l'état.
  await checkAsync("stop() désactive et réinitialise l'état", async () => {
    const { rm } = makeReadingMode();
    await rm.start('jean', 3, 1);
    rm.stop();
    assert.strictEqual(rm.active, false);
    assert.strictEqual(rm.book, null);
    assert.strictEqual(rm.verses.length, 0);
    assert.strictEqual(rm.currentIndex, -1);
  });

  // Test 8 : processFragment() est un no-op sûr quand le mode est inactif
  // (aucune exception, retourne null) — important car server.js peut
  // recevoir des fragments avant toute activation.
  check('processFragment() ne fait rien si le mode est inactif', () => {
    const { rm, calls } = makeReadingMode();
    const result = rm.processFragment('cet homme vint de nuit trouver jesus');
    assert.strictEqual(result, null);
    assert.strictEqual(calls.onVerseAdvance.length, 0);
  });

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
})();
