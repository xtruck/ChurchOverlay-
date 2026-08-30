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

// AJOUT (Partie 2 — garde-fou clavier partagé) : utilisé par tout
// écouteur keydown global qui doit rester muet pendant une saisie ailleurs
// (recherche biblique, palette Ctrl+K, filtre du mur média…) — d'abord
// écrit dans trust-mode.js (barre d'espace = confirmer un verset en
// attente), déplacé ici car media-library.js (touches 1-9 du mur média) en
// a besoin exactement de la même façon.
export function isTypingContext() {
  const el = document.activeElement;
  if (!el) return false;
  const tag = (el.tagName || '').toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable;
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

// AJOUT (polish — cohérence UI) : remplace les confirm()/prompt() natifs du
// navigateur (bloquants, non stylés, incohérents avec le reste du tableau
// de bord) par une petite modale asynchrone, même structure/z-index que
// .startup-wizard-overlay (dashboard.css) — le seul autre overlay
// plein-écran existant ici, pas un nouveau pattern inventé.
// - confirmDialog(message) résout true/false (remplace confirm()).
// - confirmDialog(message, { input: true, defaultValue }) affiche un champ
//   texte et résout la valeur saisie, ou null si annulé (même contrat que
//   prompt() : null au lieu d'une chaîne vide sur annulation).
export function confirmDialog(message, { input = false, defaultValue = '', danger = false } = {}) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'confirm-dialog-overlay';
    overlay.innerHTML = `
      <div class="confirm-dialog" role="alertdialog" aria-modal="true">
        <div class="confirm-dialog-message">${escapeHtmlDashboard(message)}</div>
        ${input ? `<input type="text" class="confirm-dialog-input" value="${escapeHtmlDashboard(defaultValue)}">` : ''}
        <div class="confirm-dialog-actions">
          <button type="button" class="confirm-dialog-cancel">Annuler</button>
          <button type="button" class="confirm-dialog-ok${danger ? ' danger' : ''}">${input ? 'Valider' : 'Confirmer'}</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const inputEl = overlay.querySelector('.confirm-dialog-input');
    const finish = (value) => {
      overlay.remove();
      resolve(value);
    };

    overlay.querySelector('.confirm-dialog-cancel').addEventListener('click', () => {
      finish(input ? null : false);
    });
    overlay.querySelector('.confirm-dialog-ok').addEventListener('click', () => {
      finish(input ? inputEl.value : true);
    });
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) finish(input ? null : false);
    });
    document.addEventListener(
      'keydown',
      function onKey(e) {
        if (e.key === 'Escape') {
          document.removeEventListener('keydown', onKey);
          finish(input ? null : false);
        } else if (e.key === 'Enter' && (!input || document.activeElement === inputEl)) {
          document.removeEventListener('keydown', onKey);
          finish(input ? inputEl.value : true);
        }
      },
      { capture: true }
    );

    if (inputEl) {
      inputEl.focus();
      inputEl.select();
    } else {
      overlay.querySelector('.confirm-dialog-ok').focus();
    }
  });
}

export function requireWsOrWarn() {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    showToast("Non connecté au serveur — impossible de lancer l'analyse IA.", 'error');
    return false;
  }
  return true;
}
