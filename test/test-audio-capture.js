/**
 * ============================================================================
 *  test-audio-capture.js — Tests pour audio-capture.js
 * ----------------------------------------------------------------------------
 *  CHANGELOG v0.5.0 : l'ancien test exigeait FFmpeg installé + un micro
 *  connecté + 10s d'attente réelle — inutilisable en CI et non automatisable.
 *  feedPcmChunk() est une fonction pure (aucun matériel requis) : on
 *  vérifie ici la segmentation/chevauchement en lui injectant des chunks
 *  PCM16 synthétiques.
 *
 *  CORRECTIF : un commit ultérieur a renommé l'API du module
 *  (startRecording -> startBrowserCapture, pushAudioChunk -> feedPcmChunk)
 *  en cohérence avec server.js/main.js, mais ce test n'avait pas été mis à
 *  jour — il appelait des noms de fonctions qui n'existaient plus, faisant
 *  échouer `npm test` alors que le pipeline runtime réel fonctionnait.
 * ============================================================================
 */

'use strict';
const assert = require('assert');
const fs = require('fs');
const audioCapture = require('../audio-capture');

console.log('=== Test Audio Capture (segmentation) ===\n');

/**
 * Génère un buffer PCM16LE synthétique avec une amplitude donnée.
 * AJOUT (VAD réel) : les tests de segmentation utilisaient auparavant
 * Buffer.alloc() (silence pur, tout à zéro) — ça passait avant le filtre
 * VAD, mais un vrai silence est désormais volontairement rejeté par
 * handleAudioData(). On génère donc un signal avec une amplitude
 * suffisante pour être classé "voix" par analyzeVoiceActivity().
 * @param {number} byteLength - taille du buffer en octets (doit être pair)
 * @param {number} [amplitude=6000] - amplitude int16 (silenceThreshold par défaut = 0.02 → seuil ≈ 655)
 */
function makeVoicedBuffer(byteLength, amplitude = 6000) {
  const buf = Buffer.alloc(byteLength - (byteLength % 2));
  for (let i = 0; i + 1 < buf.length; i += 2) {
    buf.writeInt16LE(i % 4 === 0 ? amplitude : -amplitude, i);
  }
  return buf;
}

async function run() {
  const config = audioCapture.getConfig();
  const bytesPerSample = config.bitDepth / 8;
  const samplesPerSecond = config.sampleRate * config.channels;
  const segmentBytes = (config.segmentDuration / 1000) * samplesPerSecond * bytesPerSample;

  // Test 1 : feedPcmChunk() sans startBrowserCapture() ne fait rien (pas de crash)
  console.log('[TEST] Test 1: feedPcmChunk() avant startBrowserCapture()...');
  audioCapture.feedPcmChunk(Buffer.alloc(1000));
  console.log('[TEST] ✓ Ignoré sans erreur\n');

  // Test 2 : un segment complet déclenche onAudioSegment()
  console.log('[TEST] Test 2: segmentation déclenchée au bon seuil...');
  let segments = [];
  audioCapture.on({
    onAudioSegment: (file) => segments.push(file),
    onError: (err) => console.error('[TEST] onError inattendu:', err.message),
  });

  await audioCapture.startBrowserCapture();
  assert.strictEqual(
    audioCapture.isRecording(),
    true,
    'isRecording() devrait être true après startBrowserCapture()'
  );

  // Un seul chunk plus grand que segmentBytes doit produire exactement 1 segment
  // (signal "voix" synthétique — voir makeVoicedBuffer, un silence pur serait
  // désormais filtré par le VAD, voir Test 6 plus bas)
  audioCapture.feedPcmChunk(makeVoicedBuffer(segmentBytes + 100));
  assert.strictEqual(segments.length, 1, 'Un segment aurait dû être créé');
  assert(fs.existsSync(segments[0]), 'Le fichier segment devrait exister sur disque');
  const wav = fs.readFileSync(segments[0]);
  assert.strictEqual(wav.toString('ascii', 0, 4), 'RIFF', 'En-tête WAV invalide (RIFF)');
  assert.strictEqual(wav.toString('ascii', 8, 12), 'WAVE', 'En-tête WAV invalide (WAVE)');
  console.log('[TEST] ✓ Segment WAV créé et bien formé:', segments[0]);

  // Test 3 : plusieurs petits chunks cumulés déclenchent aussi un segment
  console.log('\n[TEST] Test 3: accumulation de petits chunks...');
  segments = [];
  const smallChunk = makeVoicedBuffer(Math.ceil(segmentBytes / 4) + 10);
  for (let i = 0; i < 5; i++) audioCapture.feedPcmChunk(smallChunk);
  assert(segments.length >= 1, 'Au moins un segment aurait dû être créé après accumulation');
  console.log('[TEST] ✓', segments.length, 'segment(s) créé(s) par accumulation');

  // Test 4 : stopRecording() nettoie l'état
  console.log('\n[TEST] Test 4: stopRecording()...');
  await audioCapture.stopRecording();
  assert.strictEqual(
    audioCapture.isRecording(),
    false,
    'isRecording() devrait être false après stopRecording()'
  );
  console.log('[TEST] ✓ Capture arrêtée proprement');

  // Test 5 : pickBestDevice() — heuristique pure de sélection de micro
  console.log('\n[TEST] Test 5: pickBestDevice()...');
  const r1 = audioCapture.pickBestDevice(['Stereo Mix (Realtek)', 'Microphone (USB Headset)']);
  assert.strictEqual(
    r1.chosen,
    'Microphone (USB Headset)',
    'Devrait écarter Stereo Mix et choisir le micro'
  );
  const r2 = audioCapture.pickBestDevice(['Stereo Mix (Realtek)', 'CABLE Output (VB-Audio)']);
  assert.strictEqual(
    r2.chosen,
    null,
    'Ne devrait rien choisir si seuls des loopbacks sont détectés'
  );
  const r3 = audioCapture.pickBestDevice([]);
  assert.strictEqual(r3.chosen, null, 'Liste vide devrait renvoyer chosen: null');
  console.log('[TEST] ✓ pickBestDevice() se comporte comme attendu');

  // Test 6 : VAD réel — un segment de silence pur est filtré, un segment
  // "voisé" passe. AJOUT (chantier VAD).
  console.log('\n[TEST] Test 6: filtrage VAD (analyzeVoiceActivity / computeRms)...');
  const silentSegment = Buffer.alloc(segmentBytes);
  const voicedSegment = makeVoicedBuffer(segmentBytes);
  const vadConfig = { ...config };

  const silentInfo = audioCapture.analyzeVoiceActivity(silentSegment, vadConfig);
  assert.strictEqual(
    silentInfo.voicedMs,
    0,
    'Un segment de silence pur ne devrait avoir aucune ms voisée'
  );

  const voicedInfo = audioCapture.analyzeVoiceActivity(voicedSegment, vadConfig);
  assert(
    voicedInfo.voicedMs >= vadConfig.minSpeechDuration,
    'Un segment voisé devrait dépasser minSpeechDuration'
  );

  // Bout-en-bout : un segment de silence pur envoyé via feedPcmChunk() ne
  // doit PAS déclencher onAudioSegment().
  segments = [];
  let skippedInfo = null;
  audioCapture.on({
    onAudioSegment: (file) => segments.push(file),
    onSegmentSkipped: (info) => {
      skippedInfo = info;
    },
    onError: (err) => console.error('[TEST] onError inattendu:', err.message),
  });
  await audioCapture.startBrowserCapture();
  audioCapture.feedPcmChunk(Buffer.alloc(segmentBytes + 100));
  assert.strictEqual(
    segments.length,
    0,
    'Un segment de silence pur ne devrait pas être envoyé au STT'
  );
  await audioCapture.stopRecording();
  console.log('[TEST] ✓ Silence correctement filtré avant envoi au STT');

  // CORRECTIF (problème récurrent — transcription qui ne démarre jamais
  // sans aucune erreur visible) : le rejet d'un segment pour silence doit
  // désormais déclencher onSegmentSkipped(), pas rester un simple
  // console.log invisible en usage normal.
  console.log('\n[TEST] Test 7: onSegmentSkipped() se déclenche bien sur un rejet...');
  assert(
    skippedInfo !== null,
    'onSegmentSkipped() aurait dû être appelé pour le segment silencieux'
  );
  assert.strictEqual(skippedInfo.voicedMs, 0, 'voicedMs devrait être 0 pour un silence pur');
  assert.strictEqual(
    skippedInfo.threshold,
    config.silenceThreshold,
    'threshold rapporté devrait correspondre à la config active'
  );
  console.log('[TEST] ✓ onSegmentSkipped() rapporte les bonnes informations');

  // CORRECTIF : silenceThreshold doit être réglable via startBrowserCapture(),
  // pour que MIC_SILENCE_THRESHOLD (server.js/config-validator.js) ait un
  // effet réel. À threshold=0, même un signal très faible doit passer.
  console.log('\n[TEST] Test 8: silenceThreshold personnalisé via startBrowserCapture()...');
  segments = [];
  skippedInfo = null;
  audioCapture.on({
    onAudioSegment: (file) => segments.push(file),
    onSegmentSkipped: (info) => {
      skippedInfo = info;
    },
    onError: (err) => console.error('[TEST] onError inattendu:', err.message),
  });
  await audioCapture.startBrowserCapture({ silenceThreshold: 0 });
  // Un signal quasi silencieux (amplitude très faible) — rejeté avec le
  // seuil par défaut (0.02), mais devrait passer avec silenceThreshold: 0.
  const quietSegment = makeVoicedBuffer(segmentBytes, 50);
  audioCapture.feedPcmChunk(quietSegment);
  assert.strictEqual(
    segments.length,
    1,
    'Avec silenceThreshold: 0, un signal faible devrait quand même être envoyé au STT'
  );
  assert.strictEqual(
    skippedInfo,
    null,
    'onSegmentSkipped() ne devrait pas se déclencher quand silenceThreshold: 0'
  );
  await audioCapture.stopRecording();
  console.log('[TEST] ✓ silenceThreshold: 0 désactive bien le filtre de silence');

  console.log('\n=== Tous les tests sont passés ===');
  process.exit(0);
}

run().catch((err) => {
  console.error('[TEST] ✗ Échec:', err.message);
  process.exit(1);
});
