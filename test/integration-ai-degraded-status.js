/**
 * ============================================================================
 *  integration-ai-degraded-status.js — bannière "IA en mode dégradé" (audit
 *  fonctionnel)
 * ----------------------------------------------------------------------------
 *  server.js calcule déjà aiFeatures/aiLoadErrors (voir ai-modules-loader.js)
 *  et les envoie dans CHAQUE message 'init', mais rien côté tableau de bord
 *  ne les lisait jamais avant ce correctif — un module IA en repli (clé API
 *  absente, échec de chargement...) restait invisible à l'opérateur, visible
 *  seulement dans les journaux serveur.
 *
 *  ai-modules-loader.js est remplacé par un faux module (même convention que
 *  groq-wrapper.js/deepgram-wrapper.js ci-dessous) pour contrôler précisément
 *  aiLoadErrors plutôt que de dépendre des échecs de chargement réels de cet
 *  environnement de test (clés API absentes ou non selon la machine).
 *
 *  Couvre :
 *   1. aiLoadErrors non vide -> bannière visible, message listant les
 *      fonctionnalités en mode limité (nombre + noms des modules).
 *   2. Bouton "Fermer" -> bannière masquée.
 *  aiLoadErrors est calculé UNE SEULE FOIS au démarrage de server.js (pas
 *  par connexion), donc le cas "aucune erreur" n'est pas testable dans ce
 *  même fichier sans un second server.js — déjà couvert indirectement par
 *  n'importe quel autre test d'intégration qui charge dashboard.html sans
 *  faire planter ai-modules-loader.js : la bannière y reste invisible par
 *  défaut (voir #aiDegradedBanner, display:none tant que setAiDegradedStatus()
 *  n'a rien à signaler).
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

// AJOUT (ce test) : contrôle exact d'aiFeatures/aiLoadErrors, indépendant de
// ce que les VRAIS modules IA chargeraient sur cette machine.
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
      aiLoadErrors: [
        'SemanticDetector: groq.chatCompletion not available',
        'BibleSemanticSearch: index introuvable',
      ],
      groqHasChatCompletion: false,
    };
  },
});

process.env.PORT = process.env.PORT || '8796'; // distinct des autres tests
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

    await page.addInitScript(() => {
      localStorage.setItem('churchoverlay_wizard_seen', '1');
    });

    await page.goto(`http://127.0.0.1:${process.env.PORT}/dashboard.html`, { waitUntil: 'load' });
    await page.waitForFunction(
      () => document.getElementById('aiDegradedBanner')?.style.display === 'flex',
      { timeout: 5000 }
    );

    check('bannière IA dégradée visible après le message init', true);
    const msgText = await page.locator('#aiDegradedMessage').textContent();
    check(
      'le message mentionne le nombre de fonctionnalités en mode limité',
      msgText.includes('2'),
      msgText
    );
    check('le message nomme SemanticDetector', msgText.includes('SemanticDetector'), msgText);
    check('le message nomme BibleSemanticSearch', msgText.includes('BibleSemanticSearch'), msgText);

    await page.locator('#aiDegradedDismissBtn').click();
    await sleep(150);
    check(
      'le bouton "Fermer" masque la bannière',
      (await page.locator('#aiDegradedBanner').evaluate((el) => el.style.display)) !== 'flex'
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
  }

  console.log(
    `\n=== Résultat bannière IA en mode dégradé : ${passed} passés, ${failed} échoués ===`
  );
  process.exit(failed > 0 ? 1 : 0);
})();
