/**
 * dashboard/features/scene-studio.js — studio de scènes (texte + logo/image
 * composés sur un fond, voir scene-store.js/server.js côté backend).
 *
 * AJOUT (studio de scènes, lot 5/6) : galerie EN LECTURE SEULE pour
 * l'instant (lister/déclencher/supprimer/épingler des scènes déjà créées) —
 * modelée directement sur dashboard/features/media-library.js, même
 * discipline (la liste vit côté serveur, diffusée à tous les tableaux de
 * bord ouverts). Le formulaire de composition (créer/modifier une scène) est
 * le lot 6 — sans lui, les scènes affichées ici doivent être créées "à la
 * main" via des messages WS (voir test/integration-scene-crud.js) ou, à
 * terme, le lot 6. Cette galerie reste un incrément réel et utilisable : un
 * opérateur peut déjà déclencher/épingler/supprimer des scènes existantes.
 *
 * L'aperçu de chaque carte utilise renderSceneDom() — voir scene-render.js,
 * chargé en script classique par dashboard.html (window.renderSceneDom) —
 * EXACTEMENT la même fonction que celle qui dessine la scène sur le
 * projecteur (overlay.html) : ce que l'opérateur voit ici est ce qui sera
 * diffusé, par construction.
 */
import { ws, getHttpOrigin } from '../state.js';
import { showToast, escapeHtmlDashboard } from '../utils.js';
import { updatePosterCardSceneItems } from './poster-principal-card.js';
import { getMediaLibraryItems } from './media-library.js';

let sceneStudioItems = [];

// AJOUT (Next Cue Confidence — vérification de préparation avant diffusion,
// voir next-cue-confidence.js) : même raisonnement que getMediaLibraryItems()
// dans media-library.js — la liste vit déjà ici, tenue à jour à chaque
// diffusion serveur (sceneLibraryUpdated), pas de second aller-retour WS pour
// que le module de vérification puisse résoudre un sceneId de repère de
// feuille de route vers la scène complète (background/elements, mediaUrl déjà
// résolues côté serveur).
export function getSceneStudioItems() {
  return sceneStudioItems;
}

// AJOUT (studio de scènes, lot 6/6 — composeur) : état local du formulaire de
// composition, distinct de sceneStudioItems (qui reflète la galerie déjà
// enregistrée côté serveur). `composerEditingId` null = création d'une
// nouvelle scène ; sinon, id de la scène en cours de modification (voir
// openSceneComposer()). Presets uniquement (grille 3x3, 4 polices déjà
// chargées par overlay.html) — mêmes contraintes que scene-store.js
// (sanitizeElement()), donc aucune valeur envoyée ici ne peut être rejetée
// côté serveur.
let composerEditingId = null;
let composerBackground = { type: 'none', mediaId: null, color: '#0b0f1a' };
let composerElements = [];

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
  };
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
  if (mediaSelect) mediaSelect.style.display = composerBackground.type === 'media' ? '' : 'none';
  if (colorInput) colorInput.style.display = composerBackground.type === 'color' ? '' : 'none';
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
            <button class="queue-icon-btn queue-remove" onclick="removeComposerElement('${el.id}')" title="Supprimer cet élément">✕</button>
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
          <button class="queue-icon-btn queue-remove" onclick="removeComposerElement('${el.id}')" title="Supprimer cet élément">✕</button>
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
// est une copie, jamais une référence vers sceneStudioItems — modifier le
// formulaire ne doit rien changer avant un "Enregistrer" explicite).
export function openSceneComposer(id) {
  const card = document.getElementById('sceneComposerCard');
  if (!card) return;
  const title = document.getElementById('sceneComposerTitle');
  const nameInput = document.getElementById('composerNameInput');
  const phrasesInput = document.getElementById('composerPhrasesInput');
  const bgTypeSelect = document.getElementById('composerBgTypeSelect');
  const colorInput = document.getElementById('composerBgColorInput');

  const existing = id ? sceneStudioItems.find((s) => s.id === id) : null;
  composerEditingId = existing ? existing.id : null;
  composerBackground = existing
    ? {
        type: existing.background.type,
        mediaId: existing.background.mediaId || null,
        color: existing.background.color || '#0b0f1a',
      }
    : { type: 'none', mediaId: null, color: '#0b0f1a' };
  composerElements = existing ? existing.elements.map((el) => ({ ...el })) : [];

  if (title) title.textContent = existing ? `Modifier « ${existing.name} »` : 'Nouvelle scène';
  if (nameInput) nameInput.value = existing ? existing.name : '';
  if (phrasesInput) phrasesInput.value = existing ? (existing.triggerPhrases || []).join(', ') : '';
  if (bgTypeSelect) bgTypeSelect.value = composerBackground.type;
  if (colorInput) colorInput.value = composerBackground.color || '#0b0f1a';

  renderComposerBgMediaOptions();
  onComposerBgTypeChange(); // synchronise la visibilité média/couleur avec le type qui vient d'être posé
  renderComposerElementsList();
  updateComposerPreview();

  card.style.display = '';
  card.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

export function closeSceneComposer() {
  const card = document.getElementById('sceneComposerCard');
  if (card) card.style.display = 'none';
  composerEditingId = null;
  composerBackground = { type: 'none', mediaId: null, color: '#0b0f1a' };
  composerElements = [];
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
  };
  if (composerEditingId) payload.id = composerEditingId;
  ws.send(JSON.stringify(payload));
  showToast(composerEditingId ? 'Scène mise à jour.' : 'Scène créée.', 'success');
  closeSceneComposer();
}

export function triggerSceneStudioItem(id) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    showToast('Non connecté au serveur.', 'error');
    return;
  }
  ws.send(JSON.stringify({ action: 'triggerScene', id }));
}

export function deleteSceneStudioItem(id) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    showToast('Non connecté au serveur.', 'error');
    return;
  }
  ws.send(JSON.stringify({ action: 'deleteScene', id }));
}

export function hideSceneNow() {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    showToast('Non connecté au serveur.', 'error');
    return;
  }
  ws.send(JSON.stringify({ action: 'hideScene' }));
}

// AJOUT (Partie 7.1.1 — import PowerPoint, texte des diapositives) : même
// pattern que addMediaLibraryItem() dans media-library.js (sélecteur natif
// côté main.js, traitement réel côté worker server.js — voir
// pptx-importer.js pour la portée assumée).
export async function importPptxSlides() {
  if (!window.churchOverlay || !window.churchOverlay.pickPptxFile) return;
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    showToast("Non connecté au serveur — impossible d'importer.", 'error');
    return;
  }
  try {
    const sourcePath = await window.churchOverlay.pickPptxFile();
    if (!sourcePath) return; // sélection annulée par l'opérateur
    ws.send(JSON.stringify({ action: 'importPptxSlides', sourcePath }));
  } catch (err) {
    showToast(
      'Échec de la sélection du fichier : ' + (err && err.message ? err.message : err),
      'error'
    );
  }
}

// AJOUT : réponse à importPptxSlides ci-dessus — voir ws-dispatch.js
// (case 'pptxImportResult').
export function handlePptxImportResult(result) {
  if (!result || result.scenesCreated === 0) {
    showToast('Import PowerPoint : aucune diapositive avec du texte trouvée.', 'warning');
    return;
  }
  showToast(
    `Import PowerPoint : ${result.scenesCreated} scène(s) créée(s) sur ${result.slidesFound} diapositive(s).`,
    'success'
  );
}

// AJOUT (poster principal) : même mécanisme que toggleDefaultMediaItem()
// dans media-library.js — un seul poster principal à la fois, désigner
// celui-ci démarque automatiquement l'ancien (scène OU média, voir
// l'arbitrage croisé côté serveur, lot 2).
export function toggleDefaultScene(id, isCurrentlyDefault) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    showToast('Non connecté au serveur.', 'error');
    return;
  }
  ws.send(JSON.stringify({ action: 'setDefaultScene', id: isCurrentlyDefault ? null : id }));
  showToast(
    isCurrentlyDefault ? 'Poster principal retiré.' : 'Poster principal défini.',
    'success'
  );
}

export function renderSceneStudioGallery(scenes) {
  sceneStudioItems = Array.isArray(scenes) ? scenes : [];
  updatePosterCardSceneItems(sceneStudioItems);
  const list = document.getElementById('sceneStudioList');
  const countEl = document.getElementById('sceneStudioCount');
  if (countEl) countEl.textContent = sceneStudioItems.length;
  if (!list) return;

  if (sceneStudioItems.length === 0) {
    list.innerHTML =
      '<div class="empty-state-note" style="grid-column: 1 / -1">Aucune scène créée pour l’instant.</div>';
    return;
  }

  list.innerHTML = sceneStudioItems
    .map((scene) => {
      const badge = scene.isDefault ? '<span class="media-gallery-badge">⭐ Poster</span>' : '';
      // AJOUT (déclenchement vocal des scènes) : même badge que la
      // Médiathèque (.media-item-phrase-badge) — rend visible, d'un coup
      // d'œil dans la galerie, si une scène est atteignable à la voix ou
      // seulement au clic manuel (voir scene-store.js#matchTriggerPhrase).
      const phrasesBadges = (scene.triggerPhrases || [])
        .map((p) => `<span class="media-item-phrase-badge">🎙 ${escapeHtmlDashboard(p)}</span>`)
        .join('');
      return `
                <div class="media-gallery-card${scene.isDefault ? ' is-default' : ''}">
                    <div class="media-gallery-thumb scene-preview-thumb" id="scenePreview-${scene.id}">
                        ${badge}
                    </div>
                    <div class="media-gallery-body">
                        <div class="media-gallery-label" title="${escapeHtmlDashboard(scene.name)}">${escapeHtmlDashboard(scene.name)}</div>
                        <div class="media-item-phrases">${phrasesBadges || '<span class="media-item-phrase-badge">Déclenchement manuel uniquement</span>'}</div>
                    </div>
                    <div class="media-gallery-actions">
                        <button class="btn btn-primary" onclick="triggerSceneStudioItem('${scene.id}')" title="Afficher maintenant sur l'overlay">▶ Afficher</button>
                        <button class="queue-icon-btn" onclick="openSceneComposer('${scene.id}')" title="Modifier cette scène">✏</button>
                        <button class="queue-icon-btn" onclick="toggleDefaultScene('${scene.id}', ${scene.isDefault ? 'true' : 'false'})" title="${scene.isDefault ? 'Retirer le statut de poster principal' : 'Définir comme poster principal (affiché quand rien d’autre n’est à l’écran)'}">${scene.isDefault ? '⭐' : '☆'}</button>
                        <button class="queue-icon-btn" onclick="addToRundown('scene', '${scene.id}', '${escapeHtmlDashboard(scene.name).replace(/'/g, "\\'")}')" title="Ajouter à la feuille de route">➕</button>
                        <button class="queue-icon-btn queue-remove" onclick="deleteSceneStudioItem('${scene.id}')" title="Supprimer">✕</button>
                    </div>
                </div>
            `;
    })
    .join('');

  // AJOUT (aperçu réel, pas une vignette statique) : renderSceneDom() (voir
  // scene-render.js) manipule un ÉLÉMENT DOM réel — impossible de le faire
  // dans la chaîne de caractères ci-dessus, donc peuplé APRÈS insertion dans
  // le document, une fois les conteneurs #scenePreview-<id> réellement présents.
  if (typeof window.renderSceneDom !== 'function') return; // scene-render.js pas encore chargé (chargement en cours) : rien de cassé, juste pas d'aperçu pour l'instant
  for (const scene of sceneStudioItems) {
    const previewEl = document.getElementById(`scenePreview-${scene.id}`);
    if (!previewEl) continue;
    // renderSceneDom() vide le conteneur avant de dessiner (voir son en-tête)
    // — le badge ⭐ inséré ci-dessus serait donc écrasé. Dessiné dans un
    // enfant dédié plutôt que dans le conteneur passé à renderSceneDom() lui-même.
    const badgeMarkup = scene.isDefault ? '<span class="media-gallery-badge">⭐ Poster</span>' : '';
    const canvas = document.createElement('div');
    canvas.className = 'scene-preview-canvas';
    previewEl.innerHTML = badgeMarkup;
    previewEl.appendChild(canvas);
    window.renderSceneDom(scene, canvas);
  }
}

window.triggerSceneStudioItem = triggerSceneStudioItem;
window.deleteSceneStudioItem = deleteSceneStudioItem;
window.hideSceneNow = hideSceneNow;
window.importPptxSlides = importPptxSlides;
window.toggleDefaultScene = toggleDefaultScene;
// AJOUT (studio de scènes, lot 6/6 — composeur) : onclick/onchange/oninput
// inline dans le HTML généré ci-dessus (dashboard.html et les rangées
// d'éléments construites par renderComposerElementsList()) — même
// discipline que les exports ci-dessus, qui suivent déjà ce pattern.
window.openSceneComposer = openSceneComposer;
window.closeSceneComposer = closeSceneComposer;
window.saveComposerScene = saveComposerScene;
window.addComposerElement = addComposerElement;
window.removeComposerElement = removeComposerElement;
window.updateComposerElementField = updateComposerElementField;
window.onComposerBgTypeChange = onComposerBgTypeChange;
window.onComposerBgMediaChange = onComposerBgMediaChange;
window.onComposerBgColorChange = onComposerBgColorChange;
