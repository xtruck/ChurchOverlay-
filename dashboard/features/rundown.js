/**
 * dashboard/features/rundown.js — feuille de route (rundown/cue-list,
 * chantier 4.3).
 *
 * Distinct de verse-queue.js (file d'attente de VERSETS seulement, locale
 * au navigateur, perdue au rechargement) : ici, mixte (verset/média/scène)
 * et PERSISTÉ côté serveur (rundown-store.js) — préparé à l'avance, survit
 * à un rechargement du tableau de bord et reste synchronisé entre plusieurs
 * postes opérateur. Les repères média/scène s'ajoutent depuis leurs propres
 * galeries (media-library.js/scene-studio.js, bouton "➕ Feuille de route"),
 * les repères verset s'ajoutent directement depuis la carte ci-dessous —
 * même style d'ajout que verse-queue.js#addToQueue.
 *
 * Réutilise délibérément les classes .queue-item/.queue-icon-btn déjà
 * stylées pour verse-queue.js — même nature d'UI (liste ordonnée de repères
 * qu'on ajoute/retire/déclenche un par un), pas de nouveau système visuel.
 */
import { ws } from '../state.js';
import { showToast, escapeHtmlDashboard } from '../utils.js';

let rundownCues = [];
let rundownActiveIndex = -1;

const CUE_TYPE_ICON = { verse: '📖', media: '📷', scene: '🎬' };

export function addVerseToRundown() {
  const input = document.getElementById('rundownRefInput');
  const reference = input ? input.value.trim() : '';
  if (!reference) return;
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    showToast('Non connecté au serveur — impossible d’ajouter à la feuille de route.', 'error');
    return;
  }
  ws.send(JSON.stringify({ action: 'addRundownCue', type: 'verse', label: reference, reference }));
  if (input) input.value = '';
}

/**
 * Appelée depuis media-library.js/scene-studio.js (bouton "➕ Feuille de
 * route" de chaque élément de galerie) — un seul point d'entrée générique
 * pour les deux types, plutôt qu'une fonction dupliquée par type.
 * @param {'media'|'scene'} type
 * @param {string} id
 * @param {string} label
 */
export function addToRundown(type, id, label) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    showToast('Non connecté au serveur — impossible d’ajouter à la feuille de route.', 'error');
    return;
  }
  const payload = { action: 'addRundownCue', type, label };
  if (type === 'media') payload.mediaId = id;
  else payload.sceneId = id;
  ws.send(JSON.stringify(payload));
  showToast(`« ${label} » ajouté à la feuille de route.`, 'success');
}

export function removeRundownCue(id) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ action: 'removeRundownCue', id }));
}

export function moveRundownCue(id, direction) {
  const idx = rundownCues.findIndex((c) => c.id === id);
  const target = idx + direction;
  if (idx === -1 || target < 0 || target >= rundownCues.length) return;
  const reordered = rundownCues.map((c) => c.id);
  [reordered[idx], reordered[target]] = [reordered[target], reordered[idx]];
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ action: 'reorderRundownCues', orderedIds: reordered }));
}

export function triggerRundownCue(id) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    showToast('Non connecté au serveur.', 'error');
    return;
  }
  ws.send(JSON.stringify({ action: 'triggerRundownCue', id }));
}

export function nextRundownCue() {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    showToast('Non connecté au serveur.', 'error');
    return;
  }
  ws.send(JSON.stringify({ action: 'nextRundownCue' }));
}

export function clearRundown() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  if (rundownCues.length === 0) return;
  if (!window.confirm('Vider toute la feuille de route ? Cette action est irréversible.')) return;
  ws.send(JSON.stringify({ action: 'clearRundown' }));
}

/**
 * Message rundownActiveCue — contrairement à rundownUpdated, ne transporte
 * pas la liste complète des repères (juste id/index du repère qui vient
 * d'être déclenché). renderRundown() garde déjà rundownCues à jour (aucune
 * mutation de la LISTE elle-même par triggerRundownCue/nextRundownCue côté
 * serveur, seul le pointeur "actif" change) — on se contente donc de mettre
 * ce pointeur à jour et de redessiner, sans aller rechercher la liste.
 */
export function applyRundownActiveCue(message) {
  rundownActiveIndex = typeof message.index === 'number' ? message.index : -1;
  renderRundown({ cues: rundownCues, activeIndex: rundownActiveIndex });
}

export function renderRundown(message) {
  rundownCues = Array.isArray(message.cues) ? message.cues : [];
  rundownActiveIndex = typeof message.activeIndex === 'number' ? message.activeIndex : -1;

  const countEl = document.getElementById('rundownCount');
  if (countEl) countEl.textContent = rundownCues.length;
  const list = document.getElementById('rundownList');
  if (!list) return;

  if (rundownCues.length === 0) {
    list.innerHTML =
      '<div class="empty-state-note">Feuille de route vide. Ajoutez une référence ci-dessus, ou depuis la Médiathèque/le Studio de scènes.</div>';
    return;
  }

  list.innerHTML = rundownCues
    .map((cue, i) => {
      const isActive = i === rundownActiveIndex;
      return `
                <div class="queue-item${isActive ? ' is-active-rundown-cue' : ''}">
                    <span class="queue-item-position">${i + 1}</span>
                    <span class="queue-item-ref" title="${escapeHtmlDashboard(cue.label)}">${CUE_TYPE_ICON[cue.type] || ''} ${escapeHtmlDashboard(cue.label)}</span>
                    <div class="queue-item-actions">
                        <button class="queue-icon-btn" onclick="moveRundownCue('${cue.id}', -1)" title="Monter" ${i === 0 ? 'disabled' : ''}>↑</button>
                        <button class="queue-icon-btn" onclick="moveRundownCue('${cue.id}', 1)" title="Descendre" ${i === rundownCues.length - 1 ? 'disabled' : ''}>↓</button>
                        <button class="queue-icon-btn queue-send" onclick="triggerRundownCue('${cue.id}')" title="Déclencher maintenant">▶</button>
                        <button class="queue-icon-btn queue-remove" onclick="removeRundownCue('${cue.id}')" title="Retirer">✕</button>
                    </div>
                </div>
            `;
    })
    .join('');
}

window.addVerseToRundown = addVerseToRundown;
window.addToRundown = addToRundown;
window.removeRundownCue = removeRundownCue;
window.moveRundownCue = moveRundownCue;
window.triggerRundownCue = triggerRundownCue;
window.nextRundownCue = nextRundownCue;
window.clearRundown = clearRundown;
