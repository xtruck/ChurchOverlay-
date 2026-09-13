/**
 * ============================================================================
 *  test-multiview-switcher.js — switcher multiview dual-bus Program/Preview
 *  (chantier ultime, scene-studio.js)
 * ----------------------------------------------------------------------------
 *  Même discipline que integration-scene-composer.js : server.js tourne
 *  réellement (ASR/micro mockés), dashboard.html charge dans un VRAI
 *  navigateur (Playwright/Chromium) — le canal Preview est un état PUREMENT
 *  client (scene-studio.js#previewSceneId, jamais diffusé), le canal Program
 *  fait autorité via le VRAI message showScene renvoyé par le serveur suite
 *  à l'action WS 'triggerScene' déjà testée par integration-scene-crud.js.
 *
 *  Couvre : armement Preview (bordure cyan, barre de bus, bouton CUT activé),
 *  CUT/TAKE par clic (bordure rouge Program après l'aller-retour serveur
 *  réel), raccourci clavier Espace (même effet que le clic), et la garde
 *  "Espace ignoré en contexte de saisie".
 * ============================================================================
 */
'use strict';
const fs = require('fs');
const os = require('os');
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

process.env.PORT = process.env.PORT || '8775'; // distinct des autres tests
process.env.CHURCHOVERLAY_SKIP_BIBLE_DOWNLOAD = '1';
require('../server.js');
const sceneStore = require('../scene-store');

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

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'churchoverlay-multiview-test-'));
  const sceneA = sceneStore.addScene({ name: 'Scène A (multiview test)' });
  const sceneB = sceneStore.addScene({ name: 'Scène B (multiview test)' });

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

    await page.locator('.nav-item[data-sections*="studio"]').first().click();
    await sleep(300);

    console.log('\n=== Scénario 1 : armer la Preview (👁), aucune diffusion ===\n');

    const cardA = page.locator('.media-gallery-card', { hasText: sceneA.name });
    await cardA.locator('[data-action="preview"]').click();
    await sleep(150);

    check(
      'bordure cyan (tally-preview) appliquée à la carte armée',
      await cardA.evaluate((el) => el.classList.contains('tally-preview'))
    );
    check(
      'barre de bus : Preview affiche le nom de la scène armée',
      (await page.locator('#multiviewPreviewLabel').textContent()) === sceneA.name
    );
    check(
      'barre de bus : Program toujours vide (rien diffusé)',
      (await page.locator('#multiviewProgramLabel').textContent()) === 'Rien en direct'
    );
    check(
      'bouton CUT activé une fois une Preview armée',
      !(await page.locator('#sceneCutBtn').isDisabled())
    );

    console.log('\n=== Scénario 2 : CUT / TAKE (clic) -> diffusion réelle ===\n');

    await page.click('#sceneCutBtn');
    await sleep(400); // aller-retour WS réel (triggerScene -> showScene)

    check(
      'après CUT : la scène armée porte désormais la bordure rouge (tally-program)',
      await cardA.evaluate((el) => el.classList.contains('tally-program'))
    );
    check(
      'après CUT : elle ne porte plus la bordure cyan (Program prioritaire sur Preview à l’affichage)',
      !(await cardA.evaluate((el) => el.classList.contains('tally-preview')))
    );
    check(
      'barre de bus : Program affiche désormais le nom de la scène diffusée',
      (await page.locator('#multiviewProgramLabel').textContent()) === sceneA.name
    );

    console.log('\n=== Scénario 3 : raccourci clavier Espace = même effet que CUT ===\n');

    const cardB = page.locator('.media-gallery-card', { hasText: sceneB.name });
    await cardB.locator('[data-action="preview"]').click();
    await sleep(150);
    check(
      'Preview réarmée sur la scène B',
      await cardB.evaluate((el) => el.classList.contains('tally-preview'))
    );

    await page.locator('body').click({ position: { x: 5, y: 5 } }); // s’assure qu’aucun champ n’a le focus
    await page.keyboard.press('Space');
    await sleep(400);

    check(
      'Espace (hors saisie) a bien déclenché CUT : scène B désormais en Program',
      await cardB.evaluate((el) => el.classList.contains('tally-program'))
    );
    check(
      'la scène A précédente n’est plus en Program (une seule à la fois)',
      !(await cardA.evaluate((el) => el.classList.contains('tally-program')))
    );

    console.log('\n=== Scénario 4 : Espace ignoré en contexte de saisie ===\n');

    await cardA.locator('[data-action="preview"]').click();
    await sleep(150);
    const programBeforeTyping = await page.locator('#multiviewProgramLabel').textContent();

    // Un champ de saisie visible et ordinaire du tableau de bord — la barre
    // "Saisir ou simuler une phrase" (search-detector-bar), jamais
    // spécifique à ce test.
    await page.locator('.nav-item[data-sections*="overview"]').first().click();
    await sleep(150);
    const searchInput = page.locator('#speechTextInput');
    await searchInput.click();
    await page.keyboard.press('Space');
    await sleep(300);

    await page.locator('.nav-item[data-sections*="studio"]').first().click();
    await sleep(150);
    const programAfterTyping = await page.locator('#multiviewProgramLabel').textContent();
    check(
      'Espace tapé dans un champ de saisie ne déclenche PAS CUT (Program inchangé)',
      programAfterTyping === programBeforeTyping
    );

    console.log(`\nErreurs console cumulées sur tout le test : ${consoleErrors.length}`);
    if (consoleErrors.length > 0) console.log(consoleErrors.slice(0, 10));
    check('aucune erreur console déclenchée', consoleErrors.length === 0);
  } finally {
    await browser.close();
    for (const s of [sceneA, sceneB]) {
      try {
        sceneStore.deleteItem(s.id);
      } catch (_) {
        /* best effort */
      }
    }
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (_) {
      /* best effort */
    }
  }

  console.log(
    `\n=== Résultat switcher multiview Program/Preview : ${passed} passés, ${failed} échoués ===`
  );
  process.exit(failed > 0 ? 1 : 0);
})();
