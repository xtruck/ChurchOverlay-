'use strict';
/**
 * ============================================================================
 *  test-live-subtitles.js — Diffusion des sous-titres en direct par QR code
 * ----------------------------------------------------------------------------
 *  Couvre :
 *   1. network-utils.js#getLanIpAddress/buildLanUrl (détection IP LAN, os
 *      mocké — pas de dépendance à la vraie configuration réseau du poste
 *      qui exécute les tests).
 *   2. live-subtitles-ws-handlers.js#getCompanionQr — garde-fous (WS_HOST
 *      local, aucune IP détectée) ET génération réelle (vrai appel à la lib
 *      `qrcode`, pas mocké — même philosophie que test-clip-exporter.js
 *      pour ffmpeg : un test qui mocke la lib qu'il est censé vérifier ne
 *      prouve rien).
 *   3. Routage HTTP réel de la page mobile (/companion).
 *   4. Diffusion ciblée : un client 'viewer' (companion/mobile) reçoit bien
 *      transcript/transcriptTranslation, ET ne peut exécuter AUCUNE commande
 *      opérateur (RBAC déjà généraliste, voir test-ws-auth.js — ici
 *      spécifiquement dans le contexte de ce chantier : setCaptions/
 *      setTranslatedCaptions/getCompanionQr).
 * ============================================================================
 */
const assert = require('assert');
const os = require('os');
const path = require('path');
const Module = require('module');

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log('[TEST] ✓', name);
    passed++;
  } else {
    console.error('[TEST] ✗', name, detail !== undefined ? '— ' + detail : '');
    failed++;
  }
}

console.log('=== Test Diffusion des sous-titres en direct (QR code) ===\n');

// ============================================================================
// 1. network-utils.js — détection IP LAN (os.networkInterfaces() mocké)
// ============================================================================
console.log('--- network-utils.js ---');
{
  const networkUtils = require('../network-utils');
  const originalNetworkInterfaces = os.networkInterfaces;

  os.networkInterfaces = () => ({
    lo: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }],
    'Wi-Fi': [
      { family: 'IPv6', internal: false, address: 'fe80::1234' },
      { family: 'IPv4', internal: false, address: '192.168.1.42' },
    ],
  });
  check(
    'getLanIpAddress(): ignore loopback et IPv6, choisit la première IPv4 externe',
    networkUtils.getLanIpAddress() === '192.168.1.42'
  );
  check(
    'buildLanUrl(): construit une URL réseau correcte',
    networkUtils.buildLanUrl('companion', 8765) === 'http://192.168.1.42:8765/companion'
  );
  check(
    'buildLanUrl(): retire un "/" de tête du chemin sans le dupliquer',
    networkUtils.buildLanUrl('/companion', 8765) === 'http://192.168.1.42:8765/companion'
  );

  os.networkInterfaces = () => ({
    lo: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }],
    tun0: [{ family: 'IPv6', internal: false, address: 'fe80::abcd' }],
  });
  check(
    'getLanIpAddress(): renvoie null sans interface IPv4 externe (loopback/IPv6 seuls)',
    networkUtils.getLanIpAddress() === null
  );
  check('buildLanUrl(): renvoie null quand aucune IP LAN détectée', networkUtils.buildLanUrl('companion', 8765) === null);

  os.networkInterfaces = originalNetworkInterfaces;
}
console.log('');

// ============================================================================
// 2. live-subtitles-ws-handlers.js — getCompanionQr (garde-fous + génération réelle)
// ============================================================================
console.log('--- live-subtitles-ws-handlers.js ---');
(async () => {
  const liveSubtitlesWsHandlers = require('../live-subtitles-ws-handlers');
  const realQRCode = require('qrcode');

  function makeCtx(overrides) {
    return {
      wsHost: '192.168.1.10',
      buildLanUrl: (pathName, port) => `http://192.168.1.10:${port}/${pathName}`,
      serverPort: 8765,
      QRCode: realQRCode,
      ...overrides,
    };
  }

  function fakeWs() {
    const messages = [];
    return { send: (raw) => messages.push(JSON.parse(raw)), messages };
  }

  // --- Garde-fou : WS_HOST local -> QR inutilisable, refusé clairement ---
  {
    const handlers = liveSubtitlesWsHandlers.createHandlers(makeCtx({ wsHost: '127.0.0.1' }));
    const ws = fakeWs();
    await handlers.get('getCompanionQr')(ws, {});
    check(
      'getCompanionQr: WS_HOST=127.0.0.1 -> erreur claire, aucun QR généré',
      ws.messages.length === 1 && ws.messages[0].action === 'error'
    );
  }

  // --- Garde-fou : aucune IP LAN détectée ---
  {
    const handlers = liveSubtitlesWsHandlers.createHandlers(
      makeCtx({ buildLanUrl: () => null })
    );
    const ws = fakeWs();
    await handlers.get('getCompanionQr')(ws, {});
    check(
      "getCompanionQr: aucune IP LAN -> erreur claire, aucun QR généré",
      ws.messages.length === 1 && ws.messages[0].action === 'error'
    );
  }

  // --- Génération réelle (vrai appel à la lib qrcode, pas mocké) ---
  {
    const handlers = liveSubtitlesWsHandlers.createHandlers(makeCtx());
    const ws = fakeWs();
    await handlers.get('getCompanionQr')(ws, {});
    const msg = ws.messages[0];
    check(
      'getCompanionQr: succès -> companionQrGenerated avec la bonne URL',
      msg && msg.action === 'companionQrGenerated' && msg.url === 'http://192.168.1.10:8765/companion'
    );
    check(
      'getCompanionQr: qrDataUrl est un VRAI PNG en data URI (lib qrcode réellement appelée)',
      !!msg && typeof msg.qrDataUrl === 'string' && msg.qrDataUrl.startsWith('data:image/png;base64,')
    );
    check(
      "getCompanionQr: l'URL générée ne porte AUCUN jeton (route /companion volontairement publique)",
      !msg.url.includes('token=')
    );
  }

  console.log('');
  await runIntegrationTests();
})().catch((err) => {
  console.error('[TEST] ÉCHEC INATTENDU:', err.message);
  console.error(err.stack);
  process.exit(1);
});

// ============================================================================
// 3 & 4. Serveur réel : routage /companion + diffusion ciblée viewer (RBAC)
// ============================================================================
async function runIntegrationTests() {
  console.log('--- Serveur réel : routage /companion + RBAC diffusion ciblée ---');

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

  const transcriptQueue = [];
  injectFakeModule('groq-wrapper.js', {
    async transcribeFile() {
      throw new Error('non utilisé dans ce test');
    },
    async transcribeWithFallback() {
      return { text: transcriptQueue.shift() || '', source: 'fake-groq' };
    },
    // AJOUT : caption-translator.js appelle CETTE MÊME fonction pour
    // traduire — réponse déterministe, distincte du texte original, pour
    // pouvoir vérifier sans ambiguïté que c'est bien la TRADUCTION qui
    // atteint le client viewer.
    async chatCompletion() {
      return { text: 'This is the translated caption.', model: 'fake', usage: {} };
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

  let onAudioSegment = null;
  injectFakeModule('audio-capture.js', {
    startBrowserCapture() {},
    feedPcmChunk() {},
    stopRecording() {},
    cleanupTempFiles() {},
    isRecording() {
      return false;
    },
    on(callbacks) {
      onAudioSegment = callbacks.onAudioSegment;
    },
  });

  const OPERATOR_TOKEN = 'operator-token-live-subtitles-test';
  const VIEWER_TOKEN = 'viewer-token-live-subtitles-test-2';
  process.env.WS_AUTH_TOKEN = OPERATOR_TOKEN;
  process.env.WS_VIEWER_TOKEN = VIEWER_TOKEN;
  process.env.PORT = process.env.PORT || '8798'; // distinct des autres tests
  process.env.WS_HOST = '127.0.0.1';
  process.env.CHURCHOVERLAY_SKIP_BIBLE_DOWNLOAD = '1';

  require('../server.js');

  const WebSocket = require('ws');

  async function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  async function simulateSegment(text) {
    transcriptQueue.push(text);
    await onAudioSegment(`/tmp/fake-live-subtitles-${Date.now()}-${Math.random()}.wav`);
  }

  function connect(token) {
    return new Promise((resolve) => {
      const url = `ws://127.0.0.1:${process.env.PORT}/`;
      const ws = token ? new WebSocket(url, [token]) : new WebSocket(url);
      ws.testMessages = [];
      ws.on('message', (raw) => {
        try {
          ws.testMessages.push(JSON.parse(raw.toString()));
        } catch (_) {}
      });
      ws.on('open', () => resolve(ws));
    });
  }

  await sleep(300); // laisse le serveur s'initialiser complètement

  // --- 3. Routage HTTP réel de la page mobile ---
  const res = await fetch(`http://127.0.0.1:${process.env.PORT}/companion`);
  const html = await res.text();
  check('GET /companion: 200 OK', res.status === 200);
  check(
    'GET /companion: content-type HTML',
    (res.headers.get('content-type') || '').includes('text/html')
  );
  check(
    'GET /companion: sert bien companion.html (marqueur de contenu présent)',
    html.includes('Versets de ce culte')
  );
  check(
    'GET /companion: page compagnon durcie (sélecteur de langue des sous-titres présent)',
    html.includes('captionLangSelector')
  );
  check(
    'GET /companion: page compagnon durcie (contrôle de taille de police présent)',
    html.includes('fontBiggerBtn')
  );

  // --- 4. Diffusion ciblée : opérateur active captions + traduction ---
  const operatorWs = await connect(OPERATOR_TOKEN);
  const viewerWs = await connect(VIEWER_TOKEN);
  await sleep(100);

  check(
    "le client opérateur obtient bien le rôle 'operator'",
    operatorWs.testMessages[0] && operatorWs.testMessages[0].yourRole === 'operator'
  );
  check(
    "le client mobile/compagnon obtient bien le rôle 'viewer'",
    viewerWs.testMessages[0] && viewerWs.testMessages[0].yourRole === 'viewer'
  );

  operatorWs.send(JSON.stringify({ action: 'setCaptions', enabled: true }));
  operatorWs.send(
    JSON.stringify({ action: 'setTranslatedCaptions', enabled: true, targetLang: 'en' })
  );
  await sleep(150);

  viewerWs.testMessages = [];
  operatorWs.testMessages = [];
  await simulateSegment("Ce soir nous parlons d'un sujet qui ne correspond a aucun verset");
  await sleep(400);

  const viewerTranscript = viewerWs.testMessages.find((m) => m.action === 'transcript');
  const viewerTranslation = viewerWs.testMessages.find((m) => m.action === 'transcriptTranslation');
  check(
    "le client viewer/compagnon reçoit bien 'transcript' en temps réel",
    !!viewerTranscript && viewerTranscript.text.includes('sujet qui ne correspond')
  );
  check(
    "le client viewer/compagnon reçoit bien 'transcriptTranslation' en temps réel",
    !!viewerTranslation && viewerTranslation.text === 'This is the translated caption.'
  );

  // --- 4b. Aucune fuite de privilège : le viewer ne peut PAS piloter les
  // réglages sous-titres/QR de ce chantier, ni aucune action opérateur ---
  viewerWs.testMessages = [];
  viewerWs.send(JSON.stringify({ action: 'setCaptions', enabled: false }));
  viewerWs.send(JSON.stringify({ action: 'setTranslatedCaptions', enabled: false }));
  viewerWs.send(JSON.stringify({ action: 'getCompanionQr' }));
  await sleep(200);

  const RBAC_REJECTION = 'Action réservée aux opérateurs.';
  const rbacRejections = viewerWs.testMessages.filter(
    (m) => m.action === 'error' && m.error === RBAC_REJECTION
  );
  check(
    'un client viewer ne peut PAS désactiver setCaptions (rejeté par le RBAC, pas juste "une erreur")',
    rbacRejections.length >= 1
  );
  check(
    'setCaptions envoyé par le viewer est bien resté sans effet (toujours enabled côté opérateur)',
    (
      await (await fetch(`http://127.0.0.1:${process.env.PORT}/api/captions`)).json()
    ).enabled === true
  );
  check(
    'un client viewer ne peut PAS générer le QR compagnon NI toucher aux réglages sous-titres — les 3 tentatives sont TOUTES rejetées par le RBAC (message exact, pas une erreur métier accidentellement identique)',
    rbacRejections.length === 3
  );
  check(
    "aucune des tentatives refusées n'a atteint companionQrGenerated côté viewer",
    !viewerWs.testMessages.some((m) => m.action === 'companionQrGenerated')
  );

  // --- 4c. L'opérateur, lui, peut toujours tout faire (pas de sur-restriction
  // par le RBAC) : la même action, envoyée par l'opérateur, échoue pour une
  // raison MÉTIER (WS_HOST local dans cet environnement de test), jamais
  // pour la raison RBAC ci-dessus — la distinction exacte du message le
  // prouve. ---
  operatorWs.testMessages = [];
  operatorWs.send(JSON.stringify({ action: 'getCompanionQr' }));
  await sleep(200);
  check(
    "un client opérateur n'est JAMAIS bloqué par le RBAC sur getCompanionQr (échoue ici pour une raison métier distincte, WS_HOST local)",
    operatorWs.testMessages.some(
      (m) => m.action === 'error' && m.error.includes('accessible sur le réseau') && m.error !== RBAC_REJECTION
    )
  );

  operatorWs.close();
  viewerWs.close();

  console.log(`\n=== Résultat sous-titres en direct : ${passed}/${passed + failed} ===`);
  process.exit(failed > 0 ? 1 : 0);
}
