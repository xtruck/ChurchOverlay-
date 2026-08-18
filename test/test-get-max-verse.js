'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const bibleOfflineCache = require('../bible-offline-cache');

console.log('=== Test getMaxVerse ===\n');

// Test 1: sans données chargées, retourne null
console.log('[TEST] Test 1: sans données chargées...');
assert.strictEqual(bibleOfflineCache.getMaxVerse('esaie', 53), null, 'null quand pas de données');
console.log('[TEST] ✓ Retourne null sans données\n');

// Test 2: avec données simulées
console.log('[TEST] Test 2: données simulées (mock)...');
{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bible-cache-test-'));
  // setUserDataDir crée un sous-dossier 'bible-offline' sous tmpDir
  bibleOfflineCache.setUserDataDir(tmpDir);

  const fakeData = {
    esaie: {
      53: {
        1: 'Texte verset 1',
        2: 'Texte verset 2',
        3: 'Texte verset 3',
        4: 'Texte verset 4',
        5: 'Texte verset 5',
        6: 'Texte verset 6',
        7: 'Texte verset 7',
        8: 'Texte verset 8',
        9: 'Texte verset 9',
        10: 'Texte verset 10',
        11: 'Texte verset 11',
        12: 'Texte verset 12',
      },
      54: {
        1: 'Texte verset 1',
        2: 'Texte verset 2',
        3: 'Texte verset 3',
      },
    },
    psaumes: {
      119: {},
    },
  };

  const filePath = path.join(tmpDir, 'bible-offline', 'fra_lsg.json');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(fakeData), 'utf8');

  // Déclencher le chargement en mémoire via getOfflineVerse
  bibleOfflineCache.getOfflineVerse({ book: 'esaie', chapter: 53 });

  // Ésaïe 53 → 12 versets
  assert.strictEqual(bibleOfflineCache.getMaxVerse('esaie', 53), 12, 'Ésaïe 53 = 12 versets');

  // Ésaïe 54 → 3 versets
  assert.strictEqual(bibleOfflineCache.getMaxVerse('esaie', 54), 3, 'Ésaïe 54 = 3 versets');

  // Psaumes 119 → chapitre vide → null
  assert.strictEqual(bibleOfflineCache.getMaxVerse('psaumes', 119), null, 'Chapitre vide = null');

  // Livre inexistant → null
  assert.strictEqual(
    bibleOfflineCache.getMaxVerse('livre_inexistant', 1),
    null,
    'Livre inexistant = null'
  );

  // Chapitre inexistant → null
  assert.strictEqual(
    bibleOfflineCache.getMaxVerse('esaie', 999),
    null,
    'Chapitre inexistant = null'
  );

  // Nettoyage
  try {
    fs.rmSync(path.join(tmpDir, 'bible-offline'), { recursive: true, force: true });
  } catch (_e) {
    /* ignore */
  }
}
console.log('[TEST] ✓ Tous les cas getMaxVerse corrects\n');

// Test 3: le verset 17 d'Ésaïe 53 serait rejeté
console.log('[TEST] Test 3: simulation rejet Ésaïe 53:17...');
{
  const maxVerse = bibleOfflineCache.getMaxVerse('esaie', 53);
  assert.ok(maxVerse !== null, 'maxVerse chargé');
  assert.strictEqual(17 > maxVerse, true, 'Ésaïe 53:17 > maxVerse → rejeté');
}
console.log('[TEST] ✓ Ésaïe 53:17 correctement identifié comme inexistant\n');

console.log('=== Tous les tests getMaxVerse sont passés ===');
