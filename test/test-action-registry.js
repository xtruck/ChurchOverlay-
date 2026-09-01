'use strict';

/**
 * test-action-registry.js — Vérifie la parité entre le registre d'actions
 * et le code d'exécution réel (server.js, voice-commands.js, overlay.js).
 *
 * Règle : chaque action dans le registre DOIT exister dans le code, et
 * chaque action dans le code DOIT exister dans le registre.
 */

const fs = require('fs');
const path = require('path');
const {
  CLIENT_ACTIONS,
  SERVER_ACTIONS,
  VOICE_COMMANDS,
  listClientActions,
  listServerActions,
  listVoiceCommands,
} = require('../action-registry');

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    passed++;
  } else {
    failed++;
    console.error(`  FAIL: ${message}`);
  }
}

// ---------------------------------------------------------------------------
// Read source files
// ---------------------------------------------------------------------------

const ROOT = path.join(__dirname, '..');
// CORRECTIF (Phase 2 — modularisation du dispatch WS) : les handlers de
// certaines actions ont commencé à migrer hors de server.js vers des
// modules dédiés (voir media-ws-handlers.js, CATEGORY_HANDLERS dans
// server.js) — une vérification qui ne lisait QUE server.js ne les trouvait
// plus, alors que le comportement réel est inchangé (juste déplacé). Inclut
// donc le texte de tous les modules `*-ws-handlers.js` du dépôt en plus de
// server.js, automatiquement (glob, pas une liste à maintenir à la main —
// chaque future extraction de catégorie n'a donc rien à changer ici).
const wsHandlerFiles = fs.readdirSync(ROOT).filter((f) => f.endsWith('-ws-handlers.js'));
const serverSrc =
  fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8') +
  '\n' +
  wsHandlerFiles.map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n');
const overlaySrc = fs.readFileSync(path.join(ROOT, 'overlay.js'), 'utf8');

// ---------------------------------------------------------------------------
// 1. CLIENT_ACTIONS: chaque action doit apparaître dans server.js
// ---------------------------------------------------------------------------

console.log('\n=== CLIENT_ACTIONS → server.js ===');
const clientActions = listClientActions();
for (const action of clientActions) {
  // Le serveur traite l'action dans le dispatch if/else ou switch
  const handled =
    serverSrc.includes(`action === '${action}'`) ||
    serverSrc.includes(`case '${action}'`) ||
    (serverSrc.includes(`'${action}'`) && serverSrc.includes(`msg.action`));
  assert(handled, `CLIENT action '${action}' not found in server.js dispatch`);
}

// Vérification : le trust tier RBAC (viewer vs operator) DOIT être dérivé du
// registre, pas d'une liste dupliquée à la main (c'est exactement ce qui a
// permis à 'obs-toggle-recording'/'obs-switch-scene' — des canaux IPC
// Electron, pas des actions WS — de traîner sans être détecté : la
// précédente vérification par regex ne matchait que des noms d'action
// purement alphabétiques, donc ignorait silencieusement tout ce qui contient
// un tiret).
assert(
  /OPERATOR_ACTIONS\s*=\s*new\s*Set\(\s*actionRegistry\.listOperatorOnlyActions\(\)\s*\)/.test(
    serverSrc
  ),
  "OPERATOR_ACTIONS doit être dérivé de actionRegistry.listOperatorOnlyActions(), pas d'une liste dupliquée à la main"
);

// Sanity check : quelques actions de lecture seule doivent rester
// volontairement accessibles aux viewers (voir commentaire au-dessus de
// OPERATOR_ACTIONS dans server.js).
for (const viewerSafe of ['ping', 'getTopics', 'getMoods', 'listPlugins', 'getAiStats']) {
  assert(
    !CLIENT_ACTIONS[viewerSafe]?.operatorOnly,
    `'${viewerSafe}' devrait rester accessible aux viewers (operatorOnly ne doit pas être défini)`
  );
}

// ---------------------------------------------------------------------------
// 2. SERVER_ACTIONS: chaque action doit apparaître dans server.js (broadcast)
// ---------------------------------------------------------------------------

console.log('\n=== SERVER_ACTIONS → server.js broadcast ===');
const serverActions = listServerActions();
for (const action of serverActions) {
  const sent = serverSrc.includes(`action: '${action}'`) || serverSrc.includes(`'${action}',`);
  assert(sent, `SERVER action '${action}' not broadcast in server.js`);
}

// ---------------------------------------------------------------------------
// 3. SERVER_ACTIONS: chaque action doit apparaître dans server.js (broadcast ou ws.send)
//    ou dans overlay.js / ws-dispatch.js
// ---------------------------------------------------------------------------

console.log('\n=== SERVER_ACTIONS → server.js/overlay/ws-dispatch ===');
const wsDispatchSrc = fs.readFileSync(path.join(ROOT, 'dashboard', 'ws-dispatch.js'), 'utf8');
for (const action of serverActions) {
  const consumed =
    serverSrc.includes(`action: '${action}'`) ||
    overlaySrc.includes(`case '${action}'`) ||
    overlaySrc.includes(`'${action}'`) ||
    wsDispatchSrc.includes(`'${action}'`);
  assert(consumed, `SERVER action '${action}' not consumed anywhere`);
}

// ---------------------------------------------------------------------------
// 4. VOICE_COMMANDS: chaque commande doit apparaître dans voice-commands.js
// ---------------------------------------------------------------------------

console.log('\n=== VOICE_COMMANDS → voice-commands.js ===');
const vcSrc = fs.readFileSync(path.join(ROOT, 'voice-commands.js'), 'utf8');
const vcActions = listVoiceCommands();
for (const action of vcActions) {
  const detected = vcSrc.includes(`'${action}'`) || vcSrc.includes(`"${action}"`);
  assert(detected, `VOICE command '${action}' not found in voice-commands.js`);
}

// ---------------------------------------------------------------------------
// 5. Nombre total d'actions (sanity check)
// ---------------------------------------------------------------------------

console.log('\n=== Sanity checks ===');
assert(clientActions.length >= 60, `Expected ≥60 client actions, got ${clientActions.length}`);
assert(serverActions.length >= 25, `Expected ≥25 server actions, got ${serverActions.length}`);
assert(vcActions.length >= 10, `Expected ≥10 voice commands, got ${vcActions.length}`);

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n=== Résultat: ${passed} passed, ${failed} failed ===`);
if (failed > 0) {
  process.exit(1);
} else {
  console.log('Toutes les actions sont en parité avec le code.');
}
