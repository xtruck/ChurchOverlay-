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
import { showToast, escapeHtmlDashboard, isTypingContext } from '../utils.js';
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
                        <button class="queue-icon-btn" onclick="addToRundown('media', '${item.id}', '${escapeHtmlDashboard(item.label).replace(/'/g, "\\'")}')" title="Ajouter à la feuille de route">➕</button>
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

// AJOUT (Partie 2.3 — Mur Média, états par tuile) : "à l'écran" et "déjà
// utilisé" changent à CHAQUE déclenchement — un média peut être montré des
// dizaines de fois pendant un culte. Reconstruire toute la grille en
// innerHTML à chaque fois (comme mediaLibraryUpdated, plus bas) ne passerait
// pas le test de charge du cahier des charges (200 médias, déclenchement
// <300ms) : on bascule seulement les classes CSS des tuiles concernées,
// jamais un re-rendu complet pour ces deux états. mediaOnScreenId/
// mediaUsedIds vivent ici (pas dans ws-dispatch.js) pour rester à côté du
// rendu qu'ils pilotent.
let mediaOnScreenId = null;
const mediaUsedIds = new Set();

/**
 * Appelé par ws-dispatch.js sur 'showMedia' : marque la tuile comme "à
 * l'écran" (et "déjà utilisé" en permanence, pour le reste de la session
 * dashboard) sans reconstruire la grille.
 */
export function markMediaOnScreen(id) {
  if (mediaOnScreenId && mediaOnScreenId !== id) {
    const prev = document.querySelector(`.media-gallery-card[data-media-id="${mediaOnScreenId}"]`);
    if (prev) prev.classList.remove('is-on-screen');
  }
  mediaOnScreenId = id || null;
  mediaUsedIds.add(id);
  const card = document.querySelector(`.media-gallery-card[data-media-id="${id}"]`);
  if (card) {
    card.classList.add('is-on-screen', 'is-used');
  }
}

/**
 * Appelé par ws-dispatch.js sur 'hideMedia'/'showVerse'/'showScene' : plus
 * rien de la médiathèque n'est à l'écran (l'overlay n'affiche qu'une seule
 * chose à la fois).
 */
export function clearMediaOnScreen() {
  if (!mediaOnScreenId) return;
  const card = document.querySelector(`.media-gallery-card[data-media-id="${mediaOnScreenId}"]`);
  if (card) card.classList.remove('is-on-screen');
  mediaOnScreenId = null;
}

// Mur Média — grille visuelle pour déclenchement rapide pendant le culte
export function renderMediaWall(items) {
  const grid = document.getElementById('mediaWallGrid');
  const countEl = document.getElementById('mediaWallCount');
  if (!grid) return;
  const list = Array.isArray(items) ? items : mediaLibraryItems;
  if (countEl) countEl.textContent = list.length;
  if (list.length === 0) {
    grid.innerHTML =
      '<div class="empty-state-note" style="grid-column: 1 / -1">Aucun média ajouté.</div>';
    return;
  }
  grid.innerHTML = list
    .map((item) => {
      const thumbUrl = getHttpOrigin() + '/media/' + encodeURIComponent(item.filename || '');
      // AJOUT (Partie 2.3 — état "fichier manquant") : voir media-library.js
      // listItems() côté serveur — l'entrée existe dans l'index mais le
      // fichier réel a disparu du disque. Barré, jamais cliquable : mieux
      // vaut ne rien déclencher que déclencher un média cassé en plein culte.
      if (item.fileMissing) {
        return `
          <div class="media-gallery-card is-missing" data-media-id="${item.id}" title="Fichier introuvable sur le disque">
            <div class="media-gallery-thumb media-gallery-thumb-missing">⚠️</div>
            <div class="media-gallery-label" style="font-size:0.75rem;padding:0.3rem 0.5rem;text-align:center;text-decoration:line-through;opacity:0.6;">
              ${escapeHtmlDashboard(item.label || item.filename)}
            </div>
          </div>`;
      }
      const thumbMarkup =
        item.mediaType === 'video'
          ? `<video src="${thumbUrl}" muted preload="metadata" playsinline></video>`
          : `<img src="${thumbUrl}" alt="${escapeHtmlDashboard(item.label || item.filename)}" loading="lazy">`;
      const badges = [
        item.isDefault ? '⭐' : '',
        item.includeInLoop ? '🔁' : '',
        mediaUsedIds.has(item.id) ? '✓' : '',
      ].filter(Boolean);
      const stateClasses = [
        item.isDefault ? ' is-default' : '',
        item.id === mediaOnScreenId ? ' is-on-screen' : '',
        mediaUsedIds.has(item.id) ? ' is-used' : '',
      ].join('');
      return `
        <div class="media-gallery-card${stateClasses}" data-media-id="${item.id}" style="cursor:pointer" onclick="triggerMediaWallItem('${escapeHtmlDashboard(item.filename)}')">
          <div class="media-gallery-thumb">
            ${thumbMarkup}
            <span class="media-gallery-hotkey"></span>
            ${badges.map((b) => `<span class="media-gallery-badge">${b}</span>`).join('')}
          </div>
          <div class="media-gallery-label" style="font-size:0.75rem;padding:0.3rem 0.5rem;text-align:center;">
            ${escapeHtmlDashboard(item.label || item.filename)}
          </div>
        </div>`;
    })
    .join('');
  renumberVisibleTiles();
}
window.renderMediaWall = renderMediaWall;

// AJOUT (Partie 2.3 — touches 1-9, affordance visible) : numérote les 9
// premières tuiles VISIBLES avec un badge discret dans le coin — sans ça,
// l'opérateur devrait deviner quelle touche correspond à quelle tuile.
// Recalculé à chaque rendu ET à chaque filtre (voir filterMediaWall), qui
// change forcément quelles tuiles sont "les 9 premières visibles".
function renumberVisibleTiles() {
  const cards = Array.from(document.querySelectorAll('#mediaWallGrid .media-gallery-card'));
  let hotkeyIndex = 0;
  for (const card of cards) {
    const badge = card.querySelector('.media-gallery-hotkey');
    if (!badge) continue;
    if (card.style.display !== 'none' && hotkeyIndex < 9) {
      hotkeyIndex++;
      badge.textContent = String(hotkeyIndex);
      badge.style.display = 'block';
    } else {
      badge.textContent = '';
      badge.style.display = 'none';
    }
  }
}

window.triggerMediaWallItem = function (filename) {
  const item = mediaLibraryItems.find((i) => i.filename === filename);
  if (item && item.fileMissing) {
    showToast(`❌ "${item.label}" : fichier introuvable sur le disque, non déclenché.`, 'error');
    return;
  }
  if (item) triggerMediaLibraryItem(item.id);
};

// AJOUT (Partie 2.3 — bouton "essayer") : envoie le texte tapé au VRAI
// moteur de détection côté serveur (action WS testTriggerPhrase) — voir
// dashboard.html pour le champ/bouton, et ws-dispatch.js pour
// 'triggerPhraseTestResult' qui affiche la réponse ci-dessous.
export function testTriggerPhrase() {
  const input = document.getElementById('triggerPhraseTestInput');
  const text = input ? input.value.trim() : '';
  if (!text) return;
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    showToast('Non connecté au serveur — impossible de tester.', 'error');
    return;
  }
  ws.send(JSON.stringify({ action: 'testTriggerPhrase', text }));
}
window.testTriggerPhrase = testTriggerPhrase;

const TRIGGER_KIND_LABELS = { media: 'média', song: 'chant', scene: 'scène' };

export function renderTriggerPhraseTestResult(result) {
  const el = document.getElementById('triggerPhraseTestResult');
  if (!el) return;
  if (!result.text) {
    el.textContent = '';
    return;
  }
  if (result.matched) {
    el.textContent = `✅ Déclencherait le ${TRIGGER_KIND_LABELS[result.kind] || result.kind} « ${result.label} »`;
    el.style.color = 'var(--accent-green, #22c55e)';
  } else {
    el.textContent = '❌ Aucune correspondance — cette phrase ne déclencherait rien';
    el.style.color = 'var(--accent-red, #ef4444)';
  }
}

// AJOUT (Partie 2.3 — recherche instantanée) : filtre la grille EN PLACE
// (affiche/masque des tuiles déjà rendues, comme markMediaOnScreen ci-dessus)
// plutôt que de la reconstruire — même souci de performance sur une grosse
// médiathèque (cahier des charges : 200 médias).
function normalizeForSearch(text) {
  return (text || '').toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
}

export function filterMediaWall(query) {
  const q = normalizeForSearch(query);
  const cards = document.querySelectorAll('#mediaWallGrid .media-gallery-card');
  cards.forEach((card) => {
    const item = mediaLibraryItems.find((i) => i.id === card.dataset.mediaId);
    if (!item) return;
    const haystack = normalizeForSearch([item.label, ...(item.triggerPhrases || [])].join(' '));
    card.style.display = !q || haystack.includes(q) ? '' : 'none';
  });
  renumberVisibleTiles();
}
window.filterMediaWall = filterMediaWall;

// AJOUT (Partie 2.3 — parité clavier, touches 1-9) : les 9 premières tuiles
// VISIBLES (après filtre — voir filterMediaWall ci-dessus) se déclenchent au
// clavier, sans quitter le clavier pour attraper la souris en plein culte.
// Actif uniquement quand le Mur Média est la section réellement affichée
// (l'opérateur peut être sur un tout autre onglet de RÉGIE en même temps),
// et jamais pendant une saisie ailleurs (garde-fou partagé avec la barre
// d'espace du mode confiance — voir utils.js#isTypingContext).
document.addEventListener('keydown', (e) => {
  if (!/^[1-9]$/.test(e.key)) return;
  if (isTypingContext()) return;
  const section = document.getElementById('media-wall');
  if (!section || section.style.display === 'none') return;
  const visibleCards = Array.from(
    document.querySelectorAll('#mediaWallGrid .media-gallery-card')
  ).filter((card) => card.style.display !== 'none');
  const index = Number(e.key) - 1;
  const card = visibleCards[index];
  if (!card) return;
  e.preventDefault();
  const item = mediaLibraryItems.find((i) => i.id === card.dataset.mediaId);
  if (item && !item.fileMissing) triggerMediaLibraryItem(item.id);
});
