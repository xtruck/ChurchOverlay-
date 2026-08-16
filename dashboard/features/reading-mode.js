/**
 * dashboard/features/reading-mode.js — mode lecture verset par verset
 * (startReading/stopReading/nextReadingVerse/previousReadingVerse côté
 * serveur, voir server.js). Le texte du verset affiché arrive par le
 * 'showVerse' déjà géré ailleurs (readingMode.onVerseAdvance() diffuse un
 * showVerse complet côté serveur à chaque avancée) — ce module ne gère
 * que l'état actif/inactif de l'UI (boutons Suivant/Précédent visibles
 * ou non), pas l'affichage du verset lui-même.
 */
import { ws } from '../state.js';
import { showToast, requireWsOrWarn } from '../utils.js';

export function startReadingMode() {
  if (!requireWsOrWarn()) return;
  const input = document.getElementById('readingModeInput');
  const reference = input ? input.value.trim() : '';
  if (!reference) {
    showToast('Entrez une référence de départ (ex. Jean 3:1).', 'error');
    return;
  }
  ws.send(JSON.stringify({ action: 'startReading', reference }));
}

export function stopReadingMode() {
  if (!requireWsOrWarn()) return;
  ws.send(JSON.stringify({ action: 'stopReading' }));
}

export function nextReadingVerse() {
  if (!requireWsOrWarn()) return;
  ws.send(JSON.stringify({ action: 'nextReadingVerse' }));
}

export function previousReadingVerse() {
  if (!requireWsOrWarn()) return;
  ws.send(JSON.stringify({ action: 'previousReadingVerse' }));
}

export function setReadingModeActive(active) {
  const badge = document.getElementById('readingModeBadge');
  const startBtn = document.getElementById('readingModeStartBtn');
  const stopBtn = document.getElementById('readingModeStopBtn');
  const advanceRow = document.getElementById('readingModeAdvanceRow');
  if (badge) badge.style.display = active ? 'inline-flex' : 'none';
  if (startBtn) startBtn.style.display = active ? 'none' : 'inline-flex';
  if (stopBtn) stopBtn.style.display = active ? 'inline-flex' : 'none';
  if (advanceRow) advanceRow.style.display = active ? 'flex' : 'none';
}

// AJOUT (frontend — mode lecture "pro") : affiche la progression courante
// dans le chapitre (ex. "Jean 3 · verset 16/36"). Pos = { book, chapter,
// verse, total }, diffusé par le serveur dans chaque showVerse en mode
// lecture (voir server.js > readingModePosition). Ne reçoit que des
// chiffres du serveur — jamais de calcul ici.
export function setReadingPosition(pos) {
  const el = document.getElementById('readingModePosition');
  if (!el) return;
  if (pos && typeof pos.total === 'number' && pos.total > 0 && pos.verse) {
    const book = String(pos.book || '')
      .trim()
      .replace(/^./, (c) => c.toUpperCase());
    el.textContent = `${book} ${pos.chapter} · verset ${pos.verse}/${pos.total}`;
    el.style.display = 'inline-flex';
  } else {
    el.textContent = '';
    el.style.display = 'none';
  }
}

export function clearReadingPosition() {
  const el = document.getElementById('readingModePosition');
  if (!el) return;
  el.textContent = '';
  el.style.display = 'none';
}

window.startReadingMode = startReadingMode;
window.stopReadingMode = stopReadingMode;
window.nextReadingVerse = nextReadingVerse;
window.previousReadingVerse = previousReadingVerse;
window.setReadingPosition = setReadingPosition;
window.clearReadingPosition = clearReadingPosition;
