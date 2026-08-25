/**
 * ============================================================================
 *  test-obs-gating.js — Tests pour evaluateGate() (obs-controller.js)
 * ----------------------------------------------------------------------------
 *  AJOUT (audit — inspiré du protocole obs-websocket documenté dans
 *  obsproject/obs-websocket). evaluateGate() est une fonction pure (aucun
 *  accès réseau, aucune dépendance à `electron`) : on peut donc la tester
 *  directement en la requérant, sans mocker obs-websocket-js ni connecter
 *  quoi que ce soit à un vrai OBS.
 *
 *  Note : obs-controller.js require('electron') en haut de fichier pour
 *  safeStorage. Ce module de test n'appelle QUE evaluateGate (jamais
 *  connect()), donc `electron` n'a besoin d'être qu'un module chargeable
 *  sans planter — voir le stub minimal ci-dessous si le module réel
 *  `electron` n'est pas disponible en environnement de test pur Node
 *  (hors Electron).
 * ============================================================================
 */
'use strict';
const assert = require('assert');

// evaluateGate() n'appelle jamais safeStorage (utilisé uniquement par
// resolvePassword(), non exercé ici) : requérir obs-controller.js
// directement suffit, même hors contexte Electron réel.
const { evaluateGate, humanizeObsError } = require('../obs-controller');

console.log('=== Test OBS Gating (evaluateGate) ===\n');

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

// --- Gating désactivé : toujours ouvert, quel que soit l'état OBS --------
check(
  'gating désactivé -> toujours ouvert',
  evaluateGate({ sceneName: 'Louange', streaming: false, recording: false }, { enabled: false })
    .open === true
);

// --- Restriction par liste de scènes --------------------------------------
check(
  'scène dans la liste "en direct" -> ouvert',
  evaluateGate(
    { sceneName: 'Culte', streaming: false, recording: false },
    { enabled: true, liveSceneNames: ['Culte', 'Prédication'] }
  ).open === true
);

check(
  'scène hors de la liste "en direct" -> fermé',
  evaluateGate(
    { sceneName: 'Louange', streaming: false, recording: false },
    { enabled: true, liveSceneNames: ['Culte', 'Prédication'] }
  ).open === false
);

check(
  'liste de scènes vide -> aucune restriction par scène',
  evaluateGate(
    { sceneName: 'Peu importe', streaming: false, recording: false },
    { enabled: true, liveSceneNames: [] }
  ).open === true
);

check(
  'scène encore inconnue (null, avant le premier événement) + liste non vide -> fermé par prudence',
  evaluateGate(
    { sceneName: null, streaming: false, recording: false },
    { enabled: true, liveSceneNames: ['Culte'] }
  ).open === false
);

// --- Restriction par stream/enregistrement actif --------------------------
check(
  "requireStreamingOrRecording=true, ni l'un ni l'autre actif -> fermé",
  evaluateGate(
    { sceneName: null, streaming: false, recording: false },
    { enabled: true, requireStreamingOrRecording: true }
  ).open === false
);

check(
  'requireStreamingOrRecording=true, streaming actif -> ouvert',
  evaluateGate(
    { sceneName: null, streaming: true, recording: false },
    { enabled: true, requireStreamingOrRecording: true }
  ).open === true
);

check(
  'requireStreamingOrRecording=true, enregistrement actif (pas de stream) -> ouvert',
  evaluateGate(
    { sceneName: null, streaming: false, recording: true },
    { enabled: true, requireStreamingOrRecording: true }
  ).open === true
);

// --- Les deux conditions combinées (cumulatives) --------------------------
check(
  'les deux conditions activées, scène OK mais rien ne streame -> fermé',
  evaluateGate(
    { sceneName: 'Culte', streaming: false, recording: false },
    { enabled: true, liveSceneNames: ['Culte'], requireStreamingOrRecording: true }
  ).open === false
);

check(
  'les deux conditions activées et toutes deux satisfaites -> ouvert',
  evaluateGate(
    { sceneName: 'Culte', streaming: true, recording: false },
    { enabled: true, liveSceneNames: ['Culte'], requireStreamingOrRecording: true }
  ).open === true
);

// --- Robustesse : config manquante ou incomplète ---------------------------
check(
  'cfg null -> toujours ouvert (comportement par défaut sûr)',
  evaluateGate({ sceneName: 'X', streaming: false, recording: false }, null).open === true
);

check(
  'cfg enabled=true sans autre clé -> ouvert (aucune restriction configurée)',
  evaluateGate({ sceneName: 'X', streaming: false, recording: false }, { enabled: true }).open ===
    true
);

// --- humanizeObsError() (Partie 3.1 — assistant de connexion) --------------
// Traduit les erreurs de connexion brutes (obs-websocket-js / Node) en
// message actionnable pour l'opérateur — c'est ce message qui apparaît dans
// le panneau OBS et dans l'action WS 'obsConnectionStatus'.

check(
  'ECONNREFUSED -> message actionnable (OBS pas ouvert / WS pas activé)',
  /Outils.*Serveur WebSocket/.test(
    humanizeObsError(new Error('connect ECONNREFUSED 127.0.0.1:4455'))
  )
);

check(
  'ENOTFOUND -> message actionnable (adresse introuvable)',
  /Adresse introuvable/.test(humanizeObsError(new Error('getaddrinfo ENOTFOUND obs.local')))
);

check(
  'timeout -> message actionnable (délai dépassé)',
  /Délai de connexion dépassé/.test(humanizeObsError(new Error('connect ETIMEDOUT')))
);

check(
  'code 4009 (authentification) -> message actionnable (mot de passe incorrect)',
  humanizeObsError({ code: 4009, message: 'Authentication failed.' }) ===
    'Mot de passe OBS incorrect.'
);

check(
  'erreur inconnue -> message brut conservé (pas de message générique qui masque la vraie cause)',
  humanizeObsError(new Error('Something else entirely')) === 'Something else entirely'
);

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
