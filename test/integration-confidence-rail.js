/**
 * ============================================================================
 *  integration-confidence-rail.js — "Confidence Rail" (idée créative, brief
 *  produit) : une seule phrase, TOUJOURS visible, répond à "est-ce sûr
 *  d'aller en direct maintenant ?" — voir dashboard/features/confidence-rail.js.
 * ----------------------------------------------------------------------------
 *  server.js réel, VRAI dashboard.html dans Chromium. Le bandeau vit HORS de
 *  tout onglet (juste sous le bandeau infra .status-strip, dans le header),
 *  contrairement à la plupart des autres cartes testées jusqu'ici — pas
 *  besoin de naviguer vers un onglet particulier pour l'observer.
 *
 *  Couvre : (1) rien en jeu -> "Sûr d'aller en direct" (ok) ; (2) un repère
 *  suivant existe et est prêt (vérification résolue) -> message "prêt" (ok) ;
 *  (3) un repère suivant introuvable (média supprimé) -> "bloqué" (error),
 *  avec le VRAI message de next-cue-confidence.js, pas un texte inventé.
 *
 *  LIMITE ASSUMÉE : le cas "connexion instable" (ws fermé) n'est pas simulé
 *  ici — fermer la connexion WS du dashboard depuis ce process serveur
 *  romprait aussi la connexion du client de pilotage (opWs), rendant le
 *  reste du test impossible. La lecture directe de `ws.readyState` dans
 *  computeMessage() est triviale (une seule condition) et déjà exercée par
 *  la même discipline dans verse-session-display.js#updateStatus(), pas
 *  reproduite ici pour éviter d'inventer un scénario de test fragile.
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

process.env.PORT = process.env.PORT || '8797'; // distinct des autres tests
process.env.CHURCHOVERLAY_SKIP_BIBLE_DOWNLOAD = '1';
require('../server.js');
const rundownStore = require('../rundown-store');
const mediaLibrary = require('../media-library');

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

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'churchoverlay-confidence-rail-'));
  const addedCueIds = [];
  const addedMediaIds = [];
  let browser;
  let opWs;

  try {
    // AJOUT : média seedé AVANT le chargement du dashboard (comme
    // integration-next-cue-confidence.js) — dashboard/features/media-library.js
    // charge sa liste locale au démarrage de la page, une addItem() directe
    // APRÈS ce chargement resterait invisible à checkCueReadiness() côté
    // dashboard (aucune diffusion 'mediaLibraryUpdated' pour un appel direct
    // au store). Le repère lui-même, lui, est ajouté APRÈS coup via l'action
    // WS (voir plus bas) pour exercer la mise à jour RÉACTIVE du bandeau.
    const goodMedia = mediaLibrary.addItem({
      sourcePath: makeSourceFile(tmpDir, 'ok.png', [0x00, 0x01, 0x02, 0x03]),
      label: 'Média présent (test confidence rail)',
    });
    addedMediaIds.push(goodMedia.id);

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

    const rail = page.locator('#confidenceRail');

    // ============================================================
    // Rien en jeu (feuille de route vide) -> "Sûr d'aller en direct" (ok),
    // visible SANS naviguer vers un onglet en particulier.
    // ============================================================
    await page.waitForFunction(
      () => (document.getElementById('confidenceRail')?.textContent || '').includes('direct'),
      { timeout: 5000 }
    );
    check(
      'rien en jeu -> "Sûr d’aller en direct" affiché hors de tout onglet',
      (await rail.textContent()).includes('direct')
    );
    check(
      'classe confidence-rail-ok appliquée',
      (await rail.getAttribute('class')).includes('confidence-rail-ok')
    );

    // ============================================================
    // Un repère suivant valide (média déjà connu du dashboard, seedé plus
    // haut) -> reste "ok" une fois la vérification asynchrone résolue.
    // Ajouté via l'action WS (comme le ferait addToRundown() dans
    // rundown.js) pour exercer la mise à jour réactive du bandeau — un appel
    // direct à rundownStore.addCue() ne diffuse rien, seul le handler WS le
    // fait (même raisonnement que integration-overlay-broken-media-fallback.js
    // pour setDefaultMediaItem).
    // ============================================================
    opWs.send(
      JSON.stringify({
        action: 'addRundownCue',
        type: 'media',
        label: 'Repère prêt (test)',
        mediaId: goodMedia.id,
      })
    );
    await sleep(300);
    const cueGood = rundownStore.listCues().find((c) => c.mediaId === goodMedia.id);
    addedCueIds.push(cueGood.id);
    await page.waitForFunction(
      () => (document.getElementById('confidenceRail')?.textContent || '').includes('prêt'),
      { timeout: 5000 }
    );
    check(
      'repère suivant valide -> "Repère suivant prêt — sûr d’aller en direct"',
      (await rail.textContent()).includes('prêt')
    );
    check(
      'reste en classe confidence-rail-ok (pas d’alerte inventée)',
      (await rail.getAttribute('class')).includes('confidence-rail-ok')
    );

    // ============================================================
    // Repère suivant cassé (média supprimé de la médiathèque) -> "bloqué"
    // (error), avec le VRAI message de next-cue-confidence.js.
    // ============================================================
    opWs.send(JSON.stringify({ action: 'removeRundownCue', id: cueGood.id }));
    mediaLibrary.deleteItem(goodMedia.id);
    opWs.send(
      JSON.stringify({
        action: 'addRundownCue',
        type: 'media',
        label: 'Repère cassé (test)',
        mediaId: 'id-mediatheque-inexistant',
      })
    );
    await sleep(300);
    const cueBroken = rundownStore
      .listCues()
      .find((c) => c.mediaId === 'id-mediatheque-inexistant');
    addedCueIds.push(cueBroken.id);
    await page.waitForFunction(
      () => (document.getElementById('confidenceRail')?.textContent || '').includes('bloqué'),
      { timeout: 5000 }
    );
    check(
      'repère suivant cassé -> "Repère suivant bloqué" (error)',
      (await rail.textContent()).includes('bloqué')
    );
    check(
      'reprend le VRAI message de next-cue-confidence.js, pas un texte inventé',
      (await rail.textContent()).includes('introuvable'),
      `texte observé: "${await rail.textContent()}"`
    );
    check(
      'classe confidence-rail-error appliquée',
      (await rail.getAttribute('class')).includes('confidence-rail-error')
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
    for (const id of addedMediaIds) {
      try {
        mediaLibrary.deleteItem(id);
      } catch {
        /* déjà retiré — sans conséquence */
      }
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log(`\n=== Résultat Confidence Rail : ${passed} passés, ${failed} échoués ===`);
  await sleep(50);
  process.exit(failed > 0 ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
