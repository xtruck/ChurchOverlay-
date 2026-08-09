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
import { ws } from '../legacy-core.js';
import { showToast, escapeHtmlDashboard } from '../utils.js';

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

export function renderSongLibrary(songs) {
  songLibraryItems = Array.isArray(songs) ? songs : [];
  const list = document.getElementById('songLibraryList');
  const countEl = document.getElementById('songLibraryCount');
  if (countEl) countEl.textContent = songLibraryItems.length;
  if (!list) return;

  if (songLibraryItems.length === 0) {
    list.innerHTML =
      '<div style="font-size:0.8rem; color:var(--text-dim); padding: 0.5rem 0;">Aucun chant ajouté. Collez des paroles ci-dessus.</div>';
    return;
  }

  list.innerHTML = songLibraryItems
    .map((song) => {
      const phrasesBadges = (song.triggerPhrases || [])
        .map((p) => `<span class="media-item-phrase-badge">${escapeHtmlDashboard(p)}</span>`)
        .join('');
      const current = (songSectionIndex[song.id] || 0) + 1;
      return `
                <div class="queue-item">
                    <span class="queue-item-position">🎵</span>
                    <div class="media-item-info">
                        <div class="media-item-label">${escapeHtmlDashboard(song.title)}</div>
                        <div class="media-item-phrases">${phrasesBadges || '<span class="media-item-phrase-badge">Déclenchement manuel uniquement</span>'}</div>
                    </div>
                    <div class="queue-item-actions">
                        <button class="queue-icon-btn" onclick="stepSongSection('${song.id}', -1)" title="Section précédente">◀</button>
                        <span style="font-size:0.7rem; color:var(--text-dim); white-space:nowrap;">${current}/${song.sectionCount}</span>
                        <button class="queue-icon-btn" onclick="stepSongSection('${song.id}', 1)" title="Section suivante">▶</button>
                        <button class="queue-icon-btn queue-send" onclick="showSongSectionNow('${song.id}')" title="Afficher maintenant">▶▶</button>
                        <button class="queue-icon-btn queue-remove" onclick="deleteSongFromLibrary('${song.id}')" title="Supprimer">✕</button>
                    </div>
                </div>
            `;
    })
    .join('');
}

window.addSongToLibrary = addSongToLibrary;
window.deleteSongFromLibrary = deleteSongFromLibrary;
window.showSongSectionNow = showSongSectionNow;
window.stepSongSection = stepSongSection;
