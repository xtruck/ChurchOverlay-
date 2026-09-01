/**
 * ============================================================================
 *  test-timer-and-emergency-actions.js — emergencyClear/pauseTimer/
 *  resumeTimer/extendTime envoyés directement en WS (pas via la voix)
 * ----------------------------------------------------------------------------
 *  CORRECTIF (audit backend — Phase 1F) : ces 4 actions sont enregistrées
 *  dans action-registry.js et le tableau de bord les envoyait déjà comme de
 *  vrais messages WS (propresenter-studio.js#ppClearAll,
 *  verse-session-display.js#pauseTimer/resumeTimer, command-palette.js) —
 *  mais AUCUN handler `sanitized.action === '...'` n'existait pour elles
 *  dans le dispatch WS principal : seul handleVoiceCommand() (déclenché
 *  uniquement par une commande vocale détectée) les traitait. Un clic direct
 *  sur ces boutons/raccourcis n'avait donc AUCUN effet côté overlay — le
 *  message WS était reçu puis silencieusement ignoré. Ce test prouve que le
 *  correctif fonctionne réellement de bout en bout (vrai server.js, vraie
 *  connexion WS), pas seulement que validation.js accepte le payload.
 * ============================================================================
 */
'use strict';
const path = require('path');
const Module = require('module');
const assert = require('assert');

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

process.env.PORT = process.env.PORT || '8782'; // distinct des autres tests
process.env.CHURCHOVERLAY_SKIP_BIBLE_DOWNLOAD = '1';
require('../server.js');

const WebSocket = require('ws');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
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

  await sleep(300);

  console.log('\n=== emergencyClear/pauseTimer/resumeTimer/extendTime envoyés en direct ===\n');

  const ws = new WebSocket(`ws://127.0.0.1:${process.env.PORT}`);
  const received = [];
  await new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });
  ws.on('message', (raw) => {
    try {
      received.push(JSON.parse(raw.toString()));
    } catch (_) {}
  });

  function waitForAction(action, timeoutMs = 1500) {
    const start = Date.now();
    return new Promise((resolve, reject) => {
      const poll = () => {
        const found = received.find((m) => m.action === action);
        if (found) return resolve(found);
        if (Date.now() - start > timeoutMs) return reject(new Error(`timeout: ${action}`));
        setTimeout(poll, 20);
      };
      poll();
    });
  }

  try {
    console.log('--- emergencyClear ---');
    received.length = 0;
    ws.send(JSON.stringify({ action: 'emergencyClear' }));
    const hideMsg = await waitForAction('hideVerse');
    check('hideVerse diffusé avec emergency:true', hideMsg.emergency === true);
    const clearMsg = await waitForAction('emergencyClear');
    check('emergencyClear lui-même diffusé', !!clearMsg);

    console.log('--- pauseTimer ---');
    received.length = 0;
    ws.send(JSON.stringify({ action: 'pauseTimer' }));
    const pauseMsg = await waitForAction('pauseTimer');
    check(
      'pauseTimer diffusé avec triggeredByVoice:false (déclenché manuellement)',
      pauseMsg.triggeredByVoice === false
    );

    console.log('--- resumeTimer ---');
    received.length = 0;
    ws.send(JSON.stringify({ action: 'resumeTimer' }));
    const resumeMsg = await waitForAction('resumeTimer');
    check(
      'resumeTimer diffusé avec triggeredByVoice:false',
      resumeMsg.triggeredByVoice === false
    );

    console.log('--- extendTime ---');
    received.length = 0;
    ws.send(JSON.stringify({ action: 'extendTime', extraMs: 5 * 60 * 1000 }));
    const extendMsg = await waitForAction('extendTime');
    check('extendTime diffusé avec le extraMs envoyé par le client', extendMsg.extraMs === 300000);

    console.log('--- extendTime sans extraMs : rejeté par validation.js, pas de crash ---');
    received.length = 0;
    ws.send(JSON.stringify({ action: 'extendTime' }));
    await sleep(300);
    check(
      "un message d'erreur est renvoyé (validation.js), aucun extendTime diffusé",
      received.some((m) => m.action === 'error') && !received.some((m) => m.action === 'extendTime')
    );
  } finally {
    ws.close();
  }

  console.log(
    `\n=== Résultat actions timer/urgence : ${passed} passés, ${failed} échoués ===`
  );
  process.exit(failed > 0 ? 1 : 0);
})().catch((err) => {
  console.error("Erreur fatale dans le test d'intégration:", err);
  process.exit(1);
});
