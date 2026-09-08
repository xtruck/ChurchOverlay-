/**
 * ============================================================================
 *  test-audio-capture-deepgram-streaming.js — Deepgram streaming branché sur
 *  audio-capture.js, de bout en bout (ASR_PROVIDER=deepgram).
 * ----------------------------------------------------------------------------
 *  Prouve l'architecture demandée : quand le streaming est actif, AUCUN
 *  segment WAV n'est écrit (onAudioSegment ne se déclenche jamais tant que
 *  le streaming tient) — les chunks PCM partent directement vers la
 *  WebSocket au fil de l'eau.
 *
 *  AJOUT (Axe 3 — résilience face aux micro-coupures réseau) : vérifie aussi
 *  le cycle complet de reconnexion automatique — une coupure met le PCM en
 *  tampon local borné (PAS de segment WAV pendant ce temps), une
 *  reconnexion réussie envoie ce tampon en rafale à la nouvelle connexion et
 *  reprend le streaming temps réel SANS perte (Test 6), et si toutes les
 *  tentatives échouent, le repli définitif sur le pipeline segment/WAV
 *  classique reprend la main en récupérant l'audio accumulé pendant les
 *  tentatives — jamais perdu (Test 7). Voir audio-capture.js#openDeepgramSession/
 *  handleDeepgramDisconnect/scheduleDeepgramReconnect.
 *
 *  WebSocket simulée (voir deepgram-streaming.setWsFactoryForTesting) — pas
 *  de vraie clé Deepgram disponible dans cet environnement, voir l'en-tête
 *  de deepgram-streaming.js. Ce test valide NOTRE câblage, pas les serveurs
 *  Deepgram réels.
 * ============================================================================
 */

'use strict';
const assert = require('assert');
const EventEmitter = require('events');

process.env.DEEPGRAM_API_KEY = 'fake-key-for-test';
process.env.ASR_PROVIDER = 'deepgram';
// Ce test vérifie le CÂBLAGE (streaming actif -> pas de WAV, erreur -> repli
// -> WAV classique reprend), pas la précision de Silero — force RMS pour
// rester synchrone et déterministe (Silero classifie de façon asynchrone
// par fenêtre de 32ms ; voir test-audio-capture-silero-integration.js pour
// le test dédié à Silero, qui doit lui pacer les chunks en temps réel pour
// laisser sa file le temps de traiter avant le plafond de sécurité).
process.env.VAD_PROVIDER = 'rms';

const audioCapture = require('../audio-capture');
const deepgramStreaming = require('../deepgram-streaming');
const sessionState = require('../session-state');

console.log('=== Test intégration Deepgram Streaming <-> audio-capture.js ===\n');

class FakeWebSocket extends EventEmitter {
  constructor(url, options) {
    super();
    this.url = url;
    this.options = options;
    this.sent = [];
    this.closed = false;
    FakeWebSocket.lastInstance = this;
  }
  send(data) {
    this.sent.push(data);
    // Simule le comportement RÉEL de Deepgram observé en direct (voir
    // live-tests/diagnose-raw-messages.js) : après CloseStream, le serveur
    // ferme la connexion de SON côté, de façon asynchrone.
    if (typeof data === 'string' && data.includes('CloseStream')) {
      setImmediate(() => this.close());
    }
  }
  close() {
    this.closed = true;
    this.emit('close');
  }
  terminate() {
    this.closed = true;
    this.emit('close');
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resultMessage({ transcript, isFinal = false, confidence = 0.9 }) {
  return JSON.stringify({
    type: 'Results',
    is_final: isFinal,
    channel: { alternatives: [{ transcript, confidence }] },
  });
}

/** Chunk PCM16LE voisé (amplitude franche) — sert à faire progresser le VAD. */
function makeVoicedChunk(byteLength) {
  const buf = Buffer.alloc(byteLength - (byteLength % 2));
  for (let i = 0; i + 1 < buf.length; i += 2) {
    buf.writeInt16LE(i % 4 === 0 ? 12000 : -12000, i);
  }
  return buf;
}

async function waitFor(predicate, timeoutMs = 1000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await sleep(10);
  }
  return false;
}

async function run() {
  deepgramStreaming.setWsFactoryForTesting((url, options) => new FakeWebSocket(url, options));

  const segments = [];
  const partials = [];
  const finals = [];
  const fallbacks = [];
  audioCapture.on({
    onAudioSegment: (file, tracker) => segments.push({ file, tracker }),
    onPartialTranscript: (text, meta, tracker) => partials.push({ text, meta, tracker }),
    onFinalTranscript: (text, meta, tracker) => finals.push({ text, meta, tracker }),
    onAsrFallback: (info) => fallbacks.push(info),
    onError: (err) => console.error('[TEST] onError inattendu:', err.message),
  });

  console.log(
    '[TEST] Test 1: startBrowserCapture() avec ASR_PROVIDER=deepgram ouvre une session streaming...'
  );
  await audioCapture.startBrowserCapture();
  assert.strictEqual(audioCapture.getAsrProvider(), 'deepgram');
  const fake = FakeWebSocket.lastInstance;
  assert(fake, 'une WebSocket simulée aurait dû être créée');
  fake.emit('open');
  const becameActive = await waitFor(() => audioCapture.isDeepgramStreamingActive());
  assert.strictEqual(
    becameActive,
    true,
    'isDeepgramStreamingActive() devrait devenir true après "open"'
  );
  console.log('[TEST] ✓ Session streaming active\n');

  console.log(
    '[TEST] Test 2: les chunks PCM partent directement vers la WebSocket, ' +
      'AUCUN segment WAV écrit tant que le streaming est sain...'
  );
  const chunk = makeVoicedChunk(3200); // 100ms à 16kHz mono 16-bit — assez pour déclencher markVadOnset
  audioCapture.feedPcmChunk(chunk);
  await sleep(50); // laisse la file Silero/RMS traiter la trame (asynchrone pour Silero)
  assert(
    fake.sent.includes(chunk),
    'le chunk PCM devrait avoir été envoyé tel quel à la WebSocket'
  );
  assert.strictEqual(
    segments.length,
    0,
    'aucun segment WAV ne devrait être écrit pendant le streaming'
  );
  console.log('[TEST] ✓ Chunks forwardés en direct, pipeline WAV inactif\n');

  console.log(
    '[TEST] Test 3: un Results partiel (is_final=false) déclenche onPartialTranscript avec un tracker...'
  );
  fake.emit('message', resultMessage({ transcript: 'Jean trois', isFinal: false }));
  assert.strictEqual(partials.length, 1);
  assert.strictEqual(partials[0].text, 'Jean trois');
  assert(
    partials[0].tracker,
    'un tracker de latence devrait accompagner le partial (VAD déjà déclenché au Test 2)'
  );
  assert(
    'asrFirstPartial' in partials[0].tracker.summary().deltas,
    'le mark asrFirstPartial doit être posé'
  );
  console.log('[TEST] ✓ Partial routé avec latence VAD->ASR mesurée\n');

  console.log('[TEST] Test 4: un Results final (is_final=true) déclenche onFinalTranscript...');
  fake.emit(
    'message',
    resultMessage({ transcript: 'Jean trois seize', isFinal: true, confidence: 0.95 })
  );
  assert.strictEqual(finals.length, 1);
  assert.strictEqual(finals[0].text, 'Jean trois seize');
  assert.strictEqual(finals[0].meta.confidence, 0.95);
  const finalSummary = finals[0].tracker.summary();
  assert('asrFirstPartial' in finalSummary.deltas && 'asrFinal' in finalSummary.deltas);
  console.log(`[TEST] ✓ Final routé, latence bout-en-bout mesurée (${finalSummary.totalMs}ms)\n`);

  console.log(
    '[TEST] Test 5: une erreur streaming déclenche le repli (onAsrFallback) et désactive le streaming, ' +
      'ET amorce une reconnexion automatique (Axe 3)...'
  );
  fake.emit('error', new Error('connexion perdue'));
  assert.strictEqual(fallbacks.length, 1);
  assert.strictEqual(audioCapture.isDeepgramStreamingActive(), false);
  assert.strictEqual(
    audioCapture.isDeepgramReconnecting(),
    true,
    'une reconnexion automatique devrait démarrer immédiatement après la coupure'
  );
  console.log('[TEST] ✓ Repli déclenché proprement, reconnexion automatique amorcée\n');

  const config = audioCapture.getConfig();
  const bytesPerSample = config.bitDepth / 8;
  const samplesPerSecond = config.sampleRate * config.channels;
  const segmentBytes = (config.segmentDuration / 1000) * samplesPerSecond * bytesPerSample;

  console.log(
    '[TEST] Test 6: pendant la reconnexion, le PCM entrant est mis en tampon local ' +
      '(PAS écrit en WAV) ; une fois la reconnexion réussie, ce tampon est envoyé en rafale ' +
      "à la nouvelle connexion et le streaming temps réel reprend, SANS qu'aucun segment WAV " +
      "n'ait jamais été créé pour cet audio..."
  );
  const bufferedChunk = makeVoicedChunk(1600); // 50ms — bien en-dessous du seuil de segment WAV
  audioCapture.feedPcmChunk(bufferedChunk);
  await sleep(20);
  assert.strictEqual(
    segments.length,
    0,
    "l'audio reçu pendant la reconnexion ne doit PAS déclencher de segment WAV"
  );
  assert(
    audioCapture.getDeepgramReconnectBufferedBytes() >= bufferedChunk.length,
    'le chunk PCM reçu pendant la reconnexion devrait être dans le tampon de rattrapage'
  );
  // Laisse le délai avant la 1ère tentative (200ms) s'écouler, puis ouvre la
  // nouvelle connexion simulée (déclenchée par scheduleDeepgramReconnect()).
  const reconnectOpened = await waitFor(() => FakeWebSocket.lastInstance !== fake, 1000);
  assert(
    reconnectOpened,
    'une nouvelle WebSocket simulée aurait dû être créée pour la tentative 1'
  );
  const reconnectSocket = FakeWebSocket.lastInstance;
  reconnectSocket.emit('open');
  const reconnected = await waitFor(() => audioCapture.isDeepgramStreamingActive());
  assert.strictEqual(
    reconnected,
    true,
    'le streaming devrait redevenir actif après la reconnexion'
  );
  assert.strictEqual(
    audioCapture.isDeepgramReconnecting(),
    false,
    'la reconnexion ne devrait plus être en cours une fois réussie'
  );
  assert(
    reconnectSocket.sent.includes(bufferedChunk),
    'le chunk accumulé pendant la coupure devrait avoir été envoyé en rafale à la nouvelle connexion'
  );
  assert.strictEqual(
    audioCapture.getDeepgramReconnectBufferedBytes(),
    0,
    'le tampon de rattrapage devrait être vidé une fois envoyé'
  );
  assert.strictEqual(
    segments.length,
    0,
    "toujours aucun segment WAV : l'audio a été intégralement rattrapé par le streaming"
  );
  console.log('[TEST] ✓ Rattrapage en rafale réussi, streaming temps réel repris sans perte\n');

  console.log(
    '[TEST] Test 7: si TOUTES les tentatives de reconnexion échouent, le repli définitif sur ' +
      "le pipeline WAV classique reprend la main — ET l'audio accumulé pendant les tentatives " +
      'est préservé (versé dans le pipeline WAV), jamais perdu...'
  );
  reconnectSocket.emit('error', new Error('connexion de nouveau perdue'));
  assert.strictEqual(
    audioCapture.isDeepgramReconnecting(),
    true,
    'une nouvelle reconnexion devrait démarrer après cette seconde coupure'
  );
  // Audio reçu PENDANT cette seconde fenêtre de reconnexion — doit survivre
  // jusqu'au repli WAV définitif ci-dessous, pas être perdu quand les
  // tentatives échouent toutes.
  const survivingChunk = makeVoicedChunk(1600);
  audioCapture.feedPcmChunk(survivingChunk);
  await sleep(20);
  assert(
    audioCapture.getDeepgramReconnectBufferedBytes() >= survivingChunk.length,
    'le chunk devrait être en tampon pendant cette seconde reconnexion'
  );
  // Fait échouer les 3 tentatives à la suite (backoff 200/500/1000ms, voir
  // DEEPGRAM_RECONNECT_BACKOFF_MS dans audio-capture.js) — chaque tentative
  // ouvre une NOUVELLE WebSocket simulée qu'on fait échouer immédiatement,
  // pour rester rapide et déterministe sans attendre le filet de sécurité
  // (DEEPGRAM_RECONNECT_ATTEMPT_TIMEOUT_MS, bien plus long).
  let lastAttemptSocket = reconnectSocket;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const nextOpened = await waitFor(() => FakeWebSocket.lastInstance !== lastAttemptSocket, 2000);
    assert(
      nextOpened,
      `la tentative de reconnexion ${attempt} aurait dû ouvrir une nouvelle WebSocket simulée`
    );
    lastAttemptSocket = FakeWebSocket.lastInstance;
    lastAttemptSocket.emit('error', new Error(`échec simulé tentative ${attempt}`));
  }
  const gaveUp = await waitFor(() => audioCapture.isDeepgramReconnecting() === false, 1000);
  assert.strictEqual(
    gaveUp,
    true,
    'la reconnexion devrait être abandonnée après épuisement des 3 tentatives'
  );
  assert.strictEqual(
    audioCapture.isDeepgramStreamingActive(),
    false,
    'le streaming ne devrait pas être actif après un repli définitif'
  );
  assert.strictEqual(
    audioCapture.getDeepgramReconnectBufferedBytes(),
    0,
    'le tampon devrait avoir été vidé (versé dans le pipeline WAV), pas juste abandonné'
  );
  // Complète le segment avec le reste de l'audio nécessaire — si survivingChunk
  // a bien été versé dans STATE.audioBuffer, ce complément suffit à franchir
  // le seuil et déclencher un segment WAV.
  audioCapture.feedPcmChunk(makeVoicedChunk(segmentBytes - survivingChunk.length));
  await sleep(100);
  assert.strictEqual(
    segments.length,
    1,
    "un segment WAV aurait dû être créé, incluant l'audio accumulé pendant les tentatives échouées"
  );
  console.log(
    '[TEST] ✓ Repli définitif fonctionnel après épuisement des tentatives — aucun audio perdu\n'
  );

  await audioCapture.stopRecording();

  console.log(
    '\n[TEST] Test 8: un FINAL arrivant APRÈS un arrêt volontaire (stopRecording) est bien délivré ' +
      '(régression du bug "dernier final de chaque énoncé perdu", trouvé en test réel — voir le rapport livré)...'
  );
  {
    const finals2 = [];
    audioCapture.on({
      onAudioSegment: () => {},
      onPartialTranscript: () => {},
      onFinalTranscript: (text) => finals2.push(text),
      onAsrFallback: () => {},
    });
    await audioCapture.startBrowserCapture();
    const fake2 = FakeWebSocket.lastInstance;
    fake2.emit('open');
    await waitFor(() => audioCapture.isDeepgramStreamingActive());
    await audioCapture.stopRecording(); // déclenche finish() -> CloseStream, ne ferme plus le socket immédiatement
    assert.strictEqual(
      fake2.closed,
      false,
      'ne doit pas fermer avant la réponse de "Deepgram" (simulée)'
    );
    // Le dernier résultat arrive ICI, entre stopRecording() et la fermeture réseau — exactement le scénario réel.
    fake2.emit('message', resultMessage({ transcript: 'Jean trois seize', isFinal: true }));
    assert.strictEqual(
      finals2.length,
      1,
      'le dernier final doit être délivré malgré STATE.isRecording déjà à false'
    );
    assert.strictEqual(finals2[0], 'Jean trois seize');
  }
  console.log('[TEST] ✓ Dernier final délivré après un arrêt volontaire\n');

  console.log(
    "[TEST] Test 9: un FINAL tardif d'une session déjà REMPLACÉE (arrêt puis relance) est bien ignoré " +
      '(le correctif du Test 7 ne doit pas réintroduire de fuite entre sessions)...'
  );
  {
    const finals3 = [];
    audioCapture.on({
      onAudioSegment: () => {},
      onPartialTranscript: () => {},
      onFinalTranscript: (text) => finals3.push(text),
      onAsrFallback: () => {},
    });
    await audioCapture.startBrowserCapture();
    const staleFake = FakeWebSocket.lastInstance;
    staleFake.emit('open');
    await waitFor(() => audioCapture.isDeepgramStreamingActive());

    // Arrêt puis relance immédiate (ex. redémarrage du pipeline) — le
    // scénario réel où STATE.deepgramSession en vient à pointer vers une
    // toute nouvelle session, jamais vers `staleFake`. stopRecording()
    // déclenche finish() sur staleFake, mais on n'attend PAS sa fermeture
    // simulée avant de relancer, pour reproduire fidèlement une relance
    // rapide.
    await audioCapture.stopRecording();
    await audioCapture.startBrowserCapture();
    const freshFake = FakeWebSocket.lastInstance;
    freshFake.emit('open');
    await waitFor(() => audioCapture.isDeepgramStreamingActive());
    assert.notStrictEqual(
      staleFake,
      freshFake,
      'les deux captures doivent avoir des sockets distincts'
    );

    // Le "vieux" final de la session remplacée arrive tardivement.
    staleFake.emit('message', resultMessage({ transcript: 'texte obsolète', isFinal: true }));
    assert.strictEqual(
      finals3.length,
      0,
      "un final d'une session déjà remplacée ne doit JAMAIS être délivré"
    );

    // Le final de la session ACTIVE, lui, doit toujours fonctionner normalement.
    freshFake.emit('message', resultMessage({ transcript: 'texte actuel', isFinal: true }));
    assert.strictEqual(finals3.length, 1);
    assert.strictEqual(finals3[0], 'texte actuel');
  }
  console.log('[TEST] ✓ Final obsolète ignoré, final de la session active délivré normalement\n');

  await audioCapture.stopRecording();

  console.log(
    '[TEST] Test 10: sessionState.getTranscriptionLanguage() est lue au DÉMARRAGE de la session ' +
      'streaming et propagée à la connexion WebSocket (support bilingue FR/EN, lot 6)...'
  );
  {
    // A.5 — la langue par défaut est désormais 'fr' (pas de auto-détection par défaut).
    assert.strictEqual(
      sessionState.getTranscriptionLanguage(),
      'fr',
      'langue de session par défaut : fr (A.5)'
    );
    await audioCapture.startBrowserCapture();
    const fakeDefault = FakeWebSocket.lastInstance;
    fakeDefault.emit('open');
    await waitFor(() => audioCapture.isDeepgramStreamingActive());
    assert(
      fakeDefault.url.includes('language=fr'),
      "sans langue de session, la connexion utilise 'fr' par défaut"
    );
    await audioCapture.stopRecording();

    // Langue de session explicite -> reflétée dans l'URL de la PROCHAINE session.
    sessionState.setTranscriptionLanguage('en');
    await audioCapture.startBrowserCapture();
    const fakeEnglish = FakeWebSocket.lastInstance;
    fakeEnglish.emit('open');
    await waitFor(() => audioCapture.isDeepgramStreamingActive());
    assert(
      fakeEnglish.url.includes('language=en'),
      "avec une langue de session 'en', la connexion la reflète"
    );
    await audioCapture.stopRecording();
    sessionState.setTranscriptionLanguage(null); // ne pas fuiter d'état vers d'autres fichiers de test
  }
  console.log("[TEST] ✓ Langue de session propagée jusqu'à la connexion WebSocket streaming\n");

  deepgramStreaming.setWsFactoryForTesting(null);
  delete process.env.ASR_PROVIDER;
  console.log("=== Tous les tests d'intégration Deepgram streaming sont passés ===");
  process.exit(0);
}

run().catch((err) => {
  console.error('[TEST] ✗ Échec:', err.message);
  console.error(err.stack);
  deepgramStreaming.setWsFactoryForTesting(null);
  process.exit(1);
});
