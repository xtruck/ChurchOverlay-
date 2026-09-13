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
import { showToast, isTypingContext } from '../utils.js';
import { registerAction } from '../action-delegator.js';

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

// Barre d'espace = confirmer le verset en attente — jamais si l'opérateur
// tape ailleurs (recherche biblique, palette Ctrl+K, champ de message de
// piste…) ni si aucun verset n'est réellement en attente (le bandeau est la
// source de vérité visuelle, pas un booléen dupliqué ici).
document.addEventListener('keydown', (e) => {
  if (e.code !== 'Space' && e.key !== ' ') return;
  if (isTypingContext()) return;
  const banner = document.getElementById('pendingVerseBanner');
  // CORRECTIF (trouvé en écrivant test-multiview-switcher.js — chantier
  // ultime) : la bannière démarre masquée via l'attribut HTML `hidden` (voir
  // dashboard.html), pas `style.display` — qui reste une chaîne VIDE (donc
  // JAMAIS égale à 'none') tant que showPendingVerseBanner()/
  // hidePendingVerseBanner() ci-dessus ne l'ont pas encore touchée au moins
  // une fois. Sur un tableau de bord fraîchement chargé, ce test traitait
  // donc à tort la bannière comme visible : Espace confirmait un verset en
  // attente… qui n'existait pas. offsetParent (null quand display:none
  // s'applique, quelle qu'en soit la cause) reste correct dans tous les cas.
  if (!banner || banner.offsetParent === null) return;
  e.preventDefault();
  confirmPendingVerse();
});

// AJOUT (chantier nettoyage dashboard — purge des onclick inline) : le
// sélecteur "Mode d'Autonomie" du header (dashboard.html) passe désormais
// par data-action/data-target plutôt qu'un onclick="setTrustMode(...)" en
// dur — même fonction, juste un point d'entrée en plus (les 3 boutons
// détaillés de la carte "Mode confiance" continuent d'appeler
// window.setTrustMode() via event-bindings.js#CLICK_BINDINGS, conservé
// ci-dessous pour cette raison).
registerAction('trust-mode', 'set', (el, data) => setTrustMode(data.trustMode));

window.setTrustMode = setTrustMode;
window.confirmPendingVerse = confirmPendingVerse;
window.dismissPendingVerse = dismissPendingVerse;
