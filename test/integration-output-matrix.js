/**
 * ============================================================================
 *  integration-output-matrix.js — "Multi-Output Matrix" (brief produit,
 *  priorité #4), volet tableau de bord.
 * ----------------------------------------------------------------------------
 *  Le code Electron main-process (getDisplayWindowStatus()/createDisplayWindow()
 *  dans main.js) ne peut pas s'exécuter hors d'un vrai processus Electron — ce
 *  n'est d'ailleurs testé nulle part ailleurs dans ce dépôt pour la même
 *  raison (aucun précédent de mock du module 'electron' pour du code
 *  main-process). Ce test couvre donc ce qui est réellement testable sans
 *  Electron : le CÔTÉ TABLEAU DE BORD — window.churchOverlay (exposé par
 *  preload.js) est simulé via page.addInitScript(), le VRAI dashboard.html
 *  charge dans Chromium, et on vérifie que la matrice affiche/actualise
 *  correctement le statut et déclenche les bons appels IPC simulés.
 *
 *  Couvre : rendu initial (tout "Fermé"), clic "Afficher" -> bon mode/écran
 *  transmis à openDisplayWindow(), mise à jour EN DIRECT du statut quand
 *  onDisplayWindowStatusChanged() se déclenche (simule une fenêtre ouverte/
 *  fermée en dehors des boutons du tableau de bord, ex. Alt+F4), clic
 *  "Fermer" -> bon mode transmis à closeDisplayWindow().
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

process.env.PORT = process.env.PORT || '8788'; // distinct des autres tests
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

    // AJOUT : simule window.churchOverlay (normalement exposé par
    // preload.js dans une vraie fenêtre Electron) — appels enregistrés dans
    // window.__testCalls pour vérification, et un statut mutable partagé
    // avec le listener onDisplayWindowStatusChanged() capturé.
    await page.addInitScript(() => {
      localStorage.setItem('churchoverlay_wizard_seen', '1');
      window.__testCalls = [];
      let statusListener = null;
      let currentStatus = {
        overlay: { open: false },
        stage: { open: false },
        announcements: { open: false },
      };
      window.__setOutputStatus = (status) => {
        currentStatus = status;
        if (statusListener) statusListener();
      };
      window.churchOverlay = {
        listDisplays: async () => [
          { id: 1, label: 'Écran 1 (principal) — 1920×1080', bounds: {} },
          { id: 2, label: 'Écran 2 — 1280×720', bounds: {} },
        ],
        openDisplayWindow: async (displayId, mode) => {
          window.__testCalls.push({ fn: 'openDisplayWindow', displayId, mode });
          return { opened: true, mode };
        },
        closeDisplayWindow: async (mode) => {
          window.__testCalls.push({ fn: 'closeDisplayWindow', mode });
          return { closed: true, mode };
        },
        getDisplayWindowStatus: async () => currentStatus,
        onDisplayWindowStatusChanged: (callback) => {
          statusListener = callback;
          return () => {
            statusListener = null;
          };
        },
      };
    });

    await page.goto(`http://127.0.0.1:${process.env.PORT}/dashboard.html`, { waitUntil: 'load' });
    // #displayWindowControls vit dans <section id="settings">, pas l'onglet
    // actif par défaut — voir state.js#showSectionsFor (même raisonnement
    // que integration-airlock-preview.js pour <section id="overview">).
    await page.locator('.nav-item[data-sections="settings,overlay"]').first().click();
    await page.waitForFunction(
      () => document.getElementById('outputStatus-overlay')?.textContent.trim() === 'Fermé',
      { timeout: 5000 }
    );

    // ============================================================
    // Rendu initial : les 3 destinations affichent "Fermé"
    // ============================================================
    for (const mode of ['overlay', 'stage', 'announcements']) {
      check(
        `rendu initial : ${mode} affiche "Fermé"`,
        (await page.locator(`#outputStatus-${mode}`).textContent()).trim() === 'Fermé'
      );
    }

    // ============================================================
    // "Afficher" sur la ligne Overlay -> openDisplayWindow(id, 'overlay')
    // ============================================================
    await page.selectOption('#outputScreen-overlay', '2');
    await page.click('#outputOpenOverlayBtn');
    await page.waitForFunction(() => window.__testCalls.some((c) => c.fn === 'openDisplayWindow'), {
      timeout: 3000,
    });
    const openCall = await page.evaluate(() =>
      window.__testCalls.find((c) => c.fn === 'openDisplayWindow')
    );
    check(
      '"Afficher" sur Overlay transmet le bon mode',
      openCall && openCall.mode === 'overlay',
      JSON.stringify(openCall)
    );
    check(
      '"Afficher" sur Overlay transmet l’écran sélectionné (2)',
      openCall && openCall.displayId === 2,
      JSON.stringify(openCall)
    );

    // ============================================================
    // Mise à jour EN DIRECT du statut (simule une fenêtre ouverte/fermée
    // hors des boutons du tableau de bord, ex. Alt+F4 ou statut initial
    // après ouverture réelle) — sans aucune action opérateur.
    // ============================================================
    await page.evaluate(() => {
      window.__setOutputStatus({
        overlay: { open: true, screenLabel: 'Écran 2' },
        stage: { open: false },
        announcements: { open: false },
      });
    });
    await page.waitForFunction(
      () => document.getElementById('outputStatus-overlay')?.textContent.includes('Écran 2'),
      { timeout: 3000 }
    );
    check(
      'statut poussé en direct -> la ligne Overlay reflète "Ouvert — Écran 2" sans clic opérateur',
      (await page.locator('#outputStatus-overlay').textContent()).includes('Ouvert — Écran 2')
    );
    check(
      'les autres lignes restent "Fermé" (statut par destination, pas global)',
      (await page.locator('#outputStatus-stage').textContent()).trim() === 'Fermé'
    );

    // ============================================================
    // "Fermer" sur la ligne Overlay -> closeDisplayWindow('overlay')
    // ============================================================
    await page.click('#outputCloseOverlayBtn');
    await page.waitForFunction(
      () => window.__testCalls.some((c) => c.fn === 'closeDisplayWindow'),
      {
        timeout: 3000,
      }
    );
    const closeCall = await page.evaluate(() =>
      window.__testCalls.find((c) => c.fn === 'closeDisplayWindow')
    );
    check(
      '"Fermer" sur Overlay transmet le bon mode',
      closeCall && closeCall.mode === 'overlay',
      JSON.stringify(closeCall)
    );

    check(
      'aucune erreur console applicative',
      consoleErrors.length === 0,
      consoleErrors.join(' | ')
    );

    if (browser) await browser.close();
    browser = null;
  } catch (err) {
    console.error('Erreur fatale dans le test d’intégration:', err);
    failed++;
    if (browser) await browser.close();
  }

  console.log(
    `\n=== Résultat Multi-Output Matrix (tableau de bord) : ${passed} passés, ${failed} échoués ===`
  );
  await sleep(50);
  process.exit(failed > 0 ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
