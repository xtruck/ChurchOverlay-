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
const {
  normalizeTriggerText,
  findTriggerMatch,
  findPhoneticCollisions,
} = require('../voice-trigger-matcher');

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

// ---------------------------------------------------------------------------
// findPhoneticCollisions (Partie 2.3 — Mur Média, collisions dès l'import)
// ---------------------------------------------------------------------------
const existing = [
  { id: 'm1', label: 'Photo groupe jeunes', triggerPhrases: ['groupe jeunes'] },
  { id: 'm2', label: 'Verset accueil', triggerPhrases: ['verset d’accueil', 'bienvenue'] },
];

check(
  'phrase identique (exacte) -> collision distance 0, exact=true',
  (() => {
    const c = findPhoneticCollisions(['groupe jeunes'], existing);
    return c.length === 1 && c[0].distance === 0 && c[0].exact === true && c[0].withItem.id === 'm1';
  })()
);

check(
  'phrase très proche (1 caractère de différence, "jeunes" -> "jeune") -> collision détectée, exact=false',
  (() => {
    const c = findPhoneticCollisions(['groupe jeune'], existing);
    return c.some((x) => x.withItem.id === 'm1' && x.exact === false && x.distance === 1);
  })()
);

check(
  'phrase clairement différente -> aucune collision',
  findPhoneticCollisions(['vidéo de louange'], existing).length === 0
);

check(
  'excludeId ignore ses propres phrases (édition d’un élément existant)',
  findPhoneticCollisions(['groupe jeunes'], existing, { excludeId: 'm1' }).length === 0
);

check(
  'plusieurs phrases candidates -> chaque collision remontée séparément',
  findPhoneticCollisions(['bienvenue', 'verset accueil'], existing).length >= 2
);

check(
  'liste existante vide -> aucune collision, pas d’exception',
  findPhoneticCollisions(['peu importe'], []).length === 0
);

check(
  'phrases candidates vides/undefined -> aucune collision, pas d’exception',
  findPhoneticCollisions([], existing).length === 0 &&
    findPhoneticCollisions(undefined, existing).length === 0
);

check(
  'trié par distance croissante (les plus proches en premier)',
  (() => {
    const c = findPhoneticCollisions(['groupe jeunes', 'groupe jeune'], existing);
    return c.every((x, i) => i === 0 || c[i - 1].distance <= x.distance);
  })()
);

assert.strictEqual(failed, 0, `${failed} test(s) échoué(s)`);
console.log(`\n=== Résultat voice-trigger-matcher : ${passed} passés, ${failed} échoués ===`);
process.exit(failed > 0 ? 1 : 0);
