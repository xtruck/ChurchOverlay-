/**
 * ============================================================================
 *  integration-focus-mode.js — "Focus Mode" (brief produit, priorité #6).
 * ----------------------------------------------------------------------------
 *  Même discipline que integration-airlock-preview.js : server.js réel, VRAI
 *  dashboard.html dans Chromium, un client WS opérateur brut pour seeder/
 *  déclencher, le reste piloté depuis la VRAIE UI.
 *
 *  Couvre : le bouton bascule ouvre/ferme la surcouche ; une fois un média
 *  diffusé, la colonne "en direct" du mode focus l'affiche (même rendu que
 *  le sas, voir renderContentPreview() partagé) ; le prochain repère de la
 *  feuille de route s'affiche et "Aller en direct" le déclenche réellement
 *  (même chemin que le "▶ Suivant" de la feuille de route) ; "Tout effacer"/
 *  "Écran noir" déclenchent bien les vraies actions d'urgence existantes
 *  (vérifié via leurs toasts de confirmation respectifs, déjà éprouvés
 *  ailleurs) ; "Quitter" referme la surcouche.
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

process.env.PORT = process.env.PORT || '8790'; // distinct des autres tests
process.env.CHURCHOVERLAY_SKIP_BIBLE_DOWNLOAD = '1';
require('../server.js');
const mediaLibrary = require('../media-library');
const rundownStore = require('../rundown-store');

const WebSocket = require('ws');
const { chromium } = require(path.join(__dirname, '..', 'node_modules', 'playwright-core'));

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function waitForOpen(ws) {
  return new Promise((resolve) => ws.once('open', resolve));
}

function makeSourceFile(dir, filename, bytes) {
  const p = path.join(dir, filename);
  fs.writeFileSync(p, Buffer.from(bytes));
  return p;
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

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'churchoverlay-focus-'));
  const addedMediaIds = [];
  const addedCueIds = [];
  let browser;
  let opWs;

  try {
    const media = mediaLibrary.addItem({
      sourcePath: makeSourceFile(tmpDir, 'photo.png', [0x00, 0x01, 0x02, 0x03]),
      label: 'Photo focus (test)',
    });
    addedMediaIds.push(media.id);

    // CORRECTIF (pollution inter-fichiers) : voir le même correctif dans
    // integration-service-heartbeat.js — ce test suppose cueMedia à l'index
    // 0, fragile si un autre fichier de la même invocation npm test a
    // laissé des repères derrière lui (même CHURCHOVERLAY_DATA_DIR partagé
    // pour toute la suite). clearCues() garantit un état connu.
    rundownStore.clearCues();
    const cueMedia = rundownStore.addCue({
      type: 'media',
      label: 'Photo focus (test)',
      mediaId: media.id,
    });
    addedCueIds.push(cueMedia.id);
    const cueVerse = rundownStore.addCue({
      type: 'verse',
      label: 'Suivant (test)',
      reference: 'Jean 3:16',
    });
    addedCueIds.push(cueVerse.id);

    opWs = new WebSocket(`ws://127.0.0.1:${process.env.PORT}`);
    await waitForOpen(opWs);

    browser = await chromium.launch();
    const page = await browser.newPage();
    const consoleErrors = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        const loc = msg.location();
        consoleErrors.push(`${msg.text()} (${(loc && loc.url) || ''})`);
      }
    });
    await page.addInitScript(() => {
      localStorage.setItem('churchoverlay_wizard_seen', '1');
    });
    await page.goto(`http://127.0.0.1:${process.env.PORT}/dashboard.html`, { waitUntil: 'load' });
    await page.waitForFunction(() => document.getElementById('rundownList') !== null, {
      timeout: 5000,
    });

    // ============================================================
    // Avant activation : la surcouche n'existe pas encore dans le DOM
    // (créée à la demande, voir createOverlay() dans focus-mode.js)
    // ============================================================
    check(
      'surcouche absente du DOM avant la première activation',
      (await page.locator('#focusModeOverlay').count()) === 0
    );

    // ============================================================
    // Déclencher le repère média DE LA FEUILLE DE ROUTE (pas triggerMediaItem
    // direct) AVANT d'activer le mode focus — "en direct" doit déjà refléter
    // l'état réel dès l'ouverture (tick() initial), et "prochain repère" doit
    // correctement pointer sur LE REPÈRE SUIVANT dans la feuille de route
    // (l'index actif du rundown n'avance QUE via triggerRundownCue/
    // nextRundownCue, jamais via un déclenchement média direct — voir
    // getRundownActiveIndex() dans rundown.js).
    // ============================================================
    opWs.send(JSON.stringify({ action: 'triggerRundownCue', id: cueMedia.id }));
    await sleep(300);

    await page.click('#focusModeToggleBtn');
    await page.waitForFunction(
      () => document.getElementById('focusModeOverlay')?.classList.contains('active'),
      { timeout: 3000 }
    );
    check('bascule -> la surcouche devient visible (classe .active)', true);

    await page.waitForFunction(() => document.querySelector('#focusModeLivePreview img') !== null, {
      timeout: 3000,
    });
    check(
      '"en direct" affiche déjà le média diffusé AVANT l’activation (tick initial, pas d’attente d’intervalle)',
      (await page.locator('#focusModeLivePreview img').count()) === 1
    );

    const nextCueText = await page.locator('#focusModeNextCue').textContent();
    check(
      'prochain repère affiché correctement (le repère verset, pas encore actif)',
      nextCueText.includes('Suivant (test)'),
      `texte observé: "${nextCueText}"`
    );

    // ============================================================
    // "Aller en direct" -> déclenche réellement le prochain repère (même
    // chemin que nextRundownCue()) : la feuille de route elle-même avance.
    // ============================================================
    await page.click('#focusModeGoLiveBtn');
    await page.waitForFunction(
      () => (document.getElementById('focusModeNextCue')?.textContent || '').includes('Fin de'),
      { timeout: 3000 }
    );
    check(
      '"Aller en direct" avance réellement la feuille de route (plus de repère suivant après)',
      true
    );

    // ============================================================
    // Urgences : vérifiées via leurs toasts de confirmation respectifs
    // (déjà les VRAIES actions ppClearAll()/toggleBlackScreen(), pas une
    // troisième implémentation à valider séparément).
    // ============================================================
    await page.click('#focusModeClearAllBtn');
    await page.waitForFunction(
      () =>
        Array.from(document.querySelectorAll('.toast')).some((t) =>
          t.textContent.includes('MASTER CLEAR')
        ),
      { timeout: 3000 }
    );
    check('"Tout effacer" déclenche bien ppClearAll() (toast MASTER CLEAR)', true);

    await page.click('#focusModeBlackScreenBtn');
    await page.waitForFunction(
      () =>
        Array.from(document.querySelectorAll('.toast')).some((t) =>
          t.textContent.includes('Écran noir activé')
        ),
      { timeout: 3000 }
    );
    check('"Écran noir" déclenche bien toggleBlackScreen() (toast de confirmation)', true);

    // ============================================================
    // Quitter -> la surcouche redevient invisible
    // ============================================================
    await page.click('#focusModeExitBtn');
    await page.waitForFunction(
      () => !document.getElementById('focusModeOverlay')?.classList.contains('active'),
      { timeout: 3000 }
    );
    check('"Quitter" referme bien la surcouche', true);

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
        /* sans conséquence */
      }
    }
    for (const id of addedMediaIds) {
      try {
        mediaLibrary.deleteItem(id);
      } catch {
        /* sans conséquence */
      }
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log(`\n=== Résultat Focus Mode : ${passed} passés, ${failed} échoués ===`);
  await sleep(50);
  process.exit(failed > 0 ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
