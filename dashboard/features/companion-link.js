/**
 * dashboard/features/companion-link.js — lien vers la page compagnon
 * (companion.html) pour l'assemblée, à coller dans un générateur de QR code.
 * Extrait de dashboard/legacy-core.js (chantier de modularisation).
 */
import { showToast } from '../utils.js';

(function initCompanionLink() {
  const link = document.getElementById('companionLink');
  if (!link) return;
  const url = window.location.origin + '/companion';
  link.href = url;
  link.textContent = url;
})();

export function copyCompanionLink() {
  const url = window.location.origin + '/companion';
  navigator.clipboard
    .writeText(url)
    .then(() => {
      showToast('Lien copié — collez-le dans un générateur de QR code.', 'success');
    })
    .catch(() => {
      showToast('Copie impossible — sélectionnez le lien manuellement.', 'error');
    });
}

window.copyCompanionLink = copyCompanionLink;
