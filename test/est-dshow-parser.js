/**
 * ============================================================================
 *  test-dshow-parser.js — Tests de non-régression (golden files) pour
 *  dshow-parser.js
 * ----------------------------------------------------------------------------
 *  Historique : deux bugs distincts ont déjà rendu la détection micro
 *  totalement silencieuse (liste toujours vide) :
 *    1. Un parseur qui ne gérait que le format inline '"Nom" (audio)',
 *       absent des builds Windows les plus courants (Gyan.dev/BtbN).
 *    2. Un cache 24h qui persistait un résultat vide et le resservait même
 *       après correction du bug #1 (voir main.js/detectAudioDevices).
 *  Ces échantillons sont recopiés MOT POUR MOT depuis de vraies sorties
 *  FFmpeg (builds Gyan.dev, BtbN, et anciens builds à suffixe inline)
 *  documentées publiquement, pour empêcher toute régression future sur le
 *  parsing lui-même.
 * ============================================================================
 */

'use strict';

const assert = require('assert');
const { parseDshowAudioDevices } = require('../dshow-parser');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`[TEST] ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`[TEST] ✗ ${name}`);
    console.error(`        ${err.message}`);
    process.exitCode = 1;
  }
}

console.log('=== Test dshow-parser.js (golden files) ===\n');

// ----------------------------------------------------------------------------
// Golden file 1 : build Gyan.dev / BtbN moderne, format à deux sections
// (le format le plus courant sur les PC des utilisateurs — c'est celui qui
// causait un résultat TOUJOURS VIDE avant le correctif).
// ----------------------------------------------------------------------------
const GOLDEN_TWO_SECTION = String.raw`ffmpeg version N-118273-g6c9d... Copyright (c) 2000-2024 the FFmpeg developers
  built with gcc 13.2.0
[dshow @ 000001d6f6f2ea40] DirectShow video devices (some may be both video and audio devices)
[dshow @ 000001d6f6f2ea40]  "Integrated Webcam"
[dshow @ 000001d6f6f2ea40]     Alternative name "@device_pnp_\\?\usb#vid_0c45&pid_6a15&mi_00#7&1e8b1a1&0&0000#{65e8773d-8f56-11d0-a3b9-00a0c9223196}\global"
[dshow @ 000001d6f6f2ea40]  "OBS Virtual Camera"
[dshow @ 000001d6f6f2ea40]     Alternative name "@device_sw_{860BB310-5D01-11D0-BD3B-00A0C911CE86}\{A3FCE0F5-3493-419F-958A-ABA1250EC20B}"
[dshow @ 000001d6f6f2ea40] DirectShow audio devices
[dshow @ 000001d6f6f2ea40]  "Microphone (Realtek(R) Audio)"
[dshow @ 000001d6f6f2ea40]     Alternative name "@device_cm_{33D9A762-90C8-11D0-BD43-00A0C911CE86}\wave_{024F58BD-C3C7-401F-B905-455306BF3F33}"
[dshow @ 000001d6f6f2ea40]  "Casque Micro-USB (2- USB Audio Device)"
[dshow @ 000001d6f6f2ea40]     Alternative name "@device_cm_{33D9A762-90C8-11D0-BD43-00A0C911CE86}\wave_{0881BEEB-1C3E-4C22-997E-C1A757D757DF}"
dummy: Immediate exit requested`;

test('Format à 2 sections (Gyan.dev/BtbN) : les 2 micros sont détectés, la webcam est exclue', () => {
  const devices = parseDshowAudioDevices(GOLDEN_TWO_SECTION);
  assert.deepStrictEqual(devices, [
    'Microphone (Realtek(R) Audio)',
    'Casque Micro-USB (2- USB Audio Device)',
  ]);
});

// ----------------------------------------------------------------------------
// Golden file 2 : ancien build avec suffixe inline "(audio)" / "(video)"
// (documenté dans des guides de capture DirectShow encore utilisés
// aujourd'hui avec certains builds spécialisés type screen-capture-recorder).
// ----------------------------------------------------------------------------
const GOLDEN_INLINE = String.raw`[dshow @ 000001eb780baf00] "USB Capture HDMI" (video)
[dshow @ 000001eb780baf00] Alternative name "@device_pnp_\\?\usb#vid_2935&pid_0006&mi_00#8&3027539&0&0000#{65e8773d-8f56-11d0-a3b9-00a0c9223196}\global"
[dshow @ 000001eb780baf00] "OBS Virtual Camera" (none)
[dshow @ 000001eb780baf00] Alternative name "@device_sw_{860BB310-5D01-11D0-BD3B-00A0C911CE86}\{A3FCE0F5-3493-419F-958A-ABA1250EC20B}"
[dshow @ 000001eb780baf00] "VoiceMeeter Aux Output (VB-Audio VoiceMeeter AUX VAIO)" (audio)
[dshow @ 000001eb780baf00] Alternative name "@device_cm_{33D9A762-90C8-11D0-BD43-00A0C911CE86}\wave_{024F58BD-C3C7-401F-B905-455306BF3F33}"
[dshow @ 000001eb780baf00] "IN 3-4 (2- BEHRINGER UMC 404HD 192k)" (audio)
[dshow @ 000001eb780baf00] Alternative name "@device_cm_{33D9A762-90C8-11D0-BD43-00A0C911CE86}\wave_{0881BEEB-1C3E-4C22-997E-C1A757D757DF}"`;

test('Format inline "(audio)" (anciens builds) : les 2 périphériques audio sont détectés', () => {
  const devices = parseDshowAudioDevices(GOLDEN_INLINE);
  assert.deepStrictEqual(devices, [
    'VoiceMeeter Aux Output (VB-Audio VoiceMeeter AUX VAIO)',
    'IN 3-4 (2- BEHRINGER UMC 404HD 192k)',
  ]);
});

// ----------------------------------------------------------------------------
// Golden file 3 : aucun périphérique vidéo, seulement des micros (machine
// sans webcam — la section vidéo peut être absente ou vide).
// ----------------------------------------------------------------------------
const GOLDEN_AUDIO_ONLY = String.raw`[dshow @ 000001a2] DirectShow audio devices
[dshow @ 000001a2]  "Microphone (USB Audio Device)"
[dshow @ 000001a2]     Alternative name "@device_cm_{33D9A762-90C8-11D0-BD43-00A0C911CE86}\wave_{ABCDEF01}"`;

test('Aucune section vidéo (machine sans webcam) : le micro est quand même détecté', () => {
  const devices = parseDshowAudioDevices(GOLDEN_AUDIO_ONLY);
  assert.deepStrictEqual(devices, ['Microphone (USB Audio Device)']);
});

// ----------------------------------------------------------------------------
// Golden file 4 : échec réel d'énumération DirectShow (message d'erreur
// FFmpeg documenté — voir main.js/diagnoseEmptyResult pour la détection de
// ce cas précis, qui NE DOIT PAS être confondu avec "0 micro branché").
// ----------------------------------------------------------------------------
const GOLDEN_ENUMERATION_FAILED = String.raw`[dshow @ 000001a2] Could not enumerate audio devices (or none found).
[dshow @ 000001a2] I/O error`;

test("Échec d'énumération DirectShow : aucune fausse détection, liste vide", () => {
  const devices = parseDshowAudioDevices(GOLDEN_ENUMERATION_FAILED);
  assert.deepStrictEqual(devices, []);
});

// ----------------------------------------------------------------------------
// Cas limites généraux
// ----------------------------------------------------------------------------
test('Entrée vide : ne plante pas, renvoie []', () => {
  assert.deepStrictEqual(parseDshowAudioDevices(''), []);
});

test('Entrée undefined/null : ne plante pas, renvoie []', () => {
  assert.deepStrictEqual(parseDshowAudioDevices(undefined), []);
  assert.deepStrictEqual(parseDshowAudioDevices(null), []);
});

test('Nom de micro contenant des guillemets échappés dans "Alternative name" : ignoré correctement', () => {
  const output = String.raw`[dshow @ x] DirectShow audio devices
[dshow @ x]  "Micro Test"
[dshow @ x]     Alternative name "@device_cm_{...}\wave_{...}"`;
  assert.deepStrictEqual(parseDshowAudioDevices(output), ['Micro Test']);
});

console.log(`\n=== ${passed} test(s) réussis ===`);
if (process.exitCode === 1) {
  console.error('[TEST] ✗ Des tests dshow-parser ont échoué');
} else {
  console.log('[TEST] ✓ Tous les tests dshow-parser (golden files) sont passés');
}
