/**
 * dashboard/features/ip-cameras.js — jumelage/ajout d'une caméra IP
 * (téléphone), voir ip-camera-store.js côté backend : QR code sans
 * application, ou formulaire manuel pour une app "IP Webcam" déjà en
 * cours d'exécution. Configuration ponctuelle, avant ou entre les cultes —
 * pas une tâche de direct.
 *
 * Distinct de ip-camera-feed.js (la grille des caméras déjà ajoutées,
 * regardée PENDANT le culte — Operator-essential, voir son en-tête)
 * (redesign IA — étape 2, scission live/config du fichier
 * dashboard/features/ip-cameras.js d'origine, voir
 * DASHBOARD-IA-REDESIGN-PROPOSAL.md, question ouverte 2).
 * Extrait de dashboard/legacy-core.js (chantier de modularisation).
 */
import { ws } from '../state.js';
import { showToast } from '../utils.js';

export function addIpCamera() {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    showToast('Non connecté au serveur.', 'error');
    return;
  }
  const labelInput = document.getElementById('ipCameraLabelInput');
  const urlInput = document.getElementById('ipCameraUrlInput');
  const label = labelInput ? labelInput.value.trim() : '';
  const url = urlInput ? urlInput.value.trim() : '';
  if (!url) {
    showToast('Entrez l’adresse du flux (ex. http://192.168.1.50:8080/video).', 'error');
    return;
  }
  ws.send(JSON.stringify({ action: 'addIpCamera', label, url }));
  if (labelInput) labelInput.value = '';
  if (urlInput) urlInput.value = '';
}

// AJOUT (caméra téléphone par QR code, demande explicite) : le téléphone
// n'a besoin d'aucune app — il scanne, ouvre phone-camera.html dans son
// propre navigateur, et apparaît automatiquement dans la liste ci-dessus
// (voir POST /phone-camera-pair côté serveur, qui l'ajoute à
// ip-camera-store.js). Le QR encode une URL http://<ip-locale>:<port>/...
// — nécessite donc que le serveur soit accessible sur le réseau (voir le
// message d'erreur clair renvoyé sinon par generateCameraPairing côté serveur).
export function generateCameraPairing() {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    showToast('Non connecté au serveur.', 'error');
    return;
  }
  const labelInput = document.getElementById('cameraPairingLabelInput');
  const qualitySelect = document.getElementById('cameraPairingQualitySelect');
  ws.send(
    JSON.stringify({
      action: 'generateCameraPairing',
      label: labelInput ? labelInput.value.trim() : '',
      quality: qualitySelect ? qualitySelect.value : 'medium',
    })
  );
}

export function showCameraPairingQr(message) {
  const box = document.getElementById('cameraPairingBox');
  const img = document.getElementById('cameraPairingQr');
  const expiry = document.getElementById('cameraPairingExpiry');
  if (!box || !img) return;

  img.src = message.qrDataUrl;
  box.style.display = 'block';
  if (expiry && typeof message.expiresInMs === 'number') {
    expiry.textContent = `${Math.round(message.expiresInMs / 60000)} minutes`;
  }
  showToast(
    'QR code généré — scannez-le avec le téléphone dans les minutes qui suivent.',
    'success'
  );
}

window.addIpCamera = addIpCamera;
window.generateCameraPairing = generateCameraPairing;
