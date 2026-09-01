/**
 * ============================================================================
 *  test/test-ws-origin-validation.js — validateOrigin() sur bind non local
 * ----------------------------------------------------------------------------
 *  CORRECTIF (modularisation backend — sécurité) : validateOrigin()
 *  (server.js) utilisait origin.startsWith(allowed) pour comparer l'en-tête
 *  Origin du handshake WS à ALLOWED_ORIGINS — un Origin forgé comme
 *  "http://localhost:<port>.attacker.example" passait ce contrôle (préfixe
 *  exact d'une entrée autorisée), alors que ce n'est ni localhost ni le
 *  port réellement configuré. Passé à une comparaison EXACTE
 *  (ALLOWED_ORIGINS.has(origin)).
 *
 *  validateOrigin() court-circuite en `true` dès que WS_HOST vaut
 *  '127.0.0.1'/'localhost' (le défaut) — donc pour exercer réellement sa
 *  logique de comparaison, ce test démarre server.js avec un WS_HOST NON
 *  local (voir plus bas), comme un opérateur qui exposerait le pipeline sur
 *  le réseau de l'église (cas documenté dans le README). Même approche que
 *  test-ws-auth.js : server.js tourne réellement, seuls le réseau/micro
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
// WS_HOST volontairement NON local pour exercer validateOrigin() au-delà de
// son court-circuit localhost — WS_AUTH_TOKEN obligatoire dans ce mode
// (server.js refuse sinon de démarrer, voir config-validator.js).
// -------------------------------------------------------------------------
const OPERATOR_TOKEN = 'operator-token-for-origin-tests';
process.env.WS_AUTH_TOKEN = OPERATOR_TOKEN;
process.env.PORT = process.env.PORT || '8769'; // distinct des autres tests
process.env.WS_HOST = '0.0.0.0';
process.env.CHURCHOVERLAY_SKIP_BIBLE_DOWNLOAD = '1';

require('../server.js');

const WebSocket = require('ws');

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * @param {Object} opts
 * @param {string} [opts.token] - jeton envoyé via Sec-WebSocket-Protocol
 * @param {string|null} [opts.origin] - en-tête Origin ; omis si absent de opts
 */
function connect({ token, origin } = {}) {
  return new Promise((resolve) => {
    const url = `ws://127.0.0.1:${process.env.PORT}/`;
    const wsOptions = origin !== undefined ? { headers: { Origin: origin } } : undefined;
    const ws = token ? new WebSocket(url, [token], wsOptions) : new WebSocket(url, wsOptions);

    let closeCode = null;
    let closeReason = null;
    ws.on('close', (code, reason) => {
      closeCode = code;
      closeReason = reason.toString();
      setTimeout(
        () => resolve({ ws, opened: ws.readyState === WebSocket.OPEN, closeCode, closeReason }),
        0
      );
    });
    ws.on('error', () => {}); // ignoré : on statue sur 'close'

    ws.on('open', async () => {
      // Fenêtre pour un rejet applicatif post-handshake (ws.close(1008,...)
      // dans le handler 'connection', après le handshake HTTP réussi).
      await sleep(150);
      resolve({ ws, opened: ws.readyState === WebSocket.OPEN, closeCode, closeReason });
    });
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

  console.log('\n=== validateOrigin() — comparaison exacte, WS_HOST non local ===\n');

  // 1) Origin exactement autorisé (http://localhost:<port>) -> accepté
  {
    const { ws, opened, closeReason } = await connect({
      token: OPERATOR_TOKEN,
      origin: `http://localhost:${process.env.PORT}`,
    });
    check('origin exact autorisé -> connexion acceptée', opened, `closeReason=${closeReason}`);
    if (ws) ws.close();
  }

  // 2) Origin avec ALLOWED_ORIGINS comme PRÉFIXE (attaque classique du
  //    startsWith d'origine) -> doit être refusé, précisément pour l'origine
  //    (pas confondu avec un refus de jeton).
  {
    const { opened, closeCode, closeReason } = await connect({
      token: OPERATOR_TOKEN,
      origin: `http://localhost:${process.env.PORT}.attacker.example`,
    });
    check(
      'origin avec préfixe autorisé mais suffixe malveillant -> refusé',
      !opened && closeCode === 1008,
      `opened=${opened} code=${closeCode} reason=${closeReason}`
    );
    check(
      'refusé précisément pour son origine (pas pour son jeton)',
      /origine/i.test(closeReason || ''),
      closeReason
    );
  }

  // 3) Origin malformé -> refusé
  {
    const { opened, closeCode, closeReason } = await connect({
      token: OPERATOR_TOKEN,
      origin: 'not-a-valid-origin-at-all',
    });
    check(
      'origin malformé -> refusé',
      !opened && closeCode === 1008,
      `opened=${opened} code=${closeCode} reason=${closeReason}`
    );
  }

  // 4) Origin absent -> autorisé par la politique actuelle (clients
  //    natifs/file:// sans Origin, voir le commentaire de defense-in-depth
  //    dans validateOrigin() : le vrai contrôle d'accès reste le jeton).
  {
    const { opened, closeReason } = await connect({ token: OPERATOR_TOKEN });
    check(
      'origin absent -> autorisé (politique actuelle, clients natifs)',
      opened,
      `closeReason=${closeReason}`
    );
  }

  // 5) Origin valide mais AUCUN jeton -> toujours refusé (le contrôle
  //    d'origine seul ne suffit jamais à autoriser une connexion).
  {
    const { opened, closeCode } = await connect({
      origin: `http://localhost:${process.env.PORT}`,
    });
    check(
      "origin valide sans jeton -> refusé quand même (l'origine n'est pas le vrai contrôle d'accès)",
      !opened && closeCode === 1008,
      `opened=${opened} code=${closeCode}`
    );
  }

  console.log(
    `\n=== Résultat validation d'origine WebSocket : ${passed} passés, ${failed} échoués ===`
  );
  process.exit(failed > 0 ? 1 : 0);
})().catch((err) => {
  console.error('Erreur fatale dans le test test-ws-origin-validation:', err);
  process.exit(1);
});
