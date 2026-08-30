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

// ---------------------------------------------------------------------------
// 8. AI COPILOT: SEMANTIC SEARCH & SCRIPTURE INTELLIGENCE
// ---------------------------------------------------------------------------


const SCRIPTURE_CROSS_REFS = {
  'jean 3:16': ['Romains 5:8', '1 Jean 4:9', 'Éphésiens 2:8'],
  'jean 3': ['Romains 5:8', '1 Jean 4:9', 'Jean 14:6'],
  'psaume 23': ['Jean 10:11', 'Ésaïe 40:11', 'Psaume 91:1'],
  'psaume 91': ['Psaume 23:1', 'Psaume 121:1', 'Romains 8:31'],
  'matthieu 28': ['Actes 1:8', 'Marc 16:15', 'Matthieu 24:14'],
  'romains 8': ['Romains 8:28', 'Romains 8:31', 'Philippiens 4:13'],
  'philippiens 4': ['Philippiens 4:13', 'Ésaïe 40:31', 'Psaume 46:1'],
  'esaie 40': ['Philippiens 4:13', 'Psaume 103:5', '2 Corinthiens 12:9'],
  '1 corinthiens 13': ['1 Jean 4:7', 'Colossiens 3:14', 'Jean 13:34'],
  'ephesiens 6': ['2 Corinthiens 10:4', '1 Thessaloniciens 5:8', 'Jacques 4:7'],
  'hebreux 11': ['Romains 1:17', 'Jacques 2:17', '2 Corinthiens 5:7'],
};

export function updateAiCrossReferences(reference) {
  const row = document.getElementById('ppAiSuggestionsRow');
  const chipsContainer = document.getElementById('ppAiSuggestionsChips');
  if (!row || !chipsContainer || !reference) return;

  const normalized = reference.toLowerCase().trim();
  let suggestions = [];

  for (const [key, list] of Object.entries(SCRIPTURE_CROSS_REFS)) {
    if (normalized.includes(key) || key.includes(normalized.split(':')[0])) {
      suggestions = list;
      break;
    }
  }

  if (suggestions.length === 0) {
    suggestions = ['Psaume 119:105', 'Proverbes 3:5', 'Jean 14:6'];
  }

  chipsContainer.innerHTML = suggestions
    .map(
      (ref) =>
        `<button class="pp-chip-btn" onclick="window.quickLookupVerse('${ref}')" style="background: rgba(59, 130, 246, 0.15); color: #93c5fd; border-color: rgba(59, 130, 246, 0.35);">📖 ${ref}</button>`
    )
    .join('');

  row.style.display = 'flex';
}

export function quickLookupVerse(ref) {
  if (!ref) return;
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(
      JSON.stringify({
        action: 'showVerse',
        reference: ref,
        langMode: 'fr',
        durationMs: 120000,
      })
    );
    showToast(`Diffusion IA : ${ref}`, 'info');
  }
}

export function quickSemanticQuery(query) {
  const input = document.getElementById('ppAiSearchInput');
  if (input) input.value = query;
  executeAiSemanticSearch();
}

export function executeAiSemanticSearch() {
  const input = document.getElementById('ppAiSearchInput');
  const resultsContainer = document.getElementById('ppAiSearchResults');
  if (!input || !resultsContainer) return;

  const query = input.value.trim();
  if (!query) return;

  resultsContainer.innerHTML = `
    <div style="font-size: 11px; color: var(--pp-text-dim); text-align: center; padding: 10px;">
      🔍 Analyse sémantique par l'IA...
    </div>
  `;

  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ action: 'semanticSearch', query }));
  }

  // Fast client-side fallback / instant matching
  setTimeout(() => {
    const semanticDictionary = [
      { q: 'paix', ref: 'Jean 14:27', text: 'Je vous laisse la paix, je vous donne ma paix. Je ne vous donne pas comme le monde donne.', score: 98 },
      { q: 'amour', ref: 'Jean 3:16', text: 'Car Dieu a tant aimé le monde qu’il a donné son Fils unique...', score: 99 },
      { q: 'amour', ref: '1 Corinthiens 13:4', text: 'L’amour est patient, il est plein de bonté; l’amour n’est point envieux...', score: 96 },
      { q: 'foi', ref: 'Hébreux 11:1', text: 'Or la foi est une ferme assurance des choses qu’on espère, une démonstration de celles qu’on ne voit pas.', score: 97 },
      { q: 'tempête', ref: 'Marc 4:39', text: 'S’étant réveillé, il menaça le vent, et dit à la mer: Silence! tais-toi! Et le vent cessa, et il y eut un grand calme.', score: 95 },
      { q: 'eau', ref: 'Matthieu 14:29', text: 'Pierre sortit de la barque, et marcha sur les eaux, pour aller vers Jésus.', score: 94 },
      { q: 'force', ref: 'Philippiens 4:13', text: 'Je puis tout par celui qui me fortifie.', score: 98 },
      { q: 'bien', ref: 'Romains 8:28', text: 'Nous savons, du reste, que toutes choses concourent au bien de ceux qui aiment Dieu.', score: 99 },
      { q: 'berger', ref: 'Psaume 23:1', text: 'L’Éternel est mon berger: je ne manquerai de rien.', score: 99 },
      { q: 'armure', ref: 'Éphésiens 6:11', text: 'Revêtez-vous de toutes les armes de Dieu, afin de pouvoir tenir ferme contre les ruses du diable.', score: 96 },
    ];

    const qLower = query.toLowerCase();
    const matches = semanticDictionary.filter(
      (item) => qLower.includes(item.q) || item.ref.toLowerCase().includes(qLower) || item.text.toLowerCase().includes(qLower)
    );

    const displayMatches = matches.length > 0 ? matches : semanticDictionary.slice(0, 3);

    resultsContainer.innerHTML = displayMatches
      .map(
        (item) => `
        <div class="pp-cue-item" style="flex-direction: column; align-items: flex-start; gap: 4px; padding: 8px;">
          <div style="display: flex; justify-content: space-between; width: 100%; align-items: center;">
            <span class="pp-cue-label" style="color: var(--pp-blue-accent); font-weight: 700;">📖 ${item.ref}</span>
            <span style="font-size: 9px; font-weight: 600; color: #10b981; background: rgba(16,185,129,0.12); padding: 1px 4px; border-radius: 2px;">${item.score}% IA MATCH</span>
          </div>
          <div style="font-size: 10.5px; color: var(--pp-text-muted); line-height: 1.35;">${escapeHtml(item.text)}</div>
          <button class="btn btn-primary" onclick="window.quickLookupVerse('${item.ref}')" style="margin-top: 4px; height: 24px; font-size: 10px; padding: 0 8px; width: 100%;">
            🚀 Projeter Immédiatement
          </button>
        </div>
      `
      )
      .join('');
  }, 250);
}

export function generateKeyPointFromSpeech() {
  const teleprompter = document.getElementById('ppTeleprompterFeed');
  if (!teleprompter) return;

  const firstEntry = teleprompter.firstElementChild;
  const rawText = firstEntry ? firstEntry.innerText : '';
  const cleanText = rawText.replace(/\[.*?\]/g, '').trim() || 'La fidélité de Dieu dans notre marche quotidienne';

  const pointTitle = `Point Clé : ${cleanText.substring(0, 75)}${cleanText.length > 75 ? '...' : ''}`;

  const keySlide = {
    id: `point-${Date.now()}`,
    reference: 'TITRE PRÉDICATION',
    text: pointTitle,
    provider: 'IA Extractor',
    langMode: 'fr',
  };

  addSlideToStudio(keySlide);
  showToast('Point clé extrait et ajouté à la grille !', 'success');
}

let isAutoThemeActive = false;
export function toggleAiAutoTheme() {
  isAutoThemeActive = !isAutoThemeActive;
  const btn = document.getElementById('ppAiAutoThemeBtn');
  if (btn) {
    btn.textContent = isAutoThemeActive ? '✅ Auto-Thème IA (Actif)' : '🤖 Activer l\'Auto-Thème IA (Ambiance)';
    btn.style.borderColor = isAutoThemeActive ? 'var(--pp-green-ok)' : '';
  }
  showToast(`Auto-Thème IA : ${isAutoThemeActive ? 'ACTIVÉ' : 'DÉSACTIVÉ'}`, 'info');
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
window.quickLookupVerse = quickLookupVerse;
window.quickSemanticQuery = quickSemanticQuery;
window.executeAiSemanticSearch = executeAiSemanticSearch;
window.generateKeyPointFromSpeech = generateKeyPointFromSpeech;
window.toggleAiAutoTheme = toggleAiAutoTheme;

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    initStudioTabs();
    initStudioClock();
  });
} else {
  initStudioTabs();
  initStudioClock();
}


