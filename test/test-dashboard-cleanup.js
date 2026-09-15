/**
 * ============================================================================
 *  test-dashboard-cleanup.js — panneaux repliables (chantier nettoyage
 *  dashboard).
 * ----------------------------------------------------------------------------
 *  Même discipline que integration-scene-composer.js/test-multiview-switcher.js :
 *  server.js tourne réellement, dashboard.html charge dans un VRAI navigateur
 *  (Playwright/Chromium).
 *
 *  SUPPRIMÉ (redesign IA — étape 6) : ce fichier couvrait aussi le bascule
 *  Mode Direct/Configuration (dashboard-cleanup.js), retiré — redondant avec
 *  la scission Opérateur/Paramètres et le tiroir d'outils secondaires
 *  (étapes 3-5). Seul le panneau repliable (#networkSettingsCard, mécanisme
 *  générique .accordion-card/.accordion-header, toujours réel) reste couvert
 *  ici.
 *
 *  Couvre : panneau repliable — fermé par défaut, un clic sur l'en-tête
 *  bascule .collapsed, un second clic replie à nouveau.
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

process.env.PORT = process.env.PORT || '8776'; // distinct des autres tests
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

  await sleep(300);

  const browser = await chromium.launch();
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error' && !msg.text().startsWith('Failed to load resource')) {
      consoleErrors.push(msg.text());
    }
  });
  page.on('pageerror', (err) => consoleErrors.push('pageerror: ' + err.message));
  page.on('response', (resp) => {
    const url = resp.url();
    if (
      url.startsWith(`http://127.0.0.1:${process.env.PORT}/`) &&
      resp.status() >= 400 &&
      !url.includes('/phone-camera-stream/')
    ) {
      consoleErrors.push(`HTTP ${resp.status()} ${url}`);
    }
  });
  await page.addInitScript(() => {
    window.churchOverlay = { pickMediaFile: async () => null, getSettings: async () => ({}) };
    localStorage.setItem('churchoverlay_wizard_seen', '1');
  });

  try {
    await page.goto(`http://127.0.0.1:${process.env.PORT}/dashboard.html`, { waitUntil: 'load' });
    await sleep(800);

    console.log('\n=== Panneau repliable (#networkSettingsCard) ===\n');

    // #networkSettingsCard vit dans <section id="settings"> (onglet
    // "Paramètres") — invisible tant que cet onglet n'est pas actif.
    await page.locator('.nav-item[data-sections*="settings"]').first().click();
    await sleep(200);
    check(
      'le panneau réseau (data-group=cameras) est visible',
      await page.locator('#networkSettingsCard').isVisible()
    );

    check(
      'fermé par défaut (classe .collapsed présente)',
      await page
        .locator('#networkSettingsCard')
        .evaluate((el) => el.classList.contains('collapsed'))
    );
    await page.locator('#networkSettingsCard .accordion-header').click();
    await sleep(150);
    check(
      'un clic sur l’en-tête déplie le panneau (.collapsed retirée)',
      !(await page
        .locator('#networkSettingsCard')
        .evaluate((el) => el.classList.contains('collapsed')))
    );
    check(
      'le contenu (champ d’adresse réseau) redevient visible',
      await page.locator('#networkWsHostInput').isVisible()
    );
    await page.locator('#networkSettingsCard .accordion-header').click();
    await sleep(150);
    check(
      'un second clic replie à nouveau le panneau',
      await page
        .locator('#networkSettingsCard')
        .evaluate((el) => el.classList.contains('collapsed'))
    );

    console.log(`\nErreurs console cumulées sur tout le test : ${consoleErrors.length}`);
    if (consoleErrors.length > 0) console.log(consoleErrors.slice(0, 10));
    check('aucune erreur console déclenchée', consoleErrors.length === 0);
  } finally {
    await browser.close();
  }

  console.log(`\n=== Résultat nettoyage dashboard : ${passed} passés, ${failed} échoués ===`);
  process.exit(failed > 0 ? 1 : 0);
})();
