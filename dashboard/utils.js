/**
 * dashboard/utils.js — utilitaires partagés par tout le tableau de bord
 * (toasts, journal d'activité, échappement HTML, garde WebSocket).
 *
 * Extrait de dashboard/legacy-core.js (chantier de modularisation). `ws`
 * est déclaré dans dashboard/state.js — importé ici en lecture seule
 * (liaison "live" ES module : requireWsOrWarn() voit toujours la valeur
 * actuelle, sans jamais pouvoir la réassigner elle-même).
 */
import { ws } from './state.js';

export function escapeHtmlDashboard(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

export function createToastContainer() {
  const container = document.createElement('div');
  container.className = 'toast-container';
  document.body.appendChild(container);
  return container;
}

export function showToast(message, type = 'info', duration = 3000) {
  const container = document.querySelector('.toast-container') || createToastContainer();
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;

  let icon = 'ℹ️';
  if (type === 'success') icon = '✅';
  if (type === 'error') icon = '⚠️';
  if (type === 'warning') icon = '⚡';

  // CORRECTIF (audit production — XSS) : message est souvent un gabarit
  // incluant err.message ou un champ serveur dynamique, jamais échappé
  // avant insertion.
  toast.innerHTML = `<span>${icon}</span><span>${escapeHtmlDashboard(message)}</span>`;
  container.appendChild(toast);

  setTimeout(() => {
    toast.remove();
  }, duration);
}

export function addActivity(title, type = 'info') {
  const feed = document.getElementById('activityFeed');
  if (!feed) return;

  const item = document.createElement('div');
  item.className = 'activity-item';
  const time = new Date().toLocaleTimeString();

  // CORRECTIF (audit production — XSS) : title inclut souvent des champs
  // dynamiques (message.error, message.reference, un fuzzyOriginal qui
  // reflète la transcription vocale...) jamais échappés avant insertion.
  // `type` reste un littéral interne, pas besoin de l'échapper.
  item.innerHTML = `
                <div class="activity-icon ${type}">•</div>
                <div class="activity-content">
                    <div class="activity-title">${escapeHtmlDashboard(title)}</div>
                    <div class="activity-time">${time}</div>
                </div>
            `;

  feed.insertBefore(item, feed.firstChild);

  while (feed.children.length > 20) {
    feed.removeChild(feed.lastChild);
  }
}

export function requireWsOrWarn() {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    showToast("Non connecté au serveur — impossible de lancer l'analyse IA.", 'error');
    return false;
  }
  return true;
}
