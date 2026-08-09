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
      '<div style="font-size:0.8rem; color:var(--text-dim); padding: 0.5rem 0;">Aucun verset en attente. Ajoutez une référence ci-dessus.</div>';
    return;
  }

  list.innerHTML = verseQueue
    .map(
      (item, i) => `
                <div class="queue-item">
                    <span class="queue-item-position">${i + 1}</span>
                    <span class="queue-item-ref">${escapeHtmlDashboard(item.reference)}</span>
                    <div class="queue-item-actions">
                        <button class="queue-icon-btn" onclick="moveQueueItem(${item.id}, -1)" title="Monter" ${i === 0 ? 'disabled' : ''}>↑</button>
                        <button class="queue-icon-btn" onclick="moveQueueItem(${item.id}, 1)" title="Descendre" ${i === verseQueue.length - 1 ? 'disabled' : ''}>↓</button>
                        <button class="queue-icon-btn queue-send" onclick="sendQueueItem(${item.id})" title="Envoyer maintenant">▶</button>
                        <button class="queue-icon-btn queue-remove" onclick="removeFromQueue(${item.id})" title="Retirer">✕</button>
                    </div>
                </div>
            `
    )
    .join('');
}

renderQueue();

window.addToQueue = addToQueue;
window.removeFromQueue = removeFromQueue;
window.moveQueueItem = moveQueueItem;
window.sendQueueItem = sendQueueItem;
window.sendNextInQueue = sendNextInQueue;
