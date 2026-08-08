/**
 * ============================================================================
 *  test-camera-capture.js — Tests pour camera-capture.js
 * ----------------------------------------------------------------------------
 *  Sur le modèle de test-audio-capture.js : les fonctions PURES
 *  (pickBestCamera, formatDeviceLabel, mapGetUserMediaError) sont testées
 *  directement en Node. listCameras()/startCapture() touchent
 *  navigator.mediaDevices (inexistant hors navigateur) — non testables ici
 *  sans matériel réel, seule leur garde défensive (erreur claire plutôt que
 *  ReferenceError brut) est vérifiée.
 * ============================================================================
 */
'use strict';
const assert = require('assert');
const cameraCapture = require('../camera-capture');

console.log('=== Test Camera Capture ===\n');

// Test 1 : pickBestCamera() — liste vide.
console.log('[TEST] Test 1: pickBestCamera([])...');
{
  const result = cameraCapture.pickBestCamera([]);
  assert.strictEqual(result.chosen, null);
  assert.deepStrictEqual(result.candidates, []);
  assert.deepStrictEqual(result.rejected, []);
}
console.log('[TEST] ✓ Liste vide -> aucune caméra choisie\n');

// Test 2 : pickBestCamera() — uniquement une caméra virtuelle -> rejetée.
console.log('[TEST] Test 2: pickBestCamera() avec seulement une caméra virtuelle...');
{
  const devices = [{ deviceId: '1', label: 'OBS Virtual Camera' }];
  const result = cameraCapture.pickBestCamera(devices);
  assert.strictEqual(result.chosen, null, 'une caméra virtuelle seule ne doit jamais être choisie');
  assert.strictEqual(result.rejected.length, 1);
}
console.log('[TEST] ✓ Caméra virtuelle isolée rejetée\n');

// Test 3 : pickBestCamera() — vraie webcam préférée à une caméra virtuelle.
console.log('[TEST] Test 3: pickBestCamera() préfère une vraie webcam...');
{
  const devices = [
    { deviceId: '1', label: 'OBS Virtual Camera' },
    { deviceId: '2', label: 'HD Webcam USB' },
  ];
  const result = cameraCapture.pickBestCamera(devices);
  assert.strictEqual(result.chosen && result.chosen.deviceId, '2');
  assert.strictEqual(result.candidates.length, 1);
  assert.strictEqual(result.rejected.length, 1);
}
console.log('[TEST] ✓ Webcam physique préférée à la caméra virtuelle\n');

// Test 4 : pickBestCamera() — un seul candidat réel, choisi par défaut même
// sans mot-clé caméra dans le libellé.
console.log('[TEST] Test 4: pickBestCamera() avec un seul candidat réel...');
{
  const devices = [{ deviceId: '1', label: 'Logitech C920' }];
  const result = cameraCapture.pickBestCamera(devices);
  assert.strictEqual(result.chosen && result.chosen.deviceId, '1');
}
console.log('[TEST] ✓ Candidat unique choisi même sans indice de nom\n');

// Test 4b (CORRECTIF — caméras NDI) : "NDI Video" (nom exposé par l'outil
// gratuit NDI Virtual Input) doit être reconnu comme une source RÉELLE et
// préféré — avant ce correctif, il était filtré comme une fausse caméra
// virtuelle au même titre qu'OBS Virtual Camera.
console.log('[TEST] Test 4b: pickBestCamera() reconnaît une caméra NDI comme réelle...');
{
  const devices = [{ deviceId: '1', label: 'NDI Video' }];
  const result = cameraCapture.pickBestCamera(devices);
  assert.strictEqual(
    result.chosen && result.chosen.deviceId,
    '1',
    'une caméra NDI (pontée via NDI Virtual Input) ne doit plus être rejetée comme virtuelle'
  );
  assert.strictEqual(result.rejected.length, 0);
}
{
  const devices = [
    { deviceId: '1', label: 'Integrated Webcam' },
    { deviceId: '2', label: 'NDI Video' },
  ];
  const result = cameraCapture.pickBestCamera(devices);
  assert.strictEqual(
    result.candidates.length,
    2,
    'les deux sources doivent être candidates (aucune rejetée)'
  );
}
console.log('[TEST] ✓ Caméra NDI reconnue comme source réelle, non filtrée\n');

// Test 4c (CORRECTIF — caméras de téléphone) : DroidCam/Iriun/EpocCam
// (applications compagnon PC qui exposent un téléphone comme webcam)
// doivent être reconnues comme des sources réelles — avant ce correctif,
// elles étaient filtrées comme de fausses caméras virtuelles.
console.log('[TEST] Test 4c: pickBestCamera() reconnaît les caméras de téléphone...');
{
  const devices = [{ deviceId: '1', label: 'DroidCam Source 2' }];
  const result = cameraCapture.pickBestCamera(devices);
  assert.strictEqual(
    result.chosen && result.chosen.deviceId,
    '1',
    'DroidCam ne doit plus être rejetée comme caméra virtuelle'
  );
  assert.strictEqual(result.rejected.length, 0);
}
{
  const devices = [{ deviceId: '1', label: 'Iriun Webcam' }];
  const result = cameraCapture.pickBestCamera(devices);
  assert.strictEqual(
    result.chosen && result.chosen.deviceId,
    '1',
    'Iriun ne doit plus être rejetée'
  );
}
{
  const devices = [{ deviceId: '1', label: 'EpocCam Camera' }];
  const result = cameraCapture.pickBestCamera(devices);
  assert.strictEqual(
    result.chosen && result.chosen.deviceId,
    '1',
    'EpocCam ne doit plus être rejetée'
  );
}
console.log('[TEST] ✓ Caméras de téléphone (DroidCam/Iriun/EpocCam) reconnues comme réelles\n');

// Test 5 : formatDeviceLabel() — libellé vide (avant permission accordée)
// retombe sur un nom générique numéroté, jamais une chaîne vide.
console.log('[TEST] Test 5: formatDeviceLabel()...');
{
  assert.strictEqual(cameraCapture.formatDeviceLabel({ label: '' }, 0), 'Caméra 1');
  assert.strictEqual(cameraCapture.formatDeviceLabel({ label: '   ' }, 2), 'Caméra 3');
  assert.strictEqual(
    cameraCapture.formatDeviceLabel({ label: 'Logitech C920' }, 0),
    'Logitech C920'
  );
}
console.log('[TEST] ✓ Libellés formatés correctement (avec repli générique)\n');

// Test 6 : mapGetUserMediaError() — chaque type d'erreur connu donne un
// message clair et distinct, sans jamais renvoyer un message vide.
console.log('[TEST] Test 6: mapGetUserMediaError()...');
{
  const noCam = cameraCapture.mapGetUserMediaError({ name: 'NotFoundError' });
  assert(/aucune caméra/i.test(noCam), 'NotFoundError -> message "aucune caméra"');

  const denied = cameraCapture.mapGetUserMediaError({ name: 'NotAllowedError' });
  assert(/refusé/i.test(denied), 'NotAllowedError -> message "refusé"');

  const inUse = cameraCapture.mapGetUserMediaError({ name: 'NotReadableError' });
  assert(/déjà utilisée/i.test(inUse), 'NotReadableError -> message "déjà utilisée"');

  const stale = cameraCapture.mapGetUserMediaError({ name: 'OverconstrainedError' });
  assert(/plus disponible/i.test(stale), 'OverconstrainedError -> message "plus disponible"');

  const unknown = cameraCapture.mapGetUserMediaError({ name: 'WeirdError', message: 'oops' });
  assert(
    unknown.includes('oops'),
    'erreur inconnue -> message générique incluant le détail original'
  );
}
console.log('[TEST] ✓ Tous les types d’erreur getUserMedia produisent un message clair\n');

// Test 7 : isCapturing() — état initial à false (aucune capture démarrée
// dans ce processus de test).
console.log('[TEST] Test 7: isCapturing() à l’état initial...');
assert.strictEqual(cameraCapture.isCapturing(), false);
console.log('[TEST] ✓ Aucune capture active par défaut\n');

// Test 8 : listCameras()/startCapture() hors navigateur -> erreur claire,
// jamais un crash brut (ReferenceError: navigator is not defined).
console.log('[TEST] Test 8: garde défensive hors navigateur...');
(async () => {
  await assert.rejects(
    () => cameraCapture.listCameras(),
    /énumération/i,
    'listCameras() hors navigateur doit rejeter avec un message clair'
  );
  await assert.rejects(
    () => cameraCapture.startCapture(null, {}),
    /disponible/i,
    'startCapture() hors navigateur doit rejeter avec un message clair'
  );
  console.log('[TEST] ✓ Garde défensive active hors navigateur (pas de crash brut)\n');

  console.log('=== Tous les tests camera-capture sont passés ===');
})().catch((err) => {
  console.error('[TEST] ✗ Échec:', err.message);
  process.exit(1);
});
