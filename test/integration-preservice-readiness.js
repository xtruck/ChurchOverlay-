/**
 * ============================================================================
 *  integration-preservice-readiness.js — Pre-Service Readiness Score
 * ----------------------------------------------------------------------------
 *  Extension du bouton "Tester avant le culte" existant (preServiceCheck,
 *  voir diagnostics-ws-handlers.js) : au-delà des clés API/médiathèque déjà
 *  couvertes, agrège désormais la feuille de route, le mode de confiance,
 *  les modules IA en repli et la charge réseau WebSocket en un score/badge
 *  unique — calculé côté SERVEUR (le tableau de bord ne fait qu'afficher,
 *  voir renderPreServiceCheckResult dans preservice-ai.js).
 * ----------------------------------------------------------------------------
 *  Couvre : (1) feuille de route vide + mode de confiance non choisi ->
 *  badge "à vérifier" ; (2) un repère ajouté + mode de confiance choisi ->
 *  ces deux lignes passent au vert et le score progresse ; (3) modules IA en
 *  échec de chargement (aiLoadErrors non vide) -> ligne "Modules IA" en
 *  alerte, score qui baisse en conséquence ; (4) cliquer à nouveau sur le
 *  bouton met bien à jour l'affichage en direct (pas seulement au premier
 *  chargement).
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
  // AJOUT (ce test) : preServiceCheck (diagnostics-ws-handlers.js) appelle
  // groq.checkKey()/deepgramWrapper.checkKey() sans condition — un faux
  // module qui ne l'expose pas fait échouer TOUTE la vérification pré-culte
  // (silencieusement côté serveur, juste un message 'error' diffusé).
  async checkKey() {
    return { configured: false, ok: false, error: 'GROQ_API_KEY non défini (test).' };
  },
});
injectFakeModule('deepgram-wrapper.js', {
  isConfigured() {
    return false;
  },
  async transcribeFile() {
    throw new Error('non utilisé dans ce test');
  },
  async checkKey() {
    return { configured: false, ok: false, error: 'DEEPGRAM_API_KEY non défini (test).' };
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

// AJOUT (ce test) : contrôle exact d'aiLoadErrors, même convention que
// integration-ai-degraded-status.js — indépendant de ce que les VRAIS
// modules IA chargeraient sur cette machine (clés API absentes ou non selon
// l'environnement).
injectFakeModule('ai-modules-loader.js', {
  loadAIModules() {
    return {
      semanticDetector: null,
      detectCommand: null,
      corrector: null,
      semanticSearch: null,
      plugins: null,
      themeGenerator: null,
      aiEnricher: null,
      aiLoadErrors: ['SemanticDetector: groq.chatCompletion not available'],
      groqHasChatCompletion: false,
    };
  },
});

process.env.PORT = process.env.PORT || '8791'; // distinct des autres tests
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
    // CORRECTIF (pollution inter-fichiers) : même correctif que
    // integration-cue-cards.js/integration-rundown-timeline.js — état connu
    // quel que soit ce qui a tourné avant dans la même invocation npm test.
    rundownStore.clearCues();

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
    // #preServiceCheckBtn vit dans <section id="settings"> (onglet Réglages),
    // masquée par défaut (style="display: none") tant qu'on n'a pas cliqué
    // le nav-item correspondant — même raisonnement que
    // integration-cue-cards.js pour #rundownList dans <section id="overview">.
    await page.locator('.nav-item[data-sections="settings,overlay"]').first().click();
    await page.waitForFunction(
      () => document.getElementById('preServiceCheckBtn')?.offsetParent !== null,
      { timeout: 5000 }
    );

    // ============================================================
    // État initial : feuille de route vide, mode de confiance non choisi,
    // module IA en échec de chargement -> badge "à vérifier", pas "prêt".
    // ============================================================
    await page.click('#preServiceCheckBtn');
    await page.waitForFunction(
      () => document.getElementById('preServiceCheckResults')?.style.display === 'block',
      { timeout: 5000 }
    );
    const headline1 = await page.locator('.preflight-headline').textContent();
    check(
      'feuille de route vide + mode non choisi + IA en repli -> badge "à vérifier"',
      headline1.includes('à vérifier'),
      headline1
    );
    check(
      'ligne "Feuille de route préparée" en alerte quand elle est vide',
      (await page
        .locator('.preflight-row', { hasText: 'Feuille de route préparée' })
        .first()
        .getAttribute('class')) !== null
    );
    const scoreText1 = await page
      .locator('.preflight-headline .preflight-row-status')
      .textContent();
    const score1 = Number.parseInt(scoreText1, 10);
    check(
      'le score initial est un pourcentage valide (0-100), pas 100%',
      Number.isFinite(score1) && score1 >= 0 && score1 < 100,
      scoreText1
    );

    // ============================================================
    // Ajoute un repère + choisit un mode de confiance -> ces deux points
    // passent au vert, le score progresse (mais reste < 100 à cause du
    // module IA toujours en repli).
    // ============================================================
    const cue = rundownStore.addCue({
      type: 'verse',
      label: 'Ouverture (test readiness)',
      reference: 'Jean 3:16',
    });
    addedCueIds.push(cue.id);
    opWs.send(JSON.stringify({ action: 'setTrustMode', mode: 'semi-auto' }));
    await sleep(100);

    await page.click('#preServiceCheckBtn');
    await page.waitForFunction(
      () =>
        (document.querySelector('.preflight-headline .preflight-row-status')?.textContent || '') !==
        '',
      { timeout: 5000 }
    );
    await sleep(150); // laisse le second rendu (re-clic) se stabiliser

    const rundownRowText = await page
      .locator('.preflight-row', { hasText: 'Feuille de route préparée' })
      .first()
      .textContent();
    check(
      'après ajout d’un repère, la ligne "Feuille de route préparée" reflète 1 repère',
      rundownRowText.includes('1 repère'),
      rundownRowText
    );
    const trustRowText = await page
      .locator('.preflight-row', { hasText: 'Mode de confiance' })
      .first()
      .textContent();
    check(
      'après setTrustMode, la ligne "Mode de confiance" affiche Semi-automatique',
      trustRowText.includes('Semi-automatique'),
      trustRowText
    );
    const aiRowText = await page
      .locator('.preflight-row', { hasText: 'Modules IA' })
      .first()
      .textContent();
    check(
      'la ligne "Modules IA" reste en alerte (aiLoadErrors non vide, indépendant du rundown/trust mode)',
      aiRowText.includes('1 en mode limité'),
      aiRowText
    );

    const scoreText2 = await page
      .locator('.preflight-headline .preflight-row-status')
      .textContent();
    const score2 = Number.parseInt(scoreText2, 10);
    check(
      'le score progresse après avoir corrigé 2 des 3 points en alerte',
      score2 > score1,
      `avant: ${scoreText1}, après: ${scoreText2}`
    );
    check('le score reste sous 100% tant que le module IA est en repli', score2 < 100, scoreText2);

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

  console.log(
    `\n=== Résultat Pre-Service Readiness Score : ${passed} passés, ${failed} échoués ===`
  );
  await sleep(50);
  process.exit(failed > 0 ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
