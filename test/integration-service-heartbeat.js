/**
 * ============================================================================
 *  integration-service-heartbeat.js — "Service Heartbeat" (idée créative,
 *  brief produit) : une pastille animée résume, d'un coup d'œil, le même état
 *  que le texte de retard/avance déjà affiché par la Timeline-Based Service
 *  Flow (priorité #5, voir #rundownScheduleStatus) — sans dupliquer son
 *  calcul (voir setHeartbeatDot() dans dashboard/features/rundown.js, piloté
 *  par le MÊME computeScheduleStatus() que renderScheduleStatus()).
 * ----------------------------------------------------------------------------
 *  LIMITE ASSUMÉE (même raisonnement que integration-rundown-timeline.js,
 *  voir son en-tête) : l'état "en retard" (rundown-heartbeat-behind) ne peut
 *  se déclencher qu'au-delà d'un écart réel de 60s+ (SCHEDULE_STATUS_TOLERANCE_MS)
 *  — le tester demanderait une vraie attente de 60s+, écartée pour ne pas
 *  ralentir toute la suite. "en avance" (rundown-heartbeat-ahead), lui, se
 *  déclenche déterministiquement avec une estimation volontairement énorme
 *  (60 min) face à un écoulement réel de quelques secondes — testé ci-dessous.
 *  "waiting"/"running" (avant tout déclenchement / premier segment) sont
 *  déterministes et couverts aussi.
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
  async getVerseMultilang(reference) {
    return {
      book: reference.book,
      chapter: reference.chapter,
      verse: reference.verseStart || 1,
      text: 'Texte factice de test.',
      reference: `${reference.book} ${reference.chapter}:${reference.verseStart || 1}`,
    };
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

process.env.PORT = process.env.PORT || '8796'; // distinct des autres tests
process.env.CHURCHOVERLAY_SKIP_BIBLE_DOWNLOAD = '1';
require('../server.js');
const rundownStore = require('../rundown-store');

const WebSocket = require('ws');
const { chromium } = require(path.join(__dirname, '..', 'node_modules', 'playwright-core'));

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function waitForOpen(ws) {
  return new Promise((resolve) => ws.once('open', resolve));
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

  const addedCueIds = [];
  let browser;
  let opWs;

  try {
    // CORRECTIF (pollution inter-fichiers) : ce test suppose cueA à l'index
    // 0 (voir plus bas, "premier segment" -> pastille "running") — une
    // hypothèse fragile si un AUTRE fichier de test de cette même invocation
    // npm test (même CHURCHOVERLAY_DATA_DIR partagé pour toute la suite,
    // voir scripts/run-tests.js) a laissé des repères derrière lui avant
    // celui-ci. rundown-store.js n'a pas de notion de "session de test" —
    // clearCues() ici garantit un état connu, quel que soit ce qui s'est
    // exécuté avant, sans dépendre de l'ordre des fichiers.
    rundownStore.clearCues();
    const cueA = rundownStore.addCue({
      type: 'verse',
      label: 'Ouverture (test heartbeat)',
      reference: 'Jean 3:16',
    });
    addedCueIds.push(cueA.id);
    const cueB = rundownStore.addCue({
      type: 'verse',
      label: 'Message (test heartbeat)',
      reference: 'Romains 8:28',
    });
    addedCueIds.push(cueB.id);

    opWs = new WebSocket(`ws://127.0.0.1:${process.env.PORT}`);
    await waitForOpen(opWs);

    browser = await chromium.launch();
    const page = await browser.newPage();
    const consoleErrors = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    await page.addInitScript(() => {
      localStorage.setItem('churchoverlay_wizard_seen', '1');
    });
    await page.goto(`http://127.0.0.1:${process.env.PORT}/dashboard.html`, { waitUntil: 'load' });
    await page.locator('.nav-item[data-sections="overview,transcript,controls"]').first().click();
    await page.waitForFunction(() => document.getElementById('rundownList').children.length > 0, {
      timeout: 5000,
    });

    const dot = page.locator('#rundownHeartbeatDot');

    // ============================================================
    // Avant tout déclenchement -> "waiting" (en attente de l'opérateur)
    // ============================================================
    check(
      'culte pas encore démarré -> pastille "waiting"',
      (await dot.getAttribute('class')).includes('rundown-heartbeat-waiting')
    );

    // ============================================================
    // Repère A déclenché (premier segment, pas encore de retard calculable)
    // -> "running"
    // ============================================================
    opWs.send(JSON.stringify({ action: 'triggerRundownCue', id: cueA.id }));
    await page.waitForFunction(
      () =>
        (document.getElementById('rundownHeartbeatDot')?.className || '').includes(
          'rundown-heartbeat-running'
        ),
      { timeout: 3000 }
    );
    check(
      'premier segment en cours (pas encore de 2e repère) -> pastille "running"',
      (await dot.getAttribute('class')).includes('rundown-heartbeat-running')
    );

    // ============================================================
    // Estimation énorme (60 min) sur A face à un écoulement réel de
    // quelques secondes -> "en avance" déterministe, sans attendre 60s+.
    // ============================================================
    const rowA = page.locator('#rundownList .queue-item', {
      has: page.locator(`[onclick*="'${cueA.id}'"]`),
    });
    await rowA.locator('.queue-item-duration-input').fill('60');
    await rowA.locator('.queue-item-duration-input').dispatchEvent('change');
    await sleep(300); // laisse rundownUpdated (diffusion serveur) redessiner

    opWs.send(JSON.stringify({ action: 'triggerRundownCue', id: cueB.id }));
    await page.waitForFunction(
      () =>
        (document.getElementById('rundownHeartbeatDot')?.className || '').includes(
          'rundown-heartbeat-ahead'
        ),
      { timeout: 5000 }
    );
    check(
      'segment A (estimé 60 min, réel ~quelques secondes) terminé -> pastille "ahead"',
      (await dot.getAttribute('class')).includes('rundown-heartbeat-ahead')
    );
    const statusText = await page.locator('#rundownScheduleStatus').textContent();
    check(
      'le texte associé confirme "en avance" (même état, pas de divergence pastille/texte)',
      statusText.includes('avance'),
      `texte observé: "${statusText}"`
    );

    check(
      'aucune erreur console applicative',
      consoleErrors.length === 0,
      consoleErrors.join(' | ')
    );
  } catch (err) {
    console.error('Erreur fatale dans le test d’intégration:', err);
    failed++;
  } finally {
    if (browser) await browser.close();
    if (opWs) opWs.close();
    for (const id of addedCueIds) {
      try {
        rundownStore.removeCue(id);
      } catch {
        /* déjà retiré — sans conséquence */
      }
    }
  }

  console.log(`\n=== Résultat Service Heartbeat : ${passed} passés, ${failed} échoués ===`);
  await sleep(50);
  process.exit(failed > 0 ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
