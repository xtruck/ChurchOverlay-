/**
 * dashboard/features/network-settings.js — carte "Réseau (caméra
 * téléphone par QR)" : WS_HOST + statut du jeton WS. Décorrélée du gros
 * panneau Clés API (api-settings.js) — un seul champ à lire/écrire, pas
 * besoin de partager son état interne. WS_AUTH_TOKEN/WS_VIEWER_TOKEN ne
 * se configurent pas ici — ensureWsToken() (main.js) les génère et les
 * persiste déjà tout seul ; cette carte n'en affiche que le statut.
 * Extrait de dashboard/legacy-core.js (chantier de modularisation).
 */
import { state, ws } from '../state.js';
import { showToast } from '../utils.js';
import { updateNetworkStatusStrip } from './status-strip.js';

/* ======================================================================
   Réseau (WS_HOST + statut du jeton WS) — carte "Réseau (caméra téléphone
   par QR)". Décorrélée du gros panneau Clés API (initApiSettingsPanel) :
   un seul champ à lire/écrire, pas besoin de partager son état interne.
   WS_AUTH_TOKEN/WS_VIEWER_TOKEN ne se configurent pas ici — ensureWsToken()
   (main.js) les génère et les persiste déjà tout seul ; cette carte n'en
   affiche que le statut (voir renderNetworkStatus(), alimentée par l'action
   WS 'getNetworkStatus').
   ====================================================================== */
let suggestedLanIp = null;

export async function initNetworkCard() {
  if (!window.churchOverlay || !window.churchOverlay.getSettings) return;
  try {
    const settings = await window.churchOverlay.getSettings();
    suggestedLanIp = settings.suggestedLanIp || null;
    const input = document.getElementById('networkWsHostInput');
    if (input && !input.value && settings.wsHost) {
      input.value = settings.wsHost;
    }
  } catch (e) {
    console.error('Impossible de lire les réglages réseau :', e);
  }
}

export function useSuggestedLanIp() {
  const input = document.getElementById('networkWsHostInput');
  if (!input) return;
  if (!suggestedLanIp) {
    showToast(
      'Aucune adresse réseau détectée sur ce PC — vérifiez que le Wi-Fi/Ethernet est actif.',
      'error'
    );
    return;
  }
  input.value = suggestedLanIp;
}

export function saveNetworkSettings() {
  const input = document.getElementById('networkWsHostInput');
  const value = input ? input.value.trim() : '';
  if (!value) {
    showToast('Renseignez une adresse réseau.', 'error');
    return;
  }
  if (!window.churchOverlay || !window.churchOverlay.saveNetworkSettings) {
    showToast("Réglage réseau indisponible hors de l'application ChurchOverlay.", 'error');
    return;
  }
  window.churchOverlay
    .saveNetworkSettings(value)
    .then(() => {
      showToast('Adresse réseau enregistrée — redémarrage du serveur…', 'success');
      // Le worker redémarre côté main.js (voir save-network-settings) ; la
      // reconnexion WS déclenchera un nouveau 'getNetworkStatus' via
      // ws.onopen, mais on redemande aussi explicitement après un court
      // délai au cas où la reconnexion serait plus lente que ce délai.
      setTimeout(requestNetworkStatus, 2500);
    })
    .catch((err) =>
      showToast("Échec de l'enregistrement : " + (err && err.message ? err.message : err), 'error')
    );
}

export function requestNetworkStatus() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ action: 'getNetworkStatus' }));
  }
}

export function renderNetworkStatus(message) {
  const badge = document.getElementById('networkQrReadyBadge');
  const currentHost = document.getElementById('networkCurrentHost');
  const tokenStatus = document.getElementById('networkTokenStatus');
  if (badge) {
    badge.textContent = message.qrCameraReady ? 'Prêt' : 'Indisponible';
    badge.className = 'status-badge ' + (message.qrCameraReady ? 'success' : 'warning');
  }
  state.qrCameraReady = !!message.qrCameraReady;
  updateNetworkStatusStrip();
  if (currentHost) {
    currentHost.textContent = message.qrCameraReady
      ? message.wsHost
      : `${message.wsHost} (local uniquement)`;
  }
  if (tokenStatus) {
    tokenStatus.textContent = message.wsAuthEnabled
      ? 'généré automatiquement ✓'
      : 'non disponible ⚠️';
  }
}

initNetworkCard();

window.useSuggestedLanIp = useSuggestedLanIp;
window.saveNetworkSettings = saveNetworkSettings;
