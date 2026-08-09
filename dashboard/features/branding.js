/**
 * dashboard/features/branding.js — habillage caméra (logo +
 * titre/sous-titre), voir branding-store.js et branding-overlay.html
 * côté backend/overlay. Contrairement au reste de la médiathèque, ce
 * n'est PAS une liste — un seul logo, un seul titre/sous-titre actifs à
 * la fois, affichés par-dessus la caméra dans OBS via une Source
 * Navigateur séparée.
 * Extrait de dashboard/legacy-core.js (chantier de modularisation).
 */
import { ws, getHttpOrigin } from '../legacy-core.js';
import { showToast } from '../utils.js';

/* ======================================================================
   Habillage caméra (logo + titre/sous-titre, voir branding-store.js et
   branding-overlay.html). Contrairement au reste de la médiathèque, ce
   n'est PAS une liste — un seul logo, un seul titre/sous-titre actifs à la
   fois, affichés par-dessus la caméra dans OBS via une Source Navigateur
   séparée (voir applyBrandingOverlayUrl() plus haut).
   ====================================================================== */
let brandingState = {
  logoUrl: null,
  position: 'bottom-right',
  title: '',
  subtitle: '',
  visible: false,
};

export function renderBranding(branding) {
  if (!branding) return;
  brandingState = branding;

  // AJOUT (demande explicite — "même vidéo, même GIF") : même logique de
  // bascule <img>/<video> que branding-overlay.html, pour l'aperçu côté
  // tableau de bord.
  const img = document.getElementById('brandingLogoImg');
  const video = document.getElementById('brandingLogoVideo');
  const placeholder = document.getElementById('brandingLogoPlaceholder');
  const isVideo = branding.logoType === 'video';
  const activeEl = isVideo ? video : img;
  const inactiveEl = isVideo ? img : video;
  if (inactiveEl) {
    inactiveEl.style.display = 'none';
    inactiveEl.removeAttribute('src');
  }
  if (activeEl && placeholder) {
    if (branding.logoUrl) {
      const absoluteLogoUrl = branding.logoUrl.startsWith('http')
        ? branding.logoUrl
        : getHttpOrigin() + branding.logoUrl;
      if (activeEl.src !== absoluteLogoUrl) activeEl.src = absoluteLogoUrl;
      activeEl.style.display = 'block';
      placeholder.style.display = 'none';
    } else {
      activeEl.style.display = 'none';
      activeEl.removeAttribute('src');
      placeholder.style.display = 'block';
    }
  }

  const positionSelect = document.getElementById('brandingPositionSelect');
  if (positionSelect && document.activeElement !== positionSelect) {
    positionSelect.value = branding.position || 'bottom-right';
  }
  const sizeSelect = document.getElementById('brandingSizeSelect');
  if (sizeSelect && document.activeElement !== sizeSelect) {
    sizeSelect.value = branding.size || 'medium';
  }

  const titleInput = document.getElementById('brandingTitleInput');
  const subtitleInput = document.getElementById('brandingSubtitleInput');
  // Ne pas écraser ce que l'opérateur est EN TRAIN de taper (un autre
  // tableau de bord ouvert ailleurs pourrait diffuser une mise à jour
  // pendant la saisie) — seulement synchroniser un champ non focus.
  if (titleInput && document.activeElement !== titleInput) titleInput.value = branding.title || '';
  if (subtitleInput && document.activeElement !== subtitleInput) {
    subtitleInput.value = branding.subtitle || '';
  }

  const statusBadge = document.getElementById('brandingStatus');
  const toggleBtn = document.getElementById('brandingVisibleToggleBtn');
  if (statusBadge) {
    statusBadge.textContent = branding.visible ? 'Affiché' : 'Masqué';
    statusBadge.className = 'status-badge ' + (branding.visible ? 'success' : 'warning');
  }
  if (toggleBtn) {
    toggleBtn.textContent = branding.visible ? '🙈 Masquer' : '👁️ Afficher sur la diffusion';
  }
}

export async function pickBrandingLogo() {
  if (!window.churchOverlay || !window.churchOverlay.pickMediaFile) {
    showToast(
      'Le choix de fichier natif n’est disponible que dans l’application ChurchOverlay.',
      'error'
    );
    return;
  }
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    showToast('Non connecté au serveur.', 'error');
    return;
  }
  try {
    const sourcePath = await window.churchOverlay.pickMediaFile();
    if (!sourcePath) return; // sélection annulée par l'opérateur
    ws.send(JSON.stringify({ action: 'setBrandingLogo', sourcePath }));
  } catch (err) {
    showToast(
      'Échec de la sélection du fichier : ' + (err && err.message ? err.message : err),
      'error'
    );
  }
}

export function clearBrandingLogo() {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    showToast('Non connecté au serveur.', 'error');
    return;
  }
  ws.send(JSON.stringify({ action: 'clearBrandingLogo' }));
}

export function onBrandingPositionChange() {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    showToast('Non connecté au serveur.', 'error');
    return;
  }
  const select = document.getElementById('brandingPositionSelect');
  ws.send(
    JSON.stringify({
      action: 'setBrandingPosition',
      position: select ? select.value : 'bottom-right',
    })
  );
}

export function onBrandingSizeChange() {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    showToast('Non connecté au serveur.', 'error');
    return;
  }
  const select = document.getElementById('brandingSizeSelect');
  ws.send(JSON.stringify({ action: 'setBrandingSize', size: select ? select.value : 'medium' }));
}

export function saveBrandingText() {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    showToast('Non connecté au serveur.', 'error');
    return;
  }
  const titleInput = document.getElementById('brandingTitleInput');
  const subtitleInput = document.getElementById('brandingSubtitleInput');
  ws.send(
    JSON.stringify({
      action: 'setBrandingText',
      title: titleInput ? titleInput.value.trim() : '',
      subtitle: subtitleInput ? subtitleInput.value.trim() : '',
    })
  );
  showToast('Texte enregistré.', 'success');
}

export function toggleBrandingVisible() {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    showToast('Non connecté au serveur.', 'error');
    return;
  }
  ws.send(JSON.stringify({ action: 'setBrandingVisible', visible: !brandingState.visible }));
}

window.pickBrandingLogo = pickBrandingLogo;
window.clearBrandingLogo = clearBrandingLogo;
window.onBrandingPositionChange = onBrandingPositionChange;
window.onBrandingSizeChange = onBrandingSizeChange;
window.saveBrandingText = saveBrandingText;
window.toggleBrandingVisible = toggleBrandingVisible;
