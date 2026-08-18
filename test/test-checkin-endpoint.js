'use strict';
/**
 * Test d'intégration — POST /api/checkin + son reflet dans getSessionStats
 * (chantier 4.6, présence anonyme via companion.html).
 */
process.env.PORT = process.env.PORT || '8776'; // distinct des autres tests
process.env.WS_HOST = '127.0.0.1';
process.env.CHURCHOVERLAY_SKIP_BIBLE_DOWNLOAD = '1';

require('../server.js');

const WebSocket = require('ws');

function assert(cond, msg) {
  if (!cond) {
    console.error('[TEST] ✗', msg);
    process.exit(1);
  }
  console.log('[TEST] ✓', msg);
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function connect() {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${process.env.PORT}/`);
    ws.testMessages = [];
    ws.on('message', (raw) => {
      try {
        ws.testMessages.push(JSON.parse(raw.toString()));
      } catch (_) {
        /* ignore */
      }
    });
    ws.on('open', async () => {
      await sleep(100);
      resolve(ws);
    });
  });
}

function waitForMessage(ws, predicate, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const poll = () => {
      const idx = ws.testMessages.findIndex(predicate);
      if (idx !== -1) {
        resolve(ws.testMessages.splice(idx, 1)[0]);
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error('timeout en attente du message'));
        return;
      }
      setTimeout(poll, 20);
    };
    poll();
  });
}

async function checkin() {
  const res = await fetch(`http://127.0.0.1:${process.env.PORT}/api/checkin`, { method: 'POST' });
  return res.json();
}

async function getCheckinCount(ws) {
  ws.send(JSON.stringify({ action: 'getSessionStats', days: 1 }));
  const stats = await waitForMessage(ws, (m) => m.action === 'sessionStats');
  return stats.checkinCount;
}

(async () => {
  await sleep(300);

  console.log('\n=== POST /api/checkin ===\n');

  const first = await checkin();
  assert(first.ok === true, 'POST /api/checkin répond {ok: true}');

  const ws = await connect();
  await waitForMessage(ws, (m) => m.action === 'init');

  // CORRECTIF (trouvé en écrivant ce test) : ce process require() server.js
  // directement, sans workerData -- USER_DATA_DIR retombe donc sur le vrai
  // ~/.churchoverlay de la machine (voir server.js#USER_DATA_DIR), partagé
  // avec toute autre exécution de cette même suite le même jour. Une
  // assertion sur un COMPTE ABSOLU casserait dès la deuxième exécution de
  // `npm test` (les présences des runs précédents restent dans la fenêtre
  // "days: 1"). Mesure donc un DELTA avant/après plutôt qu'un total,
  // robuste à cet état ambiant.
  const before = await getCheckinCount(ws);
  await checkin();
  await checkin();
  const after = await getCheckinCount(ws);

  assert(
    after - before === 2,
    `getSessionStats reflète les 2 nouvelles présences enregistrées (delta obtenu: ${after - before})`
  );

  ws.close();
  console.log('\n=== Tous les tests /api/checkin sont passés ===');
  // CORRECTIF (trouvé en écrivant ce test) : plusieurs POST /api/checkin
  // suivis d'un process.exit() immédiat font planter le process sur cette
  // machine ("Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)",
  // src\win\async.c) — un bug connu Node/libuv sur Windows où un handle lié
  // à un socket keep-alive HTTP ou au checkpoint WAL de better-sqlite3 n'a
  // pas fini sa fermeture asynchrone quand exit() force l'arrêt. Isolé en
  // testant : 1 POST -> jamais de crash, 3 POST -> crash déterministe (3/3),
  // 3 POST + 500ms d'attente avant exit() -> jamais de crash (3/3). Épargne
  // ce délai pour laisser le nettoyage se terminer proprement plutôt que de
  // forcer l'arrêt en plein milieu.
  await sleep(500);
  process.exit(0);
})().catch((err) => {
  console.error("Erreur fatale dans le test d'intégration:", err);
  process.exit(1);
});
