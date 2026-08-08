/**
 * ============================================================================
 *  camera-capture.js — Aperçu webcam USB (dashboard opérateur)
 * ----------------------------------------------------------------------------
 *  AJOUT (demande explicite — capture webcam pour l'opérateur). Module
 *  ISOLÉ de tout le pipeline audio existant (audio-capture.js,
 *  groq-wrapper.js, deepgram-wrapper.js, detector.js, server.js) : aucune
 *  dépendance croisée, aucune donnée envoyée au serveur/worker — juste un
 *  aperçu vidéo LOCAL côté opérateur, dans dashboard.html.
 *
 *  Contrairement à audio-capture.js (qui tourne dans le worker/serveur et
 *  reçoit des octets PCM déjà capturés par le renderer via IPC), ce module
 *  tourne entièrement côté RENDERER : c'est là que vivent
 *  navigator.mediaDevices et les éléments <video>. Il est chargé via
 *  <script src="camera-capture.js"> dans dashboard.html, avant dashboard.js,
 *  et expose son API sur window.CameraCapture — même esprit que les autres
 *  modules autonomes du dépôt (song-library.js, etc.), adapté au contexte
 *  renderer plutôt que worker.
 *
 *  ÉTAPE ACTUELLE : aperçu opérateur uniquement. Pas encore de sortie vers
 *  overlay.html — la vidéo ne quitte jamais le poste opérateur.
 *
 *  Exporté en CommonJS (module.exports) ET sur window.CameraCapture pour
 *  rester testable avec un simple require() en Node (voir
 *  test/test-camera-capture.js), comme audio-capture.js — seules les
 *  fonctions pures (pickBestCamera, formatDeviceLabel, mapGetUserMediaError)
 *  sont réellement testables hors navigateur ; le reste (énumération réelle,
 *  getUserMedia, flux vidéo) demande du vrai matériel, comme pour la
 *  capture micro existante.
 * ============================================================================
 */
'use strict';

// Caméras virtuelles à écarter automatiquement (logiciels de routage vidéo,
// jamais une vraie webcam physique) — même logique que LOOPBACK_PATTERNS
// dans audio-capture.js, appliquée aux libellés de caméra.
// CORRECTIF (demande explicite — caméras NDI) : "ndi video" a été RETIRÉ de
// cette liste. C'est exactement le nom sous lequel l'outil gratuit "NDI
// Virtual Input" (NDI Tools, NewTek/Vizrt) expose un flux NDI comme une
// webcam standard au système — ce n'était pas une caméra virtuelle "à
// écarter" comme OBS Virtual Camera, mais une source réelle légitime (PTZ
// NDI, régie vidéo) qu'on rejetait par erreur avant. Voir CAMERA_HINT_PATTERNS
// ci-dessous : "ndi" y est maintenant un indice PRÉFÉRÉ plutôt que rejeté.
// CORRECTIF (demande explicite — caméras de téléphone) : "droidcam" (Android),
// "iriun" et "epoccam" (iOS) ont été RETIRÉS pour la même raison — ce sont
// les applications compagnon PC des apps téléphone DroidCam/Iriun
// Webcam/EpocCam, qui exposent le téléphone comme une webcam standard une
// fois leur client de bureau lancé. Un vrai usage légitime (l'église utilise
// plusieurs téléphones comme caméras), pas une caméra virtuelle "à écarter".
const VIRTUAL_CAMERA_PATTERNS =
  /obs virtual camera|snap camera|manycam|xsplit vcam|camo\b|virtual cam/i;

// Mots qui indiquent fortement une vraie webcam physique — "ndi"/"droidcam"
// inclus : ce sont des sources réelles (voir commentaire ci-dessus), pas du
// bruit à filtrer. "iriun"/"epoccam" n'ont pas besoin d'être ajoutés ici :
// leurs libellés ("Iriun Webcam", "EpocCam Camera") contiennent déjà
// "webcam"/"camera".
const CAMERA_HINT_PATTERNS = /webcam|cam[ée]ra|camera|facetime|integrated|usb|ndi|droidcam/i;

const DEFAULT_CONSTRAINTS = {
  width: { ideal: 1280 },
  height: { ideal: 720 },
};

const STATE = {
  stream: null,
  videoElement: null,
  deviceId: null,
  onStopped: null,
};

/**
 * Choisit la caméra la plus probable parmi une liste détectée. Heuristique :
 * élimine les caméras virtuelles, privilégie les libellés contenant
 * "webcam"/"caméra"/"usb", et à défaut garde la première de la liste.
 * @param {Array<{deviceId: string, label: string}>} devices
 * @returns {{ chosen: object|null, candidates: object[], rejected: object[] }}
 */
function pickBestCamera(devices) {
  if (!devices || devices.length === 0) {
    return { chosen: null, candidates: [], rejected: [] };
  }
  const rejected = devices.filter((d) => VIRTUAL_CAMERA_PATTERNS.test(d.label || ''));
  const candidates = devices.filter((d) => !VIRTUAL_CAMERA_PATTERNS.test(d.label || ''));

  if (candidates.length === 0) {
    // Rien de sûr : mieux vaut ne rien présélectionner qu'une caméra virtuelle.
    return { chosen: null, candidates: [], rejected };
  }
  if (candidates.length === 1) {
    return { chosen: candidates[0], candidates, rejected };
  }

  const withHint = candidates.filter((d) => CAMERA_HINT_PATTERNS.test(d.label || ''));
  const chosen = withHint.length > 0 ? withHint[0] : candidates[0];
  return { chosen, candidates, rejected };
}

/**
 * Libellé affichable pour un périphérique. Avant que la permission caméra
 * ne soit accordée, enumerateDevices() ne renvoie que des libellés vides —
 * on retombe alors sur un nom générique numéroté plutôt que d'afficher une
 * ligne vide dans le menu déroulant.
 * @param {{label?: string}} device
 * @param {number} index
 * @returns {string}
 */
function formatDeviceLabel(device, index) {
  if (device && typeof device.label === 'string' && device.label.trim()) {
    return device.label.trim();
  }
  return `Caméra ${index + 1}`;
}

/**
 * Traduit une erreur getUserMedia (DOMException) en message clair pour un
 * opérateur non-technique — jamais de crash silencieux ni de message
 * cryptique de navigateur.
 * @param {Error|DOMException} err
 * @returns {string}
 */
function mapGetUserMediaError(err) {
  const name = err && err.name;
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
    return 'Aucune caméra détectée. Vérifiez qu’une webcam est bien branchée.';
  }
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError') {
    return 'Accès à la caméra refusé. Autorisez la caméra dans les paramètres de l’application/du système.';
  }
  if (name === 'NotReadableError' || name === 'TrackStartError') {
    return 'La caméra est déjà utilisée par une autre application. Fermez-la puis réessayez.';
  }
  if (name === 'OverconstrainedError' || name === 'ConstraintNotSatisfiedError') {
    return 'Cette caméra n’est plus disponible (débranchée ?). Choisissez-en une autre dans la liste.';
  }
  return 'Erreur caméra : ' + (err && err.message ? err.message : String(err));
}

/**
 * Liste les webcams disponibles sur la machine.
 * @returns {Promise<Array<{deviceId: string, label: string}>>}
 */
async function listCameras() {
  if (
    typeof navigator === 'undefined' ||
    !navigator.mediaDevices ||
    !navigator.mediaDevices.enumerateDevices
  ) {
    throw new Error('L’énumération des caméras n’est pas disponible dans cet environnement.');
  }
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices
    .filter((d) => d.kind === 'videoinput')
    .map((d, i) => ({ deviceId: d.deviceId, label: formatDeviceLabel(d, i) }));
}

/**
 * Démarre la capture d'une caméra et branche son flux sur l'élément vidéo
 * fourni (aperçu opérateur uniquement). Coupe proprement une capture en
 * cours avant d'en démarrer une nouvelle (changement de caméra à chaud).
 * @param {string} deviceId - vide/undefined pour laisser le navigateur choisir
 * @param {HTMLVideoElement} videoElement
 * @returns {Promise<true>}
 */
async function startCapture(deviceId, videoElement) {
  if (!videoElement) {
    throw new Error('Élément vidéo manquant pour l’aperçu caméra.');
  }
  if (
    typeof navigator === 'undefined' ||
    !navigator.mediaDevices ||
    !navigator.mediaDevices.getUserMedia
  ) {
    throw new Error('La capture caméra n’est pas disponible dans cet environnement.');
  }

  if (STATE.stream) {
    stopCapture();
  }

  const videoConstraints = Object.assign({}, DEFAULT_CONSTRAINTS);
  if (deviceId) videoConstraints.deviceId = { exact: deviceId };

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: videoConstraints, audio: false });
  } catch (err) {
    throw new Error(mapGetUserMediaError(err), { cause: err });
  }

  const [track] = stream.getVideoTracks();
  if (track) {
    // Caméra débranchée/désactivée par l'OS pendant la capture : on nettoie
    // l'état proprement plutôt que de laisser un flux mort affiché.
    track.addEventListener('ended', () => {
      const wasCapturing = !!STATE.stream;
      stopCapture();
      if (wasCapturing && typeof STATE.onStopped === 'function') {
        STATE.onStopped('device-ended');
      }
    });
  }

  videoElement.srcObject = stream;
  STATE.stream = stream;
  STATE.videoElement = videoElement;
  STATE.deviceId = deviceId || null;
  return true;
}

/**
 * Arrête la capture en cours (si active) et libère la caméra. Ne fait rien
 * si aucune capture n'est en cours — appel sûr en toutes circonstances.
 */
function stopCapture() {
  if (STATE.stream) {
    STATE.stream.getTracks().forEach((track) => track.stop());
  }
  if (STATE.videoElement) {
    STATE.videoElement.srcObject = null;
  }
  STATE.stream = null;
  STATE.videoElement = null;
  STATE.deviceId = null;
}

/**
 * @returns {boolean} true si une capture caméra est active
 */
function isCapturing() {
  return !!STATE.stream;
}

/**
 * Enregistre un rappel appelé quand la capture s'arrête d'elle-même
 * (caméra débranchée en cours d'utilisation).
 * @param {(reason: string) => void} callback
 */
function onStopped(callback) {
  STATE.onStopped = typeof callback === 'function' ? callback : null;
}

const api = {
  pickBestCamera,
  formatDeviceLabel,
  mapGetUserMediaError,
  listCameras,
  startCapture,
  stopCapture,
  isCapturing,
  onStopped,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
}
if (typeof window !== 'undefined') {
  window.CameraCapture = api;
}
