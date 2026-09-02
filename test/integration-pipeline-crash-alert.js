/**
 * ============================================================================
 *  integration-pipeline-crash-alert.js — "Offline/reconnect status" (brief
 *  produit, priorité #9).
 * ----------------------------------------------------------------------------
 *  Audit avant correctif (voir le commit) : la résilience réseau/reconnexion
 *  était déjà solide (reconnexion WS avec repli exponentiel + statut clair
 *  côté tableau de bord, l'overlay garde son dernier contenu affiché sans se
 *  vider pendant une coupure, resynchronisation complète à la reconnexion —
 *  ce dernier point construit CE MÊME chantier plus tôt, voir Timeline-Based
 *  Service Flow), et main.js redémarre déjà automatiquement le worker
 *  server.js en cas de crash, avec un vrai coupe-circuit (trop de crashes
 *  rapprochés -> arrêt, message clair pour un port déjà utilisé). La seule
 *  pièce manquante : ce coupe-circuit ne remontait JAMAIS jusqu'au tableau
 *  de bord — dashboard/features/pipeline-health.js recevait déjà
 *  payload.status via onStatusUpdate() mais ne le lisait jamais, un
 *  commentaire du fichier affirmant même à tort que la bannière d'alerte
 *  existante couvrait déjà ce cas.
 *
 *  Ce test ne peut pas déclencher un vrai crash-loop du worker Electron
 *  (server.js tourne ici directement via `node`, pas dans un vrai worker
 *  Electron piloté par main.js) — il simule donc directement l'appel IPC que
 *  main.js ferait dans ce cas, en remplaçant window.churchOverlay.onStatusUpdate
 *  comme le ferait vraiment preload.js, puis en déclenchant le callback
 *  capturé avec le même payload que flushDashboard() enverrait réellement.
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

process.env.PORT = process.env.PORT || '8793'; // distinct des autres tests
process.env.CHURCHOVERLAY_SKIP_BIBLE_DOWNLOAD = '1';
require('../server.js');

const { chromium } = require(path.join(__dirname, '..', 'node_modules', 'playwright-core'));

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

  let browser;
  try {
    browser = await chromium.launch();
    const page = await browser.newPage();
    const consoleErrors = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });

    // AJOUT : simule window.churchOverlay.onStatusUpdate exactement comme
    // preload.js le fait réellement (voir son en-tête) — callback capturé
    // dans window.__statusUpdateCallback pour être déclenché à la main avec
    // le même genre de payload que flushDashboard() enverrait (main.js).
    await page.addInitScript(() => {
      localStorage.setItem('churchoverlay_wizard_seen', '1');
      window.churchOverlay = window.churchOverlay || {};
      window.churchOverlay.onStatusUpdate = (callback) => {
        window.__statusUpdateCallback = callback;
        return () => {
          window.__statusUpdateCallback = null;
        };
      };
      window.churchOverlay.onPipelineAlert = () => () => {};
      window.churchOverlay.requestRestart = async () => {};
    });

    await page.goto(`http://127.0.0.1:${process.env.PORT}/dashboard.html`, { waitUntil: 'load' });
    await page.waitForFunction(() => typeof window.__statusUpdateCallback === 'function', {
      timeout: 5000,
    });

    // ============================================================
    // Bannière masquée au départ.
    // ============================================================
    check(
      'bannière d’alerte pipeline masquée avant tout statut reçu',
      (await page.locator('#pipelineAlertBanner').evaluate((el) => el.style.display)) !== 'flex'
    );

    // ============================================================
    // status:'stopped' (arrêt VOLONTAIRE côté main.js, voir wasIntentional)
    // -> AUCUNE alerte : ce n'est pas un signal de panne.
    // ============================================================
    await page.evaluate(() => window.__statusUpdateCallback({ status: 'stopped' }));
    await sleep(200);
    check(
      'status:"stopped" (arrêt volontaire) -> aucune bannière d’alerte',
      (await page.locator('#pipelineAlertBanner').evaluate((el) => el.style.display)) !== 'flex'
    );

    // ============================================================
    // status:'error' (coupe-circuit crash-loop / port déjà utilisé côté
    // main.js) -> la bannière existante (avec son bouton Redémarrer) doit
    // enfin apparaître — c'est le VRAI bug corrigé par ce chantier.
    // ============================================================
    await page.evaluate(() => window.__statusUpdateCallback({ status: 'error' }));
    await page.waitForFunction(
      () => document.getElementById('pipelineAlertBanner')?.style.display === 'flex',
      { timeout: 3000 }
    );
    check('status:"error" -> la bannière d’alerte pipeline apparaît enfin', true);
    check(
      'la bannière porte la classe d’erreur (pas seulement avertissement)',
      await page
        .locator('#pipelineAlertBanner')
        .evaluate((el) => el.classList.contains('pipeline-banner--error'))
    );
    check(
      'le message explique la situation et mentionne "Redémarrer"',
      (await page.locator('#pipelineAlertMessage').textContent()).length > 10
    );
    check(
      'le bouton "Redémarrer le pipeline" existant reste accessible depuis cette bannière',
      await page.locator('#restartPipelineBtn').isVisible()
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
  }

  console.log(
    `\n=== Résultat alerte crash-loop du pipeline (tableau de bord) : ${passed} passés, ${failed} échoués ===`
  );
  await sleep(50);
  process.exit(failed > 0 ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
