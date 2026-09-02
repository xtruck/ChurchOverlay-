/**
 * dashboard/features/focus-mode.js — "Focus Mode" (brief produit,
 * priorité #6) : masque tout sauf ce qui compte pendant le moment le plus
 * critique du culte — ce qui est réellement à l'écran, le prochain repère,
 * un geste "Aller en direct" à un clic, les urgences (tout effacer/écran
 * noir), et le statut de connexion.
 *
 * Réutilise délibérément l'existant plutôt que de dupliquer :
 * - Aperçu "en direct" : EXACTEMENT le même rendu que la colonne "en
 *   direct" du sas de diffusion (voir renderContentPreview()/getCurrentLive()
 *   dans airlock-preview.js) — jamais une seconde implémentation qui
 *   pourrait diverger de ce que montre le reste de l'app.
 * - "Aller en direct" appelle nextRundownCue() (rundown.js), le même chemin
 *   que le bouton "▶ Suivant" de la feuille de route elle-même.
 * - "Tout effacer"/"Écran noir" appellent ppClearAll()/toggleBlackScreen(),
 *   déjà les vrais boutons d'urgence de l'app (voir Smart Fallback Mode et
 *   le raccourci F1/Échap de propresenter-studio.js) — pas de troisième
 *   variante d'"urgence".
 * - Statut de connexion : la même classe `.status`/`.status-dot`+`<span>`
 *   que le reste de l'app (voir updateStatus() dans
 *   verse-session-display.js, qui cible déjà TOUT élément `.status` sur la
 *   page via querySelectorAll) — se met à jour tout seul, sans code
 *   spécifique à ce module.
 *
 * Rafraîchi par un simple intervalle pendant que le mode est actif (voir
 * tick() plus bas) plutôt que branché sur chaque diffusion WS individuelle
 * (showVerse/showMedia/showScene/rundownUpdated...) — cette vue est
 * volontairement secondaire/à basse fréquence d'interaction (l'opérateur la
 * regarde, il n'y clique pas à chaque frappe), un délai d'une seconde est
 * imperceptible et évite d'ajouter six points de couplage supplémentaires
 * dans ws-dispatch.js pour un gain invisible à l'œil.
 *
 * Pas de raccourci Échap pour quitter : propresenter-studio.js traite déjà
 * Échap comme F1 (ppClearAll()) au niveau de la fenêtre entière — ajouter un
 * second écouteur Échap ici créerait une interaction fragile entre les deux
 * (lequel gagne, dans quel ordre) pour un gain marginal face au bouton
 * "Quitter" déjà visible en permanence.
 */
import { renderContentPreview, getCurrentLive } from './airlock-preview.js';
import { getRundownCues, getRundownActiveIndex, nextRundownCue } from './rundown.js';
import { ppClearAll } from './propresenter-studio.js';
import { toggleBlackScreen } from './verse-session-display.js';

const CUE_TYPE_ICON = { verse: '📖', media: '📷', scene: '🎬' };

let overlay = null;
let livePreviewEl = null;
let nextCueEl = null;
let goLiveBtn = null;
let clockEl = null;
let tickTimer = null;
let active = false;

function createOverlay() {
  overlay = document.createElement('div');
  overlay.id = 'focusModeOverlay';
  overlay.className = 'focus-mode-overlay';
  overlay.innerHTML = `
    <div class="focus-mode-header">
      <span class="status live-status-pill">
        <span class="status-dot"></span><span>Connecté</span>
      </span>
      <span class="focus-mode-clock" id="focusModeClock"></span>
      <button type="button" class="btn btn-secondary chip-sm" id="focusModeExitBtn">✕ Quitter le mode focus</button>
    </div>
    <div class="focus-mode-body">
      <div class="focus-mode-panel">
        <div class="focus-mode-panel-label">En direct maintenant</div>
        <div class="focus-mode-preview-frame" id="focusModeLivePreview"></div>
      </div>
      <div class="focus-mode-panel">
        <div class="focus-mode-panel-label">Prochain repère</div>
        <div class="focus-mode-next-cue" id="focusModeNextCue"></div>
        <button type="button" class="btn btn-primary btn-full-width" id="focusModeGoLiveBtn">▶ Aller en direct</button>
      </div>
    </div>
    <div class="focus-mode-emergency">
      <button type="button" class="btn btn-danger" id="focusModeClearAllBtn">⏹ Tout effacer</button>
      <button type="button" class="btn btn-secondary" id="focusModeBlackScreenBtn">⬛ Écran noir</button>
    </div>
  `;
  document.body.appendChild(overlay);

  livePreviewEl = overlay.querySelector('#focusModeLivePreview');
  nextCueEl = overlay.querySelector('#focusModeNextCue');
  goLiveBtn = overlay.querySelector('#focusModeGoLiveBtn');
  clockEl = overlay.querySelector('#focusModeClock');

  overlay.querySelector('#focusModeExitBtn').addEventListener('click', toggleFocusMode);
  goLiveBtn.addEventListener('click', () => nextRundownCue());
  overlay.querySelector('#focusModeClearAllBtn').addEventListener('click', () => ppClearAll());
  overlay
    .querySelector('#focusModeBlackScreenBtn')
    .addEventListener('click', () => toggleBlackScreen());
}

function renderNextCue() {
  const cues = getRundownCues();
  const next = cues[getRundownActiveIndex() + 1];
  if (!next) {
    nextCueEl.textContent =
      cues.length === 0 ? 'Feuille de route vide.' : 'Fin de la feuille de route.';
    goLiveBtn.disabled = true;
    return;
  }
  nextCueEl.textContent = `${CUE_TYPE_ICON[next.type] || ''} ${next.label}`;
  goLiveBtn.disabled = false;
}

function tick() {
  renderContentPreview(livePreviewEl, getCurrentLive());
  renderNextCue();
  clockEl.textContent = new Date().toLocaleTimeString('fr-FR', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function toggleFocusMode() {
  if (!overlay) createOverlay();
  active = !active;
  overlay.classList.toggle('active', active);
  if (active) {
    tick();
    tickTimer = setInterval(tick, 1000);
  } else if (tickTimer) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
}

window.toggleFocusMode = toggleFocusMode;
