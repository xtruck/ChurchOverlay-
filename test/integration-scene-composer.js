/**
 * ============================================================================
 *  integration-scene-composer.js — le composeur (formulaire) construit bien
 *  le JSON exact attendu par scene-store.js
 * ----------------------------------------------------------------------------
 *  AJOUT (studio de scènes, lot 6/6) : contrairement à integration-scene-crud.js
 *  (lot 3, qui envoie des messages WS écrits à la main pour valider le
 *  contrat serveur) et integration-scene-overlay-lifecycle.js (lot 4, qui
 *  valide le rendu réel sur overlay.html), ce test valide le CHAÎNON
 *  MANQUANT entre les deux : que le formulaire de composition
 *  (dashboard/features/scene-studio.js, chargé dans le VRAI dashboard.html
 *  via Playwright/Chromium) construit bien, à partir d'interactions DOM
 *  réelles (remplir un champ, choisir une position, cliquer "+ Texte"),
 *  exactement le JSON que scene-store.js#sanitizeElement()/sanitizeBackground()
 *  attend — sans quoi la galerie (lot 5) et le rendu overlay (lot 4) auraient
 *  beau être irréprochables, un opérateur ne pourrait jamais réellement
 *  composer de scène.
 *
 *  Couvre aussi le correctif de sécurité appliqué pendant ce lot : le champ
 *  texte d'un élément est assigné via la PROPRIÉTÉ .value (jamais l'attribut
 *  HTML value="...") précisément parce qu'un opérateur peut y taper des
 *  guillemets — ce test tape volontairement un texte contenant des
 *  guillemets doubles ET des chevrons pour vérifier qu'ils survivent intacts
 *  jusqu'au store (pas de troncature, pas de rupture du DOM du formulaire).
 *
 *  server.js tourne réellement (ASR/micro mockés, mêmes fakes que les autres
 *  tests scène). Nettoyage complet en fin de test.
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

process.env.PORT = process.env.PORT || '8774'; // distinct des autres tests
require('../server.js');
const sceneStore = require('../scene-store');
const mediaLibrary = require('../media-library');

const { chromium } = require(path.join(__dirname, '..', 'node_modules', 'playwright-core'));

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function makeSourceFile(dir, filename) {
  const p = path.join(dir, filename);
  fs.writeFileSync(p, Buffer.from([0x00, 0x01, 0x02, 0x03]));
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

  await sleep(300);

  const addedSceneIds = [];
  const addedMediaIds = [];
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'churchoverlay-scene-composer-test-'));

  const browser = await chromium.launch();
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => consoleErrors.push('pageerror: ' + err.message));
  await page.addInitScript(() => {
    window.churchOverlay = { pickMediaFile: async () => null, getSettings: async () => ({}) };
  });

  try {
    const bgMedia = mediaLibrary.addItem({
      sourcePath: makeSourceFile(tmpDir, 'fond.png'),
      label: 'Fond composeur test',
    });
    addedMediaIds.push(bgMedia.id);
    const logoMedia = mediaLibrary.addItem({
      sourcePath: makeSourceFile(tmpDir, 'logo.png'),
      label: 'Logo composeur test',
    });
    addedMediaIds.push(logoMedia.id);

    await page.goto(`http://127.0.0.1:${process.env.PORT}/dashboard.html`, {
      waitUntil: 'load',
    });
    await sleep(800); // laisse la connexion WS + getSceneLibrary/getMediaLibrary initiaux se résoudre

    await page.locator('.nav-item[data-sections*="studio"]').first().click();
    await sleep(300);

    console.log('\n=== Scénario 1 : composer une scène complète via le formulaire ===\n');

    await page.click('button:has-text("Nouvelle scène")');
    await sleep(150);
    check(
      'le composeur s’ouvre (carte visible)',
      await page.locator('#sceneComposerCard').isVisible()
    );

    const trickyText = 'Bienvenue "chez nous" & <à tous> !';
    await page.fill('#composerNameInput', 'Scène composée par test');
    await page.selectOption('#composerBgTypeSelect', 'media');
    await page.selectOption('#composerBgMediaSelect', bgMedia.id);

    await page.click('#sceneComposerCard button:has-text("+ Texte")');
    await sleep(100);
    const textRow = page
      .locator('#composerElementsList .scene-composer-element-row')
      .filter({ hasText: '🔤' });
    await textRow.locator('input[type="text"]').fill(trickyText);
    await textRow.locator('select').nth(0).selectOption('top-center'); // position
    await textRow.locator('select').nth(1).selectOption('Manrope'); // police
    await textRow.locator('input[type="number"]').fill('10'); // taille
    await textRow.locator('select').nth(2).selectOption('700'); // graisse
    await textRow.locator('input[type="color"]').fill('#ff00ff');
    await textRow.locator('select').nth(3).selectOption('left'); // alignement

    await page.click('#sceneComposerCard button:has-text("+ Image / logo")');
    await sleep(100);
    const imageRow = page
      .locator('#composerElementsList .scene-composer-element-row')
      .filter({ hasText: '🖼' });
    await imageRow.locator('select').nth(0).selectOption(logoMedia.id); // média
    await imageRow.locator('select').nth(1).selectOption('bottom-right'); // position
    await imageRow.locator('input[type="number"]').fill('25'); // largeur

    await sleep(150);
    const preview = await page.evaluate(() => ({
      hasBgImg: !!document.querySelector('#composerPreviewFrame .scene-background-img'),
      sceneTextContent: document.querySelector('#composerPreviewFrame .scene-text')
        ? document.querySelector('#composerPreviewFrame .scene-text').textContent
        : null,
      imageCount: document.querySelectorAll('#composerPreviewFrame .scene-image img').length,
    }));
    check('aperçu en direct : le fond image est rendu', preview.hasBgImg);
    check(
      'aperçu en direct : le texte (avec guillemets/chevrons) est rendu intact',
      preview.sceneTextContent === trickyText,
      JSON.stringify(preview.sceneTextContent)
    );
    check('aperçu en direct : l’élément image est rendu', preview.imageCount === 1);

    await page.click('#sceneComposerCard button:has-text("Enregistrer la scène")');
    await sleep(500);
    check(
      'le composeur se referme après enregistrement',
      !(await page.locator('#sceneComposerCard').isVisible())
    );

    const created = sceneStore.listItems().find((s) => s.name === 'Scène composée par test');
    addedSceneIds.push(created ? created.id : null);

    check('la scène a bien été créée côté store', !!created);
    if (created) {
      check(
        'fond : type média + bon mediaId',
        created.background.type === 'media' && created.background.mediaId === bgMedia.id
      );
      check('deux éléments enregistrés', created.elements.length === 2);
      const textEl = created.elements.find((e) => e.type === 'text');
      const imageEl = created.elements.find((e) => e.type === 'image');
      check(
        'élément texte : contenu intact (guillemets/chevrons non corrompus)',
        !!textEl && textEl.text === trickyText,
        JSON.stringify(textEl)
      );
      check(
        'élément texte : position/police/taille/graisse/couleur/alignement corrects',
        !!textEl &&
          textEl.position === 'top-center' &&
          textEl.fontFamily === 'Manrope' &&
          textEl.fontSizePct === 10 &&
          textEl.fontWeight === 700 &&
          textEl.color === '#ff00ff' &&
          textEl.align === 'left',
        JSON.stringify(textEl)
      );
      check(
        'élément image : mediaId/position/largeur corrects',
        !!imageEl &&
          imageEl.mediaId === logoMedia.id &&
          imageEl.position === 'bottom-right' &&
          imageEl.widthPct === 25,
        JSON.stringify(imageEl)
      );
    }

    if (!created) {
      console.log('Scénario 2 ignoré : la scène n’a pas pu être créée au scénario 1.');
    } else {
      console.log(
        '\n=== Scénario 2 : "✏ Modifier" pré-remplit le formulaire, "Enregistrer" met à jour (pas de doublon) ===\n'
      );
      const galleryCard = page
        .locator('#sceneStudioList .media-gallery-card')
        .filter({ hasText: 'Scène composée par test' });
      await galleryCard.locator('button[title="Modifier cette scène"]').click();
      await sleep(200);

      check(
        'le composeur se rouvre avec le nom pré-rempli',
        (await page.inputValue('#composerNameInput')) === 'Scène composée par test'
      );
      check(
        'le fond média pré-rempli est bien sélectionné',
        (await page.inputValue('#composerBgMediaSelect')) === bgMedia.id
      );
      const reopenedTextRow = page
        .locator('#composerElementsList .scene-composer-element-row')
        .filter({ hasText: '🔤' });
      check(
        'le texte de l’élément est pré-rempli intact (guillemets/chevrons compris)',
        (await reopenedTextRow.locator('input[type="text"]').inputValue()) === trickyText
      );

      await page.fill('#composerNameInput', 'Scène composée par test (modifiée)');
      await reopenedTextRow.locator('input[type="text"]').fill('Texte modifié');
      await page.click('#sceneComposerCard button:has-text("Enregistrer la scène")');
      await sleep(500);

      const afterEdit = sceneStore.listItems().filter((s) => s.id === created.id);
      check(
        'un seul enregistrement pour cet id après modification (pas de doublon)',
        afterEdit.length === 1
      );
      check(
        'le nom et le texte ont bien été mis à jour, même id',
        afterEdit.length === 1 &&
          afterEdit[0].name === 'Scène composée par test (modifiée)' &&
          afterEdit[0].elements.find((e) => e.type === 'text').text === 'Texte modifié',
        JSON.stringify(afterEdit[0])
      );
      check(
        'aucun doublon par nom non plus (updateScene, pas addScene)',
        sceneStore.listItems().filter((s) => s.name.startsWith('Scène composée par test'))
          .length === 1
      );
    }

    console.log(`\nErreurs console cumulées sur tout le test : ${consoleErrors.length}`);
    if (consoleErrors.length) console.log(consoleErrors);
    check(
      'aucune erreur console déclenchée',
      consoleErrors.length === 0,
      JSON.stringify(consoleErrors)
    );
  } finally {
    for (const id of addedSceneIds) {
      if (!id) continue;
      try {
        sceneStore.deleteItem(id);
      } catch (_) {}
    }
    for (const id of addedMediaIds) {
      try {
        mediaLibrary.deleteItem(id);
      } catch (_) {}
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
    await browser.close();
  }

  console.log(`\n=== Résultat composeur de scènes : ${passed} passés, ${failed} échoués ===`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((err) => {
  console.error("Erreur fatale dans le test d'intégration:", err);
  console.error(err.stack);
  process.exit(1);
});
