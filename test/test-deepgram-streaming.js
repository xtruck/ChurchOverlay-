/**
 * ============================================================================
 *  test-deepgram-streaming.js — Tests pour deepgram-streaming.js
 * ----------------------------------------------------------------------------
 *  Aucune clé DEEPGRAM_API_KEY réelle n'est disponible dans cet environnement
 *  (voir en-tête de deepgram-streaming.js) — ces tests vérifient donc NOTRE
 *  logique (parsing des messages, routage partial/final, mise en file avant
 *  ouverture, gestion erreur/fermeture) via une WebSocket simulée injectée
 *  (wsFactory), PAS le comportement réel des serveurs Deepgram. Un test
 *  contre une vraie clé reste nécessaire avant la mise en production de ce
 *  chemin (voir le rapport livré).
 * ============================================================================
 */

'use strict';
const assert = require('assert');
const EventEmitter = require('events');

process.env.DEEPGRAM_API_KEY = 'fake-key-for-test';
const deepgramStreaming = require('../deepgram-streaming');

console.log('=== Test Deepgram Streaming (WebSocket simulée) ===\n');

/** Simule le constructeur `ws` — même API (.on/.send/.close/.terminate). */
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
    // ferme la connexion de SON côté, de façon asynchrone — jamais en
    // réaction synchrone à l'envoi. C'est justement ce délai que le
    // correctif de finish() (deepgram-streaming.js) doit maintenant
    // attendre avant de fermer le socket local.
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

function makeFactory() {
  return (url, options) => new FakeWebSocket(url, options);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resultMessage({ transcript, isFinal = false, speechFinal = false, confidence = 0.9 }) {
  return JSON.stringify({
    type: 'Results',
    is_final: isFinal,
    speech_final: speechFinal,
    channel: { alternatives: [{ transcript, confidence }] },
  });
}

async function run() {
  console.log('[TEST] Test 1: createSession() sans DEEPGRAM_API_KEY lève une erreur claire...');
  delete process.env.DEEPGRAM_API_KEY;
  assert.throws(() => deepgramStreaming.createSession({}, makeFactory()), /DEEPGRAM_API_KEY/);
  process.env.DEEPGRAM_API_KEY = 'fake-key-for-test';
  console.log('[TEST] ✓ Erreur explicite\n');

  console.log('[TEST] Test 2: URL construite avec les paramètres attendus (streaming, fr, interim_results)...');
  const url = deepgramStreaming.buildStreamingUrl();
  assert(url.startsWith('wss://api.deepgram.com/v1/listen?'), 'endpoint streaming attendu');
  assert(url.includes('interim_results=true'), "interim_results=true requis pour recevoir des 'partial'");
  assert(url.includes('language=fr'), 'langue française attendue');
  assert(url.includes('encoding=linear16'), 'encodage PCM16LE attendu (cohérent avec audio-capture.js)');
  assert(url.includes('sample_rate=16000'), 'sample rate 16kHz attendu (cohérent avec audio-capture.js)');
  console.log('[TEST] ✓ URL correcte\n');

  console.log('[TEST] Test 3: authentification par en-tête Authorization: Token <clé>...');
  {
    const partials = [];
    const session = deepgramStreaming.createSession({ onPartial: (t) => partials.push(t) }, makeFactory());
    const fake = FakeWebSocket.lastInstance;
    assert.strictEqual(fake.options.headers.Authorization, 'Token fake-key-for-test');
    session.abort();
  }
  console.log('[TEST] ✓ En-tête correct\n');

  console.log('[TEST] Test 4: audio envoyé avant "open" est mis en file puis vidé à l\'ouverture...');
  {
    const session = deepgramStreaming.createSession({}, makeFactory());
    const fake = FakeWebSocket.lastInstance;
    const chunkA = Buffer.from([1, 2, 3]);
    const chunkB = Buffer.from([4, 5, 6]);
    session.sendAudio(chunkA);
    session.sendAudio(chunkB);
    assert.strictEqual(fake.sent.length, 0, 'rien ne doit partir avant "open"');
    assert.strictEqual(session.isOpen(), false);
    fake.emit('open');
    assert.strictEqual(session.isOpen(), true);
    assert.strictEqual(fake.sent.length, 2, 'les 2 chunks en attente doivent partir à l\'ouverture');
    assert.strictEqual(fake.sent[0], chunkA);
    assert.strictEqual(fake.sent[1], chunkB);
    // Un chunk envoyé APRÈS ouverture part immédiatement, pas de mise en file.
    const chunkC = Buffer.from([7, 8, 9]);
    session.sendAudio(chunkC);
    assert.strictEqual(fake.sent.length, 3);
    session.abort();
  }
  console.log('[TEST] ✓ Mise en file puis envoi immédiat après ouverture\n');

  console.log('[TEST] Test 5: un Results avec is_final=false route vers onPartial...');
  {
    const partials = [];
    const finals = [];
    const session = deepgramStreaming.createSession(
      { onPartial: (t, m) => partials.push({ t, m }), onFinal: (t, m) => finals.push({ t, m }) },
      makeFactory()
    );
    const fake = FakeWebSocket.lastInstance;
    fake.emit('open');
    fake.emit('message', resultMessage({ transcript: 'Jean trois', isFinal: false }));
    assert.strictEqual(partials.length, 1);
    assert.strictEqual(partials[0].t, 'Jean trois');
    assert.strictEqual(finals.length, 0, 'un résultat non-final ne doit JAMAIS déclencher onFinal');
    session.abort();
  }
  console.log('[TEST] ✓ Routage partial correct\n');

  console.log('[TEST] Test 6: un Results avec is_final=true route vers onFinal, avec confiance...');
  {
    const partials = [];
    const finals = [];
    const session = deepgramStreaming.createSession(
      { onPartial: (t) => partials.push(t), onFinal: (t, m) => finals.push({ t, m }) },
      makeFactory()
    );
    const fake = FakeWebSocket.lastInstance;
    fake.emit('open');
    fake.emit(
      'message',
      resultMessage({ transcript: 'Jean trois seize', isFinal: true, confidence: 0.97 })
    );
    assert.strictEqual(finals.length, 1);
    assert.strictEqual(finals[0].t, 'Jean trois seize');
    assert.strictEqual(finals[0].m.confidence, 0.97);
    assert.strictEqual(partials.length, 0, 'un résultat final ne doit pas aussi déclencher onPartial');
    session.abort();
  }
  console.log('[TEST] ✓ Routage final correct, confiance propagée\n');

  console.log('[TEST] Test 7: speech_final=true (sans is_final) route aussi vers onFinal...');
  {
    const finals = [];
    const session = deepgramStreaming.createSession({ onFinal: (t) => finals.push(t) }, makeFactory());
    const fake = FakeWebSocket.lastInstance;
    fake.emit('open');
    fake.emit('message', resultMessage({ transcript: 'Amen', isFinal: false, speechFinal: true }));
    assert.strictEqual(finals.length, 1, 'speech_final doit être traité comme une fin de phrase');
    session.abort();
  }
  console.log('[TEST] ✓ speech_final traité comme final\n');

  console.log('[TEST] Test 8: un Results avec transcript vide (silence) ne déclenche rien...');
  {
    const partials = [];
    const finals = [];
    const session = deepgramStreaming.createSession(
      { onPartial: (t) => partials.push(t), onFinal: (t) => finals.push(t) },
      makeFactory()
    );
    const fake = FakeWebSocket.lastInstance;
    fake.emit('open');
    fake.emit('message', resultMessage({ transcript: '', isFinal: true }));
    assert.strictEqual(partials.length, 0);
    assert.strictEqual(finals.length, 0);
    session.abort();
  }
  console.log('[TEST] ✓ Silence ignoré\n');

  console.log('[TEST] Test 9: un message non-JSON ne fait jamais planter la session...');
  {
    const session = deepgramStreaming.createSession({}, makeFactory());
    const fake = FakeWebSocket.lastInstance;
    fake.emit('open');
    assert.doesNotThrow(() => fake.emit('message', 'ceci n\'est pas du JSON'));
    session.abort();
  }
  console.log('[TEST] ✓ Message malformé toléré\n');

  console.log('[TEST] Test 10: une erreur WebSocket appelle onError (pour déclencher le repli côté appelant)...');
  {
    let receivedErr = null;
    const session = deepgramStreaming.createSession({ onError: (e) => (receivedErr = e) }, makeFactory());
    const fake = FakeWebSocket.lastInstance;
    fake.emit('error', new Error('connexion refusée'));
    assert(receivedErr instanceof Error);
    assert.strictEqual(receivedErr.message, 'connexion refusée');
    session.abort();
  }
  console.log('[TEST] ✓ onError propagé\n');

  console.log('[TEST] Test 11: finish() envoie CloseStream, attend que Deepgram ferme lui-même, sendAudio() après close() est un no-op...');
  {
    let closedCalled = false;
    const session = deepgramStreaming.createSession({ onClose: () => (closedCalled = true) }, makeFactory());
    const fake = FakeWebSocket.lastInstance;
    fake.emit('open');
    session.finish();
    assert(fake.sent.some((s) => typeof s === 'string' && s.includes('CloseStream')));
    // CORRECTIF (live test réel — voir deepgram-streaming.js) : le socket
    // local ne doit PLUS se fermer de façon SYNCHRONE juste après l'envoi
    // de CloseStream — ça ne laissait auparavant aucune chance à Deepgram
    // de renvoyer son dernier résultat. La fermeture n'arrive qu'une fois
    // que le serveur (simulé ici) ferme lui-même la connexion.
    assert.strictEqual(fake.closed, false, 'ne doit pas fermer avant que Deepgram ait répondu');
    await sleep(10); // laisse le setImmediate() du FakeWebSocket simuler la fermeture serveur
    assert.strictEqual(fake.closed, true);
    assert.strictEqual(closedCalled, true);
    assert.strictEqual(session.isOpen(), false);
    // Ne doit jamais lever, même après fermeture.
    assert.doesNotThrow(() => session.sendAudio(Buffer.from([1])));
  }
  console.log('[TEST] ✓ Fin de session propre, fermeture locale différée jusqu\'à la réponse serveur\n');

  console.log(
    '[TEST] Test 12: un Results FINAL arrivant APRÈS finish() (avant la fermeture serveur simulée) est bien délivré à onFinal (régression du bug "dernier final perdu")...'
  );
  {
    const finals = [];
    const session = deepgramStreaming.createSession(
      { onFinal: (t) => finals.push(t) },
      makeFactory()
    );
    const fake = FakeWebSocket.lastInstance;
    fake.emit('open');
    session.finish(); // envoie CloseStream ; le FakeWebSocket ne se fermera qu'au prochain tick (setImmediate)
    // Le dernier résultat de Deepgram arrive ICI, avant la fermeture réseau — exactement le scénario observé en direct.
    fake.emit('message', resultMessage({ transcript: 'Jean trois seize', isFinal: true, confidence: 0.95 }));
    assert.strictEqual(finals.length, 1, 'le dernier final doit être délivré même après finish()');
    assert.strictEqual(finals[0], 'Jean trois seize');
    await sleep(10);
    assert.strictEqual(fake.closed, true, 'la connexion doit tout de même finir par se fermer');
  }
  console.log('[TEST] ✓ Dernier final délivré avant la fermeture\n');

  console.log('[TEST] Test 13: finish() ne bloque jamais indéfiniment si le serveur ne ferme jamais (filet FINISH_TIMEOUT_MS)...');
  {
    // FakeWebSocket "sourde" : n'émet jamais 'close' d'elle-même, même après CloseStream.
    class DeafFakeWebSocket extends FakeWebSocket {
      send(data) {
        this.sent.push(data); // ne déclenche PAS de close() automatique
      }
    }
    const session = deepgramStreaming.createSession(
      {},
      (url, options) => new DeafFakeWebSocket(url, options)
    );
    const fake = FakeWebSocket.lastInstance;
    fake.emit('open');
    session.finish();
    assert.strictEqual(fake.closed, false);
    await sleep(deepgramStreaming.FINISH_TIMEOUT_MS + 50);
    assert.strictEqual(fake.closed, true, 'le filet de sécurité doit forcer la fermeture après FINISH_TIMEOUT_MS');
  }
  console.log('[TEST] ✓ Filet de sécurité déclenché — jamais de connexion qui pend indéfiniment\n');

  console.log('\n=== Tous les tests deepgram-streaming sont passés ===');
  process.exit(0);
}

run().catch((err) => {
  console.error('[TEST] ✗ Échec:', err.message);
  process.exit(1);
});
