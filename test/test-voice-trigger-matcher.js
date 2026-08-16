/**
 * ============================================================================
 *  test-voice-trigger-matcher.js — Tests pour voice-trigger-matcher.js
 * ----------------------------------------------------------------------------
 *  Mutualisé depuis media-library.js/song-library.js (Chantier D, mission
 *  autonome) — ces deux fichiers dupliquaient exactement le même
 *  normalize()/matchTriggerPhrase(). Ce test couvre le module partagé une
 *  seule fois ; test-media-library.js et test-song-library.js continuent de
 *  couvrir leur propre wrapper (forme de retour spécifique à chacun).
 * ============================================================================
 */
'use strict';
const assert = require('assert');
const { normalizeTriggerText, findTriggerMatch } = require('../voice-trigger-matcher');

console.log('=== Test voice-trigger-matcher ===\n');

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

// ---------------------------------------------------------------------------
// normalizeTriggerText
// ---------------------------------------------------------------------------
check(
  'minuscules + accents retirés + espaces de bord retirés',
  normalizeTriggerText('  Été Béni  ') === 'ete beni'
);
check('texte vide -> chaîne vide', normalizeTriggerText('') === '');
check('undefined/null -> chaîne vide, pas d’exception', normalizeTriggerText(undefined) === '');

// ---------------------------------------------------------------------------
// findTriggerMatch
// ---------------------------------------------------------------------------
const items = [
  { id: 'a', triggerPhrases: ['photo du bâtiment', 'notre église'] },
  { id: 'b', triggerPhrases: ['vidéo de louange'] },
];

check(
  'sous-chaîne trouvée (accents ignorés côté phrase déclencheuse ET texte transcrit)',
  findTriggerMatch(items, 'montrez-nous une photo du batiment svp')?.id === 'a'
);
check(
  'correspondance insensible à la casse',
  findTriggerMatch(items, 'MONTREZ NOTRE ÉGLISE')?.id === 'a'
);
check('aucune correspondance -> null', findTriggerMatch(items, 'bonjour à tous') === null);
check('texte vide -> null (jamais de crash sur chaîne vide)', findTriggerMatch(items, '') === null);
check('liste vide -> null', findTriggerMatch([], 'photo du bâtiment') === null);
check(
  'items undefined -> null, pas d’exception',
  findTriggerMatch(undefined, 'photo du bâtiment') === null
);
check(
  'item sans triggerPhrases -> ignoré, pas d’exception',
  findTriggerMatch([{ id: 'c' }], 'peu importe') === null
);

// getTriggerPhrases personnalisé (song-library.js n'a pas la même forme de
// retour que media-library.js, mais réutilise le même moteur de recherche).
const songs = [{ id: 's1', lyrics: { triggerPhrases: ['dieu est amour'] } }];
check(
  'getTriggerPhrases personnalisé (forme différente, ex. song-library.js)',
  findTriggerMatch(songs, 'chantons dieu est amour ensemble', (s) => s.lyrics.triggerPhrases)
    ?.id === 's1'
);

assert.strictEqual(failed, 0, `${failed} test(s) échoué(s)`);
console.log(`\n=== Résultat voice-trigger-matcher : ${passed} passés, ${failed} échoués ===`);
process.exit(failed > 0 ? 1 : 0);
