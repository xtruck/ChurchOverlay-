/**
 * ============================================================================
 *  integration-airlock-preview.js — "Airlock Preview" (brief produit,
 *  priorité #2) : armer un repère de la feuille de route affiche son aperçu
 *  dans le sas de diffusion SANS rien envoyer en direct, puis "Aller en
 *  direct" déclenche réellement — voir dashboard/features/airlock-preview.js.
 * ----------------------------------------------------------------------------
 *  Même discipline que integration-next-cue-confidence.js : server.js réel,
 *  VRAI dashboard.html dans Chromium, données seedées via
 *  mediaLibrary/sceneStore/rundownStore AVANT page.goto(). bible-lookup-
 *  with-api.js est mocké (comme test-rundown-actions.js) pour que le
 *  repère verset ait un texte déterministe une fois réellement diffusé.
 *
 *  Couvre le parcours complet : armer un média -> aperçu peuplé, rien de
 *  diffusé -> aller en direct -> colonne "en direct" mise à jour, sas vidé ;
 *  armer une scène -> aperçu rendu (renderSceneDom réel) ; désarmer sans
 *  diffuser -> sas vidé, "en direct" inchangé ; armer un verset -> aperçu
 *  référence-seule (texte non encore connu) -> en direct -> texte réel
 *  affiché.
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
      text: 'Car Dieu a tant aimé le monde... (texte factice de test)',
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

process.env.PORT = process.env.PORT || '8786'; // distinct des autres tests
process.env.CHURCHOVERLAY_SKIP_BIBLE_DOWNLOAD = '1';
require('../server.js');
const mediaLibrary = require('../media-library');
const sceneStore = require('../scene-store');
const rundownStore = require('../rundown-store');

const { chromium } = require(path.join(__dirname, '..', 'node_modules', 'playwright-core'));

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
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

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'churchoverlay-airlock-'));
  const addedMediaIds = [];
  const addedSceneIds = [];
  const addedCueIds = [];
  let browser;

  try {
    const media = mediaLibrary.addItem({
      sourcePath: makeSourceFile(tmpDir, 'photo.png', [0x00, 0x01, 0x02, 0x03]),
      label: 'Photo sas (test)',
    });
    addedMediaIds.push(media.id);

    const scene = sceneStore.addScene({
      name: 'Scène sas (test)',
      background: { type: 'color', color: '#101418' },
      elements: [{ type: 'text', text: 'Bienvenue', position: 'center', color: '#ffffff' }],
    });
    addedSceneIds.push(scene.id);

    const cueMedia = rundownStore.addCue({
      type: 'media',
      label: 'Photo sas (test)',
      mediaId: media.id,
    });
    addedCueIds.push(cueMedia.id);
    const cueScene = rundownStore.addCue({
      type: 'scene',
      label: 'Scène sas (test)',
      sceneId: scene.id,
    });
    addedCueIds.push(cueScene.id);
    const cueVerse = rundownStore.addCue({
      type: 'verse',
      label: 'Jean 3:16 (test)',
      reference: 'Jean 3:16',
    });
    addedCueIds.push(cueVerse.id);

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
    // #rundownList/#airlockCard vivent dans <section id="overview">, pas
    // l'onglet actif par défaut ("propresenter-live", voir state.js#showSectionsFor)
    // — sans ce clic, tous les éléments existent dans le DOM mais restent
    // display:none, donc invisibles/non cliquables pour Playwright.
    await page.locator('.nav-item[data-sections="overview,transcript,controls"]').first().click();
    // getMediaLibrary/getSceneLibrary/getRundown envoyés automatiquement à
    // l'ouverture (voir state.js#initWebSocket) — laisse le temps que les
    // trois réponses arrivent avant d'interagir avec la feuille de route.
    await page.waitForFunction(() => document.getElementById('rundownList').children.length > 0, {
      timeout: 5000,
    });

    const airlockText = () => page.locator('#airlockCard').innerText();

    // --- Avant tout armement : sas vide, boutons désactivés ---
    check(
      'sas vide au départ (aucun élément armé)',
      /Aucun élément armé/.test(await airlockText())
    );
    check(
      '"Aller en direct" désactivé sans élément armé',
      await page.locator('#airlockGoLiveBtn').isDisabled()
    );

    // --- Armer le média : aperçu peuplé, RIEN diffusé (overlay inchangé) ---
    await page.click(`#rundownList [onclick="armRundownCue('${cueMedia.id}')"]`);
    await page.waitForFunction(() => !document.getElementById('airlockGoLiveBtn').disabled, {
      timeout: 3000,
    });
    check(
      'média armé -> aperçu contient une image',
      (await page.locator('#airlockArmedPreview img').count()) === 1
    );
    check(
      'média armé -> colonne "en direct" toujours vide (rien diffusé)',
      /Rien à l.écran/.test(await airlockText())
    );

    // --- Aller en direct : colonne "en direct" mise à jour, sas vidé ---
    await page.click('#airlockGoLiveBtn');
    await page.waitForFunction(
      () => document.getElementById('airlockLivePreview').querySelector('img'),
      {
        timeout: 5000,
      }
    );
    check(
      'après "Aller en direct" : colonne "en direct" affiche l’image',
      (await page.locator('#airlockLivePreview img').count()) === 1
    );
    check(
      'après "Aller en direct" : sas redevient vide',
      await page.locator('#airlockGoLiveBtn').isDisabled()
    );

    // --- Armer la scène : rendu réel via renderSceneDom ---
    await page.click(`#rundownList [onclick="armRundownCue('${cueScene.id}')"]`);
    await page.waitForFunction(() => !document.getElementById('airlockGoLiveBtn').disabled, {
      timeout: 3000,
    });
    check(
      'scène armée -> aperçu contient le texte de la scène',
      (await page.locator('#airlockArmedPreview .scene-text').innerText()) === 'Bienvenue'
    );
    check(
      'scène armée SANS aller en direct -> "en direct" montre toujours le média précédent',
      (await page.locator('#airlockLivePreview img').count()) === 1
    );

    // --- Désarmer sans diffuser : sas vidé, "en direct" inchangé ---
    await page.click('#airlockDisarmBtn');
    await page.waitForFunction(() => document.getElementById('airlockGoLiveBtn').disabled, {
      timeout: 3000,
    });
    check('désarmer -> sas redevient vide', /Aucun élément armé/.test(await airlockText()));
    check(
      'désarmer -> "en direct" toujours inchangé (le média précédent)',
      (await page.locator('#airlockLivePreview img').count()) === 1
    );

    // --- Armer le verset : aperçu référence-seule (pas de texte, honnête) ---
    await page.click(`#rundownList [onclick="armRundownCue('${cueVerse.id}')"]`);
    await page.waitForFunction(() => !document.getElementById('airlockGoLiveBtn').disabled, {
      timeout: 3000,
    });
    const armedVerseText = await page.locator('#airlockArmedPreview').innerText();
    check('verset armé -> aperçu affiche la référence', armedVerseText.includes('Jean 3:16'));
    check(
      'verset armé -> aucun texte biblique inventé avant diffusion réelle',
      !armedVerseText.includes('Car Dieu a tant aimé')
    );

    // --- Aller en direct sur le verset : texte réel maintenant connu ---
    await page.click('#airlockGoLiveBtn');
    await page.waitForFunction(
      () => (document.getElementById('airlockLivePreview').innerText || '').includes('Car Dieu'),
      { timeout: 5000 }
    );
    check(
      'verset en direct -> le vrai texte (issu du lookup serveur) apparaît dans "en direct"',
      (await page.locator('#airlockLivePreview').innerText()).includes('Car Dieu a tant aimé')
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
    for (const id of addedCueIds) {
      try {
        rundownStore.removeCue(id);
      } catch {
        /* déjà retiré ou jamais créé */
      }
    }
    for (const id of addedSceneIds) {
      try {
        sceneStore.deleteItem(id);
      } catch {
        /* idem */
      }
    }
    for (const id of addedMediaIds) {
      try {
        mediaLibrary.deleteItem(id);
      } catch {
        /* idem */
      }
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log(`\n=== Résultat Airlock Preview : ${passed} passés, ${failed} échoués ===`);
  await sleep(50);
  process.exit(failed > 0 ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
