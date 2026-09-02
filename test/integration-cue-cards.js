/**
 * ============================================================================
 *  integration-cue-cards.js — "Cue Cards" (idée créative, brief produit) :
 *  chaque repère de la feuille de route affiche un statut opérationnel
 *  grossier (En direct/Armé/Diffusé) qui communique la sécurité d'un coup
 *  d'œil, avant même de lire le détail du badge de préparation existant
 *  (voir dashboard/features/next-cue-confidence.js — Prêt/À vérifier/Bloqué,
 *  déjà couvert par integration-next-cue-confidence.js, PAS dupliqué ici).
 * ----------------------------------------------------------------------------
 *  Même discipline que integration-rundown-timeline.js : server.js réel, VRAI
 *  dashboard.html dans Chromium, un client WS opérateur brut sert à seeder/
 *  déclencher des repères, le reste passe par la VRAIE UI (clic sur "Armer").
 *
 *  Couvre : (1) aucun chip pour un repère qui n'est ni en direct, ni armé,
 *  ni diffusé ; (2) clic "Armer" (VRAIE UI) -> chip "⏏ Armé" ; (3) clic
 *  "Désarmer" (carte Sas de diffusion) -> chip retiré ; (4) déclenchement ->
 *  chip "● En direct" sur le repère actif, "✓ Diffusé" sur le précédent.
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

process.env.PORT = process.env.PORT || '8795'; // distinct des autres tests
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
    // CORRECTIF (pollution inter-fichiers) : voir le même correctif dans
    // integration-service-heartbeat.js — ce test suppose cueA à l'index 0,
    // fragile si un autre fichier de la même invocation npm test a laissé
    // des repères derrière lui (même CHURCHOVERLAY_DATA_DIR partagé pour
    // toute la suite). clearCues() garantit un état connu.
    rundownStore.clearCues();
    const cueA = rundownStore.addCue({
      type: 'verse',
      label: 'Ouverture (test cue cards)',
      reference: 'Jean 3:16',
    });
    addedCueIds.push(cueA.id);
    const cueB = rundownStore.addCue({
      type: 'verse',
      label: 'Message (test cue cards)',
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
    // #rundownList vit dans <section id="overview"> — voir le même
    // raisonnement dans integration-airlock-preview.js/integration-rundown-timeline.js.
    await page.locator('.nav-item[data-sections="overview,transcript,controls"]').first().click();
    await page.waitForFunction(() => document.getElementById('rundownList').children.length > 0, {
      timeout: 5000,
    });

    // ============================================================
    // État initial : ni en direct, ni armé, ni diffusé -> chip vide
    // ============================================================
    const chipA = page.locator(`#cueStatus-${cueA.id}`);
    check(
      'repère ni en direct/armé/diffusé -> chip de statut vide',
      (await chipA.textContent()).trim() === ''
    );

    // ============================================================
    // Clic "Armer" (VRAIE UI) sur le repère A -> chip "⏏ Armé"
    // ============================================================
    const rowA = page.locator('#rundownList .queue-item', {
      has: page.locator(`[onclick*="'${cueA.id}'"]`),
    });
    await rowA.locator('[onclick^="armRundownCue"]').click();
    await page.waitForFunction(
      (id) => (document.getElementById(`cueStatus-${id}`)?.textContent || '').includes('Armé'),
      cueA.id,
      { timeout: 3000 }
    );
    check('clic "Armer" -> chip "⏏ Armé" affiché', (await chipA.textContent()).includes('Armé'));
    check(
      'chip armé porte la classe cue-status-armed',
      (await chipA.getAttribute('class')).includes('cue-status-armed')
    );

    // ============================================================
    // Clic "Désarmer" (carte Sas de diffusion) -> chip retiré
    // ============================================================
    await page.click('#airlockDisarmBtn');
    await page.waitForFunction(
      (id) => (document.getElementById(`cueStatus-${id}`)?.textContent || '').trim() === '',
      cueA.id,
      { timeout: 3000 }
    );
    check('clic "Désarmer" -> chip de statut retiré', (await chipA.textContent()).trim() === '');

    // ============================================================
    // Déclencher A puis B -> "● En direct" sur l'actif, "✓ Diffusé" sur le précédent
    // ============================================================
    opWs.send(JSON.stringify({ action: 'triggerRundownCue', id: cueA.id }));
    await page.waitForFunction(
      (id) => (document.getElementById(`cueStatus-${id}`)?.textContent || '').includes('direct'),
      cueA.id,
      { timeout: 3000 }
    );
    check(
      'repère A déclenché -> chip "● En direct"',
      (await chipA.textContent()).includes('direct')
    );
    check(
      'chip en direct porte la classe cue-status-live',
      (await chipA.getAttribute('class')).includes('cue-status-live')
    );

    opWs.send(JSON.stringify({ action: 'triggerRundownCue', id: cueB.id }));
    const chipB = page.locator(`#cueStatus-${cueB.id}`);
    await page.waitForFunction(
      (id) => (document.getElementById(`cueStatus-${id}`)?.textContent || '').includes('direct'),
      cueB.id,
      { timeout: 3000 }
    );
    check(
      'repère B déclenché à son tour -> B affiche "● En direct"',
      (await chipB.textContent()).includes('direct')
    );
    check(
      'repère A (précédent) affiche désormais "✓ Diffusé"',
      (await chipA.textContent()).includes('Diffusé')
    );
    check(
      'chip diffusé porte la classe cue-status-played',
      (await chipA.getAttribute('class')).includes('cue-status-played')
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

  console.log(`\n=== Résultat Cue Cards : ${passed} passés, ${failed} échoués ===`);
  await sleep(50);
  process.exit(failed > 0 ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
