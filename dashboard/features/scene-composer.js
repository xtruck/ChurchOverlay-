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
import { getSceneStudioItems } from './scene-studio.js';
import { registerAction } from '../action-delegator.js';

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
  const colorInput = document.getElementById('composerBgColorInput');
  composerBackground.type = typeSelect ? typeSelect.value : 'none';
  // CORRECTIF (visibilité par classe CSS, voir dashboard.html
  // `.is-hidden { display: none !important }`) : un simple `style.display`
  // ne suffit plus à RÉVÉLER ces deux champs — la règle CSS avec
  // !important gagne toujours sur un style inline tant que la classe
  // `is-hidden` reste posée sur l'élément.
  if (mediaSelect) mediaSelect.classList.toggle('is-hidden', composerBackground.type !== 'media');
  if (colorInput) colorInput.classList.toggle('is-hidden', composerBackground.type !== 'color');
  updateComposerPreview();
}

export function onComposerBgMediaChange() {
  const mediaSelect = document.getElementById('composerBgMediaSelect');
  composerBackground.mediaId = mediaSelect && mediaSelect.value ? mediaSelect.value : null;
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
            <span class="scene-composer-element-badge">🖼 Image #${idx + 1}</span>
            <select onchange="updateComposerElementField('${el.id}','mediaId',this.value)">
              <option value="">— choisir un média —</option>
              ${mediaOptions}
            </select>
            <select onchange="updateComposerElementField('${el.id}','position',this.value)">${posOptions}</select>
            <input type="number" min="1" max="100" value="${el.widthPct}" title="Largeur (% du cadre)" oninput="updateComposerElementField('${el.id}','widthPct',Number(this.value))" style="width: 70px">
            <button class="queue-icon-btn queue-remove" data-action="remove" data-target="scene-composer-element" data-id="${el.id}" title="Supprimer cet élément">✕</button>
          </div>`;
      }

      return `
        <div class="scene-composer-element-row">
          <span class="scene-composer-element-badge">🔤 Texte #${idx + 1}</span>
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
          <button class="queue-icon-btn queue-remove" data-action="remove" data-target="scene-composer-element" data-id="${el.id}" title="Supprimer cet élément">✕</button>
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
window.onComposerBgColorChange = onComposerBgColorChange;
window.toggleComposerFocusMode = toggleComposerFocusMode;

registerAction('scene-composer-element', 'remove', (el, data) => removeComposerElement(data.id));
