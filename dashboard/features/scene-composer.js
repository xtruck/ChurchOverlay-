/**
 * dashboard/features/scene-composer.js — formulaire de composition de
 * scènes (texte + logo/image sur un fond, voir scene-store.js/server.js
 * côté backend) : créer ou modifier une scène avant le culte. Un vrai
 * outil de préparation, pas de direct — contrairement à la galerie (lister/
 * déclencher/couper/masquer des scènes déjà créées), qui reste dans
 * scene-studio.js (redesign IA — étape 2, scission live/config du fichier
 * dashboard/features/scene-studio.js d'origine, voir
 * DASHBOARD-IA-REDESIGN-PROPOSAL.md).
 *
 * L'aperçu utilise renderSceneDom() — voir scene-render.js, chargé en
 * script classique par dashboard.html (window.renderSceneDom) —
 * EXACTEMENT la même fonction que celle qui dessine la scène sur le
 * projecteur (overlay.html) : ce que l'opérateur voit ici est ce qui sera
 * diffusé, par construction.
 *
 * Import circulaire avec scene-studio.js (qui importe openSceneComposer()
 * d'ici pour son action 'scene'/'edit') : sans risque, même précédent déjà
 * en production que rundown.js/airlock-preview.js — ni l'un ni l'autre
 * module n'appelle les fonctions de l'autre à l'évaluation du module,
 * toujours depuis un rendu déclenché plus tard (WS/clic/clavier).
 */
import { ws, getHttpOrigin } from '../state.js';
import { showToast, escapeHtmlDashboard } from '../utils.js';
import { getMediaLibraryItems } from './media-library.js';

// AJOUT (redesign — pas d'emoji comme icône structurelle) : remplace les
// 🖼/🔤/✕ littéraux ci-dessous (badges de type d'élément + bouton
// supprimer). Le test/integration-scene-composer.js repérait ces lignes
// via leur emoji (Playwright .filter({hasText})) — mis à jour pour
// chercher "Image #"/"Texte #" à la place, du texte qui reste présent.
const ICON_IMAGE_ELEMENT =
  '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><path d="M21 15l-5-5L5 21"></path></svg>';
const ICON_TEXT_ELEMENT =
  '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M4 7V4h16v3M9 20h6M12 4v16"></path></svg>';
const ICON_REMOVE =
  '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"></path></svg>';
import { getSceneStudioItems } from './scene-studio.js';
import { registerAction } from '../action-delegator.js';

// CORRECTIF (retour opérateur — "impossible d'ajouter un média depuis le
// composeur") : le fond/les éléments image du composeur ne proposaient
// qu'un <select> des médias DÉJÀ présents dans la Médiathèque — sans rien
// y avoir ajouté au préalable ailleurs dans le tableau de bord, ce menu
// restait vide et rien ne se passait au clic (aucune erreur non plus,
// juste un menu sans options). Réutilise le même sélecteur de fichier
// natif que la Médiathèque (window.churchOverlay.pickMediaFile, voir
// media-library.js) pour importer directement depuis le composeur, sans
// devoir changer d'onglet. mediaLibraryUpdated (diffusé par le serveur
// après l'ajout) est ce qui fait réellement apparaître le nouvel élément
// dans getMediaLibraryItems() — ce module n'a aucun moyen direct d'attendre
// cette confirmation serveur, donc on sonde la liste localement le temps
// qu'elle arrive plutôt que de deviner un délai fixe.
async function quickAddMedia() {
  if (!window.churchOverlay || !window.churchOverlay.pickMediaFile) {
    showToast(
      "Ajout de média disponible uniquement dans l'application ChurchOverlay (pas dans un navigateur).",
      'error'
    );
    return null;
  }
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    showToast('Non connecté au serveur.', 'error');
    return null;
  }
  let sourcePath;
  try {
    sourcePath = await window.churchOverlay.pickMediaFile();
  } catch (err) {
    showToast(
      'Échec de la sélection du fichier : ' + (err && err.message ? err.message : err),
      'error'
    );
    return null;
  }
  if (!sourcePath) return null; // sélection annulée par l'opérateur

  const existingIds = new Set(getMediaLibraryItems().map((m) => m.id));
  const filename = sourcePath.split(/[\\/]/).pop() || 'media';
  const label = filename.replace(/\.[^.]+$/, '');
  ws.send(
    JSON.stringify({ action: 'addMediaItem', sourcePath, label, triggerPhrases: [] })
  );
  showToast('Ajout du média en cours...', 'info');

  return new Promise((resolve) => {
    let attempts = 0;
    const maxAttempts = 25; // ~5s à 200ms — largement au-delà d'un aller-retour WS local normal
    const check = () => {
      attempts++;
      const newItem = getMediaLibraryItems().find((m) => !existingIds.has(m.id));
      if (newItem) {
        resolve(newItem.id);
      } else if (attempts < maxAttempts) {
        setTimeout(check, 200);
      } else {
        // Le média finira par apparaître dans la liste dès que
        // mediaLibraryUpdated arrive (juste pas assez tôt pour être
        // sélectionné automatiquement ici) — pas une vraie erreur.
        showToast(
          "L'import prend plus de temps que prévu — le média apparaîtra dans la liste une fois prêt.",
          'info'
        );
        resolve(null);
      }
    };
    setTimeout(check, 200);
  });
}

// AJOUT (studio de scènes, lot 6/6 — composeur) : état local du formulaire de
// composition, distinct de sceneStudioItems (qui reflète la galerie déjà
// enregistrée côté serveur, voir scene-studio.js). `composerEditingId` null =
// création d'une nouvelle scène ; sinon, id de la scène en cours de
// modification (voir openSceneComposer()). Presets uniquement (grille 3x3, 4
// polices déjà chargées par overlay.html) — mêmes contraintes que
// scene-store.js (sanitizeElement()), donc aucune valeur envoyée ici ne peut
// être rejetée côté serveur.
let composerEditingId = null;
let composerBackground = { type: 'none', mediaId: null, color: '#0b0f1a' };
let composerElements = [];
// AJOUT (chantier overlay/composeur multi-scènes — Mode Focus, style
// ProPresenter/OBS) : voir scene-store.js#focusMode/scene-render.js pour le
// rendu réel (assombrit/floute le calque de fond, jamais les calques texte/
// image posés par-dessus).
let composerFocusMode = false;

const POSITION_OPTIONS = [
  ['top-left', '↖ Haut gauche'],
  ['top-center', '↑ Haut centre'],
  ['top-right', '↗ Haut droite'],
  ['center-left', '← Centre gauche'],
  ['center', '• Centre'],
  ['center-right', '→ Centre droite'],
  ['bottom-left', '↙ Bas gauche'],
  ['bottom-center', '↓ Bas centre'],
  ['bottom-right', '↘ Bas droite'],
];
const FONT_OPTIONS = ['Merriweather', 'Manrope', 'Cormorant Garamond', 'Plus Jakarta Sans'];

function makeElementId() {
  return typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : 'el-' + Date.now() + '-' + Math.random().toString(36).slice(2);
}

function resolveComposerMediaUrl(mediaId) {
  if (!mediaId) return null;
  const item = getMediaLibraryItems().find((m) => m.id === mediaId);
  return item ? getHttpOrigin() + '/media/' + encodeURIComponent(item.filename || '') : null;
}

// AJOUT : construit l'objet passé à renderSceneDom() pour l'aperçu — cette
// fonction attend des mediaUrl déjà résolues (comme le fait resolveSceneMediaUrls()
// côté serveur pour le rendu réel), jamais un mediaId brut.
function buildComposerPreviewScene() {
  return {
    background:
      composerBackground.type === 'media'
        ? { type: 'media', mediaUrl: resolveComposerMediaUrl(composerBackground.mediaId) }
        : composerBackground,
    elements: composerElements.map((el) =>
      el.type === 'image' ? { ...el, mediaUrl: resolveComposerMediaUrl(el.mediaId) } : el
    ),
    focusMode: composerFocusMode,
  };
}

// AJOUT (chantier overlay/composeur multi-scènes — Mode Focus) : bouton/
// toggle du formulaire de composition — voir dashboard.html
// (#composerFocusModeToggle) et saveComposerScene()/openSceneComposer() plus
// bas pour la lecture/écriture de composerFocusMode.
export function toggleComposerFocusMode(enabled) {
  composerFocusMode = !!enabled;
  updateComposerPreview();
}

function updateComposerPreview() {
  const frame = document.getElementById('composerPreviewFrame');
  if (!frame || typeof window.renderSceneDom !== 'function') return;
  window.renderSceneDom(buildComposerPreviewScene(), frame);
}

function renderComposerBgMediaOptions() {
  const mediaSelect = document.getElementById('composerBgMediaSelect');
  if (!mediaSelect) return;
  const options = getMediaLibraryItems()
    .map(
      (m) =>
        `<option value="${m.id}" ${composerBackground.mediaId === m.id ? 'selected' : ''}>${escapeHtmlDashboard(m.label)}</option>`
    )
    .join('');
  mediaSelect.innerHTML = '<option value="">— choisir un média —</option>' + options;
}

export function onComposerBgTypeChange() {
  const typeSelect = document.getElementById('composerBgTypeSelect');
  const mediaSelect = document.getElementById('composerBgMediaSelect');
  const importBtn = document.getElementById('composerBgMediaImportBtn');
  const colorInput = document.getElementById('composerBgColorInput');
  composerBackground.type = typeSelect ? typeSelect.value : 'none';
  // CORRECTIF (visibilité par classe CSS, voir dashboard.html
  // `.is-hidden { display: none !important }`) : un simple `style.display`
  // ne suffit plus à RÉVÉLER ces deux champs — la règle CSS avec
  // !important gagne toujours sur un style inline tant que la classe
  // `is-hidden` reste posée sur l'élément.
  if (mediaSelect) mediaSelect.classList.toggle('is-hidden', composerBackground.type !== 'media');
  if (importBtn) importBtn.classList.toggle('is-hidden', composerBackground.type !== 'media');
  if (colorInput) colorInput.classList.toggle('is-hidden', composerBackground.type !== 'color');
  updateComposerPreview();
}

export function onComposerBgMediaChange() {
  const mediaSelect = document.getElementById('composerBgMediaSelect');
  composerBackground.mediaId = mediaSelect && mediaSelect.value ? mediaSelect.value : null;
  updateComposerPreview();
}

export async function quickAddBackgroundMedia() {
  const newId = await quickAddMedia();
  if (!newId) return;
  composerBackground.mediaId = newId;
  renderComposerBgMediaOptions();
  updateComposerPreview();
}

async function quickAddElementMedia(elementId) {
  const newId = await quickAddMedia();
  if (!newId) return;
  const el = composerElements.find((e) => e.id === elementId);
  if (!el) return; // l'élément a pu être supprimé pendant l'import
  el.mediaId = newId;
  renderComposerElementsList();
  updateComposerPreview();
}

export function onComposerBgColorChange() {
  const colorInput = document.getElementById('composerBgColorInput');
  composerBackground.color = colorInput ? colorInput.value : '#0b0f1a';
  updateComposerPreview();
}

// AJOUT : les rangées de champs ne sont reconstruites (renderComposerElementsList)
// qu'à l'ajout/suppression d'un élément — une frappe dans un champ texte ne
// touche QUE le modèle en mémoire (updateComposerElementField) + l'aperçu
// (conteneur séparé), jamais le DOM du formulaire lui-même : reconstruire
// l'innerHTML à chaque frappe ferait perdre le focus/curseur en cours de
// saisie (bug déjà rencontré ailleurs dans ce projet avec un pattern similaire).
export function updateComposerElementField(id, field, value) {
  const el = composerElements.find((e) => e.id === id);
  if (!el) return;
  el[field] = value;
  updateComposerPreview();
}

export function addComposerElement(type) {
  const id = makeElementId();
  composerElements.push(
    type === 'image'
      ? { id, type: 'image', mediaId: '', position: 'center', widthPct: 18, rotationDeg: 0 }
      : {
          id,
          type: 'text',
          text: '',
          position: 'center',
          align: 'center',
          fontFamily: 'Merriweather',
          fontSizePct: 6,
          fontWeight: 400,
          color: '#FFFFFF',
          rotationDeg: 0,
        }
  );
  renderComposerElementsList();
  updateComposerPreview();
}

export function removeComposerElement(id) {
  composerElements = composerElements.filter((e) => e.id !== id);
  renderComposerElementsList();
  updateComposerPreview();
}

function renderComposerElementsList() {
  const container = document.getElementById('composerElementsList');
  if (!container) return;

  if (composerElements.length === 0) {
    container.innerHTML =
      '<div class="empty-state-note">Aucun élément — ajoutez du texte ou une image ci-dessus.</div>';
    return;
  }

  const mediaItems = getMediaLibraryItems();
  container.innerHTML = composerElements
    .map((el, idx) => {
      const posOptions = POSITION_OPTIONS.map(
        ([value, posLabel]) =>
          `<option value="${value}" ${el.position === value ? 'selected' : ''}>${posLabel}</option>`
      ).join('');

      if (el.type === 'image') {
        const mediaOptions = mediaItems
          .map(
            (m) =>
              `<option value="${m.id}" ${el.mediaId === m.id ? 'selected' : ''}>${escapeHtmlDashboard(m.label)}</option>`
          )
          .join('');
        return `
          <div class="scene-composer-element-row">
            <span class="scene-composer-element-badge">${ICON_IMAGE_ELEMENT} Image #${idx + 1}</span>
            <select onchange="updateComposerElementField('${el.id}','mediaId',this.value)">
              <option value="">— choisir un média —</option>
              ${mediaOptions}
            </select>
            <button class="queue-icon-btn" data-action="quick-add-media" data-target="scene-composer-element" data-id="${el.id}" title="Importer une nouvelle image/vidéo pour cet élément">+ Importer</button>
            <select onchange="updateComposerElementField('${el.id}','position',this.value)">${posOptions}</select>
            <input type="number" min="1" max="100" value="${el.widthPct}" title="Largeur (% du cadre)" oninput="updateComposerElementField('${el.id}','widthPct',Number(this.value))" style="width: 70px">
            <input type="number" min="-180" max="180" value="${el.rotationDeg || 0}" title="Rotation (degrés)" oninput="updateComposerElementField('${el.id}','rotationDeg',Number(this.value))" style="width: 60px">
            <button class="queue-icon-btn queue-remove" data-action="remove" data-target="scene-composer-element" data-id="${el.id}" title="Supprimer cet élément">${ICON_REMOVE}</button>
          </div>`;
      }

      return `
        <div class="scene-composer-element-row">
          <span class="scene-composer-element-badge">${ICON_TEXT_ELEMENT} Texte #${idx + 1}</span>
          <input type="text" id="composerElText-${el.id}" placeholder="Texte à afficher" oninput="updateComposerElementField('${el.id}','text',this.value)">
          <select onchange="updateComposerElementField('${el.id}','position',this.value)">${posOptions}</select>
          <select onchange="updateComposerElementField('${el.id}','fontFamily',this.value)">
            ${FONT_OPTIONS.map((f) => `<option value="${f}" ${el.fontFamily === f ? 'selected' : ''}>${f}</option>`).join('')}
          </select>
          <input type="number" min="1" max="30" value="${el.fontSizePct}" title="Taille (% de la hauteur du cadre)" oninput="updateComposerElementField('${el.id}','fontSizePct',Number(this.value))" style="width: 60px">
          <select onchange="updateComposerElementField('${el.id}','fontWeight',Number(this.value))">
            <option value="400" ${el.fontWeight === 400 ? 'selected' : ''}>Normal</option>
            <option value="700" ${el.fontWeight === 700 ? 'selected' : ''}>Gras</option>
          </select>
          <input type="color" value="${el.color}" oninput="updateComposerElementField('${el.id}','color',this.value)">
          <select onchange="updateComposerElementField('${el.id}','align',this.value)">
            <option value="left" ${el.align === 'left' ? 'selected' : ''}>Gauche</option>
            <option value="center" ${el.align === 'center' ? 'selected' : ''}>Centre</option>
            <option value="right" ${el.align === 'right' ? 'selected' : ''}>Droite</option>
          </select>
          <input type="number" min="-180" max="180" value="${el.rotationDeg || 0}" title="Rotation (degrés)" oninput="updateComposerElementField('${el.id}','rotationDeg',Number(this.value))" style="width: 60px">
          <button class="queue-icon-btn queue-remove" data-action="remove" data-target="scene-composer-element" data-id="${el.id}" title="Supprimer cet élément">${ICON_REMOVE}</button>
        </div>`;
    })
    .join('');

  // AJOUT (sécurité — attribut HTML vs propriété DOM) : le texte d'un élément
  // est saisi librement par l'opérateur (contrairement à position/police/
  // poids, tous issus de <select> à valeurs fixes) — l'assigner via l'attribut
  // value="..." dans le gabarit ci-dessus casserait hors de l'attribut sur un
  // guillemet double (escapeHtmlDashboard() n'échappe que &/</>, pas les
  // guillemets). Assigné ici via la PROPRIÉTÉ .value (écriture DOM directe,
  // jamais interprétée comme du HTML), après insertion dans le document.
  for (const el of composerElements) {
    if (el.type !== 'text') continue;
    const input = document.getElementById(`composerElText-${el.id}`);
    if (input) input.value = el.text;
  }
}

// AJOUT : id=null -> nouvelle scène vierge ; id d'une scène existante ->
// pré-remplit le formulaire avec une copie de son contenu (composerElements
// est une copie, jamais une référence vers la liste de scene-studio.js —
// modifier le formulaire ne doit rien changer avant un "Enregistrer" explicite).
export function openSceneComposer(id) {
  const card = document.getElementById('sceneComposerCard');
  if (!card) return;
  const title = document.getElementById('sceneComposerTitle');
  const nameInput = document.getElementById('composerNameInput');
  const phrasesInput = document.getElementById('composerPhrasesInput');
  const bgTypeSelect = document.getElementById('composerBgTypeSelect');
  const colorInput = document.getElementById('composerBgColorInput');

  const existing = id ? getSceneStudioItems().find((s) => s.id === id) : null;
  composerEditingId = existing ? existing.id : null;
  composerBackground = existing
    ? {
        type: existing.background.type,
        mediaId: existing.background.mediaId || null,
        color: existing.background.color || '#0b0f1a',
      }
    : { type: 'none', mediaId: null, color: '#0b0f1a' };
  composerElements = existing ? existing.elements.map((el) => ({ ...el })) : [];
  composerFocusMode = existing ? !!existing.focusMode : false;

  if (title) title.textContent = existing ? `Modifier « ${existing.name} »` : 'Nouvelle scène';
  if (nameInput) nameInput.value = existing ? existing.name : '';
  if (phrasesInput) phrasesInput.value = existing ? (existing.triggerPhrases || []).join(', ') : '';
  if (bgTypeSelect) bgTypeSelect.value = composerBackground.type;
  if (colorInput) colorInput.value = composerBackground.color || '#0b0f1a';
  const focusModeToggle = document.getElementById('composerFocusModeToggle');
  if (focusModeToggle) focusModeToggle.checked = composerFocusMode;

  renderComposerBgMediaOptions();
  onComposerBgTypeChange(); // synchronise la visibilité média/couleur avec le type qui vient d'être posé
  renderComposerElementsList();
  updateComposerPreview();

  // CORRECTIF (visibilité par classe CSS, même raison que
  // onComposerBgTypeChange ci-dessus) : `.scene-composer-card.is-hidden`
  // porte `!important` — seul le retrait de la classe révèle la carte.
  card.classList.remove('is-hidden');
  card.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

export function closeSceneComposer() {
  const card = document.getElementById('sceneComposerCard');
  if (card) card.classList.add('is-hidden');
  composerEditingId = null;
  composerBackground = { type: 'none', mediaId: null, color: '#0b0f1a' };
  composerElements = [];
  composerFocusMode = false;
}

export function saveComposerScene() {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    showToast('Non connecté au serveur.', 'error');
    return;
  }
  const nameInput = document.getElementById('composerNameInput');
  const phrasesInput = document.getElementById('composerPhrasesInput');
  const name = nameInput ? nameInput.value.trim() : '';
  if (!name) {
    showToast('Le nom de la scène est requis.', 'error');
    return;
  }
  const triggerPhrases = phrasesInput
    ? phrasesInput.value
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean)
    : [];
  const payload = {
    action: composerEditingId ? 'updateScene' : 'addScene',
    name,
    background: composerBackground,
    elements: composerElements,
    triggerPhrases,
    focusMode: composerFocusMode,
  };
  if (composerEditingId) payload.id = composerEditingId;
  ws.send(JSON.stringify(payload));
  showToast(composerEditingId ? 'Scène mise à jour.' : 'Scène créée.', 'success');
  closeSceneComposer();
}

// AJOUT (studio de scènes, lot 6/6 — composeur) : onclick/onchange/oninput
// inline dans le HTML généré ci-dessus (dashboard.html et les rangées
// d'éléments construites par renderComposerElementsList()) — même
// discipline que les exports ci-dessus, qui suivent déjà ce pattern.
window.closeSceneComposer = closeSceneComposer;
window.saveComposerScene = saveComposerScene;
window.addComposerElement = addComposerElement;
window.updateComposerElementField = updateComposerElementField;
window.onComposerBgTypeChange = onComposerBgTypeChange;
window.onComposerBgMediaChange = onComposerBgMediaChange;
// AJOUT : #composerBgMediaImportBtn (dashboard.html) est un bouton STATIQUE
// à id fixe (jamais recréé) — câblé via event-bindings.js#CLICK_BINDINGS,
// pas registerAction()/action-delegator.js (réservé au contenu rendu
// dynamiquement, voir son en-tête). Republiée sur window pour ce seul appelant.
window.quickAddBackgroundMedia = quickAddBackgroundMedia;
window.onComposerBgColorChange = onComposerBgColorChange;
window.toggleComposerFocusMode = toggleComposerFocusMode;

registerAction('scene-composer-element', 'remove', (el, data) => removeComposerElement(data.id));
registerAction('scene-composer-element', 'quick-add-media', (el, data) =>
  quickAddElementMedia(data.id)
);
