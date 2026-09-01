/**
 * ============================================================================
 *  integration-dashboard-reconnect-hydration.js — le tableau de bord se
 *  resynchronise vraiment après une reconnexion WebSocket
 * ----------------------------------------------------------------------------
 *  RÈGLE MISSION : l'application tourne EN DIRECT pendant le culte. Une
 *  coupure réseau, un redémarrage du serveur ou la mise en veille du portable
 *  de l'opérateur arrivent pour de vrai, et le tableau de bord se reconnecte
 *  tout seul (state.js > scheduleReconnect). Le danger n'est pas la coupure
 *  elle-même : c'est de revenir en affichant un état PÉRIMÉ. Un deuxième
 *  poste (ou une commande vocale) a pu changer la langue ou couper les
 *  sous-titres pendant la coupure — si le tableau de bord réaffiche l'ancien
 *  état, l'opérateur pilote à l'aveugle et croit voir ce que l'assemblée voit.
 *
 *  Les bibliothèques (médias, scènes, chants, feuille de route…) n'ont pas ce
 *  problème : state.js les REDEMANDE explicitement à chaque onopen. La langue
 *  et les bascules d'affichage, elles, n'arrivent QUE dans le message 'init' —
 *  que ws-dispatch.js ignorait presque entièrement jusqu'à ce correctif.
 *
 *  Ce test utilise un VRAI server.js (mêmes mocks réseau/micro que les autres
 *  tests d'intégration), le VRAI dashboard.html chargé dans Chromium
 *  (Playwright, comme integration-scene-composer.js) et une VRAIE coupure
 *  réseau (context.setOffline) — pas une simulation de message. Il vérifie le
 *  DOM réellement affiché, pas seulement qu'un message a été reçu.
 *
 *  Déroulé en 3 temps, calqué sur l'incident de production :
 *   1. état de départ constaté dans le DOM (français, bascules éteintes) ;
 *   2. réseau coupé, un AUTRE opérateur change tout depuis un second poste —
 *      on vérifie que le tableau de bord a bien MANQUÉ ces diffusions (il
 *      affiche encore l'ancien état). Sans cette étape, le test passerait
 *      aussi bien grâce aux diffusions live et ne prouverait rien sur la
 *      reconnexion ;
 *   3. réseau rétabli : le tableau de bord se reconnecte seul et doit
 *      afficher le NOUVEL état, reconstruit depuis le seul 'init'.
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
  async getChapterVersesMultilang() {
    throw new Error('non utilisé dans ce test');
  },
  async getVerseMultilang() {
    throw new Error('non utilisé dans ce test');
  },
  buildReferenceLabel() {
    return '';
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
  getTranslationId() {
    return 'lsg';
  },
  getCacheSize() {
    return 0;
  },
  clearCache() {},
  getProviders() {
    return ['fake-provider'];
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

process.env.PORT = process.env.PORT || '8784'; // distinct des autres tests
process.env.CHURCHOVERLAY_SKIP_BIBLE_DOWNLOAD = '1';
require('../server.js');

const WebSocket = require('ws');
const { chromium } = require(path.join(__dirname, '..', 'node_modules', 'playwright-core'));

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Attend qu'une condition lue dans le DOM devienne vraie, en interrogeant la
 * page à intervalle court. Un sleep fixe serait fragile ici : le délai de
 * reconnexion est un backoff (2s x tentatives, voir state.js), donc variable
 * selon le nombre de tentatives échouées pendant la coupure.
 */
async function waitForCondition(page, evaluateFn, timeoutMs, arg) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await page.evaluate(evaluateFn, arg);
    if (last) return last;
    await sleep(200);
  }
  return last;
}

/** Lit d'un seul coup tout l'état d'affichage visible dans le DOM. */
const readDisplayState = () => {
  const checked = (id) => {
    const el = document.getElementById(id);
    return el ? !!el.checked : null;
  };
  const activeLang = document.querySelector('.lang-btn.active');
  const activePattern = document.querySelector('#patternPicker .mood-btn.active');
  const langSelect = document.getElementById('captionTargetLangSelect');
  return {
    language: activeLang ? activeLang.dataset.lang : null,
    highContrast: checked('highContrastToggle'),
    captions: checked('captionsToggle'),
    translatedCaptions: checked('translatedCaptionsToggle'),
    captionTargetLang: langSelect ? langSelect.value : null,
    testPattern: checked('testPatternToggle'),
    backgroundPattern: activePattern ? activePattern.id.replace('pattern-btn-', '') : null,
    connected: !document.querySelector('.status.offline'),
  };
};

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

  const browser = await chromium.launch();
  const context = await browser.newContext();
  const page = await context.newPage();

  const consoleErrors = [];
  page.on('console', (msg) => {
    // Même filtrage que integration-scene-composer.js : les "Failed to load
    // resource" (flux caméra absent, polices externes) sont du bruit
    // d'environnement, pas des erreurs de l'application sous test. Pendant la
    // coupure réseau volontaire de l'étape 2, l'échec de connexion WebSocket
    // est ATTENDU (c'est le scénario testé) — on ne le compte pas non plus.
    if (msg.type() !== 'error') return;
    const text = msg.text();
    if (text.startsWith('Failed to load resource')) return;
    if (text.includes('WebSocket')) return;
    consoleErrors.push(text);
  });
  page.on('pageerror', (err) => consoleErrors.push('pageerror: ' + err.message));

  await page.addInitScript(() => {
    window.churchOverlay = { pickMediaFile: async () => null, getSettings: async () => ({}) };
    // Voir integration-scene-composer.js : sans ce drapeau, l'assistant de
    // démarrage s'ouvre seul et son overlay masque le reste de la page.
    localStorage.setItem('churchoverlay_wizard_seen', '1');

    // INSTRUMENTATION DE TEST (n'altère aucun code applicatif) : state.js
    // garde sa socket dans une variable de module, non exposée sur window —
    // on encapsule donc le constructeur natif pour en garder une référence et
    // pouvoir la FERMER pour de vrai.
    //
    // Pourquoi pas context.setOffline() : Chromium met alors les trames en
    // TAMPON et les délivre au rétablissement du réseau. Le tableau de bord
    // recevait donc les diffusions live avec du retard et se resynchronisait
    // « tout seul » — un test vert même sans le correctif, qui ne prouvait
    // rien. Une vraie fermeture reproduit fidèlement l'incident visé
    // (redémarrage du serveur, veille du portable) : le serveur ne diffuse
    // qu'aux sockets OPEN (voir broadcast() dans server.js), donc tout ce qui
    // est émis pendant la coupure est DÉFINITIVEMENT perdu pour ce client —
    // seul le 'init' de la reconnexion peut encore le rattraper.
    const NativeWebSocket = window.WebSocket;
    window.__testSockets = [];
    const Wrapped = function (...args) {
      const sock = new NativeWebSocket(...args);
      window.__testSockets.push(sock);
      return sock;
    };
    Wrapped.prototype = NativeWebSocket.prototype;
    // state.js compare `ws.readyState === WebSocket.OPEN` : les constantes
    // doivent rester accessibles sur le substitut.
    Wrapped.CONNECTING = NativeWebSocket.CONNECTING;
    Wrapped.OPEN = NativeWebSocket.OPEN;
    Wrapped.CLOSING = NativeWebSocket.CLOSING;
    Wrapped.CLOSED = NativeWebSocket.CLOSED;
    window.WebSocket = Wrapped;
  });

  /** Second poste opérateur — celui qui change l'état pendant la coupure. */
  function openOperatorSocket() {
    const sock = new WebSocket(`ws://127.0.0.1:${process.env.PORT}`);
    return new Promise((resolve, reject) => {
      sock.on('open', () => resolve(sock));
      sock.on('error', reject);
    });
  }

  try {
    await page.goto(`http://127.0.0.1:${process.env.PORT}/dashboard.html`, { waitUntil: 'load' });

    // --- 1. État de départ ------------------------------------------------
    console.log('\n=== 1. État de départ du tableau de bord ===\n');
    const initial = await waitForCondition(
      page,
      () => {
        const active = document.querySelector('.lang-btn.active');
        const online = !document.querySelector('.status.offline');
        return active && online ? { language: active.dataset.lang } : null;
      },
      15000
    );
    check(
      'le tableau de bord est connecté et affiche la langue par défaut (fr)',
      !!initial && initial.language === 'fr',
      JSON.stringify(initial)
    );

    const before = await page.evaluate(readDisplayState);
    check(
      'bascules d’affichage éteintes au départ (contraste/sous-titres/motif de test)',
      before.highContrast === false &&
        before.captions === false &&
        before.translatedCaptions === false &&
        before.testPattern === false,
      JSON.stringify(before)
    );

    // --- 2. Coupure + changements depuis un AUTRE poste --------------------
    console.log('\n=== 2. Connexion coupée — un autre opérateur change tout ===\n');
    const socketsBefore = await page.evaluate(() => {
      // Ferme la socket courante comme le ferait un redémarrage du serveur.
      const socks = window.__testSockets;
      socks[socks.length - 1].close();
      return socks.length;
    });
    const wentOffline = await waitForCondition(
      page,
      () => !!document.querySelector('.status.offline'),
      10000
    );
    check(
      'la coupure est bien vue par le tableau de bord (statut hors ligne)',
      !!wentOffline,
      'le statut est resté "connecté"'
    );

    const operator = await openOperatorSocket();
    operator.send(JSON.stringify({ action: 'setLanguage', language: 'en' }));
    operator.send(JSON.stringify({ action: 'setHighContrast', enabled: true }));
    operator.send(JSON.stringify({ action: 'setCaptions', enabled: true }));
    operator.send(
      JSON.stringify({ action: 'setTranslatedCaptions', enabled: true, targetLang: 'es' })
    );
    operator.send(JSON.stringify({ action: 'setTestPattern', enabled: true }));
    operator.send(JSON.stringify({ action: 'setBackgroundPattern', pattern: 'grid' }));
    await sleep(600);

    // Vérification CRUCIALE : le tableau de bord doit avoir MANQUÉ ces
    // diffusions. Sans ça, l'étape 3 pourrait passer grâce aux messages live
    // et ne prouverait rien sur la reconstruction depuis 'init'.
    const during = await page.evaluate(readDisplayState);
    check(
      'pendant la coupure, le tableau de bord a bien MANQUÉ les diffusions (état encore périmé)',
      during.language === 'fr' && during.captions === false && during.highContrast === false,
      JSON.stringify(during)
    );

    // --- 3. Reconnexion automatique : reconstruction depuis 'init' ---------
    console.log('\n=== 3. Reconnexion — le tableau de bord doit se resynchroniser ===\n');
    // state.js reconnecte seul (scheduleReconnect, backoff 2s x tentatives) :
    // aucune action du test ici, c'est bien le comportement de l'application
    // qui est observé.
    const reconnected = await waitForCondition(
      page,
      (n) => (window.__testSockets.length > n ? window.__testSockets.length : null),
      20000,
      socketsBefore
    );
    check(
      'le tableau de bord a ouvert une NOUVELLE connexion (vraie reconnexion, pas des trames retardées)',
      !!reconnected && reconnected > socketsBefore,
      `sockets avant=${socketsBefore}, après=${reconnected}`
    );

    const after = await waitForCondition(
      page,
      () => {
        if (document.querySelector('.status.offline')) return null;
        const active = document.querySelector('.lang-btn.active');
        const activePattern = document.querySelector('#patternPicker .mood-btn.active');
        const langSelect = document.getElementById('captionTargetLangSelect');
        const checked = (id) => {
          const el = document.getElementById(id);
          return el ? !!el.checked : null;
        };
        const state = {
          language: active ? active.dataset.lang : null,
          highContrast: checked('highContrastToggle'),
          captions: checked('captionsToggle'),
          translatedCaptions: checked('translatedCaptionsToggle'),
          captionTargetLang: langSelect ? langSelect.value : null,
          testPattern: checked('testPatternToggle'),
          backgroundPattern: activePattern ? activePattern.id.replace('pattern-btn-', '') : null,
        };
        // On attend que la reconnexion ait eu lieu ET que l'état ait été
        // réappliqué (le seul marqueur suffisant : la langue a changé).
        return state.language === 'en' ? state : null;
      },
      30000
    );

    check(
      'après reconnexion : les boutons de langue reflètent le changement manqué (en)',
      !!after && after.language === 'en',
      JSON.stringify(after)
    );
    check(
      'après reconnexion : mode grand contraste resynchronisé',
      !!after && after.highContrast === true,
      JSON.stringify(after)
    );
    check(
      'après reconnexion : sous-titres resynchronisés',
      !!after && after.captions === true,
      JSON.stringify(after)
    );
    check(
      'après reconnexion : sous-titres traduits + langue cible resynchronisés (es)',
      !!after && after.translatedCaptions === true && after.captionTargetLang === 'es',
      JSON.stringify(after)
    );
    check(
      'après reconnexion : motif de test resynchronisé',
      !!after && after.testPattern === true,
      JSON.stringify(after)
    );
    check(
      'après reconnexion : motif de fond resynchronisé (grid)',
      !!after && after.backgroundPattern === 'grid',
      JSON.stringify(after)
    );

    // Verrouille le contrat de fil dont dépend tout ce qui précède : le
    // serveur doit renvoyer un 'init' COMPLET à CHAQUE connexion, pas
    // seulement à la première — sinon la reconstruction ci-dessus n'aurait
    // rien à lire. Vérifié sur une connexion neuve (donc "reconnexion" du
    // point de vue du serveur), avec l'état déjà modifié par l'opérateur.
    //
    // NB : state.yourRole n'est volontairement pas vérifié dans le DOM — il
    // est mémorisé côté client sans aucun effet visuel (le masquage des
    // commandes en mode spectateur reste à faire, voir ws-dispatch.js). On se
    // contente donc de verrouiller sa présence dans le message.
    const late = await openOperatorSocket();
    const lateInit = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("pas de message 'init' reçu")), 5000);
      late.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.action === 'init') {
          clearTimeout(timer);
          resolve(msg);
        }
      });
    });
    late.close();
    check(
      "toute nouvelle connexion reçoit un 'init' portant l'état d'affichage à jour",
      lateInit.language === 'en' &&
        lateInit.highContrast === true &&
        lateInit.captions === true &&
        lateInit.translatedCaptions === true &&
        lateInit.captionTargetLang === 'es' &&
        lateInit.testPattern === true &&
        lateInit.backgroundPattern === 'grid',
      JSON.stringify(lateInit)
    );
    check(
      "'init' porte le rôle du client (consommé par ws-dispatch.js -> state.yourRole)",
      lateInit.yourRole === 'operator',
      String(lateInit.yourRole)
    );

    check(
      'aucune erreur console applicative pendant tout le scénario',
      consoleErrors.length === 0,
      consoleErrors.join(' | ')
    );

    operator.close();
  } finally {
    await browser.close();
  }

  console.log(
    `\n=== Résultat hydratation à la reconnexion : ${passed} passés, ${failed} échoués ===`
  );
  process.exit(failed > 0 ? 1 : 0);
})().catch((err) => {
  console.error("Erreur fatale dans le test d'intégration:", err);
  process.exit(1);
});
