/**
 * dashboard/features/branding.js — habillage caméra (logo +
 * titre/sous-titre), voir branding-store.js et branding-overlay.html
 * côté backend/overlay. Contrairement au reste de la médiathèque, ce
 * n'est PAS une liste — un seul logo, un seul titre/sous-titre actifs à
 * la fois, affichés par-dessus la caméra dans OBS via une Source
 * Navigateur séparée.
 * Extrait de dashboard/legacy-core.js (chantier de modularisation).
 */
import { ws, getHttpOrigin } from '../state.js';
import { showToast } from '../utils.js';

// AJOUT (redesign — pas d'emoji comme icône structurelle) : brandingVisibleToggleBtn
// basculait son texte entre deux emoji littéraux (🙈/👁️) via .textContent —
// remplacé par ces deux marquages SVG statiques (chaînes fixes, jamais de
// contenu utilisateur : innerHTML sans risque ici), même déclenchement.
const EYE_OFF_SVG =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M3 3l18 18"></path><path d="M10.6 5.2A10.4 10.4 0 0 1 12 5c7 0 11 7 11 7a13.2 13.2 0 0 1-3.4 4M6.6 6.6C3.7 8.4 1 12 1 12s4 7 11 7a10.5 10.5 0 0 0 4.2-.9"></path><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"></path></svg> Masquer';
const EYE_ON_SVG =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"></path><circle cx="12" cy="12" r="3"></circle></svg> Afficher sur la diffusion';

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
    toggleBtn.innerHTML = branding.visible ? EYE_OFF_SVG : EYE_ON_SVG;
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
