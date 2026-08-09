/**
 * dashboard/features/ip-cameras.js — caméras IP (téléphones), flux
 * MJPEG réseau, voir ip-camera-store.js côté backend. Distinct de
 * camera-panel.js : pas de navigator.mediaDevices ici — un <img>
 * pointé directement sur l'URL du flux réseau. Chromium affiche
 * nativement un flux MJPEG (multipart/x-mixed-replace) comme une image
 * "vivante", sans librairie ni décodage vidéo ajouté.
 * Extrait de dashboard/legacy-core.js (chantier de modularisation).
 */
import { ws } from '../state.js';
import { showToast, escapeHtmlDashboard } from '../utils.js';

/* ======================================================================
   Caméras de téléphone (flux MJPEG réseau, voir ip-camera-store.js).
   Distinct de camera-capture.js : pas de navigator.mediaDevices ici — un
   <img> pointé directement sur l'URL du flux réseau. Chromium affiche
   nativement un flux MJPEG (multipart/x-mixed-replace) comme une image
   "vivante", sans librairie ni décodage vidéo ajouté ici. Fonctionne aussi
   en mode "serveur seul" navigateur (pas de dépendance Electron/IPC,
   contrairement au panneau webcam ci-dessus).
   ====================================================================== */
let ipCameraItems = [];
const ipCameraMonitors = {}; // id -> intervalId, nettoyés à chaque ré-rendu

export function renderIpCameras(items) {
  ipCameraItems = Array.isArray(items) ? items : [];
  const list = document.getElementById('ipCameraList');
  const countEl = document.getElementById('ipCameraCount');
  if (countEl) countEl.textContent = ipCameraItems.length;
  if (!list) return;

  // Le ré-rendu détruit les <img>/badges existants : on arrête d'abord tout
  // minuteur de reconnexion en cours pour ne pas en accumuler à chaque mise
  // à jour de la liste (ajout/suppression d'une autre caméra, etc.).
  Object.values(ipCameraMonitors).forEach((timerId) => clearInterval(timerId));
  for (const key of Object.keys(ipCameraMonitors)) delete ipCameraMonitors[key];

  if (ipCameraItems.length === 0) {
    list.innerHTML =
      '<div style="font-size:0.8rem; color:var(--text-dim); padding: 0.5rem 0;">Aucune caméra de téléphone ajoutée.</div>';
    return;
  }

  list.innerHTML = ipCameraItems
    .map(
      (item) => `
                <div class="queue-item">
                    <div style="width:120px; height:68px; background:#000; border-radius:6px; overflow:hidden; flex-shrink:0;">
                        <img id="ipcam-img-${item.id}" style="width:100%; height:100%; object-fit:cover;" alt="">
                    </div>
                    <div class="media-item-info">
                        <div class="media-item-label">${escapeHtmlDashboard(item.label)}</div>
                        <span id="ipcam-status-${item.id}" class="status-badge warning">Connexion…</span>
                    </div>
                    <div class="queue-item-actions">
                        <button class="queue-icon-btn" onclick="copyIpCameraUrl('${item.id}')" title="Copier le lien pour OBS">📋</button>
                        <button class="queue-icon-btn queue-remove" onclick="deleteIpCameraItem('${item.id}')" title="Supprimer">✕</button>
                    </div>
                </div>
            `
    )
    .join('');

  for (const item of ipCameraItems) {
    startIpCameraMonitor(item.id, item.url);
  }
}

export function startIpCameraMonitor(id, url) {
  const img = document.getElementById(`ipcam-img-${id}`);
  const badge = document.getElementById(`ipcam-status-${id}`);
  if (!img || !badge) return;

  function markOnline() {
    badge.textContent = 'En ligne';
    badge.className = 'status-badge success';
  }
  function markOffline() {
    badge.textContent = 'Hors ligne';
    badge.className = 'status-badge error';
  }

  img.onload = markOnline;
  img.onerror = markOffline;
  img.src = url;

  // CORRECTIF (fiabilité — "En ligne" pouvait rester affiché indéfiniment
  // pour une caméra morte) : un flux MJPEG dont la connexion reste ouverte
  // sans plus jamais pousser d'image ne redéclenche ni onload ni onerror —
  // l'ancien code ne rechargeait QUE si déjà en erreur, donc un téléphone
  // qui perd le Wi-Fi/verrouille son écran en plein culte restait marqué
  // "En ligne" jusqu'à ce que l'opérateur s'en aperçoive autrement. On
  // recharge maintenant PÉRIODIQUEMENT, que le badge soit vert ou rouge —
  // pour une caméra téléphone jumelée par QR, le serveur refuse désormais
  // de répondre si l'image n'est plus fraîche (voir isFrameFresh côté
  // server.js), ce qui fait légitimement échouer ce rechargement et
  // corrige le badge ; pour une caméra IP tierce, une vraie coupure réseau
  // échoue tout aussi légitimement.
  ipCameraMonitors[id] = setInterval(() => {
    img.src = url + (url.includes('?') ? '&' : '?') + '_retry=' + Date.now();
  }, 12000);
}

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

export function deleteIpCameraItem(id) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    showToast('Non connecté au serveur.', 'error');
    return;
  }
  ws.send(JSON.stringify({ action: 'deleteIpCamera', id }));
}

export function copyIpCameraUrl(id) {
  const item = ipCameraItems.find((c) => c.id === id);
  if (!item) return;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard
      .writeText(item.url)
      .then(() => showToast('Lien copié — collez-le dans une Source Navigateur OBS.', 'success'))
      .catch(() => showToast(item.url, 'info'));
  } else {
    showToast(item.url, 'info');
  }
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
window.deleteIpCameraItem = deleteIpCameraItem;
window.copyIpCameraUrl = copyIpCameraUrl;
window.generateCameraPairing = generateCameraPairing;
