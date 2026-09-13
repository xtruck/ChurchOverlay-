'use strict';

/**
 * ============================================================================
 *  test-a2ui-companion.js — Generative UI A2UI sur /companion (chantier
 *  ultime)
 * ----------------------------------------------------------------------------
 *  Couvre la chaîne complète décrite au cahier des charges, à chaque
 *  frontière testée isolément (pas de serveur réel — mêmes raisons que
 *  test-transcription-corrector.js/test-asr-engine.js pour les chantiers
 *  précédents : ces fonctions sont pures ou quasi-pures, un serveur réel
 *  n'ajouterait que de la lenteur sans plus de garantie) :
 *   1. sermon-qa.js#buildSummaryCard/buildQuestionAnswerCard/buildPollCard —
 *      produisent bien une racine A2UI déjà validée (parseA2UI), jamais un
 *      JSON brut non vérifié.
 *   2. Rejet strict : une entrée malformée/hostile ne produit JAMAIS une
 *      fiche partielle, seulement null (jamais de fiche à moitié valide
 *      publiée sur une page accessible à tout le public).
 *   3. session-state.js#getCompanionCard/setCompanionCard/clearCompanionCard
 *      — l'état que sert /api/companion-card (http-routes.js).
 *   4. a2ui-parser.js#renderA2UI() sur les fiches RÉELLEMENT produites par
 *      les builders ci-dessus (pas des fixtures inventées) — prouve que la
 *      chaîne bout-en-bout (LLM -> builder -> validation -> rendu DOM) tient,
 *      avec un DOM minimal simulé (aucune dépendance navigateur/Playwright
 *      nécessaire pour ce niveau de test, contrairement à
 *      test-multiview-switcher.js qui, lui, doit vérifier une VRAIE page).
 * ============================================================================
 */

const assert = require('assert');
const sermonQa = require('../sermon-qa');
const { parseA2UI, ALLOWED_TYPES } = require('../a2ui-parser');
const sessionState = require('../session-state');

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log('[TEST] ✓', name);
    passed++;
  } else {
    console.error('[TEST] ✗', name, detail ? '— ' + detail : '');
    failed++;
  }
}

console.log('=== Tests A2UI sur /companion (chantier ultime) ===\n');

// ---------------------------------------------------------------------------
// 1. buildSummaryCard()
// ---------------------------------------------------------------------------
console.log('--- sermon-qa.js#buildSummaryCard() ---');

{
  const card = sermonQa.buildSummaryCard({
    summarized: true,
    summary: 'Un beau message sur la grâce.',
  });
  check('résumé valide : produit une racine A2UI', card && card.type === 'Card');
  check(
    'résumé valide : le texte survit intact',
    card.children[0].props.text === 'Un beau message sur la grâce.'
  );
  check('résumé valide : re-validable par parseA2UI (déjà propre)', parseA2UI(card).valid === true);
}
check(
  'pas encore de transcription (summarized:false) -> null, jamais une fiche vide',
  sermonQa.buildSummaryCard({ summarized: false, message: 'rien pour le moment' }) === null
);
check('summaryResult null -> null (jamais un throw)', sermonQa.buildSummaryCard(null) === null);
check(
  'summarized:true mais summary manquant -> null (jamais une Card sans contenu)',
  sermonQa.buildSummaryCard({ summarized: true }) === null
);

// ---------------------------------------------------------------------------
// 2. buildQuestionAnswerCard()
// ---------------------------------------------------------------------------
console.log('\n--- sermon-qa.js#buildQuestionAnswerCard() ---');

{
  const card = sermonQa.buildQuestionAnswerCard('Que dit le sermon sur la foi ?', {
    answered: true,
    answer: 'La foi est le fondement de tout.',
    sources: [{ label: 'Prédication du 12 janvier', date: '2026-01-12' }],
  });
  check('réponse valide : produit une racine A2UI', card && card.type === 'Card');
  check('réponse valide : 3 enfants (question + réponse + 1 source)', card.children.length === 3);
  check(
    'réponse valide : la source citée apparaît, avec sa date',
    card.children[2].props.text.includes('Prédication du 12 janvier') &&
      card.children[2].props.text.includes('2026-01-12')
  );
}
check(
  'question non trouvée (answered:false, message de repli) -> quand même une fiche',
  sermonQa.buildQuestionAnswerCard('Question hors sujet', {
    answered: false,
    message: 'Aucun contenu de prédication ne correspond à cette question.',
  }) !== null
);
check(
  'answerResult null -> null (jamais un throw)',
  sermonQa.buildQuestionAnswerCard('Une question', null) === null
);
{
  // AJOUT (défense en profondeur) : même si sanitizeForPrompt() en amont
  // (ai-assistant-ws-handlers.js) neutralise déjà les injections de prompt,
  // ce builder ne doit JAMAIS produire de fiche exploitable si un texte
  // contenant une balise lui parvient malgré tout — deuxième filet,
  // jamais une confiance aveugle en un seul point de défense.
  const hostileCard = sermonQa.buildQuestionAnswerCard('Q', {
    answered: true,
    answer: '<img src=x onerror=alert(1)>',
  });
  check(
    'réponse contenant une balise HTML -> rejetée (null), jamais publiée',
    hostileCard === null
  );
}

// ---------------------------------------------------------------------------
// 3. buildPollCard()
// ---------------------------------------------------------------------------
console.log('\n--- sermon-qa.js#buildPollCard() ---');

{
  const card = sermonQa.buildPollCard('Cette prédication vous a-t-elle été utile ?', [
    { label: 'Oui', action: 'sermonPoll.yes' },
    { label: 'Non', action: 'sermonPoll.no' },
  ]);
  check(
    'sondage valide : produit une racine A2UI avec 2 boutons',
    card && card.children.length === 2
  );
  check(
    'sondage valide : chaque enfant est bien un Button',
    card.children.every((c) => c.type === 'Button')
  );
}
check('aucune option -> null (jamais un sondage vide)', sermonQa.buildPollCard('Q', []) === null);
check('options absentes -> null', sermonQa.buildPollCard('Q', undefined) === null);
{
  const card = sermonQa.buildPollCard('Q', [
    { label: 'A', action: 'a' },
    { label: 'B', action: 'b' },
    { label: 'C', action: 'c' },
    { label: 'D', action: 'd' },
    { label: 'E (en trop)', action: 'e' },
  ]);
  check('plus de 4 options -> tronqué au catalogue A2UI (4 max)', card.children.length === 4);
}

// ---------------------------------------------------------------------------
// 4. session-state.js — état /api/companion-card
// ---------------------------------------------------------------------------
console.log('\n--- session-state.js — companionCard ---');

check('état initial : aucune fiche', sessionState.getCompanionCard() === null);
{
  const card = sermonQa.buildSummaryCard({ summarized: true, summary: 'x' });
  sessionState.setCompanionCard(card);
  check('setCompanionCard() : relu identique', sessionState.getCompanionCard() === card);
  sessionState.clearCompanionCard();
  check('clearCompanionCard() : retour à null', sessionState.getCompanionCard() === null);
}
check(
  'setCompanionCard(undefined) : retombe sur null (jamais undefined exposé à /api/companion-card)',
  (sessionState.setCompanionCard(undefined), sessionState.getCompanionCard() === null)
);

// ---------------------------------------------------------------------------
// 5. a2ui-parser.js#renderA2UI() sur les fiches réellement produites
// ---------------------------------------------------------------------------
console.log('\n--- a2ui-parser.js#renderA2UI() bout-en-bout (DOM minimal simulé) ---');

/**
 * DOM minimal — juste assez pour que renderA2UI() (qui n'utilise que
 * document.createElement + .textContent/.className/.appendChild/
 * addEventListener) s'exécute sans erreur et produise une structure
 * inspectable. Pas de dépendance jsdom : aucun précédent de ce genre dans ce
 * dépôt (voir test-a2ui-parser.js, qui teste délibérément SANS document —
 * ce test-ci va un cran plus loin pour prouver la chaîne bout-en-bout côté
 * fiches RÉELLEMENT produites par sermon-qa.js).
 */
function makeFakeElement(tag) {
  return {
    tagName: tag.toUpperCase(),
    className: '',
    textContent: '',
    children: [],
    listeners: {},
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    addEventListener(evt, fn) {
      this.listeners[evt] = fn;
    },
  };
}

global.document = { createElement: (tag) => makeFakeElement(tag) };
delete require.cache[require.resolve('../a2ui-parser')];
const { renderA2UI: renderA2UIWithDom } = require('../a2ui-parser');

{
  const pollCard = sermonQa.buildPollCard('Utile ?', [
    { label: 'Oui', action: 'sermonPoll.yes' },
    { label: 'Non', action: 'sermonPoll.no' },
  ]);
  let capturedAction = null;
  const el = renderA2UIWithDom(pollCard, (action) => {
    capturedAction = action;
  });
  check('rendu bout-en-bout : élément racine créé (DIV, Card)', el.tagName === 'DIV');
  // La Card a un titre ET un sous-titre (voir buildPollCard) : 2 divs
  // d'en-tête + 2 boutons = 4 enfants au total, les boutons en dernier
  // (voir renderA2UI#Card : title/subtitle ajoutés AVANT les children).
  check(
    'rendu bout-en-bout : titre + sous-titre + 2 boutons = 4 enfants',
    el.children.length === 4
  );
  const [firstBtn] = el.children.slice(2);
  check(
    'rendu bout-en-bout : le texte du bouton est posé via textContent (jamais innerHTML)',
    firstBtn.tagName === 'BUTTON' && firstBtn.textContent === 'Oui'
  );
  firstBtn.listeners.click();
  check(
    "rendu bout-en-bout : cliquer le bouton transmet l'action OPAQUE, jamais exécutée",
    capturedAction === 'sermonPoll.yes'
  );
}
delete global.document;

console.log(`\n=== Résultat A2UI /companion : ${passed} passés, ${failed} échoués ===`);
if (failed > 0) {
  process.exit(1);
} else {
  console.log('Chaîne A2UI (sermon-qa.js -> parseA2UI -> session-state -> renderA2UI) conforme.');
}
