'use strict';
/**
 * Tests unitaires pour mcp/church-ws-client.js — ChurchOverlayClient.
 * Contre un vrai serveur ws.Server local (pas server.js — juste le
 * protocole générique action/réponse qu'il implémente), pour vérifier la
 * corrélation requête/réponse (successActions / 'error' / timeout) sans
 * dépendre de toute la stack ChurchOverlay.
 */
const WebSocket = require('ws');
const { ChurchOverlayClient } = require('../mcp/church-ws-client');

let passed = 0;
let failed = 0;
function check(name, cond) {
  if (cond) {
    console.log('[TEST] ✓', name);
    passed++;
  } else {
    console.error('[TEST] ✗', name);
    failed++;
  }
}

function startFakeServer(onMessage) {
  return new Promise((resolve) => {
    const wss = new WebSocket.Server({ port: 0 }, () => {
      resolve(wss);
    });
    wss.on('connection', (ws) => {
      ws.on('message', (raw) => {
        const msg = JSON.parse(String(raw));
        onMessage(ws, msg);
      });
    });
  });
}

async function run() {
  // --- Réponse directe (ex. searchBible -> searchResults) ---
  {
    const wss = await startFakeServer((ws, msg) => {
      if (msg.action === 'searchBible') {
        ws.send(JSON.stringify({ action: 'searchResults', query: msg.query, results: ['ok'] }));
      }
    });
    const port = wss.address().port;
    const client = new ChurchOverlayClient({ url: `ws://127.0.0.1:${port}` });
    const res = await client.callAction(
      'searchBible',
      { query: 'amour' },
      { successActions: ['searchResults', 'searchError'] }
    );
    check('callAction: réponse directe reçue', res.action === 'searchResults');
    check('callAction: payload transmis intact', res.query === 'amour' && res.results[0] === 'ok');
    client.close();
    wss.close();
  }

  // --- Réponse via broadcast (écho au même client, ex. showVerse) ---
  {
    const wss = await startFakeServer((ws, msg) => {
      if (msg.action === 'showVerse') {
        // Simule broadcast() de server.js : envoyé à TOUS les clients, y
        // compris l'émetteur — ici il n'y a qu'un client, donc juste ws.
        ws.send(JSON.stringify({ action: 'showVerse', reference: msg.reference }));
        ws.send(JSON.stringify({ action: 'historyUpdated', history: [] })); // bruit à ignorer
      }
    });
    const port = wss.address().port;
    const client = new ChurchOverlayClient({ url: `ws://127.0.0.1:${port}` });
    const res = await client.callAction(
      'showVerse',
      { reference: 'Jean 3:16' },
      { successActions: ['showVerse'] }
    );
    check('callAction: écho broadcast traité comme succès', res.action === 'showVerse');
    check('callAction: message de bruit (historyUpdated) ignoré', res.reference === 'Jean 3:16');
    client.close();
    wss.close();
  }

  // --- Erreur serveur ---
  {
    const wss = await startFakeServer((ws, msg) => {
      if (msg.action === 'showVerse') {
        ws.send(JSON.stringify({ action: 'error', error: 'Référence invalide.' }));
      }
    });
    const port = wss.address().port;
    const client = new ChurchOverlayClient({ url: `ws://127.0.0.1:${port}` });
    let caught = null;
    try {
      await client.callAction('showVerse', { reference: 'xyz' }, { successActions: ['showVerse'] });
    } catch (err) {
      caught = err;
    }
    check(
      'callAction: erreur serveur rejette la promesse',
      caught && caught.message === 'Référence invalide.'
    );
    client.close();
    wss.close();
  }

  // --- Timeout (aucune réponse) ---
  {
    const wss = await startFakeServer(() => {
      /* ne répond jamais */
    });
    const port = wss.address().port;
    const client = new ChurchOverlayClient({ url: `ws://127.0.0.1:${port}` });
    let caught = null;
    try {
      await client.callAction('hideVerse', {}, { successActions: ['hideVerse'], timeoutMs: 200 });
    } catch (err) {
      caught = err;
    }
    check('callAction: timeout rejette la promesse', caught && /Timeout/.test(caught.message));
    client.close();
    wss.close();
  }

  // --- Sous-protocole (jeton d'authentification) transmis à la connexion ---
  {
    let seenProtocol = null;
    const wss = await new Promise((resolve) => {
      const server = new WebSocket.Server({ port: 0 }, () => resolve(server));
      server.on('connection', (ws, req) => {
        seenProtocol = req.headers['sec-websocket-protocol'];
      });
    });
    const port = wss.address().port;
    const client = new ChurchOverlayClient({
      url: `ws://127.0.0.1:${port}`,
      authToken: 'test-token-123',
    });
    await client.connect();
    check('connect: jeton transmis en sous-protocole WS', seenProtocol === 'test-token-123');
    client.close();
    wss.close();
  }

  // --- Fermeture de connexion pendant une requête en attente ---
  {
    const wss = await startFakeServer(() => {
      /* ferme la connexion sans répondre — voir plus bas */
    });
    const port = wss.address().port;
    const client = new ChurchOverlayClient({ url: `ws://127.0.0.1:${port}` });
    await client.connect();
    const callPromise = client
      .callAction('hideVerse', {}, { successActions: ['hideVerse'], timeoutMs: 5000 })
      .catch((err) => err);
    client.ws.close();
    const result = await callPromise;
    check(
      "connexion fermée pendant l'attente: la requête échoue proprement (pas de pendaison)",
      result instanceof Error
    );
    wss.close();
  }

  // --- Corrélation requête/réponse sous requêtes concurrentes de MÊME type
  // d'action, répondues dans l'ordre INVERSE (voir Phase 1G — l'en-tête de
  // church-ws-client.js documentait cette fragilité : correspondance FIFO
  // par simple type d'action, "un outil MCP à la fois" supposé). Un vrai
  // requestId doit garantir que chaque appel reçoit SA PROPRE réponse, peu
  // importe l'ordre d'arrivée — pas juste "une réponse de ce type-là".
  {
    const wss = await startFakeServer((ws, msg) => {
      if (msg.action === 'showVerse') {
        // Répond en ordre INVERSE de réception : la référence B (2e requête
        // envoyée) répond EN PREMIER — le pire cas pour une corrélation FIFO.
        const delay = msg.reference === 'A' ? 40 : 5;
        setTimeout(() => {
          ws.send(
            JSON.stringify({
              action: 'showVerse',
              reference: msg.reference,
              requestId: msg.requestId,
            })
          );
        }, delay);
      }
    });
    const port = wss.address().port;
    const client = new ChurchOverlayClient({ url: `ws://127.0.0.1:${port}` });
    const [resA, resB] = await Promise.all([
      client.callAction('showVerse', { reference: 'A' }, { successActions: ['showVerse'] }),
      client.callAction('showVerse', { reference: 'B' }, { successActions: ['showVerse'] }),
    ]);
    check(
      'callAction: deux requêtes concurrentes de même action, répondues en ordre inverse, résolvent CHACUNE avec sa propre réponse',
      resA.reference === 'A' && resB.reference === 'B'
    );
    client.close();
    wss.close();
  }

  console.log(`\n=== Résultat mcp/church-ws-client : ${passed}/${passed + failed} ===`);
  if (failed > 0) process.exit(1);
}

run();
