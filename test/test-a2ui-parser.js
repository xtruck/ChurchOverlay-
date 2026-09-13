'use strict';

/**
 * ============================================================================
 *  test-a2ui-parser.js — Tests pour a2ui-parser.js (Generative UI A2UI)
 * ----------------------------------------------------------------------------
 *  AJOUT (chantier durcissement v1.0). parseA2UI() est pur (aucun DOM) —
 *  testé directement en Node, comme number-words.js/bilingual-matcher.js.
 *  renderA2UI() (DOM) n'est pas exercé ici (pas de précédent de mock DOM
 *  léger dans ce dépôt hors Playwright — voir integration-scene-composer.js
 *  pour un vrai rendu de scène en Chromium) : sa garde `typeof document ===
 *  'undefined'` est vérifiée à la place, pour au moins prouver qu'il échoue
 *  proprement hors navigateur plutôt que de planter sur un ReferenceError
 *  peu clair.
 * ============================================================================
 */

const { ALLOWED_TYPES, parseA2UI, renderA2UI } = require('../a2ui-parser');

let passed = 0;
let failed = 0;

function check(condition, message) {
  if (condition) {
    passed++;
  } else {
    failed++;
    console.error(`  FAIL: ${message}`);
  }
}

console.log('=== Catalogue fermé ===');
check(
  ALLOWED_TYPES.length === 5 &&
    ['Card', 'TextLabel', 'Button', 'TextInput', 'ProgressGauge'].every((t) =>
      ALLOWED_TYPES.includes(t)
    ),
  'exactement les 5 types du cahier des charges'
);

console.log('\n=== Composants valides ===');

check(parseA2UI({ type: 'TextLabel', props: { text: 'Bonjour' } }).valid, 'TextLabel simple');
check(
  parseA2UI({ type: 'TextLabel', props: { text: 'Bonjour', variant: 'heading' } }).valid,
  'TextLabel avec variant valide'
);
check(
  parseA2UI({ type: 'Button', props: { label: 'Voter', action: 'poll.vote.yes' } }).valid,
  'Button simple'
);
check(
  parseA2UI({ type: 'TextInput', props: { name: 'email', placeholder: 'vous@exemple.com' } }).valid,
  'TextInput simple'
);
check(
  parseA2UI({ type: 'ProgressGauge', props: { value: 42, max: 100, label: '42%' } }).valid,
  'ProgressGauge simple'
);

// Carte d'information avec formulaire de sondage sermon — le scénario du
// cahier des charges ("cartes d'information, formulaires de sondage sermon").
const pollCard = {
  type: 'Card',
  props: { title: 'Sondage', subtitle: 'Cette prédication vous a-t-elle été utile ?' },
  children: [
    { type: 'TextLabel', props: { text: 'Votre avis compte.' } },
    { type: 'Button', props: { label: 'Oui', action: 'sermonPoll.answer.yes' } },
    { type: 'Button', props: { label: 'Non', action: 'sermonPoll.answer.no', style: 'secondary' } },
    { type: 'ProgressGauge', props: { value: 12, max: 50, label: '12 réponses' } },
  ],
};
const pollResult = parseA2UI(pollCard);
check(pollResult.valid, 'carte de sondage sermon complète (Card + enfants mixtes)');
check(
  pollResult.valid && pollResult.root.children.length === 4,
  'les 4 enfants de la carte de sondage sont conservés'
);

check(parseA2UI(JSON.stringify(pollCard)).valid, 'accepte aussi une chaîne JSON (pas seulement un objet)');

console.log('\n=== Rejet strict — types hors catalogue ===');

check(!parseA2UI({ type: 'Html', props: { raw: '<b>x</b>' } }).valid, 'type "Html" rejeté');
check(!parseA2UI({ type: 'Script', props: {} }).valid, 'type "Script" rejeté');
check(!parseA2UI({ type: 'Iframe', props: { src: 'x' } }).valid, 'type "Iframe" rejeté');
check(!parseA2UI({ type: 'div', props: {} }).valid, 'balise HTML brute en guise de "type" rejetée');
check(!parseA2UI({}).valid, 'objet sans "type" rejeté');
check(!parseA2UI(null).valid, 'null rejeté');
check(!parseA2UI('pas du JSON {').valid, 'JSON invalide rejeté proprement (pas d’exception)');
check(!parseA2UI([{ type: 'TextLabel', props: { text: 'x' } }]).valid, 'un tableau en racine est rejeté (un seul nœud racine attendu)');

console.log('\n=== Rejet strict — injection HTML/JS dans une prop ===');

check(
  !parseA2UI({ type: 'TextLabel', props: { text: '<img src=x onerror=alert(1)>' } }).valid,
  'balise <img onerror=...> dans TextLabel.text rejetée'
);
check(
  !parseA2UI({ type: 'TextLabel', props: { text: '<script>alert(1)</script>' } }).valid,
  '<script> dans TextLabel.text rejeté'
);
check(
  !parseA2UI({ type: 'Button', props: { label: 'x', action: 'javascript:alert(1)' } }).valid,
  'URI javascript: dans Button.action rejetée'
);
check(
  !parseA2UI({ type: 'TextInput', props: { name: 'x', value: '<svg onload=alert(1)>' } }).valid,
  '<svg onload=...> dans TextInput.value rejeté'
);
check(
  parseA2UI({ type: 'TextLabel', props: { text: 'Prix : 3 < 5, vrai.' } }).valid,
  'un simple "<" mathématique (pas une balise) reste accepté'
);

console.log('\n=== Rejet strict — props / structure ===');

check(
  !parseA2UI({ type: 'TextLabel', props: {} }).valid,
  'prop requise manquante (TextLabel.text) rejetée'
);
check(
  !parseA2UI({ type: 'TextLabel', props: { text: 'x', onClick: 'doEvil()' } }).valid,
  'prop hors catalogue ("onClick") rejetée'
);
check(
  !parseA2UI({ type: 'ProgressGauge', props: { value: 'cent' } }).valid,
  'ProgressGauge.value non numérique rejeté'
);
check(
  !parseA2UI({ type: 'ProgressGauge', props: { value: Infinity } }).valid,
  'ProgressGauge.value non fini (Infinity) rejeté'
);
check(
  !parseA2UI({ type: 'TextLabel', props: { text: 'x' }, children: [{ type: 'TextLabel', props: { text: 'y' } }] })
    .valid,
  'un composant hors catalogue "allowsChildren" (TextLabel) avec des enfants est rejeté'
);
check(
  !parseA2UI({ type: 'Card', props: {}, children: 'pas-un-tableau' }).valid,
  '"children" qui n’est pas un tableau est rejeté'
);
check(
  !parseA2UI({
    type: 'Card',
    props: {},
    children: [{ type: 'Button', props: { label: 'x', action: 'y' }, extra: 'boom' }],
  }).valid,
  'un enfant invalide invalide tout l’arbre (rejet strict, pas un abandon partiel)'
);

console.log('\n=== Limites défensives ===');

let deep = { type: 'TextLabel', props: { text: 'feuille' } };
for (let i = 0; i < 12; i++) {
  deep = { type: 'Card', props: {}, children: [deep] };
}
check(!parseA2UI(deep).valid, 'arbre trop profond (> MAX_DEPTH) rejeté');

const manyChildren = {
  type: 'Card',
  props: {},
  children: Array.from({ length: 250 }, () => ({ type: 'TextLabel', props: { text: 'x' } })),
};
check(!parseA2UI(manyChildren).valid, 'arbre trop volumineux (> MAX_NODES) rejeté');

console.log('\n=== renderA2UI() — garde hors navigateur ===');
check(
  (() => {
    try {
      renderA2UI({ type: 'TextLabel', props: { text: 'x' } });
      return false;
    } catch (e) {
      return /DOM/.test(e.message);
    }
  })(),
  'renderA2UI() échoue proprement (pas de crash silencieux) sans document'
);

console.log(`\n=== Résultat A2UI parser : ${passed} passés, ${failed} échoués ===`);
if (failed > 0) {
  process.exit(1);
} else {
  console.log('Catalogue fermé A2UI conforme (rejet strict du hors-catalogue et des injections HTML/JS).');
}
