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
  assert.strictEqual(audioCapture.isRecording(), true, 'isRecording() devrait être true après startBrowserCapture()');

  // Un seul chunk plus grand que segmentBytes doit produire exactement 1 segment
  audioCapture.feedPcmChunk(Buffer.alloc(segmentBytes + 100));
  assert.strictEqual(segments.length, 1, 'Un segment aurait dû être créé');
  assert(fs.existsSync(segments[0]), 'Le fichier segment devrait exister sur disque');
  const wav = fs.readFileSync(segments[0]);
  assert.strictEqual(wav.toString('ascii', 0, 4), 'RIFF', 'En-tête WAV invalide (RIFF)');
  assert.strictEqual(wav.toString('ascii', 8, 12), 'WAVE', 'En-tête WAV invalide (WAVE)');
  console.log('[TEST] ✓ Segment WAV créé et bien formé:', segments[0]);

  // Test 3 : plusieurs petits chunks cumulés déclenchent aussi un segment
  console.log('\n[TEST] Test 3: accumulation de petits chunks...');
  segments = [];
  const smallChunk = Buffer.alloc(Math.ceil(segmentBytes / 4) + 10);
  for (let i = 0; i < 5; i++) audioCapture.feedPcmChunk(smallChunk);
  assert(segments.length >= 1, 'Au moins un segment aurait dû être créé après accumulation');
  console.log('[TEST] ✓', segments.length, 'segment(s) créé(s) par accumulation');

  // Test 4 : stopRecording() nettoie l'état
  console.log('\n[TEST] Test 4: stopRecording()...');
  await audioCapture.stopRecording();
  assert.strictEqual(audioCapture.isRecording(), false, 'isRecording() devrait être false après stopRecording()');
  console.log('[TEST] ✓ Capture arrêtée proprement');

  // Test 5 : pickBestDevice() — heuristique pure de sélection de micro
  console.log('\n[TEST] Test 5: pickBestDevice()...');
  const r1 = audioCapture.pickBestDevice(['Stereo Mix (Realtek)', 'Microphone (USB Headset)']);
  assert.strictEqual(r1.chosen, 'Microphone (USB Headset)', 'Devrait écarter Stereo Mix et choisir le micro');
  const r2 = audioCapture.pickBestDevice(['Stereo Mix (Realtek)', 'CABLE Output (VB-Audio)']);
  assert.strictEqual(r2.chosen, null, 'Ne devrait rien choisir si seuls des loopbacks sont détectés');
  const r3 = audioCapture.pickBestDevice([]);
  assert.strictEqual(r3.chosen, null, 'Liste vide devrait renvoyer chosen: null');
  console.log('[TEST] ✓ pickBestDevice() se comporte comme attendu');

  console.log('\n=== Tous les tests sont passés ===');
  process.exit(0);
}

run().catch((err) => {
  console.error('[TEST] ✗ Échec:', err.message);
  process.exit(1);
});
