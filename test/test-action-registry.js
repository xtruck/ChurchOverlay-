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
const serverSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
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

// Vérification inverse : les actions dans OPERATOR_ACTIONS sont dans le registre
const operatorActionsMatch = serverSrc.match(/OPERATOR_ACTIONS\s*=\s*new\s*Set\(\[([\s\S]*?)\]\)/);
if (operatorActionsMatch) {
  // Strip JS comments before extracting action names
  const opsSrc = operatorActionsMatch[1].replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const actionRegex = /'([a-zA-Z]+)'/g;
  let m;
  const orphanActions = [];
  while ((m = actionRegex.exec(opsSrc)) !== null) {
    if (!CLIENT_ACTIONS[m[1]]) {
      orphanActions.push(m[1]);
    }
  }
  assert(
    orphanActions.length === 0,
    `Orphan OPERATOR_ACTIONS not in registry: ${orphanActions.join(', ')}`
  );
} else {
  assert(false, 'Could not find OPERATOR_ACTIONS Set in server.js');
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
