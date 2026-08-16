/**
 * ============================================================================
 *  test/test-ws-auth.js — Authentification & RBAC WebSocket (audit backend)
 * ----------------------------------------------------------------------------
 *  Régression pour les correctifs de l'audit backend (WS_AUTH_TOKEN /
 *  WS_VIEWER_TOKEN) :
 *
 *   1. Sans jeton (ou jeton invalide), la connexion est refusée (code 1008)
 *      dès que WS_AUTH_TOKEN est configuré.
 *   2. Le rôle d'un client est déterminé par LE JETON présenté (via l'en-tête
 *      de handshake Sec-WebSocket-Protocol), jamais par le chemin de l'URL —
 *      avant ce correctif, n'importe quel client demandant `/` obtenait le
 *      rôle 'operator' quel que soit le chemin réellement utilisé.
 *   3. Un client authentifié avec WS_VIEWER_TOKEN reste cantonné au rôle
 *      'viewer' même en se connectant sur `/` (et pas seulement `/overlay`).
 *   4. Le RBAC refuse bien une action opérateur (showVerse) envoyée par un
 *      client 'viewer'.
 *   5. `applyTheme` avec un payload `css` hors schéma (champ non autorisé,
 *      valeur trop longue, caractères de rupture de style) est rejeté par
 *      validation.js au lieu d'être diffusé tel quel.
 *
 *  Même approche que integration-quote-match.js : server.js tourne
 *  réellement ; seuls le réseau (API bibliques, Groq/Deepgram) et le micro
 *  sont mockés.
 * ============================================================================
 */
'use strict';
const path = require('path');
const Module = require('module');

function injectFakeModule(relativePath, exportsObj) {
  const abs = require.resolve(path.join(__dirname, '..', relativePath));
  const fake = new Module(abs, null);
  fake.filename = abs;
  fake.loaded = true;
  fake.exports = exportsObj;
  require.cache[abs] = fake;
  return abs;
}

injectFakeModule('bible-lookup-with-api.js', {
  async getChapterVerses() {
    throw new Error('non utilisé dans ce test');
  },
  async getVerseMultilang() {
    throw new Error('non utilisé dans ce test');
  },
  buildReferenceLabel(reference) {
    return `Jean ${reference.chapter}`;
  },
  resetFailedProviders() {},
  findByQuotedText() {
    return null;
  },
  setCacheDir() {},
  setTranslation() {},
  listTranslations() {
    return [];
  },
  getTranslationId() {
    return 'lsg';
  },
  getCacheSize() {
    return 0;
  },
  clearCache() {},
  getProviders() {
    return ['fake-provider'];
  },
});

injectFakeModule('groq-wrapper.js', {
  async transcribeFile() {
    throw new Error('non utilisé dans ce test');
  },
  async transcribeWithFallback() {
    return { text: '', source: 'fake-groq' };
  },
});

injectFakeModule('deepgram-wrapper.js', {
  isConfigured() {
    return false;
  },
  async transcribeFile() {
    throw new Error('non utilisé dans ce test');
  },
});

injectFakeModule('audio-capture.js', {
  startBrowserCapture() {},
  feedPcmChunk() {},
  stopRecording() {},
  cleanupTempFiles() {},
  isRecording() {
    return false;
  },
  on() {},
});

// -------------------------------------------------------------------------
// Jetons de test (>= 16 caractères, distincts l'un de l'autre)
// -------------------------------------------------------------------------
const OPERATOR_TOKEN = 'operator-token-for-tests-only';
const VIEWER_TOKEN = 'viewer-token-for-tests-only-2';
process.env.WS_AUTH_TOKEN = OPERATOR_TOKEN;
process.env.WS_VIEWER_TOKEN = VIEWER_TOKEN;
process.env.PORT = process.env.PORT || '8768'; // distinct des autres tests
process.env.WS_HOST = '127.0.0.1';
process.env.CHURCHOVERLAY_SKIP_BIBLE_DOWNLOAD = '1'; // pas de téléchargement biblique en test (crash libuv à l'arrêt sinon)

require('../server.js');

const WebSocket = require('ws');

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Ouvre une connexion WS vers le serveur de test et attend un court délai
 * pour voir si le serveur la referme immédiatement après le handshake
 * (rejet applicatif — ws.close(1008, ...) dans le handler 'connection').
 * Le rejet par jeton se produit APRÈS l'événement 'open' côté client (la
 * négociation de sous-protocole WebSocket réussit avant que le serveur ne
 * vérifie le jeton), donc 'open' seul ne suffit pas à savoir si la
 * connexion est acceptée.
 *
 * Tous les messages reçus sont bufferisés dès la création du socket pour
 * éviter une course avec le message `init`, envoyé par le serveur
 * immédiatement après acceptation.
 *
 * @param {Object} opts
 * @param {string} [opts.token] - jeton envoyé via Sec-WebSocket-Protocol
 * @param {string} [opts.path] - chemin de la requête (par défaut '/')
 */
function connect({ token, path: reqPath = '/' } = {}) {
  return new Promise((resolve) => {
    const url = `ws://127.0.0.1:${process.env.PORT}${reqPath}`;
    const ws = token ? new WebSocket(url, [token]) : new WebSocket(url);
    ws.testMessages = [];
    ws.on('message', (raw) => {
      try {
        ws.testMessages.push(JSON.parse(raw.toString()));
      } catch (_) {}
    });

    let closeCode = null;
    let closeReason = null;
    ws.on('close', (code, reason) => {
      closeCode = code;
      closeReason = reason.toString();
    });
    ws.on('error', () => {}); // ignoré : on statue sur 'close' ci-dessous

    ws.on('open', async () => {
      // Laisse une fenêtre pour un rejet applicatif post-handshake.
      await sleep(150);
      resolve({
        ws,
        opened: ws.readyState === WebSocket.OPEN,
        closeCode,
        closeReason,
      });
    });

    // La connexion peut aussi échouer avant tout 'open' (ex. handshake
    // HTTP refusé directement).
    ws.on('close', () => {
      setTimeout(() => resolve({ ws, opened: false, closeCode, closeReason }), 0);
    });
  });
}

function waitForMessage(ws, predicate, timeoutMs = 1000) {
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

(async () => {
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

  await sleep(300); // laisser le serveur WS s'initialiser complètement

  console.log('\n=== Authentification WebSocket ===\n');

  // 1) Aucun jeton -> connexion refusée (code 1008)
  {
    const { closeCode, opened } = await connect({});
    check(
      'connexion sans jeton refusée (1008)',
      !opened && closeCode === 1008,
      `opened=${opened} code=${closeCode}`
    );
  }

  // 2) Mauvais jeton -> connexion refusée
  {
    const { closeCode, opened } = await connect({ token: 'un-jeton-invalide-mais-assez-long' });
    check(
      'connexion avec jeton invalide refusée (1008)',
      !opened && closeCode === 1008,
      `opened=${opened} code=${closeCode}`
    );
  }

  console.log('\n=== Rôle déterminé par le jeton, pas par le chemin ===\n');

  // 3) Jeton opérateur sur '/' -> rôle operator
  {
    const { ws, opened } = await connect({ token: OPERATOR_TOKEN, path: '/' });
    check('connexion avec jeton opérateur acceptée', opened);
    const init = await waitForMessage(ws, (m) => m.action === 'init');
    check("rôle 'operator' assigné via le jeton", init.yourRole === 'operator', init.yourRole);
    ws.close();
  }

  // 4) Jeton viewer sur '/' (PAS '/overlay') -> rôle viewer quand même.
  //    C'est le cœur du correctif : avant, le chemin '/' donnait toujours
  //    'operator', peu importe le jeton présenté.
  {
    const { ws, opened } = await connect({ token: VIEWER_TOKEN, path: '/' });
    check('connexion avec jeton viewer acceptée', opened);
    const init = await waitForMessage(ws, (m) => m.action === 'init');
    check(
      "rôle 'viewer' assigné via le jeton même sur le chemin '/'",
      init.yourRole === 'viewer',
      init.yourRole
    );

    console.log('\n=== RBAC : un viewer ne peut pas exécuter une action opérateur ===\n');

    ws.send(JSON.stringify({ action: 'showVerse', reference: 'Jean 3:16', text: 'Test' }));
    const err = await waitForMessage(ws, (m) => m.action === 'error');
    check(
      "showVerse envoyé par un 'viewer' est refusé",
      /opérateur|operator/i.test(err.error || ''),
      JSON.stringify(err)
    );
    ws.close();
  }

  console.log('\n=== Validation stricte de applyTheme (css) ===\n');

  // 5) applyTheme avec un payload css hors schéma -> rejeté par validation.js
  {
    const { ws } = await connect({ token: OPERATOR_TOKEN, path: '/' });
    await waitForMessage(ws, (m) => m.action === 'init');

    ws.send(
      JSON.stringify({
        action: 'applyTheme',
        css: { background: 'red', notAllowedField: 'x' },
      })
    );
    const err1 = await waitForMessage(ws, (m) => m.action === 'error');
    check(
      'applyTheme avec un champ css non autorisé est rejeté',
      !!err1.error,
      JSON.stringify(err1)
    );

    ws.send(
      JSON.stringify({
        action: 'applyTheme',
        css: { background: 'red; } body { display:none' },
      })
    );
    const err2 = await waitForMessage(ws, (m) => m.action === 'error');
    check(
      'applyTheme avec une valeur css contenant des caractères de rupture est rejeté',
      !!err2.error,
      JSON.stringify(err2)
    );

    // Valeur légitime : doit passer et être diffusée normalement.
    ws.send(JSON.stringify({ action: 'applyTheme', css: { background: '#101010' } }));
    const applied = await waitForMessage(ws, (m) => m.action === 'applyTheme');
    check(
      'applyTheme avec un payload css valide est bien diffusé',
      applied.background === '#101010',
      JSON.stringify(applied)
    );

    ws.close();
  }

  console.log(
    `\n=== Résultat authentification WebSocket : ${passed} passés, ${failed} échoués ===`
  );
  process.exit(failed > 0 ? 1 : 0);
})().catch((err) => {
  console.error('Erreur fatale dans le test test-ws-auth:', err);
  process.exit(1);
});
