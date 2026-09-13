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

// AJOUT (chantier durcissement v1.0 — "Decision Logs & monitoring
// d'autonomie") : le journal d'activité n'affichait qu'un simple libellé —
// pour un verset/une scène auto-DÉCLENCHÉ(E) (pas une action manuelle de
// l'opérateur), impossible de savoir a posteriori POURQUOI le pipeline a
// décidé d'afficher ça (quelle méthode de détection ?) ni AVEC QUELLE
// CONFIANCE, alors que server.js calcule déjà ce score pour sa propre
// décision (voir resolveDetectionConfidenceScore) — il était juste jeté
// après avoir servi une fois au tri auto/supervisé/rejeté, jamais transmis
// au tableau de bord. `decision` (optionnel, 3e paramètre, RIEN ne change
// pour les ~60 appels existants qui ne le passent pas) porte cette
// justification : { reason, confidence }.
//   - reason : phrase courte expliquant la méthode/le déclencheur
//     (ex. "détection vocale automatique (regex)", "repli chapitre après
//     délai — verset exact non capté").
//   - confidence : score [0, 1] si le pipeline en a calculé un pour CETTE
//     décision précise (absent pour une action manuelle ou un repli
//     heuristique sans score — jamais une valeur inventée côté dashboard).
// AJOUT (chantier durcissement v1.0 — Decision Logs) : libellés FR pour
// chaque valeur de `detectedBy` diffusée par server.js (voir showVerse/
// showScene) — un seul endroit à mettre à jour si une nouvelle méthode de
// détection apparaît, plutôt que de dupliquer la traduction à chaque appel.
// Seules les méthodes VRAIMENT autonomes (le pipeline décide seul depuis
// l'audio en direct, sans action opérateur) sont listées ici : un verset
// 'manual'/déclenché par une commande vocale explicite est une décision de
// l'opérateur, pas du pipeline — inutile de le justifier comme tel.
const AUTONOMOUS_DETECTION_LABELS = {
  regex: 'détection automatique (référence reconnue dans la transcription)',
  quote: 'détection automatique (citation exacte reconnue)',
  semantic: 'détection automatique (recherche sémantique)',
  'chapter-fallback': 'repli chapitre automatique',
  'voice-cue': 'phrase déclencheuse reconnue automatiquement',
  'voice-cue-group': 'phrase déclencheuse reconnue automatiquement (groupe)',
};

/**
 * Construit la métadonnée `decision` (voir addActivity()) pour un message
 * showVerse/showScene — seulement si celui-ci a réellement été
 * AUTO-déclenché par le pipeline (pas une action manuelle ou une commande
 * vocale explicite de l'opérateur, qui sont déjà leur propre justification).
 * @param {object} message - payload WS showVerse/showScene
 * @returns {{reason?: string, confidence?: number}|null}
 */
export function describeAutonomousDecision(message) {
  if (!message || message.triggeredManually || message.triggeredByVoice) return null;
  const label = AUTONOMOUS_DETECTION_LABELS[message.detectedBy];
  if (!label && typeof message.confidence !== 'number' && !message.reason) return null;
  const decision = { reason: message.reason || label };
  if (typeof message.confidence === 'number') decision.confidence = message.confidence;
  return decision;
}

export function addActivity(title, type = 'info', decision = null) {
  const feed = document.getElementById('activityFeed');
  if (!feed) return;

  const item = document.createElement('div');
  item.className = 'activity-item';
  const time = new Date().toLocaleTimeString();

  let decisionHtml = '';
  if (decision && (decision.reason || typeof decision.confidence === 'number')) {
    const parts = [];
    if (typeof decision.confidence === 'number') {
      parts.push(`confiance ${Math.round(decision.confidence * 100)}%`);
    }
    if (decision.reason) parts.push(decision.reason);
    // CORRECTIF (audit production — XSS) : mêmes champs dynamiques que
    // `title` ci-dessous (reason peut refléter un detectedBy/texte serveur),
    // échappés avant insertion.
    decisionHtml = `<div class="activity-decision">🧠 ${escapeHtmlDashboard(parts.join(' — '))}</div>`;
  }

  // CORRECTIF (audit production — XSS) : title inclut souvent des champs
  // dynamiques (message.error, message.reference, un fuzzyOriginal qui
  // reflète la transcription vocale...) jamais échappés avant insertion.
  // `type` reste un littéral interne, pas besoin de l'échapper.
  item.innerHTML = `
                <div class="activity-icon ${type}">•</div>
                <div class="activity-content">
                    <div class="activity-title">${escapeHtmlDashboard(title)}</div>
                    ${decisionHtml}
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
