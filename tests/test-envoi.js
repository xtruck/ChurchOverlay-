/**
 * ============================================================================
 *  test-envoi.js — Simulateur d'envoi de versets (à usage de test uniquement)
 * ----------------------------------------------------------------------------
 *  Se connecte au serveur pont (server.js) et envoie un verset de test, comme
 *  le fera plus tard le pipeline micro/Speech-to-Text de l'étape 5.
 *  Sert uniquement à vérifier que le circuit complet fonctionne :
 *    ce script  →  server.js  →  overlay.html (Browser Source dans OBS)
 *
 *  USAGE :
 *    node test-envoi.js                    (envoie un verset par défaut)
 *    node test-envoi.js hide                (masque l'overlay)
 *
 *  Prérequis : server.js doit déjà être lancé (node server.js) dans un autre
 *  terminal, et overlay.html doit être ouvert (dans OBS ou un navigateur).
 * ============================================================================
 */

const WebSocket = require('ws');

const WS_URL = 'ws://localhost:8765';
const commande = process.argv[2] || 'show';

const socket = new WebSocket(WS_URL);

socket.on('open', () => {
  let message;

  if (commande === 'hide') {
    message = { action: 'hideVerse' };
  } else {
    message = {
      action: 'showVerse',
      reference: 'Jean 3:16 (test intégration OBS)',
      text: "Car Dieu a tant aimé le monde qu'il a donné son Fils unique, afin que quiconque croit en lui ne périsse point, mais qu'il ait la vie éternelle.",
      durationMs: 300000,  // 5 minutes
    };
  }

  console.log('[test-envoi] Envoi :', message);
  socket.send(JSON.stringify(message));

  // On laisse un court instant pour que le message parte avant de fermer.
  setTimeout(() => {
    socket.close();
    console.log('[test-envoi] Terminé.');
  }, 300);
});

socket.on('error', (err) => {
  console.error('[test-envoi] Impossible de se connecter à ' + WS_URL + ' — server.js est-il lancé ?');
  console.error('[test-envoi] Détail :', err.message);
  process.exit(1);
});
