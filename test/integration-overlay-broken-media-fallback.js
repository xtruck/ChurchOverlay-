/**
 * ============================================================================
 *  integration-overlay-broken-media-fallback.js — "Smart Fallback Mode"
 *  (brief produit, priorité #3, sous-item "Hide broken media automatically")
 * ----------------------------------------------------------------------------
 *  Même discipline que integration-scene-overlay-lifecycle.js : VRAI
 *  overlay.html dans Chromium, VRAI server.js, un client WS opérateur brut
 *  déclenche les actions, le DOM réellement rendu est inspecté.
 *
 *  Avant ce correctif, un média dont le fichier disparaît du disque après
 *  ajout à la médiathèque (index toujours à jour, fichier absent — voir le
 *  même scénario dans integration-next-cue-confidence.js) restait affiché
 *  comme une icône d'image cassée / une vidéo noire indéfiniment, sans
 *  repli. overlay.js#showMediaItem() pose désormais img.onerror/video.onerror
 *  -> hideMediaItem(), qui appelle déjà maybeShowDefaultContent().
 *
 *  Couvre : (1) média cassé sans poster configuré -> se masque proprement,
 *  sans DOM cassé ni erreur applicative bloquante ; (2) média cassé AVEC un
 *  poster principal configuré -> le poster reprend sa place automatiquement,
 *  sans aucune action opérateur supplémentaire.
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

process.env.PORT = process.env.PORT || '8787'; // distinct des autres tests
process.env.CHURCHOVERLAY_SKIP_BIBLE_DOWNLOAD = '1';
require('../server.js');
const mediaLibrary = require('../media-library');

const WebSocket = require('ws');
const { chromium } = require(path.join(__dirname, '..', 'node_modules', 'playwright-core'));

const USER_DATA_DIR =
  process.env.CHURCHOVERLAY_DATA_DIR || path.join(os.homedir(), '.churchoverlay');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function makeSourceFile(dir, filename, bytes) {
  const p = path.join(dir, filename);
  fs.writeFileSync(p, Buffer.from(bytes));
  return p;
}

// PNG 1x1 transparent RÉEL et décodable (pas 4 octets arbitraires) —
// nécessaire pour le "poster principal" du test : contrairement au média
// cassé (qu'on veut voir échouer), le navigateur doit ici réussir à décoder
// l'image pour que la vérification "le poster reprend sa place" ait un sens.
const VALID_PNG_1X1_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

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

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'churchoverlay-fallback-'));
  const addedMediaIds = [];
  let browser;
  let opWs;

  try {
    // --- Média "cassé" : présent dans l'index, absent du disque ---
    const brokenMedia = mediaLibrary.addItem({
      sourcePath: makeSourceFile(tmpDir, 'casse.png', [0x00, 0x01, 0x02, 0x03]),
      label: 'Média cassé (test)',
    });
    addedMediaIds.push(brokenMedia.id);
    fs.unlinkSync(path.join(USER_DATA_DIR, 'media', brokenMedia.filename));

    opWs = new WebSocket(`ws://127.0.0.1:${process.env.PORT}`);
    await waitForOpen(opWs);
    // AJOUT (Operator activity log — priorité #10) : capture les diffusions
    // reçues par ce client "opérateur" brut pour vérifier que
    // reportMediaLoadFailure() (overlay.js) atteint bien tous les tableaux
    // de bord ouverts, pas seulement la console du projecteur.
    const receivedBroadcasts = [];
    opWs.on('message', (data) => {
      try {
        receivedBroadcasts.push(JSON.parse(data.toString()));
      } catch {
        /* message non-JSON, sans rapport avec ce test */
      }
    });

    browser = await chromium.launch();
    const page = await browser.newPage();
    const consoleErrors = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        const loc = msg.location();
        consoleErrors.push(`${msg.text()} (${(loc && loc.url) || ''})`);
      }
    });
    await page.goto(`http://127.0.0.1:${process.env.PORT}/overlay.html`, { waitUntil: 'load' });
    await sleep(300); // laisse l'overlay établir sa propre connexion WS

    // ============================================================
    // Cas 1 : média cassé, AUCUN poster principal configuré
    // ============================================================
    opWs.send(JSON.stringify({ action: 'triggerMediaItem', id: brokenMedia.id }));
    // Laisse le temps au <img>/<video> de tenter le chargement et d'échouer
    // réellement (vrai 404 réseau, pas un raccourci simulé).
    await page.waitForFunction(() => document.getElementById('media-layer-img').hidden, {
      timeout: 5000,
    });
    check(
      'média cassé sans poster -> le calque média se masque tout seul (repli automatique)',
      await page.evaluate(() => document.getElementById('media-layer-img').hidden)
    );
    check(
      'média cassé sans poster -> aucune src orpheline laissée sur l’élément masqué',
      (await page.evaluate(() =>
        document.getElementById('media-layer-img').getAttribute('src')
      )) === null
    );
    // AJOUT (Operator activity log) : le repli automatique doit aussi être
    // signalé au serveur (voir reportMediaLoadFailure() dans overlay.js),
    // rediffusé à tous les tableaux de bord — pas seulement géré en silence
    // côté overlay.
    const failureReport = receivedBroadcasts.find((m) => m.action === 'mediaLoadFailureReported');
    check(
      'le repli automatique est signalé au serveur (mediaLoadFailureReported diffusé)',
      !!failureReport,
      `diffusions reçues: ${JSON.stringify(receivedBroadcasts.map((m) => m.action))}`
    );
    check(
      'le signalement porte le bon libellé de média',
      failureReport && failureReport.label === 'Média cassé (test)',
      `libellé observé: ${failureReport && failureReport.label}`
    );

    // ============================================================
    // Cas 2 : même média cassé, mais AVEC un poster principal configuré —
    // le poster doit reprendre sa place tout seul, sans action opérateur.
    // ============================================================
    const posterMedia = mediaLibrary.addItem({
      sourcePath: makeSourceFile(tmpDir, 'poster.png', Buffer.from(VALID_PNG_1X1_BASE64, 'base64')),
      label: 'Poster principal (test)',
    });
    addedMediaIds.push(posterMedia.id);
    // Envoyé en WS (pas mediaLibrary.setDefaultItem() direct) : seul le
    // handler WS diffuse defaultMediaChanged — appeler le store directement
    // laisserait l'overlay déjà connecté ignorer totalement le changement.
    opWs.send(JSON.stringify({ action: 'setDefaultMediaItem', id: posterMedia.id }));
    await sleep(300);

    opWs.send(JSON.stringify({ action: 'triggerMediaItem', id: brokenMedia.id }));
    // AJOUT : media-library.js#addItem renomme TOUJOURS le fichier en
    // <uuid>.ext (voir son en-tête) — l'URL servie ne contient donc jamais
    // le nom d'origine "poster.png", seulement posterMedia.filename réel.
    await page.waitForFunction(
      (posterFilename) => {
        const img = document.getElementById('media-layer-img');
        return !img.hidden && img.src && img.src.includes(posterFilename);
      },
      posterMedia.filename,
      { timeout: 5000 }
    );
    // AJOUT : stabilisation avant la vérification finale — waitForFunction()
    // se contente d'un état vrai à UN instant donné (le sondage Playwright
    // peut techniquement capturer un état transitoire) ; un court repos
    // confirme que le poster reste bien affiché plutôt que d'accepter un
    // flash isolé comme preuve suffisante.
    await sleep(1000);
    check(
      'média cassé AVEC poster configuré -> le poster principal reprend automatiquement l’écran',
      await page.evaluate((posterFilename) => {
        const img = document.getElementById('media-layer-img');
        return !img.hidden && img.src.includes(posterFilename);
      }, posterMedia.filename)
    );

    // AJOUT : le 404 du média cassé est délibéré (c'est le scénario même
    // que ce test vérifie), Chromium le journalise quand même en erreur
    // console — voir le même raisonnement dans
    // integration-next-cue-confidence.js.
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
    if (opWs) opWs.close();
    for (const id of addedMediaIds) {
      try {
        mediaLibrary.deleteItem(id);
      } catch {
        /* le fichier "cassé" a déjà été supprimé à la main — sans conséquence */
      }
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log(
    `\n=== Résultat repli automatique média cassé (overlay) : ${passed} passés, ${failed} échoués ===`
  );
  await sleep(50);
  process.exit(failed > 0 ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
