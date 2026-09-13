'use strict';

/**
 * ============================================================================
 *  test-ipc-security.js — Durcissement Electron & IPC type-safe
 * ----------------------------------------------------------------------------
 *  AJOUT (chantier durcissement v1.0). main.js require('electron') au
 *  chargement — comme integration-output-matrix.js le documente déjà dans
 *  son en-tête, aucun mock de 'electron' n'existe dans ce dépôt pour du code
 *  main-process, précisément parce qu'un tel mock (BrowserWindow, ipcMain,
 *  dialog, safeStorage...) serait lourd à maintenir en phase avec l'API
 *  réelle sans jamais garantir grand-chose de plus qu'une analyse du code
 *  source. Ce test vérifie donc, comme test-action-registry.js le fait déjà
 *  pour le registre d'actions WS, des INVARIANTS STRUCTURELS sur le texte
 *  source de main.js/preload.js — pas un comportement runtime.
 *
 *  Couvre les 3 exigences du chantier :
 *   1. Toute fenêtre BrowserWindow créée par main.js déclare
 *      contextIsolation:true, nodeIntegration:false, sandbox:true.
 *   2. preload.js n'expose jamais l'objet ipcRenderer brut sur window (ni
 *      littéralement, ni en le réexportant tel quel dans l'objet
 *      contextBridge.exposeInMainWorld) — seulement des fonctions qui
 *      l'enveloppent (invoke/send/on).
 *   3. Les handlers ipcMain.handle() migrés vers le modèle Result (voir
 *      ipc-result.js) ne mélangent jamais cette forme avec l'ancienne
 *      convention { ok, error } — la migration doit être totale, jamais
 *      partielle sur un même handler.
 *  Plus des tests unitaires purs sur ipc-result.js lui-même (aucune
 *  dépendance Electron, exécutables normalement).
 * ============================================================================
 */

const fs = require('fs');
const path = require('path');
const { okResult, errResult, isResult } = require('../ipc-result');

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

const ROOT = path.join(__dirname, '..');
const mainSrc = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
const preloadSrc = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8');

// ---------------------------------------------------------------------------
// 1. ipc-result.js — comportement pur
// ---------------------------------------------------------------------------
console.log('=== ipc-result.js ===');

check(JSON.stringify(okResult()) === JSON.stringify({ success: true }), 'okResult() sans payload');
check(
  JSON.stringify(okResult({ a: 1 })) === JSON.stringify({ success: true, data: { a: 1 } }),
  'okResult(data) inclut data'
);
check(
  JSON.stringify(errResult('boom')) === JSON.stringify({ success: false, error: 'boom' }),
  'errResult(string)'
);
check(
  errResult(new Error('boom')).error === 'boom',
  'errResult(Error) extrait .message, pas l’objet Error (IPC sérialise en JSON)'
);
check(isResult(okResult()) && isResult(okResult({ x: 1 })), 'isResult() reconnaît un succès');
check(isResult(errResult('e')), 'isResult() reconnaît un échec');
check(!isResult({ ok: true }), 'isResult() rejette l’ancienne forme { ok }');
check(!isResult({ success: true, error: 'x' }), 'isResult() rejette success+error simultanés');
check(!isResult({ success: false, data: 1 }), 'isResult() rejette success:false+data simultanés');
check(!isResult(null) && !isResult('x') && !isResult(42), 'isResult() rejette les non-objets');

// ---------------------------------------------------------------------------
// 2. Durcissement BrowserWindow (contextIsolation / sandbox / nodeIntegration)
// ---------------------------------------------------------------------------
console.log('\n=== Durcissement BrowserWindow ===');

const windowBlockCount = (mainSrc.match(/new BrowserWindow\(/g) || []).length;
check(windowBlockCount >= 1, 'au moins une fenêtre BrowserWindow créée dans main.js');

// Découpe grossière par bloc de fenêtre : chaque occurrence de
// "new BrowserWindow(" jusqu'à la fermeture correspondante n'est pas triviale
// à parser par regex (accolades imbriquées) — on vérifie donc à la place que
// le nombre d'occurrences de chaque garde de sécurité est AU MOINS égal au
// nombre de fenêtres, ce qui est déjà violé si UNE SEULE fenêtre omet un
// réglage (les trois réglages n'apparaissent nulle part ailleurs dans
// main.js pour une autre raison — vérifié : uniquement dans les blocs
// webPreferences).
const contextIsolationCount = (mainSrc.match(/contextIsolation:\s*true/g) || []).length;
const nodeIntegrationCount = (mainSrc.match(/nodeIntegration:\s*false/g) || []).length;
const sandboxCount = (mainSrc.match(/sandbox:\s*true/g) || []).length;

check(
  contextIsolationCount >= windowBlockCount,
  `contextIsolation:true doit apparaître au moins ${windowBlockCount} fois (trouvé ${contextIsolationCount})`
);
check(
  nodeIntegrationCount >= windowBlockCount,
  `nodeIntegration:false doit apparaître au moins ${windowBlockCount} fois (trouvé ${nodeIntegrationCount})`
);
check(
  sandboxCount >= windowBlockCount,
  `sandbox:true doit apparaître au moins ${windowBlockCount} fois (trouvé ${sandboxCount})`
);

// Aucune fenêtre ne doit explicitement désactiver ces gardes ailleurs.
check(!/contextIsolation:\s*false/.test(mainSrc), 'aucune fenêtre avec contextIsolation:false');
check(!/nodeIntegration:\s*true/.test(mainSrc), 'aucune fenêtre avec nodeIntegration:true');
check(!/sandbox:\s*false/.test(mainSrc), 'aucune fenêtre avec sandbox:false');

// ---------------------------------------------------------------------------
// 3. preload.js — pas d'ipcRenderer brut exposé
// ---------------------------------------------------------------------------
console.log('\n=== preload.js — pas d’ipcRenderer brut exposé ===');

const bridgeCallMatch = preloadSrc.match(
  /contextBridge\.exposeInMainWorld\(\s*['"][^'"]+['"]\s*,\s*\{([\s\S]*)\}\s*\)\s*;?\s*$/m
);
check(!!bridgeCallMatch, 'preload.js appelle bien contextBridge.exposeInMainWorld({...})');
const bridgeBody = bridgeCallMatch ? bridgeCallMatch[1] : '';

// L'objet exposé ne doit contenir aucune propriété qui RÉEXPORTE
// ipcRenderer tel quel (ex. `ipcRenderer,` en raccourci ES6, ou
// `ipcRenderer: ipcRenderer`) — seules des fonctions qui l'enveloppent
// (`(...) => ipcRenderer.invoke(...)`, `.on(...)`) sont autorisées.
check(
  !/(^|[^.\w])ipcRenderer\s*,/.test(bridgeBody) && !/ipcRenderer\s*:\s*ipcRenderer/.test(bridgeBody),
  'aucune propriété n’expose ipcRenderer lui-même (raccourci ou alias direct)'
);
check(
  !/window\.ipcRenderer\s*=/.test(preloadSrc),
  'aucune assignation directe de window.ipcRenderer ailleurs dans preload.js'
);
// Chaque usage d'ipcRenderer dans le pont doit être un APPEL de méthode
// (.invoke/.send/.on/.removeListener), jamais l'identifiant seul renvoyé.
const bareIpcRendererReturn = /return\s+ipcRenderer\s*;/.test(bridgeBody);
check(!bareIpcRendererReturn, 'aucune fonction du pont ne renvoie ipcRenderer lui-même');

// ---------------------------------------------------------------------------
// 4. Modèle Result — migration totale, jamais mélangée sur un handler migré
// ---------------------------------------------------------------------------
console.log('\n=== Modèle Result IPC — pas de forme mélangée ===');

// Les canaux ci-dessous ont été migrés vers okResult()/errResult() dans le
// cadre de ce chantier (voir main.js) — la liste sert de repère volontaire :
// si l'un d'eux régresse vers l'ancienne forme { ok, error }, ce test doit le
// détecter plutôt que de laisser un renderer lire un champ qui n'existe plus.
const migratedChannels = [
  'save-setup',
  'save-network-settings',
  'set-asr-provider',
  'clear-api-key',
  'list-themes',
  'get-active-theme',
  'set-active-theme',
  'obs-get-config',
  'obs-set-config',
  'obs-connect',
  'obs-list-scenes',
  'obs-switch-scene',
  'obs-toggle-recording',
  'obs-toggle-streaming',
  'propresenter-get-config',
  'propresenter-set-config',
  'propresenter-connect',
  'propresenter-send-message',
  'pco-get-config',
  'pco-set-config',
  'pco-fetch-plan-items',
];

/**
 * Extrait le texte complet d'un appel `ipcMain.handle('channel', ...)` en
 * comptant les parenthèses depuis le `(` d'ouverture jusqu'à sa fermeture —
 * plus fiable qu'une regex non-gourmande face à des accolades/parenthèses
 * imbriquées (try/catch, callbacks) dans le corps du handler.
 * @param {string} src
 * @param {string} channel
 * @returns {string|null}
 */
function extractHandlerCall(src, channel) {
  const marker = new RegExp(`ipcMain\\.handle\\(\\s*['"]${channel}['"]`);
  const startMatch = src.match(marker);
  if (!startMatch) return null;
  const openParenIdx = src.indexOf('(', startMatch.index + 'ipcMain.handle'.length);
  if (openParenIdx === -1) return null;
  let depth = 0;
  for (let i = openParenIdx; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')') {
      depth--;
      if (depth === 0) return src.slice(startMatch.index, i + 1);
    }
  }
  return null; // parenthèse jamais refermée — fichier tronqué/corrompu
}

for (const channel of migratedChannels) {
  const body = extractHandlerCall(mainSrc, channel);
  check(!!body, `ipcMain.handle('${channel}', ...) trouvé dans main.js`);
  if (!body) continue;
  check(
    /\bokResult\(/.test(body) && /\berrResult\(/.test(body),
    `'${channel}' utilise okResult()/errResult() sur ses deux chemins`
  );
  check(
    !/\{\s*ok\s*:\s*(true|false)/.test(body),
    `'${channel}' ne renvoie plus l’ancienne forme { ok: ... }`
  );
}

check(
  !/\{\s*ok\s*:\s*true/.test(mainSrc) && !/\{\s*ok\s*:\s*false/.test(mainSrc),
  'main.js ne contient plus AUCUNE occurrence de l’ancienne forme { ok: true|false }'
);

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n=== Résultat IPC security : ${passed} passés, ${failed} échoués ===`);
if (failed > 0) {
  process.exit(1);
} else {
  console.log('Durcissement Electron/IPC conforme.');
}
