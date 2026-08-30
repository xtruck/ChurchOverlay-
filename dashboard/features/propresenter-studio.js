/**
 * dashboard/features/propresenter-studio.js — Interface Studio ProPresenter pour ChurchOverlay
 *
 * Implémente l'orchestration du studio broadcast :
 *   1. Raccourcis et boutons Master Clear (F1-F4, Espace, Échap)
 *   2. Grille de diapositives 16:9 interactive (Click-to-Fire)
 *   3. Synchronisation en temps réel du moniteur PGM et du Stage Display
 *   4. Horloge de régie et chronomètre de culte
 *   5. Navigation d'onglets du panneau gauche (Rundown, Écritures, Médias, Chants)
 */

import { state, ws } from '../state.js';
import { showToast } from '../utils.js';
import { nextRundownCue } from './rundown.js';

let serviceStartTime = Date.now();
let slideGridItems = [];
let activeSlideId = null;

// ---------------------------------------------------------------------------
// 1. MASTER CLEAR CONTROLS & SHORTCUTS
// ---------------------------------------------------------------------------

export function ppClearAll() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ action: 'emergencyClear' }));
    ws.send(JSON.stringify({ action: 'hideVerse' }));
    ws.send(JSON.stringify({ action: 'hideMedia' }));
    ws.send(JSON.stringify({ action: 'hideScene' }));
  }
  activeSlideId = null;
  updatePgmDisplay(null);
  updateStageDisplay(null);
  renderStudioSlides();
  showToast('MASTER CLEAR : Tout a été masqué.', 'info');
}

export function ppClearSlide() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ action: 'hideVerse' }));
  }
  if (state.currentVerse) {
    state.currentVerse = null;
  }
  updatePgmDisplay(null);
  renderStudioSlides();
  showToast('Texte / Verset masqué.', 'info');
}

export function ppClearMedia() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ action: 'hideMedia' }));
  }
  showToast('Média d’arrière-plan masqué.', 'info');
}

export function ppClearProps() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ action: 'hideScene' }));
  }
  showToast('Habillage / Scène masqué.', 'info');
}

// Global Keyboard Shortcuts (ProPresenter standard)
window.addEventListener('keydown', (e) => {
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;

  if (e.key === 'F1' || (e.key === 'Escape' && !e.shiftKey)) {
    e.preventDefault();
    ppClearAll();
  } else if (e.key === 'F2') {
    e.preventDefault();
    ppClearSlide();
  } else if (e.key === 'F3') {
    e.preventDefault();
    ppClearMedia();
  } else if (e.key === 'F4') {
    e.preventDefault();
    ppClearProps();
  } else if (e.key === ' ' || e.key === 'ArrowRight') {
    e.preventDefault();
    if (window.nextReadingVerse) {
      window.nextReadingVerse();
    } else {
      nextRundownCue();
    }
  } else if (e.key === 'ArrowLeft') {
    e.preventDefault();
    if (window.prevReadingVerse) {
      window.prevReadingVerse();
    }
  }
});

// ---------------------------------------------------------------------------
// 2. STUDIO TABS (LEFT PANE)
// ---------------------------------------------------------------------------
export function initStudioTabs() {
  const tabs = document.querySelectorAll('.pp-nav-tab');
  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      tabs.forEach((t) => t.classList.remove('active'));
      document.querySelectorAll('.pp-tab-pane').forEach((p) => p.classList.remove('active'));

      tab.classList.add('active');
      const targetId = tab.dataset.target;
      const targetPane = document.getElementById(targetId);
      if (targetPane) targetPane.classList.add('active');
    });
  });
}

// ---------------------------------------------------------------------------
// 3. STUDIO CLOCK & SERVICE TIMER
// ---------------------------------------------------------------------------
export function initStudioClock() {
  const clockEl = document.getElementById('ppStudioClock');
  const timerEl = document.getElementById('ppStudioTimer');

  setInterval(() => {
    const now = new Date();
    if (clockEl) {
      clockEl.textContent = now.toLocaleTimeString([], { hour12: false });
    }
    if (timerEl) {
      const elapsedSec = Math.floor((Date.now() - serviceStartTime) / 1000);
      const hrs = String(Math.floor(elapsedSec / 3600)).padStart(2, '0');
      const mins = String(Math.floor((elapsedSec % 3600) / 60)).padStart(2, '0');
      const secs = String(elapsedSec % 60).padStart(2, '0');
      timerEl.textContent = `${hrs}:${mins}:${secs}`;
    }
  }, 1000);
}

// ---------------------------------------------------------------------------
// 4. PRESENTATION SLIDE GRID (CENTER PANE)
// ---------------------------------------------------------------------------
export function addSlideToStudio(slide) {
  const existingIdx = slideGridItems.findIndex((s) => s.reference === slide.reference);
  if (existingIdx !== -1) {
    slideGridItems.splice(existingIdx, 1);
  }
  slideGridItems.unshift(slide);
  if (slideGridItems.length > 24) slideGridItems.pop();
  activeSlideId = slide.id || slide.reference;
  renderStudioSlides();
  updatePgmDisplay(slide);
  updateStageDisplay(slide);
}

export function renderStudioSlides() {
  const container = document.getElementById('ppSlideGridWrapper');
  if (!container) return;

  if (slideGridItems.length === 0) {
    container.innerHTML = `
      <div style="grid-column: 1 / -1; text-align: center; padding: 40px; color: var(--pp-text-dim);">
        <div style="font-size: 28px; margin-bottom: 8px;">📺</div>
        <div style="font-size: 13px; font-weight: 600;">Aucune diapositive active</div>
        <div style="font-size: 11px;">Les versets détectés ou sélectionnés s'afficheront ici sous forme de diapositives ProPresenter.</div>
      </div>
    `;
    return;
  }

  container.innerHTML = slideGridItems
    .map((slide, idx) => {
      const isActive = (slide.id || slide.reference) === activeSlideId;
      return `
        <div class="pp-presentation-slide ${isActive ? 'active is-live' : ''}" onclick="window.fireStudioSlide(${idx})">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <span class="pp-slide-header-ref">📖 ${escapeHtml(slide.reference)}</span>
            ${isActive ? '<span style="font-size: 9px; font-weight: 800; color: #ff1744; background: rgba(255,23,68,0.2); padding: 1px 4px; border-radius: 2px;">LIVE</span>' : ''}
          </div>
          <div class="pp-slide-content-preview">${escapeHtml(slide.text || '')}</div>
          <div class="pp-slide-footer">
            <span>Diapo ${idx + 1}</span>
            <span>${slide.provider || 'LSG 1910'}</span>
          </div>
        </div>
      `;
    })
    .join('');
}

window.fireStudioSlide = function (idx) {
  const slide = slideGridItems[idx];
  if (!slide) return;
  activeSlideId = slide.id || slide.reference;
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      action: 'showVerse',
      reference: slide.reference,
      text: slide.text,
      langMode: slide.langMode || 'fr',
      durationMs: 120000,
    }));
  }
  updatePgmDisplay(slide);
  updateStageDisplay(slide);
  renderStudioSlides();
  showToast(`Diapositive envoyée : ${slide.reference}`, 'success');
};

// ---------------------------------------------------------------------------
// 5. PROGRAM (PGM) & STAGE DISPLAY MIRRORING
// ---------------------------------------------------------------------------
export function updatePgmDisplay(verse) {
  const pgmMonitor = document.getElementById('ppPgmMonitor');
  const pgmRef = document.getElementById('ppPgmRef');
  const pgmText = document.getElementById('ppPgmText');
  const liveBadge = document.getElementById('ppLiveOnAirBadge');

  if (!pgmMonitor || !pgmRef || !pgmText) return;

  if (verse && verse.reference) {
    pgmMonitor.classList.add('is-live');
    if (liveBadge) liveBadge.style.display = 'block';
    pgmRef.textContent = verse.reference;
    pgmText.textContent = verse.text || '';
  } else {
    pgmMonitor.classList.remove('is-live');
    if (liveBadge) liveBadge.style.display = 'none';
    pgmRef.textContent = 'PROGRAMME HORS LIGNE';
    pgmText.textContent = 'Aucun élément diffusé actuellement sur l’overlay.';
  }
}

export function updateStageDisplay(verse) {
  const stageRef = document.getElementById('ppStageRef');
  const stageText = document.getElementById('ppStageText');
  if (!stageRef || !stageText) return;

  if (verse && verse.reference) {
    stageRef.textContent = verse.reference;
    stageText.textContent = verse.text || '';
  } else {
    stageRef.textContent = 'ÉCRAN SCÈNE';
    stageText.textContent = 'En attente du prochain texte...';
  }
}

// ---------------------------------------------------------------------------
// 6. QUICK SCRIPTURE KEYPAD
// ---------------------------------------------------------------------------
export function fireQuickScripture() {
  const bookEl = document.getElementById('ppQuickBook');
  const chapEl = document.getElementById('ppQuickChapter');
  const verseEl = document.getElementById('ppQuickVerse');
  const langEl = document.getElementById('ppQuickLang');

  const book = bookEl ? bookEl.value : 'Jean';
  const chapter = chapEl ? parseInt(chapEl.value, 10) || 1 : 1;
  const verseNum = verseEl ? parseInt(verseEl.value, 10) || 1 : 1;
  const lang = langEl ? langEl.value : 'fr';

  const ref = `${book} ${chapter}:${verseNum}`;

  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      action: 'showVerse',
      reference: ref,
      langMode: lang,
      durationMs: 120000,
    }));
    showToast(`Envoi de ${ref}...`, 'info');
  }
}

// ---------------------------------------------------------------------------
// 7. MOOD PRESET PICKER
// ---------------------------------------------------------------------------
export function setStudioMood(mood) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ action: 'setTheme', theme: mood }));
    showToast(`Ambiance appliquée : ${mood}`, 'success');
  }
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

window.ppClearAll = ppClearAll;
window.ppClearSlide = ppClearSlide;
window.ppClearMedia = ppClearMedia;
window.ppClearProps = ppClearProps;
window.fireQuickScripture = fireQuickScripture;
window.setStudioMood = setStudioMood;

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    initStudioTabs();
    initStudioClock();
  });
} else {
  initStudioTabs();
  initStudioClock();
}

