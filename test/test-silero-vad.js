/**
 * ============================================================================
 *  test-silero-vad.js — Tests pour silero-vad.js (VAD neuronal)
 * ----------------------------------------------------------------------------
 *  Le modèle réel (models/silero_vad.onnx) est chargé — pas de mock — car
 *  c'est justement le contrat empirique du modèle (formes de tenseurs,
 *  comportement sur silence vs bruit fort) qui doit être vérifié, pas
 *  seulement la logique JS autour. Nécessite onnxruntime-node installé
 *  (voir package.json) — si absent, ce test échoue explicitement plutôt que
 *  de passer silencieusement sur une intégration jamais vraiment testée.
 * ============================================================================
 */

'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vad = require('../silero-vad');

console.log('=== Test Silero VAD (modèle ONNX réel) ===\n');

async function run() {
  console.log('[TEST] Test 1: init() charge le modèle réel...');
  const initResult = await vad.init();
  assert.strictEqual(initResult.ok, true, `init() devrait réussir (erreur: ${initResult.error})`);
  assert.strictEqual(vad.isAvailable(), true, 'isAvailable() devrait être true après init() OK');
  console.log('[TEST] ✓ Modèle chargé\n');

  console.log('[TEST] Test 2: init() est idempotent (rappel sans recharger)...');
  const second = await vad.init();
  assert.strictEqual(second.ok, true, 'un second init() doit rester OK');
  console.log('[TEST] ✓ Idempotent\n');

  console.log('[TEST] Test 3: silence pur => probabilité de parole très faible...');
  const stream = vad.createStreamState();
  const silence = new Float32Array(vad.WINDOW_SAMPLES);
  const pSilence = await vad.processWindow(silence, stream);
  assert(pSilence < 0.1, `silence devrait donner une probabilité faible (obtenu: ${pSilence})`);
  console.log(`[TEST] ✓ prob(silence) = ${pSilence.toFixed(4)}\n`);

  console.log(
    '[TEST] Test 4: bruit blanc fort => probabilité de parole toujours faible ' +
      "(la distinction que le RMS seul ne peut PAS faire — c'est le bug corrigé)..."
  );
  const noiseStream = vad.createStreamState();
  const noise = new Float32Array(vad.WINDOW_SAMPLES);
  // Seed déterministe (pas Math.random — reproductible) : bruit blanc à
  // forte amplitude, largement au-dessus de n'importe quel seuil RMS de
  // parole normale, mais sans structure de parole.
  let seed = 42;
  for (let i = 0; i < noise.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    noise[i] = ((seed % 2000) / 1000 - 1) * 0.85; // amplitude ~0.85, bien au-dessus du seuil RMS de parole
  }
  const rmsOfNoise = Math.sqrt(noise.reduce((s, x) => s + x * x, 0) / noise.length);
  assert(rmsOfNoise > 0.3, `le bruit de test doit être fort (RMS obtenu: ${rmsOfNoise})`);
  const pNoise = await vad.processWindow(noise, noiseStream);
  assert(
    pNoise < 0.5,
    `du bruit blanc fort mais non-vocal ne devrait pas être classé "parole" (obtenu: ${pNoise}) — ` +
      `un détecteur RMS seul aurait accepté ce signal (RMS ${rmsOfNoise.toFixed(3)} très au-dessus de tout seuil de silence usuel)`
  );
  console.log(
    `[TEST] ✓ prob(bruit blanc fort, RMS=${rmsOfNoise.toFixed(3)}) = ${pNoise.toFixed(4)}\n`
  );

  console.log('[TEST] Test 5: état LSTM propagé entre fenêtres (pas figé)...');
  const evolvingStream = vad.createStreamState();
  const before = Float32Array.from(evolvingStream.state);
  await vad.processWindow(silence, evolvingStream);
  const after = evolvingStream.state;
  assert(
    !before.every((v, i) => v === after[i]),
    "l'état LSTM devrait changer après une inférence (sinon le streaming n'a aucun sens)"
  );
  console.log('[TEST] ✓ État mis à jour après inférence\n');

  console.log('[TEST] Test 6: deux flux ont des états indépendants...');
  const streamA = vad.createStreamState();
  const streamB = vad.createStreamState();
  await vad.processWindow(noise, streamA);
  assert(
    streamB.state.every((v) => v === 0),
    "créer/utiliser streamA ne doit jamais muter l'état initial de streamB"
  );
  console.log('[TEST] ✓ États indépendants\n');

  console.log('[TEST] Test 7: processWindow() rejette une taille de fenêtre incorrecte...');
  await assert.rejects(
    () => vad.processWindow(new Float32Array(256), vad.createStreamState()),
    /512/,
    'une fenêtre de mauvaise taille doit lever une erreur explicite mentionnant la taille attendue'
  );
  console.log('[TEST] ✓ Erreur explicite sur taille invalide\n');

  console.log(
    '[TEST] Test 8: NON-RÉGRESSION — de la PAROLE RÉELLE connue doit dépasser le seuil de parole...'
  );
  const speechPath = path.join(__dirname, '..', 'live-tests', 'samples', 'testA_16k.wav');
  assert(fs.existsSync(speechPath), `échantillon de parole connu introuvable : ${speechPath}`);
  const speechSamples = readWavPcm16(speechPath);
  assert(speechSamples.length >= vad.WINDOW_SAMPLES, 'échantillon de parole trop court');
  const speechStream = vad.createStreamState();
  const probs = [];
  for (
    let offset = 0;
    offset + vad.WINDOW_SAMPLES <= speechSamples.length;
    offset += vad.WINDOW_SAMPLES
  ) {
    const window = speechSamples.slice(offset, offset + vad.WINDOW_SAMPLES);
    probs.push(await vad.processWindow(window, speechStream));
  }
  const maxProb = Math.max(...probs);
  const pctAbove = (probs.filter((p) => p >= 0.5).length / probs.length) * 100;
  assert(
    maxProb >= 0.5,
    `de la parole réelle connue (testA_16k.wav) doit être détectée : max prob=${maxProb.toFixed(4)}, ` +
      `${pctAbove.toFixed(1)}% des fenêtres >= 0.5. Si le modèle renvoie ~0.001 partout, c'est le bug du ` +
      'contexte STFT de 64 échantillons manquant (voir en-tête de silero-vad.js).'
  );
  console.log(
    `[TEST] ✓ prob(parole testA_16k.wav) : max=${maxProb.toFixed(4)}, ` +
      `${pctAbove.toFixed(1)}% des fenêtres >= 0.5 (avant correctif : max ~0.003)\n`
  );

  console.log('\n=== Tous les tests silero-vad sont passés ===');
  process.exit(0);
}

/**
 * Lit un WAV PCM16 mono/16kHz en Float32Array [-1,1] (scan des chunks,
 * insensible au header). Taille = multiple de WINDOW_SAMPLES non garanti —
 * l'appelant tronque.
 */
function readWavPcm16(filePath) {
  const b = fs.readFileSync(filePath);
  let off = 12;
  while (off + 8 <= b.length) {
    const id = b.toString('ascii', off, off + 4);
    const sz = b.readUInt32LE(off + 4);
    if (id === 'data') {
      const n = sz / 2;
      const out = new Float32Array(n);
      const dataOff = off + 8;
      for (let i = 0; i < n; i++) out[i] = b.readInt16LE(dataOff + i * 2) / 32768;
      return out;
    }
    off += 8 + sz + (sz % 2);
  }
  throw new Error(`chunk 'data' introuvable dans ${filePath}`);
}

run().catch((err) => {
  console.error('[TEST] ✗ Échec:', err.message);
  process.exit(1);
});
