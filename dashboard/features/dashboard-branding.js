/**
 * dashboard/features/dashboard-branding.js — identité de marque du TABLEAU
 * DE BORD lui-même (nom d'organisation, couleur d'accent, logo dans la
 * barre latérale) — voir dashboard-branding-store.js côté serveur pour la
 * distinction avec l'habillage caméra (dashboard/features/branding.js) et
 * le thème de l'overlay de projection (mood-theme.js). Pensé pour la
 * revente de l'app comme produit "clé en main" — chaque installation peut
 * porter le nom/la couleur/le logo de son organisation.
 */
import { ws, getHttpOrigin } from '../state.js';
import { showToast } from '../utils.js';

// CORRECTIF (redesign — direction "console de diffusion") : ce repli était
// resté sur l'ancien violet (#7c8cf5) après le changement de --primary dans
// dashboard.css (:root) — dashboard-branding.js écrase --primary en style
// inline sur <html> à CHAQUE connexion (même sans accentColor configuré côté
// serveur), qui gagne toujours sur la valeur de la feuille de style. Un
// nouvel utilisateur sans branding personnalisé voyait donc l'ancienne
// couleur malgré le nouveau thème.
const DEFAULT_ACCENT_COLOR = '#ff8a3d';

export function applyDashboardBranding(branding) {
  if (!branding) return;

  const titleEl = document.getElementById('brandTitle');
  if (titleEl) titleEl.textContent = branding.organizationName || 'ChurchOverlay';

  // AJOUT : --primary est la seule variable à écraser pour rebrander tout
  // l'outil — dashboard.css dérive --primary-hover/--primary-300/600/700
  // et les alias --gold/--garnet/--sapphire-*soft via color-mix() à partir
  // de cette valeur, donc tout le système de tons suit automatiquement.
  // CORRECTIF (thème "cabine-mono") : un style inline sur <html> gagne
  // TOUJOURS sur n'importe quelle règle de feuille de style, aussi
  // spécifique soit-elle (voir :root[data-theme="cabine-mono"] dans
  // dashboard.css) — sans cette garde, la couleur d'accent de
  // l'organisation continuerait de percer à travers un thème dont le but
  // est justement de n'avoir AUCUNE couleur. Seule exception à "le CSS
  // gère tout" dans ce fichier, imposée par cette contrainte de
  // spécificité, pas par choix.
  if (document.documentElement.dataset.theme !== 'cabine-mono') {
    document.documentElement.style.setProperty(
      '--primary',
      branding.accentColor || DEFAULT_ACCENT_COLOR
    );
  }

  const defaultIcon = document.getElementById('brandIconDefault');
  const logoImg = document.getElementById('brandLogoImg');
  if (logoImg && defaultIcon) {
    if (branding.logoUrl) {
      const absoluteUrl = branding.logoUrl.startsWith('http')
        ? branding.logoUrl
        : getHttpOrigin() + branding.logoUrl;
      if (logoImg.src !== absoluteUrl) logoImg.src = absoluteUrl;
      logoImg.style.display = 'block';
      defaultIcon.style.display = 'none';
    } else {
      logoImg.style.display = 'none';
      logoImg.removeAttribute('src');
      defaultIcon.style.display = 'flex';
    }
  }

  // Synchronise le panneau de réglages (Réglages -> Identité de la marque)
  // sans écraser un champ en cours de saisie — un autre tableau de bord
  // ouvert ailleurs pourrait diffuser une mise à jour pendant la frappe.
  const orgNameInput = document.getElementById('dashboardOrgNameInput');
  if (orgNameInput && document.activeElement !== orgNameInput) {
    orgNameInput.value = branding.organizationName || '';
  }
  const accentColorInput = document.getElementById('dashboardAccentColorInput');
  if (accentColorInput && document.activeElement !== accentColorInput) {
    accentColorInput.value = branding.accentColor || DEFAULT_ACCENT_COLOR;
  }
}

export function saveDashboardOrgName() {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    showToast('Non connecté au serveur.', 'error');
    return;
  }
  const input = document.getElementById('dashboardOrgNameInput');
  ws.send(
    JSON.stringify({
      action: 'setDashboardOrgName',
      organizationName: input ? input.value.trim() : '',
    })
  );
  showToast('Nom d’organisation enregistré.', 'success');
}

export function saveDashboardAccentColor() {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    showToast('Non connecté au serveur.', 'error');
    return;
  }
  const input = document.getElementById('dashboardAccentColorInput');
  ws.send(
    JSON.stringify({
      action: 'setDashboardAccentColor',
      accentColor: input ? input.value : DEFAULT_ACCENT_COLOR,
    })
  );
}

export async function pickDashboardLogo() {
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
    ws.send(JSON.stringify({ action: 'setDashboardLogo', sourcePath }));
  } catch (err) {
    showToast(
      'Échec de la sélection du fichier : ' + (err && err.message ? err.message : err),
      'error'
    );
  }
}

export function clearDashboardLogo() {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    showToast('Non connecté au serveur.', 'error');
    return;
  }
  ws.send(JSON.stringify({ action: 'clearDashboardLogo' }));
}

window.saveDashboardOrgName = saveDashboardOrgName;
window.saveDashboardAccentColor = saveDashboardAccentColor;
window.pickDashboardLogo = pickDashboardLogo;
window.clearDashboardLogo = clearDashboardLogo;
