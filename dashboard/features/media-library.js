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
import { updatePosterCardMediaItems } from './poster-principal-card.js';

/* ======================================================================
   Médiathèque (déclenchement vocal ou manuel de photos/vidéos, voir
   media-library.js/server.js). Contrairement à la file d'attente de
   versets ci-dessus (purement locale à cet onglet), la liste vit côté
   serveur : le déclenchement vocal doit pouvoir la consulter pendant tout
   le culte, même si aucun tableau de bord n'est ouvert à ce moment-là.
   ====================================================================== */
let mediaLibraryItems = [];

// AJOUT (studio de scènes, lot 6/6 — composeur) : le composeur a besoin de
// lister les médias déjà uploadés pour son fond et ses éléments image/logo
// (voir scene-studio.js) — même liste, déjà tenue à jour ici à chaque
// diffusion serveur, pas de second aller-retour WS pour la dupliquer.
export function getMediaLibraryItems() {
  return mediaLibraryItems;
}

// AJOUT (glisser-déposer médiathèque) : extrait de l'ancien
// addMediaLibraryItem() — logique de soumission partagée entre le
// sélecteur natif ci-dessous ET handleMediaFileDrop() plus bas, qui
// obtient sourcePath autrement (webUtils.getPathForFile(), voir
// preload.js) mais doit lire/réinitialiser EXACTEMENT les mêmes champs du
// formulaire pour que les deux chemins se comportent de façon identique.
function submitMediaFromPath(sourcePath) {
  const labelInput = document.getElementById('mediaLabelInput');
  const phrasesInput = document.getElementById('mediaPhrasesInput');
  const loopInput = document.getElementById('mediaLoopInput');
  const durationInput = document.getElementById('mediaDurationInput');
  const styleInput = document.getElementById('mediaStyleInput');
  // AJOUT (poster principal — correctif "le poster ne revient pas après un
  // verset") : voir server.js#addMediaItem pour la cause réelle du bug —
  // ce champ fait en un seul geste, à l'ajout, ce qui exigeait avant un
  // second clic (facilement oublié) sur l'étoile ⭐ après coup.
  const posterInput = document.getElementById('mediaPosterInput');
  const label = labelInput ? labelInput.value.trim() : '';
  const triggerPhrases = phrasesInput
    ? phrasesInput.value
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean)
    : [];
  const includeInLoop = !!(loopInput && loopInput.checked);
  const setAsPoster = !!(posterInput && posterInput.checked);
  // "Poster" coché : la durée est forcée à null côté serveur
  // (mediaLibrary.setDefaultItem(), voir server.js) — le champ durée est de
  // toute façon désactivé dans le formulaire quand cette case est cochée
  // (voir updateMediaPosterFormState() plus bas), donc rawSeconds serait
  // déjà vide ici en pratique ; ce garde reste explicite plutôt qu'implicite.
  const rawSeconds = !setAsPoster && durationInput ? durationInput.value.trim() : '';
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
      setAsPoster,
    })
  );
  if (labelInput) labelInput.value = '';
  if (phrasesInput) phrasesInput.value = '';
  if (loopInput) loopInput.checked = false;
  if (durationInput) durationInput.value = '';
  if (styleInput) styleInput.value = 'fade';
  if (posterInput) posterInput.checked = false;
  updateMediaPosterFormState();
}

export async function addMediaLibraryItem() {
  if (!window.churchOverlay || !window.churchOverlay.pickMediaFile) return;
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    showToast("Non connecté au serveur — impossible d'ajouter un média.", 'error');
    return;
  }
  try {
    const sourcePath = await window.churchOverlay.pickMediaFile();
    if (!sourcePath) return; // sélection annulée par l'opérateur
    submitMediaFromPath(sourcePath);
  } catch (err) {
    showToast(
      'Échec de la sélection du fichier : ' + (err && err.message ? err.message : err),
      'error'
    );
  }
}

// AJOUT (glisser-déposer médiathèque) : appelée depuis l'attribut ondrop de
// #mediaDropzone (dashboard.html). preventDefault() en tout premier — sans
// lui, Chromium/Electron navigue la fenêtre entière vers le fichier déposé
// (voir aussi le filet de sécurité global dans ui-effects.js, qui couvre le
// reste de la fenêtre hors de cette zone). Ne gère qu'UN SEUL fichier à la
// fois (comme le sélecteur natif ci-dessus, properties: ['openFile']) —
// déposer plusieurs fichiers n'utilise que le premier, silencieusement,
// plutôt que de complexifier ce premier jet avec une file d'ajouts.
export function handleMediaFileDrop(event) {
  event.preventDefault();
  event.currentTarget.classList.remove('media-dropzone--active');

  if (!window.churchOverlay || !window.churchOverlay.getPathForFile) return;
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    showToast("Non connecté au serveur — impossible d'ajouter un média.", 'error');
    return;
  }
  const file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
  if (!file) return;

  let sourcePath;
  try {
    sourcePath = window.churchOverlay.getPathForFile(file);
  } catch (err) {
    showToast('Fichier déposé illisible : ' + (err && err.message ? err.message : err), 'error');
    return;
  }
  if (!sourcePath) {
    showToast(
      "Impossible de déterminer l'emplacement du fichier déposé — utilisez plutôt « Choisir un fichier ».",
      'error'
    );
    return;
  }

  // AJOUT (confort — le nom n'est pas toujours saisi avant un dépôt, à la
  // différence du sélecteur natif où le fichier est déjà visible/nommé dans
  // la fenêtre de dialogue) : ne remplit le nom QUE s'il est vide, jamais
  // n'écrase une valeur déjà tapée par l'opérateur avant le dépôt.
  const labelInput = document.getElementById('mediaLabelInput');
  if (labelInput && !labelInput.value.trim()) {
    const base = file.name.replace(/\.[^.]+$/, '');
    labelInput.value = base;
  }

  submitMediaFromPath(sourcePath);
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

export function renderMediaLibrary(items) {
  mediaLibraryItems = Array.isArray(items) ? items : [];
  // AJOUT (studio de scènes, lot 5/6) : la carte "Poster principal" est
  // désormais partagée avec scene-studio.js — voir poster-principal-card.js,
  // qui décide seul quoi afficher (elle peut aussi devenir une scène).
  updatePosterCardMediaItems(mediaLibraryItems);
  const list = document.getElementById('mediaLibraryList');
  const countEl = document.getElementById('mediaLibraryCount');
  if (countEl) countEl.textContent = mediaLibraryItems.length;
  if (!list) return;

  if (mediaLibraryItems.length === 0) {
    list.innerHTML =
      '<div class="empty-state-note" style="grid-column: 1 / -1">Aucun média ajouté. Choisissez une photo ou une vidéo ci-dessus.</div>';
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

// AJOUT (poster principal — correctif "le poster ne revient pas après un
// verset") : la durée n'a aucun effet quand "Poster" est coché (forcée à
// null côté serveur, voir setDefaultItem() dans media-library.js) — désactiver
// visiblement le champ évite qu'un opérateur pense l'avoir réglée pour rien.
export function updateMediaPosterFormState() {
  const posterInput = document.getElementById('mediaPosterInput');
  const durationInput = document.getElementById('mediaDurationInput');
  if (!posterInput || !durationInput) return;
  const isPoster = posterInput.checked;
  durationInput.disabled = isPoster;
  durationInput.placeholder = isPoster ? 'Illimitée (poster)' : 'Durée (s)';
  if (isPoster) durationInput.value = '';
}

// Même garde que les autres panneaux Electron-only (file d'affichage,
// dashboard.js:~1067) : le sélecteur de fichier natif n'existe que côté
// application de bureau (pont IPC depuis preload.js).
(function initMediaLibraryPanel() {
  const unavailable = document.getElementById('mediaLibraryUnavailable');
  const addRow = document.getElementById('mediaLibraryAddRow');
  const dropzone = document.getElementById('mediaDropzone');
  if (!addRow) return;
  if (!window.churchOverlay || !window.churchOverlay.pickMediaFile) {
    if (unavailable) unavailable.style.display = 'flex';
    addRow.style.display = 'none';
    if (dropzone) dropzone.style.display = 'none';
  }
})();

window.addMediaLibraryItem = addMediaLibraryItem;
window.handleMediaFileDrop = handleMediaFileDrop;
window.triggerMediaLibraryItem = triggerMediaLibraryItem;
window.deleteMediaLibraryItem = deleteMediaLibraryItem;
window.hideMediaNow = hideMediaNow;
// AJOUT (studio de scènes, lot 5/6) : window.clearDefaultPosterFromCard est
// désormais défini par poster-principal-card.js (voir son import ci-dessus) —
// retiré d'ici pour ne pas l'écraser selon l'ordre de chargement des modules.
window.saveMediaItemDetails = saveMediaItemDetails;
window.toggleDefaultMediaItem = toggleDefaultMediaItem;
window.updateMediaPosterFormState = updateMediaPosterFormState;
