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
import { searchBibleByTopic } from './bible-search.js';
import { registerAction } from '../action-delegator.js';

const serviceStartTime = Date.now();
const slideGridItems = [];
let activeSlideId = null;

// ---------------------------------------------------------------------------
// 1. MASTER CLEAR CONTROLS & SHORTCUTS
// ---------------------------------------------------------------------------

export function ppClearAll() {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    showToast('Non connecté au serveur — rien à masquer.', 'error');
    return;
  }
  ws.send(JSON.stringify({ action: 'emergencyClear' }));
  ws.send(JSON.stringify({ action: 'hideVerse' }));
  ws.send(JSON.stringify({ action: 'hideMedia' }));
  ws.send(JSON.stringify({ action: 'hideScene' }));
  activeSlideId = null;
  updatePgmDisplay(null);
  updateStageDisplay(null);
  renderStudioSlides();
  showToast('MASTER CLEAR : Tout a été masqué.', 'info');
}

export function ppClearSlide() {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    showToast('Non connecté au serveur — rien à masquer.', 'error');
    return;
  }
  ws.send(JSON.stringify({ action: 'hideVerse' }));
  if (state.currentVerse) {
    state.currentVerse = null;
  }
  updatePgmDisplay(null);
  renderStudioSlides();
  showToast('Texte / Verset masqué.', 'info');
}

export function ppClearMedia() {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    showToast('Non connecté au serveur — rien à masquer.', 'error');
    return;
  }
  ws.send(JSON.stringify({ action: 'hideMedia' }));
  showToast('Média d’arrière-plan masqué.', 'info');
}

export function ppClearProps() {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    showToast('Non connecté au serveur — rien à masquer.', 'error');
    return;
  }
  ws.send(JSON.stringify({ action: 'hideScene' }));
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
    // CORRECTIF (Le Plateau — Changement 3, piège CSS Grid -> Flex) :
    // grid-column: 1 / -1 ne fait plus rien depuis que .pp-slides-wrapper
    // est passé en flex (pellicule horizontale, voir dashboard.css) —
    // remplacé par width: 100%, l'équivalent flex-safe pour occuper toute
    // la largeur de la bande.
    container.innerHTML = `
      <div style="width: 100%; text-align: center; padding: 40px; color: var(--pp-text-dim);">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" style="margin-bottom: 8px;"><rect x="2" y="3" width="20" height="14" rx="2" ry="2" /><line x1="8" y1="21" x2="16" y2="21" /><line x1="12" y1="17" x2="12" y2="21" /></svg>
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
        <div class="pp-presentation-slide ${isActive ? 'active is-live' : ''}" data-action="fire" data-target="studio-slide" data-index="${idx}">
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

function fireStudioSlide(idx) {
  const slide = slideGridItems[idx];
  if (!slide) return;
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    showToast('Non connecté au serveur — diapositive non envoyée.', 'error');
    return;
  }
  activeSlideId = slide.id || slide.reference;
  ws.send(
    JSON.stringify({
      action: 'showVerse',
      reference: slide.reference,
      text: slide.text,
      langMode: slide.langMode || 'fr',
      durationMs: 120000,
    })
  );
  updatePgmDisplay(slide);
  updateStageDisplay(slide);
  renderStudioSlides();
  showToast(`Diapositive envoyée : ${slide.reference}`, 'success');
}
// AJOUT (chantier nettoyage dashboard — purge des onclick inline) : les
// diapositives générées par renderStudioSlides() (voir data-action="fire"
// data-target="studio-slide" plus haut) passent désormais par le
// délégateur — jamais exposée sur window, aucun autre appelant.
registerAction('studio-slide', 'fire', (el, data) => fireStudioSlide(Number(data.index)));

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

  if (!ws || ws.readyState !== WebSocket.OPEN) {
    showToast('Non connecté au serveur — verset non envoyé.', 'error');
    return;
  }
  ws.send(
    JSON.stringify({
      action: 'showVerse',
      reference: ref,
      langMode: lang,
      durationMs: 120000,
    })
  );
  showToast(`Envoi de ${ref}...`, 'info');
}

// ---------------------------------------------------------------------------
// 7. MOOD PRESET PICKER
// ---------------------------------------------------------------------------
// CORRECTIF (redesign IA — étape 3) : setStudioMood()/le palette de 6
// ambiances codées en dur ont été retirés — envoyaient une action WS
// 'setTheme' jamais enregistrée dans action-registry.js (rejetée
// silencieusement par le serveur). #ppMoodPicker (dashboard.html) est
// désormais peuplé par la VRAIE fonction renderMoodPicker() (voir
// mood-theme.js), partagée avec le sélecteur d'ambiance de Direct
// Classique — plus de palette Studio Pro séparée à maintenir ici.

// ---------------------------------------------------------------------------
// 8. AI COPILOT: SEMANTIC SEARCH & SCRIPTURE INTELLIGENCE
// ---------------------------------------------------------------------------
// CORRECTIF (redesign IA — étape 3) : updateAiCrossReferences()/
// SCRIPTURE_CROSS_REFS (dictionnaire local de 11 entrées) ont été retirés —
// les VRAIES références croisées (getCrossReferences, calculées côté
// serveur pour le verset réellement affiché, quelle que soit sa source)
// alimentent maintenant #ppAiSuggestionsChips directement depuis
// renderCrossReferenceChips() dans ws-dispatch.js, en plus de sa cible
// historique #crossRefChips — voir son en-tête pour le détail. Ancien
// appelant retiré de verse-session-display.js#displayVerse.

export function quickLookupVerse(ref) {
  if (!ref) return;
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    showToast('Non connecté au serveur — verset non envoyé.', 'error');
    return;
  }
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

export function quickSemanticQuery(query) {
  const input = document.getElementById('ppAiSearchInput');
  if (input) input.value = query;
  executeAiSemanticSearch();
}

// CORRECTIF (redesign IA — étape 3) : envoyait auparavant une action WS
// 'semanticSearch' jamais enregistrée dans action-registry.js (rejetée
// silencieusement par le serveur) et n'affichait de toute façon toujours
// que 3-10 versets tirés d'un dictionnaire local figé de 250ms en 250ms,
// quelle que soit la vraie réponse serveur (ou son absence). Délègue
// maintenant à searchBibleByTopic() (bible-search.js), qui envoie la
// VRAIE action 'searchBible' — voir son en-tête pour l'honnêteté déjà
// requise sur ce module (recherche par mot-clé sur des thèmes prédéfinis,
// jamais un vrai index vectoriel/sémantique côté serveur). Les résultats
// arrivent par le chemin réel existant (searchResults/searchError,
// ws-dispatch.js) et s'affichent ici aussi — voir renderBibleSearchResults()/
// renderBibleSearchError() dans bible-search.js pour la diffusion vers
// #ppAiSearchResults en plus de sa cible historique #bibleSearchOutput.
export function executeAiSemanticSearch() {
  const input = document.getElementById('ppAiSearchInput');
  if (!input) return;
  const query = input.value.trim();
  if (!query) return;
  searchBibleByTopic(query);
}

export function generateKeyPointFromSpeech() {
  const teleprompter = document.getElementById('ppTeleprompterFeed');
  if (!teleprompter) return;

  const firstEntry = teleprompter.firstElementChild;
  const rawText = firstEntry ? firstEntry.innerText : '';
  const cleanText =
    rawText.replace(/\[.*?\]/g, '').trim() || 'La fidélité de Dieu dans notre marche quotidienne';

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
  // CORRECTIF (Le Plateau — Changement 4, emoji -> SVG) : le bouton porte
  // désormais une icône SVG fixe suivie d'un <span id="ppAiAutoThemeBtnLabel">
  // — btn.textContent = "..." écraserait cette icône (remplace TOUS les
  // enfants par un nœud texte). Ne cible plus que le label.
  const label = document.getElementById('ppAiAutoThemeBtnLabel');
  if (label) {
    label.textContent = isAutoThemeActive
      ? 'Auto-Thème IA (Actif)'
      : "Activer l'Auto-Thème IA (Ambiance)";
  }
  if (btn) {
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
// AJOUT (chantier nettoyage dashboard — purge des onclick inline) : les 3
// points d'appel restants (puces de suggestion, bouton "Projeter
// immédiatement", citations détectées en direct dans verse-session-display.js)
// passent désormais tous par data-action/data-target — plus d'appelant
// restant pour exposer cette fonction brute sur window.
registerAction('quick-verse', 'lookup', (el, data) => quickLookupVerse(data.ref));
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
