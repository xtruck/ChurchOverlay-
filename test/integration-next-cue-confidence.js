/**
 * ============================================================================
 *  integration-next-cue-confidence.js — "Next Cue Confidence" (brief produit,
 *  priorité #1) : badge Prêt/À vérifier/Bloqué par repère de la feuille de
 *  route, voir dashboard/features/next-cue-confidence.js.
 * ----------------------------------------------------------------------------
 *  Même discipline que integration-scene-composer.js : server.js réel (ASR
 *  mocké), VRAI dashboard.html chargé dans Chromium via Playwright, données
 *  seedées directement via mediaLibrary/sceneStore/rundownStore AVANT
 *  page.goto() (ramassées par les getMediaLibrary/getSceneLibrary/getRundown
 *  que state.js envoie automatiquement à la connexion — pas de diffusion à
 *  attendre puisque rien n'était encore connecté au moment du seed).
 *
 *  Couvre les 4 issues distinctes que next-cue-confidence.js sait détecter
 *  sans navigateur mobile ni pixel réel à lire :
 *    - média référencé mais fichier absent du disque -> bloqué
 *    - scène référençant un média supprimé de la médiathèque -> bloqué
 *    - scène avec un texte qui déborde du cadre 16:9 -> à vérifier
 *    - scène avec un contraste texte/fond quasi nul -> à vérifier
 *    - repère "propre" de chaque type (média/scène/verset) -> prêt
 *
 *  Nettoyage complet en fin de test (media/scenes/rundown).
 * ============================================================================
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

// Même résolution que server.js (USER_DATA_DIR) — nécessaire pour retrouver
// le fichier réel d'un item de médiathèque : addItem() ne renvoie que
// `filename`, jamais le chemin absolu (mediaDir reste privé à media-library.js).
const USER_DATA_DIR =
  process.env.CHURCHOVERLAY_DATA_DIR || path.join(os.homedir(), '.churchoverlay');

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

process.env.PORT = process.env.PORT || '8785'; // distinct des autres tests
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

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'churchoverlay-ncc-'));
  const addedMediaIds = [];
  const addedSceneIds = [];
  const addedCueIds = [];
  let browser;

  try {
    // --- Seed : média dont le fichier disparaît du disque après ajout ---
    const missingFileMedia = mediaLibrary.addItem({
      sourcePath: makeSourceFile(tmpDir, 'sera-supprime.png', [0x00, 0x01, 0x02, 0x03]),
      label: 'Média fichier manquant (test)',
    });
    addedMediaIds.push(missingFileMedia.id);
    const storedFilePath = path.join(USER_DATA_DIR, 'media', missingFileMedia.filename);
    fs.unlinkSync(storedFilePath); // index le connaît toujours, disque non — exactement le scénario ciblé

    // --- Seed : média intact (fichier présent, réel HEAD 200) ---
    const okMedia = mediaLibrary.addItem({
      sourcePath: makeSourceFile(tmpDir, 'ok.png', [0x00, 0x01, 0x02, 0x03]),
      label: 'Média intact (test)',
    });
    addedMediaIds.push(okMedia.id);

    // --- Seed : scène référençant un média jamais ajouté (mediaId inconnu) ---
    const danglingScene = sceneStore.addScene({
      name: 'Scène média supprimé (test)',
      background: { type: 'media', mediaId: 'mediaId-qui-n-existe-pas' },
      elements: [],
    });
    addedSceneIds.push(danglingScene.id);

    // --- Seed : scène avec débordement de texte (fond couleur, très grand, très long) ---
    const overflowScene = sceneStore.addScene({
      name: 'Scène débordante (test)',
      background: { type: 'color', color: '#101418' },
      elements: [
        {
          type: 'text',
          text: 'Ce texte est délibérément beaucoup trop long pour tenir dans le cadre à cette taille de police et devrait donc largement déborder du cadre visible sur le projecteur, ce qui est exactement ce que ce test vérifie.',
          position: 'center',
          fontSizePct: 30, // MAX_FONT_SIZE_PCT — garantit le débordement pour un texte de cette longueur
          color: '#ffffff',
        },
      ],
    });
    addedSceneIds.push(overflowScene.id);

    // --- Seed : scène à faible contraste (fond et texte quasi identiques) ---
    const lowContrastScene = sceneStore.addScene({
      name: 'Scène faible contraste (test)',
      background: { type: 'color', color: '#101010' },
      elements: [{ type: 'text', text: 'Texte peu visible', position: 'center', color: '#141414' }],
    });
    addedSceneIds.push(lowContrastScene.id);

    // --- Seed : scène "propre" (aucun problème détectable) ---
    const goodScene = sceneStore.addScene({
      name: 'Scène propre (test)',
      background: { type: 'color', color: '#0b0c10' },
      elements: [
        { type: 'text', text: 'Bienvenue', position: 'center', fontSizePct: 6, color: '#ffffff' },
      ],
    });
    addedSceneIds.push(goodScene.id);

    // --- Repères de feuille de route pointant vers tout ce qui précède ---
    const cueMissingFile = rundownStore.addCue({
      type: 'media',
      label: 'Média fichier manquant (test)',
      mediaId: missingFileMedia.id,
    });
    addedCueIds.push(cueMissingFile.id);
    const cueOkMedia = rundownStore.addCue({
      type: 'media',
      label: 'Média intact (test)',
      mediaId: okMedia.id,
    });
    addedCueIds.push(cueOkMedia.id);
    const cueDanglingScene = rundownStore.addCue({
      type: 'scene',
      label: 'Scène média supprimé (test)',
      sceneId: danglingScene.id,
    });
    addedCueIds.push(cueDanglingScene.id);
    const cueOverflowScene = rundownStore.addCue({
      type: 'scene',
      label: 'Scène débordante (test)',
      sceneId: overflowScene.id,
    });
    addedCueIds.push(cueOverflowScene.id);
    const cueLowContrastScene = rundownStore.addCue({
      type: 'scene',
      label: 'Scène faible contraste (test)',
      sceneId: lowContrastScene.id,
    });
    addedCueIds.push(cueLowContrastScene.id);
    const cueGoodScene = rundownStore.addCue({
      type: 'scene',
      label: 'Scène propre (test)',
      sceneId: goodScene.id,
    });
    addedCueIds.push(cueGoodScene.id);
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
      if (msg.type() === 'error') {
        const loc = msg.location();
        consoleErrors.push(`${msg.text()} (${(loc && loc.url) || ''})`);
      }
    });
    await page.addInitScript(() => {
      window.churchOverlay = window.churchOverlay || {};
      localStorage.setItem('churchoverlay_wizard_seen', '1');
    });

    await page.goto(`http://127.0.0.1:${process.env.PORT}/dashboard.html`, { waitUntil: 'load' });

    // Les vérifications sont asynchrones (sondes réseau/police/rendu hors-écran) —
    // attend que tous les badges soient sortis de l'état "checking" plutôt qu'un
    // délai fixe fragile.
    await page.waitForFunction(
      (ids) =>
        ids.every((id) => {
          const el = document.getElementById(`cueReadiness-${id}`);
          return el && !el.className.includes('cue-readiness-checking');
        }),
      addedCueIds,
      { timeout: 10000 }
    );

    const badgeState = async (cueId) =>
      page.evaluate((id) => {
        const el = document.getElementById(`cueReadiness-${id}`);
        return el ? { className: el.className, title: el.title } : null;
      }, cueId);

    const missingFileBadge = await badgeState(cueMissingFile.id);
    check(
      'média avec fichier disparu du disque -> badge bloqué',
      missingFileBadge && missingFileBadge.className.includes('cue-readiness-blocked'),
      JSON.stringify(missingFileBadge)
    );
    check(
      'le message du badge bloqué mentionne le fichier introuvable',
      missingFileBadge && /introuvable/i.test(missingFileBadge.title)
    );

    const okMediaBadge = await badgeState(cueOkMedia.id);
    check(
      'média intact -> badge PAS bloqué',
      okMediaBadge && !okMediaBadge.className.includes('cue-readiness-blocked'),
      JSON.stringify(okMediaBadge)
    );

    const danglingSceneBadge = await badgeState(cueDanglingScene.id);
    check(
      'scène référençant un média supprimé -> badge bloqué',
      danglingSceneBadge && danglingSceneBadge.className.includes('cue-readiness-blocked'),
      JSON.stringify(danglingSceneBadge)
    );

    const overflowBadge = await badgeState(cueOverflowScene.id);
    check(
      'scène avec texte débordant -> badge "à vérifier" (pas bloqué)',
      overflowBadge &&
        overflowBadge.className.includes('cue-readiness-attention') &&
        !overflowBadge.className.includes('cue-readiness-blocked'),
      JSON.stringify(overflowBadge)
    );

    const lowContrastBadge = await badgeState(cueLowContrastScene.id);
    check(
      'scène à faible contraste -> badge "à vérifier"',
      lowContrastBadge && lowContrastBadge.className.includes('cue-readiness-attention'),
      JSON.stringify(lowContrastBadge)
    );
    check(
      'le message du badge faible contraste mentionne le contraste',
      lowContrastBadge && /contraste/i.test(lowContrastBadge.title)
    );

    const goodSceneBadge = await badgeState(cueGoodScene.id);
    check(
      'scène propre -> badge prêt',
      goodSceneBadge && goodSceneBadge.className.includes('cue-readiness-ready'),
      JSON.stringify(goodSceneBadge)
    );

    const verseBadge = await badgeState(cueVerse.id);
    check(
      'repère verset (connecté) -> badge prêt',
      verseBadge && verseBadge.className.includes('cue-readiness-ready'),
      JSON.stringify(verseBadge)
    );

    // AJOUT : Chromium journalise TOUTE requête réseau non-2xx dans la console
    // devtools, y compris un fetch() HEAD dont le code gère parfaitement le
    // 404 via res.ok (voir urlIsReachable() dans next-cue-confidence.js) — le
    // média dont le fichier a été supprimé du disque ci-dessus produit
    // délibérément ce 404 sur /media/<id>.png (media-library.js#addItem
    // renomme toujours le fichier en <uuid>.ext, jamais le nom d'origine),
    // c'est exactement le scénario que ce test vérifie, pas une erreur
    // applicative.
    const unexpectedConsoleErrors = consoleErrors.filter(
      (e) => !(/404/.test(e) && /\/media\//.test(e))
    );
    check(
      'aucune erreur console applicative inattendue',
      unexpectedConsoleErrors.length === 0,
      unexpectedConsoleErrors.join(' | ')
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
        /* déjà retiré ou jamais créé — sans conséquence pour le nettoyage */
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
        /* le fichier "manquant" a déjà été supprimé à la main plus haut — sans conséquence */
      }
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log(`\n=== Résultat Next Cue Confidence : ${passed} passés, ${failed} échoués ===`);
  await sleep(50);
  process.exit(failed > 0 ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
