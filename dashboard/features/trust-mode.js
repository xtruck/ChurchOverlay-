/**
 * dashboard/features/trust-mode.js — Mode confiance (Partie 2 : un
 * bénévole débutant commence en manuel et gagne en confiance
 * progressivement). Trois niveaux, voir action-registry.js/session-state.js :
 *   - 'auto'      : verset détecté automatiquement affiché directement
 *                   (comportement historique, défaut).
 *   - 'semi-auto' : le verset détecté reste en attente jusqu'à confirmation
 *                   opérateur (barre d'espace, ou bouton "Confirmer").
 *   - 'manual'    : idem semi-auto (détection jamais auto-affichée), sans
 *                   nudge visuel appuyé — la détection automatique reste
 *                   purement informative, tout affichage réel passe par les
 *                   chemins manuels existants (recherche, palette, voix).
 *
 * server.js diffuse 'pendingVerseConfirmation' (verset détecté, en attente)
 * et 'pendingVerseDismissed' (abandonné ou remplacé) — ce module se contente
 * d'afficher/masquer le bandeau et de relayer les actions opérateur, aucune
 * logique de décision ici (elle vit entièrement côté serveur, pour ne
 * jamais dépendre de l'état d'un onglet dashboard particulier).
 */
import { ws } from '../state.js';
import { showToast } from '../utils.js';

export function setTrustMode(mode) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    showToast('Non connecté au serveur — impossible de changer le mode confiance.', 'error');
    return;
  }
  ws.send(JSON.stringify({ action: 'setTrustMode', mode }));
}

export function updateTrustModeButtons(mode) {
  document.querySelectorAll('.trust-mode-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.trustMode === mode);
  });
}

export function confirmPendingVerse() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ action: 'confirmPendingVerse' }));
}

export function dismissPendingVerse() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ action: 'dismissPendingVerse' }));
}

export function showPendingVerseBanner(message) {
  const banner = document.getElementById('pendingVerseBanner');
  const textEl = document.getElementById('pendingVerseText');
  if (!banner || !textEl) return;
  textEl.textContent = `Verset détecté : ${message.reference} — confirmation requise avant affichage.`;
  banner.style.display = 'flex';
}

export function hidePendingVerseBanner() {
  const banner = document.getElementById('pendingVerseBanner');
  if (banner) banner.style.display = 'none';
}

function isTypingContext() {
  const el = document.activeElement;
  if (!el) return false;
  const tag = (el.tagName || '').toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable;
}

// Barre d'espace = confirmer le verset en attente — jamais si l'opérateur
// tape ailleurs (recherche biblique, palette Ctrl+K, champ de message de
// piste…) ni si aucun verset n'est réellement en attente (le bandeau est la
// source de vérité visuelle, pas un booléen dupliqué ici).
document.addEventListener('keydown', (e) => {
  if (e.code !== 'Space' && e.key !== ' ') return;
  if (isTypingContext()) return;
  const banner = document.getElementById('pendingVerseBanner');
  if (!banner || banner.style.display === 'none') return;
  e.preventDefault();
  confirmPendingVerse();
});

window.setTrustMode = setTrustMode;
window.confirmPendingVerse = confirmPendingVerse;
window.dismissPendingVerse = dismissPendingVerse;
