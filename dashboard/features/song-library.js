/**
 * dashboard/features/song-library.js — bibliothèque de chants
 * (déclenchement vocal ou manuel, section par section, voir
 * song-library.js/server.js côté backend — nom identique, fichiers
 * distincts : celui-ci est le rendu dashboard, l'autre le stockage
 * serveur). songSectionIndex garde en mémoire LOCALE quelle section de
 * chaque chant est "en cours" — le serveur reste sans état entre deux
 * showSongSection().
 * Extrait de dashboard/legacy-core.js (chantier de modularisation).
 */
import { ws } from '../state.js';
import { showToast, escapeHtmlDashboard } from '../utils.js';
import { registerAction } from '../action-delegator.js';

// AJOUT (redesign — pas d'emoji comme icône structurelle) : remplace les
// 🎵/✕ littéraux ci-dessous.
const ICON_NOTE =
  '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle></svg>';
const ICON_REMOVE =
  '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"></path></svg>';

/* ======================================================================
   Bibliothèque de chants (déclenchement vocal ou manuel, section par
   section, voir song-library.js/server.js). Comme la médiathèque : la
   liste vit côté serveur. songSectionIndex garde en mémoire LOCALE quelle
   section de chaque chant est "en cours" pour la navigation précédent/
   suivant — le serveur, lui, reste sans état entre deux showSongSection().
   ====================================================================== */
let songLibraryItems = [];
const songSectionIndex = {};

export function addSongToLibrary() {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    showToast("Non connecté au serveur — impossible d'ajouter un chant.", 'error');
    return;
  }
  const titleInput = document.getElementById('songTitleInput');
  const phrasesInput = document.getElementById('songPhrasesInput');
  const lyricsInput = document.getElementById('songLyricsInput');
  const title = titleInput ? titleInput.value.trim() : '';
  const lyrics = lyricsInput ? lyricsInput.value : '';
  if (!title || !lyrics.trim()) {
    showToast('Titre et paroles requis.', 'error');
    return;
  }
  const triggerPhrases = phrasesInput
    ? phrasesInput.value
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean)
    : [];
  ws.send(JSON.stringify({ action: 'addSong', title, lyrics, triggerPhrases }));
  if (titleInput) titleInput.value = '';
  if (phrasesInput) phrasesInput.value = '';
  if (lyricsInput) lyricsInput.value = '';
}

export function deleteSongFromLibrary(id) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    showToast('Non connecté au serveur.', 'error');
    return;
  }
  ws.send(JSON.stringify({ action: 'deleteSong', id }));
  delete songSectionIndex[id];
}

export function showSongSectionNow(id) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    showToast('Non connecté au serveur.', 'error');
    return;
  }
  ws.send(
    JSON.stringify({ action: 'showSongSection', id, sectionIndex: songSectionIndex[id] || 0 })
  );
}

export function stepSongSection(id, direction) {
  const song = songLibraryItems.find((s) => s.id === id);
  if (!song) return;
  const current = songSectionIndex[id] || 0;
  const next = Math.max(0, Math.min(song.sectionCount - 1, current + direction));
  songSectionIndex[id] = next;
  renderSongLibrary(songLibraryItems); // met à jour l'indicateur "N/total" affiché
  showSongSectionNow(id);
}

// AJOUT (redesign IA — étape 3, fusion Studio Pro / Direct Classique) :
// rendue à l'IDENTIQUE dans deux emplacements, tous deux à l'intérieur
// d'#propresenter-live (Opérateur) depuis la fusion — la carte détaillée
// (#songLibraryList, ex-"Direct Classique", relocalisée telle quelle) ET
// l'onglet compact "Chants" du Studio Pro (#ppSongLibraryList) — ce dernier
// affichait auparavant 2 chants intégralement codés en dur (Bénis
// l'Éternel/Grâce Infinie), sans le moindre effet réel au clic (juste un
// toast générique). Même liste réelle des deux côtés, jamais une copie
// divergente.
export function renderSongLibrary(songs) {
  songLibraryItems = Array.isArray(songs) ? songs : [];
  const targets = ['songLibraryList', 'ppSongLibraryList']
    .map((id) => document.getElementById(id))
    .filter(Boolean);
  const countEl = document.getElementById('songLibraryCount');
  if (countEl) countEl.textContent = songLibraryItems.length;
  if (!targets.length) return;

  if (songLibraryItems.length === 0) {
    const emptyHtml =
      '<div class="empty-state-note">Aucun chant ajouté. Collez des paroles ci-dessus.</div>';
    targets.forEach((el) => {
      el.innerHTML = emptyHtml;
    });
    return;
  }

  const html = songLibraryItems
    .map((song) => {
      const phrasesBadges = (song.triggerPhrases || [])
        .map((p) => `<span class="media-item-phrase-badge">${escapeHtmlDashboard(p)}</span>`)
        .join('');
      const current = (songSectionIndex[song.id] || 0) + 1;
      return `
                <div class="queue-item">
                    <span class="queue-item-position">${ICON_NOTE}</span>
                    <div class="media-item-info">
                        <div class="media-item-label">${escapeHtmlDashboard(song.title)}</div>
                        <div class="media-item-phrases">${phrasesBadges || '<span class="media-item-phrase-badge">Déclenchement manuel uniquement</span>'}</div>
                    </div>
                    <div class="queue-item-actions">
                        <button class="queue-icon-btn" data-action="step-prev" data-target="song" data-id="${song.id}" title="Section précédente">◀</button>
                        <span class="song-section-progress">${current}/${song.sectionCount}</span>
                        <button class="queue-icon-btn" data-action="step-next" data-target="song" data-id="${song.id}" title="Section suivante">▶</button>
                        <button class="queue-icon-btn queue-send" data-action="trigger" data-target="song" data-id="${song.id}" title="Afficher maintenant">▶▶</button>
                        <button class="queue-icon-btn queue-remove" data-action="delete" data-target="song" data-id="${song.id}" title="Supprimer">${ICON_REMOVE}</button>
                    </div>
                </div>
            `;
    })
    .join('');
  targets.forEach((el) => {
    el.innerHTML = html;
  });
}

window.addSongToLibrary = addSongToLibrary;

// deleteSongFromLibrary, showSongSectionNow et stepSongSection n'ont plus
// besoin de window — voir registerAction ci-dessous, elles n'étaient
// exposées que pour les onclick inline désormais remplacés par la
// délégation data-action.
registerAction('song', 'step-prev', (el, data) => stepSongSection(data.id, -1));
registerAction('song', 'step-next', (el, data) => stepSongSection(data.id, 1));
registerAction('song', 'trigger', (el, data) => showSongSectionNow(data.id));
registerAction('song', 'delete', (el, data) => deleteSongFromLibrary(data.id));
