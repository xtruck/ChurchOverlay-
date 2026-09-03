/**
 * dashboard/features/companion-link.js — lien vers la page compagnon
 * (companion.html) pour l'assemblée, à coller dans un générateur de QR code.
 * Extrait de dashboard/legacy-core.js (chantier de modularisation).
 */
import { showToast } from '../utils.js';
import { getWsToken } from '../state.js';

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

// AJOUT (intégration MCP) : mcp/church-ws-client.js tourne dans son PROPRE
// process, sans accès à cette page — il a besoin du même jeton opérateur
// que celui déjà présent dans l'URL du tableau de bord (voir getWsToken()
// dans state.js, injecté par main.js via l'option `query` de loadFile).
// On ne fait ici que le rendre copiable, pas une nouvelle génération/canal.
export function copyMcpToken() {
  const token = getWsToken();
  if (!token) {
    showToast('Aucun jeton disponible — redémarrez le tableau de bord.', 'error');
    return;
  }
  navigator.clipboard
    .writeText(token)
    .then(() => {
      showToast('Jeton copié — collez-le dans la configuration MCP (WS_AUTH_TOKEN).', 'success');
    })
    .catch(() => {
      showToast('Copie impossible.', 'error');
    });
}

window.copyMcpToken = copyMcpToken;
