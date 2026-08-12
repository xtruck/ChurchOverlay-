/**
 * ============================================================================
 *  test-audio-capture-silero-integration.js — Silero VAD branché sur
 *  audio-capture.js, de bout en bout (pas juste le modèle isolé, voir
 *  test-silero-vad.js).
 * ----------------------------------------------------------------------------
 *  Reproduit précisément le bug signalé en usage réel : du bruit fort
 *  (sono, ventilateur...) envoyé au STT comme si c'était de la parole,
 *  parce que le RMS seul ne peut pas faire la différence. Ce test prouve
 *  que la classification neuronale (une fois active) rejette ce même bruit
 *  AVANT qu'il n'atteigne onAudioSegment — via le vrai chemin de
 *  handleAudioData/processSileroWindow/flushSegment, pas une fonction pure
 *  isolée.
 *
 *  Pacing réel (petits chunks + attentes) plutôt qu'un seul gros buffer :
 *  l'inférence Silero est asynchrone et mise en file (STATE.sileroQueue,
 *  voir audio-capture.js) — un seul chunk géant atteindrait le plafond de
 *  sécurité (segmentDuration) AVANT que la file n'ait eu le temps de
 *  classifier quoi que ce soit, ce qui prouverait uniquement l'absence de
 *  détection plutôt que son verdict. En production, les chunks arrivent
 *  espacés dans le temps réel (IPC renderer -> worker) — ce test respecte
 *  ce même rythme pour exercer le vrai chemin, pas un raccourci.
 * ============================================================================
 */

'use strict';
const assert = require('assert');
const audioCapture = require('../audio-capture');
const sileroVad = require('../silero-vad');

console.log('=== Test intégration Silero VAD <-> audio-capture.js ===\n');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Bruit blanc fort déterministe (pas Math.random — reproductible), PCM16LE. */
function makeNoiseChunk(byteLength, seedStart) {
  const buf = Buffer.alloc(byteLength - (byteLength % 2));
  let seed = seedStart;
  for (let i = 0; i + 1 < buf.length; i += 2) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const sample = Math.floor(((seed % 20000) / 10000 - 1) * 24000); // amplitude forte
    buf.writeInt16LE(sample, i);
  }
  return buf;
}

async function waitForSileroActive(timeoutMs = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (audioCapture.getVadProvider() === 'silero') return true;
    await sleep(20);
  }
  return false;
}

async function run() {
  console.log('[TEST] Pré-chargement du modèle Silero (hors chronométrage du test)...');
  const initResult = await sileroVad.init();
  if (!initResult.ok) {
    console.error(
      `[TEST] ✗ Modèle Silero indisponible (${initResult.error}) — test non concluant.`
    );
    process.exit(1);
  }
  console.log('[TEST] ✓ Modèle prêt\n');

  const skipped = [];
  const segments = [];
  audioCapture.on({
    onAudioSegment: (file) => segments.push(file),
    onSegmentSkipped: (info) => skipped.push(info),
    onError: (err) => console.error('[TEST] onError inattendu:', err.message),
  });

  console.log('[TEST] Test 1: la session bascule bien sur le fournisseur Silero...');
  await audioCapture.startBrowserCapture();
  const becameActive = await waitForSileroActive();
  assert.strictEqual(
    becameActive,
    true,
    "getVadProvider() devrait devenir 'silero' peu après startBrowserCapture() (modèle déjà chargé)"
  );
  console.log('[TEST] ✓ Silero actif\n');

  console.log(
    '[TEST] Test 2: du bruit fort et continu (jamais de parole) est rejeté ' +
      'sans jamais atteindre onAudioSegment (~4s de test, pacing réel)...'
  );
  const config = audioCapture.getConfig();
  const bytesPerSample = config.bitDepth / 8;
  const samplesPerSecond = config.sampleRate * config.channels;
  const chunkMs = 100;
  const chunkBytes = Math.floor((chunkMs / 1000) * samplesPerSecond * bytesPerSample);
  // Un peu plus que segmentDuration (plafond de sécurité, 4000ms par défaut)
  // pour garantir qu'un flush se produit bien pendant ce test.
  const totalMs = config.segmentDuration + 500;
  const chunkCount = Math.ceil(totalMs / chunkMs);

  for (let i = 0; i < chunkCount; i++) {
    audioCapture.feedPcmChunk(makeNoiseChunk(chunkBytes, 1000 + i));
    await sleep(chunkMs);
  }
  // Laisse la file Silero terminer de classifier les toutes dernières fenêtres.
  await sleep(300);

  assert.strictEqual(
    segments.length,
    0,
    `du bruit non-vocal ne devrait produire AUCUN segment envoyé au STT (obtenu: ${segments.length})`
  );
  assert(
    skipped.length > 0,
    'onSegmentSkipped aurait dû se déclencher au moins une fois (plafond de sécurité atteint)'
  );
  assert.strictEqual(
    skipped[skipped.length - 1].provider,
    'silero',
    "le rejet devrait être attribué au fournisseur 'silero', pas au repli RMS"
  );
  console.log(
    `[TEST] ✓ ${skipped.length} segment(s) de bruit rejeté(s) via Silero, 0 envoyé(s) au STT ` +
      `(dernière probabilité moyenne : ${skipped[skipped.length - 1].sileroAvgProb})\n`
  );

  await audioCapture.stopRecording();
  console.log("=== Tous les tests d'intégration Silero sont passés ===");
  process.exit(0);
}

run().catch((err) => {
  console.error('[TEST] ✗ Échec:', err.message);
  process.exit(1);
});
