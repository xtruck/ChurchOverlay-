/**
 * dashboard/features/ip-camera-feed.js — grille des caméras IP déjà
 * ajoutées (flux MJPEG réseau, voir ip-camera-store.js côté backend) :
 * vignettes vivantes + surveillance de connexion + actions par caméra
 * (copier le lien OBS, supprimer). Regardée pendant le culte pour
 * surveiller un second angle de caméra — Operator-essential.
 *
 * Distinct de ip-cameras.js (jumelage/ajout d'une NOUVELLE caméra — QR code
 * ou formulaire manuel), qui reste une tâche de configuration, pas de
 * direct (redesign IA — étape 2, scission live/config du fichier
 * dashboard/features/ip-cameras.js d'origine, voir
 * DASHBOARD-IA-REDESIGN-PROPOSAL.md, question ouverte 2).
 */
import { state, ws } from '../state.js';
import { showToast, escapeHtmlDashboard, copyToClipboard } from '../utils.js';
import { updateNetworkStatusStrip } from './status-strip.js';
import { registerAction } from '../action-delegator.js';

// AJOUT (redesign — pas d'emoji comme icône structurelle) : remplace les
// 📋/✕ littéraux ci-dessous — même presse-papiers déjà posé ailleurs
// (dashboard.html, "Copier le lien pour OBS").
const ICON_COPY =
  '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="8" y="2" width="8" height="4" rx="1"></rect><path d="M9 4H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-3"></path></svg>';
const ICON_REMOVE =
  '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"></path></svg>';

let ipCameraItems = [];
const ipCameraMonitors = {}; // id -> intervalId, nettoyés à chaque ré-rendu

export function renderIpCameras(items) {
  ipCameraItems = Array.isArray(items) ? items : [];
  const list = document.getElementById('ipCameraList');
  const countEl = document.getElementById('ipCameraCount');
  if (countEl) countEl.textContent = ipCameraItems.length;
  state.ipCameraCount = ipCameraItems.length;
  updateNetworkStatusStrip();
  if (!list) return;

  // Le ré-rendu détruit les <img>/badges existants : on arrête d'abord tout
  // minuteur de reconnexion en cours pour ne pas en accumuler à chaque mise
  // à jour de la liste (ajout/suppression d'une autre caméra, etc.).
  Object.values(ipCameraMonitors).forEach((timerId) => clearInterval(timerId));
  for (const key of Object.keys(ipCameraMonitors)) delete ipCameraMonitors[key];

  if (ipCameraItems.length === 0) {
    list.innerHTML = '<div class="empty-state-note">Aucune caméra de téléphone ajoutée.</div>';
    return;
  }

  list.innerHTML = ipCameraItems
    .map(
      (item) => `
                <div class="queue-item">
                    <div class="camera-thumb-wrap">
                        <img id="ipcam-img-${item.id}" alt="">
                    </div>
                    <div class="media-item-info">
                        <div class="media-item-label">${escapeHtmlDashboard(item.label)}</div>
                        <span id="ipcam-status-${item.id}" class="status-badge warning">Connexion…</span>
                    </div>
                    <div class="queue-item-actions">
                        <button class="queue-icon-btn" data-action="copy" data-target="ip-camera" data-id="${item.id}" title="Copier le lien pour OBS">${ICON_COPY}</button>
                        <button class="queue-icon-btn queue-remove" data-action="delete" data-target="ip-camera" data-id="${item.id}" title="Supprimer">${ICON_REMOVE}</button>
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

function deleteIpCameraItem(id) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    showToast('Non connecté au serveur.', 'error');
    return;
  }
  ws.send(JSON.stringify({ action: 'deleteIpCamera', id }));
}

function copyIpCameraUrl(id) {
  const item = ipCameraItems.find((c) => c.id === id);
  if (!item) return;
  copyToClipboard(item.url)
    .then(() => showToast('Lien copié — collez-le dans une Source Navigateur OBS.', 'success'))
    .catch(() => showToast(item.url, 'info'));
}

// AJOUT (chantier nettoyage dashboard — purge des onclick inline) : les
// deux boutons d'action par caméra (copier/supprimer) passent désormais
// par data-action/data-target — plus d'appelant restant pour les exposer
// bruts sur window.
registerAction('ip-camera', 'copy', (el, data) => copyIpCameraUrl(data.id));
registerAction('ip-camera', 'delete', (el, data) => deleteIpCameraItem(data.id));
