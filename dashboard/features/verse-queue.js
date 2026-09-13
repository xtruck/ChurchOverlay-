/**
 * dashboard/features/verse-queue.js — file d'attente de versets (innovation
 * frontend, inspirée de Rhema) : prépare à l'avance les versets d'une
 * prédication, purement côté dashboard (verseQueue est locale, jamais
 * envoyée au serveur telle quelle — réutilise juste l'action 'showVerse'
 * existante au moment d'envoyer).
 * Extrait de dashboard/legacy-core.js (chantier de modularisation).
 */
import { ws } from '../state.js';
import { showToast, addActivity, escapeHtmlDashboard } from '../utils.js';
import { registerAction } from '../action-delegator.js';

/* ======================================================================
           File d'attente de versets (innovation frontend, inspirée de Rhema) :
           permet à l'opérateur de préparer à l'avance les versets d'une
           prédication (recherche manuelle) et de les envoyer un par un au bon
           moment, plutôt que de taper chaque référence en direct. Purement
           côté dashboard — réutilise l'action 'showVerse' déjà supportée par
           le serveur, aucun changement serveur nécessaire.
           ====================================================================== */
const verseQueue = [];

export function addToQueue() {
  const input = document.getElementById('queueRefInput');
  const reference = input ? input.value.trim() : '';
  if (!reference) return;
  verseQueue.push({ id: Date.now() + Math.random(), reference });
  if (input) input.value = '';
  renderQueue();
}

export function removeFromQueue(id) {
  const idx = verseQueue.findIndex((v) => v.id === id);
  if (idx !== -1) verseQueue.splice(idx, 1);
  renderQueue();
}

export function moveQueueItem(id, direction) {
  const idx = verseQueue.findIndex((v) => v.id === id);
  const target = idx + direction;
  if (idx === -1 || target < 0 || target >= verseQueue.length) return;
  [verseQueue[idx], verseQueue[target]] = [verseQueue[target], verseQueue[idx]];
  renderQueue();
}

export function sendQueueItem(id) {
  const item = verseQueue.find((v) => v.id === id);
  if (!item) return;
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    showToast("Non connecté au serveur — impossible d'envoyer le verset.", 'error');
    return;
  }
  ws.send(JSON.stringify({ action: 'showVerse', reference: item.reference }));
  addActivity(`Verset envoyé depuis la file : ${item.reference}`, 'info');
  removeFromQueue(id);
}

export function sendNextInQueue() {
  if (verseQueue.length === 0) {
    showToast("File d'attente vide.", 'info');
    return;
  }
  sendQueueItem(verseQueue[0].id);
}

export function renderQueue() {
  const list = document.getElementById('queueList');
  const countEl = document.getElementById('queueCount');
  if (countEl) countEl.textContent = verseQueue.length;
  if (!list) return;

  if (verseQueue.length === 0) {
    list.innerHTML =
      '<div class="empty-state-note">Aucun verset en attente. Ajoutez une référence ci-dessus.</div>';
    return;
  }

  list.innerHTML = verseQueue
    .map(
      (item, i) => `
                <div class="queue-item">
                    <span class="queue-item-position">${i + 1}</span>
                    <span class="queue-item-ref">${escapeHtmlDashboard(item.reference)}</span>
                    <div class="queue-item-actions">
                        <button class="queue-icon-btn" data-action="move-up" data-target="verse-queue" data-id="${item.id}" title="Monter" ${i === 0 ? 'disabled' : ''}>↑</button>
                        <button class="queue-icon-btn" data-action="move-down" data-target="verse-queue" data-id="${item.id}" title="Descendre" ${i === verseQueue.length - 1 ? 'disabled' : ''}>↓</button>
                        <button class="queue-icon-btn queue-send" data-action="send" data-target="verse-queue" data-id="${item.id}" title="Envoyer maintenant">▶</button>
                        <button class="queue-icon-btn queue-remove" data-action="remove" data-target="verse-queue" data-id="${item.id}" title="Retirer">✕</button>
                    </div>
                </div>
            `
    )
    .join('');
}

renderQueue();

window.addToQueue = addToQueue;
// AJOUT (chantier nettoyage dashboard — purge des onclick inline) : les 4
// boutons par élément de la file (monter/descendre/envoyer/retirer)
// passent désormais par data-action/data-target — removeFromQueue/
// moveQueueItem/sendQueueItem n'ont plus d'appelant restant hors de ce
// module, retirées de window (addToQueue/sendNextInQueue restent
// nécessaires : boutons statiques, voir event-bindings.js#CLICK_BINDINGS).
registerAction('verse-queue', 'move-up', (el, data) => moveQueueItem(Number(data.id), -1));
registerAction('verse-queue', 'move-down', (el, data) => moveQueueItem(Number(data.id), 1));
registerAction('verse-queue', 'send', (el, data) => sendQueueItem(Number(data.id)));
registerAction('verse-queue', 'remove', (el, data) => removeFromQueue(Number(data.id)));
window.sendNextInQueue = sendNextInQueue;
