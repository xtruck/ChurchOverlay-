/**
 * ============================================================================
 *  test-voice-command-security.js — Axe 3 (Option A), bout en bout
 * ----------------------------------------------------------------------------
 *  Couvre la partie qui NE PEUT PAS être testée au niveau de voice-commands.js
 *  seul (voir test-voice-commands.js pour le wake word/la confiance
 *  phonétique, purement unitaires) : le mode "Supervised Autonomy" —
 *  file d'attente d'une action vocale proposée à l'opérateur (voir
 *  server.js#queuePendingVoiceAction/sessionState.js#pendingVoiceAction),
 *  câblé aux réglages transmis en direct via WebSocket
 *  (setVoiceCommandWakeWord/setVoiceCommandSupervision/approveVoiceAction).
 *
 *  Même discipline que test-rundown-actions.js : server.js tourne réellement,
 *  un client WS opérateur brut envoie les mêmes messages qu'un vrai dashboard
 *  (setLanguage/transcript/approveVoiceAction...), le DOM n'entre pas en jeu
 *  (contrairement aux tests overlay Playwright) — seule la diffusion WS
 *  observée fait foi. bible-lookup-with-api.js est mocké (aucun réseau requis
 *  pour hideVerse/setTheme, les seules commandes utilisées ici).
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
    throw new Error('non utilisé dans ce test (aucune commande de ce test ne cherche un verset)');
  },
  buildReferenceLabel(reference) {
    return `${reference.book} ${reference.chapter}`;
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

process.env.PORT = process.env.PORT || '8778'; // distinct des autres tests
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

  const ws = new WebSocket(`ws://127.0.0.1:${process.env.PORT}`);
  const received = [];
  await new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });
  ws.on('message', (raw) => {
    try {
      received.push(JSON.parse(raw.toString()));
    } catch (_) {
      /* message non-JSON, sans rapport avec ce test */
    }
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

  async function neverSeesAction(action, waitMs = 400) {
    await sleep(waitMs);
    return !received.some((m) => m.action === action);
  }

  try {
    console.log(
      '\n=== Scénario : comportement par défaut (supervision désactivée) — ' +
        'une commande vocale reste exécutée immédiatement ===\n'
    );
    received.length = 0;
    ws.send(JSON.stringify({ action: 'transcript', text: 'cache le verset' }));
    const immediateHide = await waitForAction('hideVerse');
    check(
      'sans supervision : hideVerse diffusé directement, triggeredByVoice=true',
      immediateHide.triggeredByVoice === true
    );
    check(
      'sans supervision : aucun pendingVoiceAction diffusé',
      !received.some((m) => m.action === 'pendingVoiceAction')
    );

    console.log(
      '\n=== Scénario : activation du mode "Supervised Autonomy" — la commande ' +
        'est proposée, PAS exécutée ===\n'
    );
    received.length = 0;
    ws.send(JSON.stringify({ action: 'setVoiceCommandSupervision', enabled: true }));
    const supervisionOn = await waitForAction('voiceCommandSupervisionChanged');
    check('setVoiceCommandSupervision : confirmation enabled=true', supervisionOn.enabled === true);

    received.length = 0;
    ws.send(JSON.stringify({ action: 'transcript', text: 'cache le verset' }));
    const pending = await waitForAction('pendingVoiceAction');
    check(
      'pendingVoiceAction diffusé avec la commande proposée (hideVerse)',
      pending.command && pending.command.action === 'hideVerse'
    );
    check(
      'pendingVoiceAction porte un id',
      typeof pending.id === 'string' && pending.id.length > 0
    );
    check('pendingVoiceAction annonce son délai d’expiration (5s)', pending.expiresInMs === 5000);
    check(
      'en mode supervisé : AUCUNE exécution immédiate (pas de hideVerse tant que non approuvé)',
      await neverSeesAction('hideVerse')
    );

    console.log(
      '\n=== Scénario : approbation avec un ID INCORRECT — rejetée, aucune exécution ===\n'
    );
    received.length = 0;
    ws.send(JSON.stringify({ action: 'approveVoiceAction', id: 'id-qui-nexiste-pas' }));
    const badApproval = await waitForAction('error');
    check(
      'approveVoiceAction avec un mauvais id : message d’erreur renvoyé',
      typeof badApproval.error === 'string' && badApproval.error.length > 0
    );
    check(
      'approbation avec mauvais id : la commande N’est PAS exécutée',
      await neverSeesAction('hideVerse')
    );

    console.log('\n=== Scénario : approbation opérateur avec le BON id — exécution réelle ===\n');
    received.length = 0;
    ws.send(JSON.stringify({ action: 'approveVoiceAction', id: pending.id }));
    const approved = await waitForAction('pendingVoiceActionApproved');
    check('pendingVoiceActionApproved diffusé, même id', approved.id === pending.id);
    const executedHide = await waitForAction('hideVerse');
    check(
      'la commande approuvée est réellement exécutée (hideVerse diffusé)',
      executedHide.triggeredByVoice === true
    );

    console.log('\n=== Scénario : phrase d’activation (wake word) + supervision combinées ===\n');
    received.length = 0;
    ws.send(
      JSON.stringify({
        action: 'setVoiceCommandWakeWord',
        enabled: true,
        words: ['overlay'],
      })
    );
    const wakeWordOn = await waitForAction('voiceCommandWakeWordChanged');
    check(
      'setVoiceCommandWakeWord : confirmation enabled=true, words=["overlay"]',
      wakeWordOn.enabled === true &&
        Array.isArray(wakeWordOn.words) &&
        wakeWordOn.words.includes('overlay')
    );

    received.length = 0;
    ws.send(JSON.stringify({ action: 'transcript', text: 'cache le verset' })); // sans "overlay"
    check(
      'wake word activé, absent du texte : AUCUNE proposition (rejeté avant même la file d’attente)',
      await neverSeesAction('pendingVoiceAction')
    );

    received.length = 0;
    ws.send(JSON.stringify({ action: 'transcript', text: 'overlay cache le verset' }));
    const pendingWithWakeWord = await waitForAction('pendingVoiceAction');
    check(
      'wake word présent : la commande passe la porte d’activation ET atterrit en attente ' +
        '(supervision toujours active)',
      pendingWithWakeWord.command && pendingWithWakeWord.command.action === 'hideVerse'
    );

    // Nettoyage : approuve cette dernière commande en attente pour ne pas la
    // laisser trainer jusqu'à son expiration naturelle (5s) après la fin du
    // test, et désactive les deux réglages pour ne rien laisser fuiter vers
    // un test suivant dans le même process.
    ws.send(JSON.stringify({ action: 'approveVoiceAction', id: pendingWithWakeWord.id }));
    await waitForAction('pendingVoiceActionApproved');
  } catch (err) {
    console.error('Erreur fatale dans le test d’intégration:', err);
    failed++;
  } finally {
    // Restaure l'état par défaut (désactivé) — même discipline que le
    // snapshot/restauration des autres tests d'intégration de ce dépôt.
    try {
      ws.send(JSON.stringify({ action: 'setVoiceCommandWakeWord', enabled: false, words: [] }));
      ws.send(JSON.stringify({ action: 'setVoiceCommandSupervision', enabled: false }));
      await sleep(100);
    } catch (_) {
      /* best-effort */
    }
    ws.close();
  }

  console.log(
    `\n=== Résultat sécurisation des commandes vocales (Axe 3) : ${passed} passés, ${failed} échoués ===`
  );
  await sleep(50);
  process.exit(failed > 0 ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
