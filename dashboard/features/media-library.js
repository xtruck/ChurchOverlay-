/**
 * dashboard/features/media-library.js — médiathèque (déclenchement vocal
 * ou manuel de photos/vidéos, voir media-library.js/server.js côté
 * backend). La liste vit côté serveur : le déclenchement vocal doit
 * pouvoir la consulter pendant tout le culte, même si aucun tableau de
 * bord n'est ouvert à ce moment-là.
 * Extrait de dashboard/legacy-core.js (chantier de modularisation) —
 * initMediaLibraryPanel() vit maintenant ici aussi (déplacé depuis son
 * emplacement d'origine, physiquement égaré près du code d'habillage
 * caméra alors qu'il appartient conceptuellement à ce fichier).
 */
import { ws, getHttpOrigin } from '../state.js';
import { showToast, escapeHtmlDashboard } from '../utils.js';

/* ======================================================================
   Médiathèque (déclenchement vocal ou manuel de photos/vidéos, voir
   media-library.js/server.js). Contrairement à la file d'attente de
   versets ci-dessus (purement locale à cet onglet), la liste vit côté
   serveur : le déclenchement vocal doit pouvoir la consulter pendant tout
   le culte, même si aucun tableau de bord n'est ouvert à ce moment-là.
   ====================================================================== */
let mediaLibraryItems = [];

export async function addMediaLibraryItem() {
  if (!window.churchOverlay || !window.churchOverlay.pickMediaFile) return;
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    showToast("Non connecté au serveur — impossible d'ajouter un média.", 'error');
    return;
  }
  try {
    const sourcePath = await window.churchOverlay.pickMediaFile();
    if (!sourcePath) return; // sélection annulée par l'opérateur
    const labelInput = document.getElementById('mediaLabelInput');
    const phrasesInput = document.getElementById('mediaPhrasesInput');
    const loopInput = document.getElementById('mediaLoopInput');
    const durationInput = document.getElementById('mediaDurationInput');
    const styleInput = document.getElementById('mediaStyleInput');
    const label = labelInput ? labelInput.value.trim() : '';
    const triggerPhrases = phrasesInput
      ? phrasesInput.value
          .split(',')
          .map((p) => p.trim())
          .filter(Boolean)
      : [];
    const includeInLoop = !!(loopInput && loopInput.checked);
    const rawSeconds = durationInput ? durationInput.value.trim() : '';
    const displayDurationMs = rawSeconds ? Math.max(1, Number(rawSeconds)) * 1000 : undefined;
    const transitionStyle = styleInput ? styleInput.value : undefined;
    ws.send(
      JSON.stringify({
        action: 'addMediaItem',
        sourcePath,
        label,
        triggerPhrases,
        includeInLoop,
        displayDurationMs,
        transitionStyle,
      })
    );
    if (labelInput) labelInput.value = '';
    if (phrasesInput) phrasesInput.value = '';
    if (loopInput) loopInput.checked = false;
    if (durationInput) durationInput.value = '';
    if (styleInput) styleInput.value = 'fade';
  } catch (err) {
    showToast(
      'Échec de la sélection du fichier : ' + (err && err.message ? err.message : err),
      'error'
    );
  }
}

export function triggerMediaLibraryItem(id) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    showToast('Non connecté au serveur.', 'error');
    return;
  }
  ws.send(JSON.stringify({ action: 'triggerMediaItem', id }));
}

export function deleteMediaLibraryItem(id) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    showToast('Non connecté au serveur.', 'error');
    return;
  }
  ws.send(JSON.stringify({ action: 'deleteMediaItem', id }));
}

export function hideMediaNow() {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    showToast('Non connecté au serveur.', 'error');
    return;
  }
  ws.send(JSON.stringify({ action: 'hideMedia' }));
}

// AJOUT (détails d'affichage média — durée + style d'apparition, pour les
// médias DÉJÀ uploadés, pas seulement au moment de l'ajout).
const MEDIA_STYLE_LABELS = {
  fade: 'Fondu',
  slide: 'Glissement',
  zoom: 'Zoom',
  cut: 'Coupe instantanée',
};

// AJOUT (poster principal — carte dédiée) : simple surface de lecture sur
// mediaLibraryItems, déjà tenu à jour par renderMediaLibrary() ci-dessous —
// aucun nouvel état, aucune nouvelle requête serveur. La source de vérité
// reste isDefault sur chaque item (media-library.js) ; le bouton "Retirer"
// de cette carte réutilise toggleDefaultMediaItem(), déjà utilisé par
// l'étoile ⭐ dans la liste Médiathèque.
export function renderDefaultPosterCard(items) {
  const empty = document.getElementById('defaultPosterEmpty');
  const active = document.getElementById('defaultPosterActive');
  const label = document.getElementById('defaultPosterLabel');
  if (!empty || !active || !label) return;

  const defaultItem = (items || []).find((item) => item.isDefault);
  if (defaultItem) {
    label.textContent = `${defaultItem.mediaType === 'video' ? '🎬' : '🖼️'} ${defaultItem.label}`;
    empty.style.display = 'none';
    active.style.display = 'flex';
    active.dataset.id = defaultItem.id;
  } else {
    empty.style.display = 'block';
    active.style.display = 'none';
    delete active.dataset.id;
  }
}

export function clearDefaultPosterFromCard() {
  const active = document.getElementById('defaultPosterActive');
  const id = active && active.dataset.id;
  if (!id) return;
  toggleDefaultMediaItem(id, true);
}

export function renderMediaLibrary(items) {
  mediaLibraryItems = Array.isArray(items) ? items : [];
  renderDefaultPosterCard(mediaLibraryItems);
  const list = document.getElementById('mediaLibraryList');
  const countEl = document.getElementById('mediaLibraryCount');
  if (countEl) countEl.textContent = mediaLibraryItems.length;
  if (!list) return;

  if (mediaLibraryItems.length === 0) {
    list.innerHTML =
      '<div style="grid-column: 1 / -1; font-size:0.8rem; color:var(--text-dim); padding: 0.5rem 0;">Aucun média ajouté. Choisissez une photo ou une vidéo ci-dessus.</div>';
    return;
  }

  list.innerHTML = mediaLibraryItems
    .map((item) => {
      const phrasesBadges = (item.triggerPhrases || [])
        .map((p) => `<span class="media-item-phrase-badge">${escapeHtmlDashboard(p)}</span>`)
        .join('');
      const durationSec =
        typeof item.displayDurationMs === 'number' ? Math.round(item.displayDurationMs / 1000) : '';
      const styleOptions = Object.entries(MEDIA_STYLE_LABELS)
        .map(
          ([value, styleLabel]) =>
            `<option value="${value}" ${item.transitionStyle === value ? 'selected' : ''}>${styleLabel}</option>`
        )
        .join('');
      // AJOUT (demande explicite — "voir clairement l'image/vidéo") : vraie
      // vignette au lieu d'un simple emoji. filename vient tel quel de
      // media-library.js (jamais une URL absolue) — même correctif de
      // résolution que le logo d'habillage caméra (getHttpOrigin()) : ce
      // tableau de bord tourne en file://, un chemin racine-relatif "/media/..."
      // se résoudrait sinon contre le disque local au lieu du serveur HTTP.
      const thumbUrl = getHttpOrigin() + '/media/' + encodeURIComponent(item.filename || '');
      const thumbMarkup =
        item.mediaType === 'video'
          ? `<video src="${thumbUrl}" muted preload="metadata" playsinline></video>`
          : `<img src="${thumbUrl}" alt="${escapeHtmlDashboard(item.label)}" loading="lazy">`;
      const badges = [
        item.isDefault ? '⭐ Poster' : '',
        item.includeInLoop ? '🔁 Diaporama' : '',
      ].filter(Boolean);
      return `
                <div class="media-gallery-card${item.isDefault ? ' is-default' : ''}">
                    <div class="media-gallery-thumb">
                        ${thumbMarkup}
                        ${badges.map((b) => `<span class="media-gallery-badge">${b}</span>`).join('')}
                    </div>
                    <div class="media-gallery-body">
                        <div class="media-gallery-label" title="${escapeHtmlDashboard(item.label)}">${escapeHtmlDashboard(item.label)}</div>
                        <div class="media-item-phrases">${phrasesBadges || '<span class="media-item-phrase-badge">Déclenchement manuel uniquement</span>'}</div>
                        <div class="media-gallery-details">
                            <input type="number" min="1" step="1" placeholder="s" value="${durationSec}" id="mediaDuration-${item.id}" ${item.isDefault ? 'disabled title="Le poster principal reste affiché en continu — pas de minuterie"' : `title="Durée d'affichage en secondes — vide = pas de minuterie automatique (masquage manuel)"`}>
                            <select id="mediaStyle-${item.id}" title="Style d'apparition à l'écran">
                                ${styleOptions}
                            </select>
                            <button class="queue-icon-btn" onclick="saveMediaItemDetails('${item.id}')" title="Enregistrer la durée/le style">💾</button>
                        </div>
                    </div>
                    <div class="media-gallery-actions">
                        <button class="btn btn-primary" onclick="triggerMediaLibraryItem('${item.id}')" title="Afficher maintenant sur l'overlay">▶ Afficher</button>
                        <button class="queue-icon-btn" onclick="toggleDefaultMediaItem('${item.id}', ${item.isDefault ? 'true' : 'false'})" title="${item.isDefault ? 'Retirer le statut de poster principal' : 'Définir comme poster principal (affiché quand rien d’autre n’est à l’écran)'}">${item.isDefault ? '⭐' : '☆'}</button>
                        <button class="queue-icon-btn queue-remove" onclick="deleteMediaLibraryItem('${item.id}')" title="Supprimer">✕</button>
                    </div>
                </div>
            `;
    })
    .join('');
}

export function saveMediaItemDetails(id) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    showToast('Non connecté au serveur.', 'error');
    return;
  }
  const durationInput = document.getElementById(`mediaDuration-${id}`);
  const styleSelect = document.getElementById(`mediaStyle-${id}`);
  const rawSeconds = durationInput ? durationInput.value.trim() : '';
  const displayDurationMs = rawSeconds ? Math.max(1, Number(rawSeconds)) * 1000 : null;
  const transitionStyle = styleSelect ? styleSelect.value : 'fade';
  ws.send(JSON.stringify({ action: 'updateMediaItem', id, displayDurationMs, transitionStyle }));
  showToast('Détails d’affichage enregistrés.', 'success');
}

// AJOUT (demande explicite — "poster principal") : affiché automatiquement
// sur l'overlay dès que rien d'autre n'est à l'écran (voir
// maybeShowDefaultMedia() dans overlay.html). Un seul à la fois — le
// marquer en démarque automatiquement un éventuel précédent côté serveur.
export function toggleDefaultMediaItem(id, isCurrentlyDefault) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    showToast('Non connecté au serveur.', 'error');
    return;
  }
  ws.send(JSON.stringify({ action: 'setDefaultMediaItem', id: isCurrentlyDefault ? null : id }));
  showToast(
    isCurrentlyDefault ? 'Poster principal retiré.' : 'Poster principal défini.',
    'success'
  );
}

// Même garde que les autres panneaux Electron-only (file d'affichage,
// dashboard.js:~1067) : le sélecteur de fichier natif n'existe que côté
// application de bureau (pont IPC depuis preload.js).
(function initMediaLibraryPanel() {
  const unavailable = document.getElementById('mediaLibraryUnavailable');
  const addRow = document.getElementById('mediaLibraryAddRow');
  if (!addRow) return;
  if (!window.churchOverlay || !window.churchOverlay.pickMediaFile) {
    if (unavailable) unavailable.style.display = 'flex';
    addRow.style.display = 'none';
  }
})();

window.addMediaLibraryItem = addMediaLibraryItem;
window.triggerMediaLibraryItem = triggerMediaLibraryItem;
window.deleteMediaLibraryItem = deleteMediaLibraryItem;
window.hideMediaNow = hideMediaNow;
window.clearDefaultPosterFromCard = clearDefaultPosterFromCard;
window.saveMediaItemDetails = saveMediaItemDetails;
window.toggleDefaultMediaItem = toggleDefaultMediaItem;
