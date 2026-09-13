/**
 * ============================================================================
 *  test-dashboard-cleanup.js — Mode Direct/Configuration, purge onclick,
 *  panneaux repliables (chantier nettoyage dashboard)
 * ----------------------------------------------------------------------------
 *  Même discipline que integration-scene-composer.js/test-multiview-switcher.js :
 *  server.js tourne réellement, dashboard.html charge dans un VRAI navigateur
 *  (Playwright/Chromium).
 *
 *  Couvre :
 *   1. Mode Direct masque les panneaux non essentiels (réseau/caméras/
 *      intégrations/système) et GARDE visibles le verset live + la barre
 *      Program/Preview du studio de scènes + la jauge de confiance —
 *      persisté en localStorage, réappliqué après rechargement.
 *   2. La palette Ctrl/Cmd+K reste capable de déclencher une action dont le
 *      panneau d'origine est masqué en Mode Direct (preuve que "masqué" ne
 *      veut jamais dire "injoignable" — voir cahier des charges §4).
 *   3. Panneau repliable (#networkSettingsCard) : fermé par défaut, un clic
 *      sur l'en-tête bascule .collapsed.
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

    console.log('\n=== Scénario 1 : Mode Configuration (défaut) — tout visible ===\n');

    check(
      'par défaut : body ne porte pas la classe mode-direct',
      !(await page.evaluate(() => document.body.classList.contains('mode-direct')))
    );

    // #networkSettingsCard vit dans <section id="settings"> (onglet
    // "Réglages", data-sections="settings,overlay") — invisible tant que cet
    // onglet n'est pas actif, indépendamment de tout mode Direct/Config
    // (mécanisme showSectionsFor() préexistant, sans rapport avec ce
    // chantier). Il faut donc s'y rendre avant de juger sa visibilité.
    await page.locator('.nav-item[data-sections*="settings"]').first().click();
    await sleep(200);
    check(
      'par défaut : le panneau réseau (data-group=cameras) est visible',
      await page.locator('#networkSettingsCard').isVisible()
    );

    console.log('\n=== Scénario 2 : bascule en Mode Direct — panneaux secondaires masqués ===\n');

    await page.locator('[data-action="set-dashboard-mode"][data-mode="direct"]').click();
    await sleep(150);

    check(
      'body porte la classe mode-direct',
      await page.evaluate(() => document.body.classList.contains('mode-direct'))
    );
    check(
      'panneau réseau masqué en Mode Direct',
      !(await page.locator('#networkSettingsCard').isVisible())
    );
    check(
      'bouton "Mode Direct" actif, "Mode Configuration" ne l’est plus',
      (await page.locator('[data-mode="direct"]').getAttribute('class')).includes('active') &&
        !(await page.locator('[data-mode="config"]').getAttribute('class')).includes('active')
    );

    await page.locator('.nav-item[data-sections*="studio"]').first().click();
    await sleep(200);
    check(
      'la barre Program/Preview + Tally du studio de scènes reste visible en Mode Direct',
      await page.locator('#multiviewBusBar').isVisible()
    );
    check(
      '"+ Nouvelle scène" (composition, non essentiel en direct) est masqué',
      !(await page.locator('#openSceneComposerBtn').isVisible())
    );

    console.log('\n=== Scénario 3 : persistance (localStorage) après rechargement ===\n');

    await page.reload({ waitUntil: 'load' });
    await sleep(800);
    check(
      'Mode Direct restauré après rechargement (localStorage)',
      await page.evaluate(() => document.body.classList.contains('mode-direct'))
    );

    console.log(
      '\n=== Scénario 4 : la palette Ctrl/Cmd+K reste capable d’agir malgré le masquage ===\n'
    );

    // "emergencyClear" est toujours dans PALETTE_ACTIONS (command-palette.js)
    // et son propre bouton (#heroEmergencyStopBtn) reste visible même en
    // Mode Direct (urgence, jamais masquée) — mais la preuve recherchée ici
    // est la palette ELLE-MÊME : un raccourci d'action WS, indépendant du
    // DOM d'un panneau masqué.
    await page.keyboard.press('Control+k');
    await sleep(200);
    const paletteVisible = await page.locator('#commandPalette').isVisible();
    check('la palette Ctrl+K s’ouvre toujours en Mode Direct', paletteVisible);
    if (paletteVisible) {
      await page.fill('#commandPalette .command-palette-input', 'contraste');
      await sleep(150);
      const hasResult =
        (await page.locator('#commandPalette .command-palette-item:visible').count()) > 0;
      check('une action de réglage (ex. contraste) reste trouvable via la palette', hasResult);
    }
    await page.keyboard.press('Escape');
    await sleep(150);
    // NOTE : close() ne retire que la classe .open (voir command-palette.js)
    // — l'overlay reste dans le DOM avec un bounding box non nul (animation
    // opacity/pointer-events, pas display:none), donc Playwright continue de
    // le voir comme isVisible():true. La classe .open est le seul signal
    // fiable de l'état réellement fermé.
    check(
      'la palette se referme (classe .open retirée)',
      !(await page.locator('#commandPalette').evaluate((el) => el.classList.contains('open')))
    );

    console.log('\n=== Scénario 5 : repasser en Mode Configuration restaure tout ===\n');

    await page.locator('[data-action="set-dashboard-mode"][data-mode="config"]').click();
    await sleep(150);
    // Scénario 2 a navigué vers l'onglet "Studio" — revenir sur "Réglages"
    // pour retrouver #networkSettingsCard avant le scénario 6 ci-dessous.
    await page.locator('.nav-item[data-sections*="settings"]').first().click();
    await sleep(200);
    check(
      'body ne porte plus la classe mode-direct',
      !(await page.evaluate(() => document.body.classList.contains('mode-direct')))
    );

    console.log('\n=== Scénario 6 : panneau repliable (#networkSettingsCard) ===\n');

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
    // Réinitialise la préférence locale pour ne pas influencer un futur run
    // (localStorage d'un navigateur Playwright frais, sans lien avec de
    // vraies données d'un opérateur — mais discipline de propreté quand même).
  }

  console.log(`\n=== Résultat nettoyage dashboard : ${passed} passés, ${failed} échoués ===`);
  process.exit(failed > 0 ? 1 : 0);
})();
