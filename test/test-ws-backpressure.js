/**
 * ============================================================================
 *  test/test-ws-backpressure.js — protection contre un client WebSocket lent
 * ----------------------------------------------------------------------------
 *  broadcast() (server.js) itère wss.clients et appelle ws.send() pour
 *  chacun — sans protection, un seul client qui ne lit jamais ses messages
 *  (overlay figé, tablette Wi-Fi faible) fait grossir indéfiniment le buffer
 *  d'envoi de CE client en mémoire serveur, SANS jamais ralentir ni sauter
 *  son tour, et sans jamais libérer cette mémoire. Ce test le prouve avec de
 *  vraies connexions WebSocket (même style que test-ws-origin-validation.js :
 *  server.js tourne réellement, seuls Groq/Deepgram/audio-capture sont
 *  mockés) — pas un test unitaire isolé sur une fonction non exportée.
 *
 *  Seuils réduits via WS_BACKPRESSURE_THRESHOLD_BYTES/_CLOSE_AFTER_MS (voir
 *  server.js) pour rester rapide et déterministe, sans avoir à saturer
 *  artificiellement 2 Mo de trafic réel.
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

// AJOUT (spécifique à ce test — diffère de test-ws-origin-validation.js) :
// getVerseMultilang() doit réussir et renvoyer un texte — le handler
// showVerse (server.js, action envoyée par un client) l'appelle réellement
// et rediffuse son résultat via broadcast() ; c'est CE trafic (réel, non
// mocké) qui sert à déclencher un vrai appel à broadcast() pour les deux
// clients. Le bufferedAmount élevé du client lent est simulé directement
// (voir plus bas, Object.defineProperty) plutôt qu'obtenu par une vraie
// saturation réseau — donc PAS besoin d'un texte volumineux ici : un texte
// volumineux ferait au contraire temporairement grossir le bufferedAmount
// RÉEL du client normal (santé/latence I/O), ce qui polluerait l'assertion
// "le client normal n'a jamais un bufferedAmount élevé". Petit et fixe.
const BIG_VERSE_TEXT = 'Car Dieu a tant aimé le monde... (texte de test court)';
injectFakeModule('bible-lookup-with-api.js', {
  async getChapterVerses() {
    throw new Error('non utilisé dans ce test');
  },
  async getVerseMultilang() {
    return {
      reference: 'Jean 3:16',
      text: BIG_VERSE_TEXT,
      text_fr: BIG_VERSE_TEXT,
      text_en: null,
      langMode: 'fr',
      provider: 'fake-provider',
    };
  },
  buildReferenceLabel(reference) {
    return `Jean ${reference.chapter}`;
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

// -------------------------------------------------------------------------
// Seuils de test : petits et rapides plutôt que les défauts de production
// (2 Mo / 5000ms) — voir server.js pour la lecture de ces variables.
// -------------------------------------------------------------------------
process.env.PORT = process.env.PORT || '8781';
process.env.CHURCHOVERLAY_SKIP_BIBLE_DOWNLOAD = '1';
process.env.WS_BACKPRESSURE_THRESHOLD_BYTES = '10000'; // 10 Ko
process.env.WS_BACKPRESSURE_CLOSE_AFTER_MS = '300';

// AJOUT : { wss } exporté par server.js UNIQUEMENT pour les tests (voir son
// commentaire) — donne accès au vrai bufferedAmount SERVEUR de chaque
// connexion, impossible à observer autrement (le bufferedAmount du CLIENT
// de test lui-même reste ~0 : c'est le serveur qui accumule en essayant de
// lui envoyer des messages qu'il ne lit plus, pas l'inverse).
const { wss } = require('../server.js');

const WebSocket = require('ws');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// CORRECTIF (fragilité de test) : un `sleep(500)` fixe suivi d'une lecture
// immédiate de `normalMessages.length` s'est avéré parfois trop court sous
// charge machine plus lourde (la diffusion showVerse arrive bien, juste
// après ce délai fixe plutôt que dans le délai — voir instrumentation qui
// l'a confirmé) — pas un bug de la logique de backpressure elle-même (les
// autres assertions de ce test, elles, passent systématiquement). Remplace
// l'attente fixe par un polling généreux là où c'est utilisé, même
// convention que test-rundown-actions.js/test-ws-request-correlation.js.
function waitUntil(predicate, timeoutMs = 3000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error('waitUntil: timeout'));
      setTimeout(poll, 20);
    };
    poll();
  });
}

function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${process.env.PORT}/`);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
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

  await sleep(300); // laisser le serveur WS s'initialiser complètement

  console.log('\n=== Protection contre un client WebSocket lent (backpressure) ===\n');

  const slowClient = await connect();
  const normalClient = await connect();

  // Corrélation client<->serveur FIABLE : pas une hypothèse sur l'ordre
  // d'insertion de wss.clients (Set — non garanti observable de façon
  // fiable ici), mais le port TCP local du client == port distant vu par
  // le serveur pour LA MÊME connexion — identification exacte, jamais
  // ambiguë même si l'ordre d'itération surprend.
  const serverSideClients = Array.from(wss.clients);
  check(
    'deux connexions serveur bien établies (setup du test)',
    serverSideClients.length === 2,
    `wss.clients.size=${serverSideClients.length}`
  );
  function findServerSideFor(clientWs) {
    const localPort = clientWs._socket.localPort;
    return serverSideClients.find((s) => s._socket.remotePort === localPort);
  }
  const serverSideSlowClient = findServerSideFor(slowClient);
  const serverSideNormalClient = findServerSideFor(normalClient);
  check(
    'corrélation client<->serveur réussie pour les deux connexions',
    !!serverSideSlowClient &&
      !!serverSideNormalClient &&
      serverSideSlowClient !== serverSideNormalClient,
    `slow trouvé=${!!serverSideSlowClient} normal trouvé=${!!serverSideNormalClient}`
  );

  // Ne compte que les diffusions 'showVerse' réelles (celles passant par
  // broadcast(), donc soumises à la protection backpressure) — le message
  // 'init' (server.js, envoyé via ws.send() direct à la connexion, PAS via
  // broadcast()) arrive de façon asynchrone juste après la connexion et
  // n'est pas forcément déjà reçu au moment où les listeners ci-dessous
  // s'attachent ; le compter ferait échouer l'assertion pour une raison
  // sans rapport avec la logique de backpressure testée ici.
  const normalMessages = [];
  normalClient.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.action === 'showVerse') normalMessages.push(data.toString());
  });
  const slowMessagesBeforeStub = [];
  slowClient.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.action === 'showVerse') slowMessagesBeforeStub.push(data.toString());
  });

  // NOTE MÉTHODOLOGIQUE : une première version de ce test tentait de
  // provoquer une VRAIE saturation TCP (socket client mis en pause côté
  // lecture + jusqu'à 2,5 Mo de trafic réel). Sur boucle locale (127.0.0.1),
  // les tampons OS (auto-tuning Windows) se sont avérés absorber tout ce
  // volume sans jamais faire grossir bufferedAmount, y compris mesuré côté
  // SERVEUR (voir server.js → module.exports pour l'accès test) — un volume
  // assez grand pour saturer de façon fiable serait de l'ordre de dizaines
  // de Mo, rendant le test lent et fragile pour un gain de fiabilité
  // marginal. Cette version teste directement la MÊME logique que
  // broadcast() lit réellement (`ws.bufferedAmount`) en fixant cette
  // propriété sur la VRAIE connexion serveur — la détection/fermeture
  // testées ici sont bien le code réel de production, seule la façon dont
  // bufferedAmount devient élevé est simulée plutôt qu'obtenue par une
  // vraie saturation réseau.
  console.log("[TEST] Simulation d'un bufferedAmount élevé côté serveur pour le client lent...");
  Object.defineProperty(serverSideSlowClient, 'bufferedAmount', {
    value: 500_000,
    configurable: true,
  });
  // Ne compte que les messages reçus APRÈS le stub — le message 'init'
  // envoyé automatiquement à la connexion (voir server.js) ne doit pas
  // fausser la mesure.
  slowMessagesBeforeStub.length = 0;

  console.log("[TEST] Déclenchement d'une vraie diffusion (broadcast() réel côté serveur)...");
  normalClient.send(
    JSON.stringify({
      action: 'showVerse',
      reference: 'Jean 3:16',
      text: 'placeholder (ignoré par le handler, qui refait son propre lookup)',
    })
  );
  // Le handler showVerse fait un vrai aller-retour asynchrone
  // (bibleLookup.getVerseMultilang() + sessionState + persistance de
  // l'historique) avant d'appeler broadcast() — un délai FIXE s'est avéré
  // parfois trop court sous charge machine plus lourde (le message
  // showVerse arrivait quand même, juste après le délai fixe — voir
  // waitUntil() plus haut). Attend le signal réel (le message arrive) au
  // lieu de deviner une durée ; un plafond généreux (3s) reste en filet de
  // sécurité si la diffusion n'arrive vraiment jamais (le test continue
  // alors avec normalMessages vide, et l'assertion suivante le signale
  // clairement plutôt que de faire planter tout le test ici).
  await waitUntil(() => normalMessages.length > 0, 3000).catch(() => {});

  check(
    "broadcast() détecte le bufferedAmount élevé et saute l'envoi au client lent",
    slowMessagesBeforeStub.length === 0,
    `messages reçus par le client lent=${slowMessagesBeforeStub.length}`
  );

  check(
    "le SERVEUR n'a PAS de bufferedAmount élevé pour le client normal (jamais affecté par le stub du client lent)",
    serverSideNormalClient.bufferedAmount < 10000,
    `bufferedAmount côté serveur=${serverSideNormalClient.bufferedAmount}`
  );

  check(
    'le client normal continue de recevoir des messages normalement pendant ce temps',
    normalMessages.length > 0,
    `messages reçus=${normalMessages.length}`
  );

  console.log('[TEST] Attente du délai de fermeture forcée (300ms) du client bloqué...');
  await sleep(600);
  // La fermeture forcée est décidée AU MOMENT d'un broadcast() (pas un
  // minuteur en tâche de fond, voir server.js) — il faut donc redéclencher
  // une diffusion réelle après le délai pour que la logique de fermeture
  // s'exécute effectivement, pas seulement attendre passivement.
  normalClient.send(
    JSON.stringify({
      action: 'showVerse',
      reference: 'Jean 3:16',
      text: 'placeholder (ignoré par le handler, qui refait son propre lookup)',
    })
  );
  // Même raisonnement que plus haut : attend le signal réel (fermeture
  // effective côté client) plutôt qu'un délai fixe deviné.
  await waitUntil(() => slowClient.readyState !== WebSocket.OPEN, 3000).catch(() => {});

  check(
    'le client resté bloqué au-delà du délai est fermé par le serveur',
    slowClient.readyState === WebSocket.CLOSED || slowClient.readyState === WebSocket.CLOSING,
    `readyState=${slowClient.readyState}`
  );

  check(
    'le client normal, lui, reste ouvert (jamais affecté par le client lent)',
    normalClient.readyState === WebSocket.OPEN,
    `readyState=${normalClient.readyState}`
  );

  try {
    normalClient.close();
  } catch (_e) {
    /* ignoré */
  }
  try {
    slowClient._socket.resume();
    slowClient.terminate();
  } catch (_e) {
    /* ignoré */
  }

  console.log(`\n=== Résultat backpressure WebSocket : ${passed} passés, ${failed} échoués ===`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((err) => {
  console.error('Erreur fatale dans le test test-ws-backpressure:', err);
  process.exit(1);
});
