/**
 * ============================================================================
 *  integration-social-share.js — "Smart Bible Overlay Builder" (brief
 *  produit, priorité #8), volet "version réseaux sociaux".
 * ----------------------------------------------------------------------------
 *  server.js réel, VRAI dashboard.html dans Chromium (même discipline que
 *  les autres tests d'intégration de ce chantier).
 *
 *  Couvre : sans verset affiché -> toast d'erreur, aucun téléchargement ;
 *  avec un verset réellement diffusé (via le VRAI pipeline showVerse, pas
 *  une valeur simulée) -> un vrai fichier PNG est téléchargé, non vide, et
 *  son nom de fichier reflète la référence.
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
      text: 'Car Dieu a tant aimé le monde qu’il a donné son Fils unique, afin que quiconque croit en lui ne périsse point, mais qu’il ait la vie éternelle.',
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

process.env.PORT = process.env.PORT || '8792'; // distinct des autres tests
process.env.CHURCHOVERLAY_SKIP_BIBLE_DOWNLOAD = '1';
require('../server.js');

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

  let browser;
  let opWs;

  try {
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
    // #heroShareImageBtn vit dans <section id="overview">, pas l'onglet actif
    // par défaut — même raisonnement que integration-airlock-preview.js.
    await page.locator('.nav-item[data-sections="overview,transcript,controls"]').first().click();
    await page.waitForFunction(() => document.getElementById('heroShareImageBtn') !== null, {
      timeout: 5000,
    });

    // ============================================================
    // Sans verset affiché : toast d'erreur, aucun téléchargement.
    // ============================================================
    let downloadFired = false;
    page.once('download', () => {
      downloadFired = true;
    });
    await page.click('#heroShareImageBtn');
    await page.waitForFunction(
      () =>
        Array.from(document.querySelectorAll('.toast')).some((t) =>
          t.textContent.includes('Aucun verset affiché')
        ),
      { timeout: 3000 }
    );
    check('sans verset -> toast d’erreur affiché', true);
    await sleep(300); // laisse une chance à un téléchargement erroné de se déclencher, s'il devait y en avoir un
    check('sans verset -> aucun téléchargement déclenché', !downloadFired);

    // ============================================================
    // Diffuser un vrai verset (VRAI pipeline showVerse, texte du fake
    // bible-lookup), puis exporter -> vrai fichier PNG téléchargé.
    // ============================================================
    opWs.send(
      JSON.stringify({ action: 'showVerse', reference: 'Jean 3:16', text: 'placeholder client' })
    );
    // AJOUT : le détecteur normalise le nom du livre en minuscules dans la
    // référence renvoyée ("jean 3:16", pas "Jean 3:16") — comparaison
    // insensible à la casse plutôt que de dépendre de cette normalisation
    // interne, qui n'est pas ce que ce test cherche à vérifier.
    await page.waitForFunction(
      () =>
        (document.getElementById('verseReference')?.textContent || '')
          .toLowerCase()
          .includes('jean'),
      { timeout: 5000 }
    );

    const downloadPromise = page.waitForEvent('download', { timeout: 5000 });
    await page.click('#heroShareImageBtn');
    const download = await downloadPromise;
    check(
      'avec un verset affiché -> un téléchargement démarre',
      true,
      'aucun événement download reçu'
    );
    check(
      'le nom de fichier reflète la référence du verset',
      download.suggestedFilename().toLowerCase().includes('jean'),
      `nom observé: "${download.suggestedFilename()}"`
    );

    const downloadPath = await download.path();
    const fs = require('fs');
    const stats = downloadPath ? fs.statSync(downloadPath) : null;
    check(
      'le fichier téléchargé est un vrai PNG non vide (pas un fichier vide/corrompu)',
      !!stats && stats.size > 1000,
      `taille observée: ${stats ? stats.size : 'fichier introuvable'} octets`
    );
    if (downloadPath) {
      const fileBuffer = fs.readFileSync(downloadPath);
      const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      check(
        'la signature de fichier confirme un PNG réel (pas juste une extension .png)',
        Buffer.compare(fileBuffer.subarray(0, 8), pngSignature) === 0
      );
    }

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
  }

  console.log(
    `\n=== Résultat Smart Bible Overlay Builder (partage) : ${passed} passés, ${failed} échoués ===`
  );
  await sleep(50);
  process.exit(failed > 0 ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
