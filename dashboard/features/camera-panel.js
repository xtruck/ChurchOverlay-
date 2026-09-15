/**
 * dashboard/features/camera-panel.js — aperçu webcam opérateur (voir
 * camera-capture.js, window.CameraCapture). Module isolé du pipeline audio
 * existant (audio-capture.js/groq-wrapper.js) : ne touche à aucune variable
 * ni fonction audio, ne fait aucun appel réseau/serveur — juste un aperçu
 * vidéo local. Extrait de dashboard/legacy-core.js.
 */
import { showToast, addActivity, escapeHtmlDashboard } from '../utils.js';

// AJOUT (redesign — pas d'emoji comme icône structurelle) : cameraToggleBtn
// basculait son texte entre deux emoji littéraux (📷/⏹) via .textContent —
// remplacé par ces deux marquages SVG statiques (chaînes fixes, jamais de
// contenu utilisateur : innerHTML sans risque ici), même déclenchement.
const CAMERA_ICON_START =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="2" y="7" width="15" height="12" rx="2"></rect><path d="M17 10l5-3v10l-5-3z"></path></svg> Démarrer la caméra';
const CAMERA_ICON_STOP =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="1"></rect></svg> Arrêter la caméra';

/* ============================================================================
 * Capture webcam — aperçu opérateur (voir camera-capture.js)
 * ----------------------------------------------------------------------------
 * AJOUT (demande explicite). Module ISOLÉ du pipeline audio existant
 * (audio-capture.js/groq-wrapper.js/realMicCaptureState) : ne touche à
 * aucune variable ni fonction audio, ne fait aucun appel réseau/serveur —
 * juste un aperçu vidéo local piloté via window.CameraCapture.
 * ============================================================================ */

async function refreshCameraList() {
  const select = document.getElementById('cameraSelect');
  if (!select || !window.CameraCapture) return;
  try {
    const cameras = await window.CameraCapture.listCameras();
    if (cameras.length === 0) {
      select.innerHTML = '<option value="">Aucune caméra détectée</option>';
      return;
    }
    select.innerHTML = cameras
      .map((c) => `<option value="${c.deviceId}">${escapeHtmlDashboard(c.label)}</option>`)
      .join('');
    const best = window.CameraCapture.pickBestCamera(cameras);
    if (best.chosen) select.value = best.chosen.deviceId;
    hideCameraErrorHint();
  } catch (err) {
    showCameraErrorHint(err && err.message ? err.message : String(err));
  }
}

function showCameraErrorHint(message) {
  const hint = document.getElementById('cameraErrorHint');
  if (!hint) return;
  hint.textContent = message;
  hint.style.display = 'block';
}

function hideCameraErrorHint() {
  const hint = document.getElementById('cameraErrorHint');
  if (hint) hint.style.display = 'none';
}

function updateCameraButtonUI() {
  const btn = document.getElementById('cameraToggleBtn');
  const badge = document.getElementById('cameraStatus');
  const video = document.getElementById('cameraPreview');
  const placeholder = document.getElementById('cameraPreviewPlaceholder');
  const active = !!(window.CameraCapture && window.CameraCapture.isCapturing());

  if (btn) btn.innerHTML = active ? CAMERA_ICON_STOP : CAMERA_ICON_START;
  if (badge) {
    badge.textContent = active ? 'Aperçu actif' : 'Capture arrêtée';
    badge.className = 'status-badge ' + (active ? 'success' : 'warning');
  }
  if (video) video.style.display = active ? 'block' : 'none';
  if (placeholder) placeholder.style.display = active ? 'none' : 'flex';
}

async function toggleCameraCapture() {
  if (!window.CameraCapture) {
    showToast('Module caméra indisponible.', 'error');
    return;
  }

  if (window.CameraCapture.isCapturing()) {
    window.CameraCapture.stopCapture();
    updateCameraButtonUI();
    addActivity('Caméra arrêtée manuellement', 'info');
    return;
  }

  const select = document.getElementById('cameraSelect');
  const video = document.getElementById('cameraPreview');
  const deviceId = select ? select.value : '';
  try {
    hideCameraErrorHint();
    await window.CameraCapture.startCapture(deviceId, video);
    updateCameraButtonUI();
    addActivity('Caméra démarrée', 'success');
    showToast('Caméra démarrée', 'success');
  } catch (err) {
    updateCameraButtonUI();
    const message = err && err.message ? err.message : String(err);
    showCameraErrorHint(message);
    showToast('Caméra : ' + message, 'error');
  }
}

(function initCameraPanel() {
  if (!document.getElementById('cameraToggleBtn') || !window.CameraCapture) return;

  window.CameraCapture.onStopped((reason) => {
    updateCameraButtonUI();
    if (reason === 'device-ended') {
      showCameraErrorHint('Caméra débranchée ou désactivée.');
      addActivity('Caméra déconnectée', 'warning');
      showToast('Caméra débranchée', 'warning');
    }
  });

  updateCameraButtonUI();
  refreshCameraList();

  // Redécouvre les vrais libellés une fois la permission accordée (avant
  // ça, enumerateDevices() ne renvoie que des libellés vides/génériques) et
  // suit le branchement/débranchement de caméras en cours d'utilisation.
  if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
    navigator.mediaDevices.addEventListener('devicechange', refreshCameraList);
  }
})();

window.refreshCameraList = refreshCameraList;
window.toggleCameraCapture = toggleCameraCapture;
