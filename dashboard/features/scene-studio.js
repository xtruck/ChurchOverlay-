/**
 * dashboard/features/scene-studio.js — galerie de scènes déjà créées
 * (lister/déclencher/couper-diffuser/masquer/épingler, switcher multiview
 * dual-bus Program/Preview, import PowerPoint) — voir
 * scene-store.js/server.js côté backend. Operator-essential : ces actions
 * sont utilisées EN DIRECT.
 *
 * Le formulaire de composition (créer/modifier une scène) vit désormais
 * dans scene-composer.js, pas ici — c'est un outil de préparation, pas de
 * direct (redesign IA — étape 2, scission live/config, voir
 * DASHBOARD-IA-REDESIGN-PROPOSAL.md). Ce fichier reste la source de vérité
 * pour sceneStudioItems (getSceneStudioItems(), consommé aussi par
 * scene-composer.js, airlock-preview.js et next-cue-confidence.js) puisque
 * c'est ici que le message serveur sceneLibraryUpdated est traité en
 * premier (voir ws-dispatch.js).
 *
 * L'aperçu de chaque carte utilise renderSceneDom() — voir scene-render.js,
 * chargé en script classique par dashboard.html (window.renderSceneDom) —
 * EXACTEMENT la même fonction que celle qui dessine la scène sur le
 * projecteur (overlay.html) : ce que l'opérateur voit ici est ce qui sera
 * diffusé, par construction.
 */
import { ws } from '../state.js';
import { showToast, escapeHtmlDashboard, isTypingContext } from '../utils.js';
import { updatePosterCardSceneItems } from './poster-principal-card.js';
import { registerAction } from '../action-delegator.js';
// AJOUT (chantier ultime — switcher multiview dual-bus Program/Preview) :
// getCurrentLive() donne le Tally rouge (scène RÉELLEMENT diffusée, voir son
// en-tête — alimenté par showScene). Import circulaire avec
// airlock-preview.js (qui importe déjà getSceneStudioItems() d'ici) — sans
// risque, même précédent déjà en production que rundown.js/airlock-preview.js
// (voir le commentaire de getArmedCueId() dans airlock-preview.js) : ni l'un
// ni l'autre module n'appelle ces fonctions à l'évaluation du module, toujours
// depuis un rendu déclenché plus tard (WS/clic/clavier).
import { getCurrentLive } from './airlock-preview.js';
// AJOUT (redesign IA — étape 2) : openSceneComposer() vit désormais dans
// scene-composer.js — voir son en-tête pour la discussion de l'import
// circulaire (scene-composer.js importe getSceneStudioItems() d'ici).
import { openSceneComposer } from './scene-composer.js';

// AJOUT (redesign — pas d'emoji comme icône structurelle) : icônes SVG
// inline réutilisées dans les gabarits de carte ci-dessous, à la place des
// emoji littéraux (⭐/🎯/🎙/👁/✏/➕/✕) — chaînes fixes, jamais de contenu
// utilisateur interpolé À L'INTÉRIEUR de ces constantes (le contenu
// utilisateur réel — nom de scène, phrase déclencheuse — passe toujours par
// escapeHtmlDashboard() séparément, inchangé).
const ICON_STAR =
  '<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 3l2.5 5.5 6 .7-4.4 4.1 1.2 6-5.3-3-5.3 3 1.2-6-4.4-4.1 6-.7z"></path></svg>';
const ICON_STAR_OUTLINE =
  '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M12 3l2.5 5.5 6 .7-4.4 4.1 1.2 6-5.3-3-5.3 3 1.2-6-4.4-4.1 6-.7z"></path></svg>';
const ICON_TARGET =
  '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><circle cx="12" cy="12" r="4"></circle><circle cx="12" cy="12" r="0.6" fill="currentColor"></circle></svg>';
const ICON_MIC =
  '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="9" y="2" width="6" height="12" rx="3"></rect><path d="M5 10a7 7 0 0 0 14 0"></path><path d="M12 17v5M9 22h6"></path></svg>';
const ICON_EYE =
  '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"></path><circle cx="12" cy="12" r="3"></circle></svg>';
const ICON_PENCIL =
  '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M4 17.5V20h2.5L18 8.5l-2.5-2.5L4 17.5z"></path><path d="M13.5 4.5l3 3"></path></svg>';
const ICON_PLUS =
  '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><path d="M12 5v14M5 12h14"></path></svg>';
const ICON_X =
  '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"></path></svg>';

let sceneStudioItems = [];

// AJOUT (chantier ultime — switcher multiview dual-bus Program/Preview) :
// canal Preview — PUREMENT local à ce tableau de bord (comme armedItem dans
// airlock-preview.js), jamais diffusé tant que CUT/TAKE n'est pas pressé.
// Le canal Program, lui, N'A PAS de second état ici : c'est getCurrentLive()
// (déjà alimenté par le VRAI message showScene du serveur) qui fait
// autorité — un seul Program possible dans toute l'app, jamais dupliqué.
let previewSceneId = null;

export function getPreviewSceneId() {
  return previewSceneId;
}

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

export function triggerSceneStudioItem(id) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    showToast('Non connecté au serveur.', 'error');
    return;
  }
  ws.send(JSON.stringify({ action: 'triggerScene', id }));
}

// --- Switcher multiview dual-bus Program/Preview (chantier ultime) --------

/**
 * Arme une scène dans le canal Preview (👁 aperçu privé) — AUCUN message WS,
 * rien n'est diffusé tant que cutToProgram() n'est pas déclenché.
 * @param {string} id
 */
export function setPreviewScene(id) {
  const scene = sceneStudioItems.find((s) => s.id === id);
  previewSceneId = scene ? id : null;
  renderSceneStudioGallery(sceneStudioItems);
  showToast(scene ? `Preview : « ${scene.name} »` : 'Preview vidée.', 'info');
}

export function clearPreviewScene() {
  previewSceneId = null;
  renderSceneStudioGallery(sceneStudioItems);
}

/**
 * CUT / TAKE — envoie la scène actuellement en Preview vers le Program.
 * Réutilise EXACTEMENT triggerSceneStudioItem() (donc l'action WS
 * 'triggerScene' déjà testée) : CUT n'est qu'un raccourci, jamais un second
 * protocole de diffusion. La Preview n'est PAS vidée après coup — un
 * opérateur qui rappuie sur CUT (ex. après un "⏹ Masquer" accidentel) doit
 * pouvoir rediffuser la même scène, comme "▶ Afficher" reste cliquable
 * plusieurs fois de suite.
 */
export function cutToProgram() {
  if (!previewSceneId) {
    showToast('Aucune scène en Preview — armez-en une avant de CUT.', 'warning');
    return;
  }
  triggerSceneStudioItem(previewSceneId);
}

function updateMultiviewBusBar() {
  const previewLabel = document.getElementById('multiviewPreviewLabel');
  const programLabel = document.getElementById('multiviewProgramLabel');
  const cutBtn = document.getElementById('sceneCutBtn');
  if (!previewLabel && !programLabel && !cutBtn) return;

  const previewScene = sceneStudioItems.find((s) => s.id === previewSceneId);
  if (previewLabel) {
    previewLabel.textContent = previewScene ? previewScene.name : 'Aucune sélection';
  }
  if (cutBtn) cutBtn.disabled = !previewScene;

  const live = getCurrentLive();
  if (programLabel) {
    programLabel.textContent =
      live && live.type === 'scene' && live.label ? live.label : 'Rien en direct';
  }
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

  const live = getCurrentLive();
  const liveSceneId = live && live.type === 'scene' && live.scene ? live.scene.id : null;

  list.innerHTML = sceneStudioItems
    .map((scene) => {
      const badge = scene.isDefault
        ? `<span class="media-gallery-badge">${ICON_STAR} Poster</span>`
        : '';
      // AJOUT (chantier overlay/composeur multi-scènes — Mode Focus) : rend
      // visible, d'un coup d'œil dans la galerie, si le fond de cette scène
      // s'estompera à l'affichage (voir scene-render.js#renderSceneDom).
      const focusModeBadge = scene.focusMode
        ? `<span class="media-gallery-badge">${ICON_TARGET} Focus</span>`
        : '';
      // AJOUT (déclenchement vocal des scènes) : même badge que la
      // Médiathèque (.media-item-phrase-badge) — rend visible, d'un coup
      // d'œil dans la galerie, si une scène est atteignable à la voix ou
      // seulement au clic manuel (voir scene-store.js#matchTriggerPhrase).
      const phrasesBadges = (scene.triggerPhrases || [])
        .map(
          (p) =>
            `<span class="media-item-phrase-badge">${ICON_MIC} ${escapeHtmlDashboard(p)}</span>`
        )
        .join('');
      // AJOUT (chantier ultime — Tally lumineux) : rouge prioritaire sur vert
      // — une scène ne peut jamais être "en Preview" ET "en Program" à
      // l'affichage (si elle est diffusée, la Preview n'a plus d'utilité
      // visuelle, même si previewSceneId la référence encore techniquement).
      // CORRECTIF (redesign — pas d'emoji comme icône structurelle) : le
      // rond de couleur (🔴/🟢) était redondant avec la couleur de fond déjà
      // portée par .tally-badge--program/--preview (voir dashboard.css) —
      // le texte PROGRAM/PREVIEW + cette couleur suffisent (color-not-only).
      const isLive = scene.id === liveSceneId;
      const isPreview = !isLive && scene.id === previewSceneId;
      const tallyClass = isLive ? ' tally-program' : isPreview ? ' tally-preview' : '';
      const tallyBadge = isLive
        ? '<span class="tally-badge tally-badge--program">PROGRAM</span>'
        : isPreview
          ? '<span class="tally-badge tally-badge--preview">PREVIEW</span>'
          : '';
      return `
                <div class="media-gallery-card${scene.isDefault ? ' is-default' : ''}${tallyClass}">
                    <div class="media-gallery-thumb scene-preview-thumb" id="scenePreview-${scene.id}">
                        ${tallyBadge}${badge}${focusModeBadge}
                    </div>
                    <div class="media-gallery-body">
                        <div class="media-gallery-label" title="${escapeHtmlDashboard(scene.name)}">${escapeHtmlDashboard(scene.name)}</div>
                        <div class="media-item-phrases">${phrasesBadges || '<span class="media-item-phrase-badge">Déclenchement manuel uniquement</span>'}</div>
                    </div>
                    <div class="media-gallery-actions">
                        <button class="btn btn-primary" data-action="trigger" data-target="scene" data-id="${scene.id}" title="Afficher immédiatement sur l'overlay (contourne la Preview)">▶ Afficher</button>
                        <button class="queue-icon-btn" data-action="preview" data-target="scene" data-id="${scene.id}" title="Envoyer en Preview (aperçu privé — CUT/TAKE ou Espace pour diffuser)">${ICON_EYE} Preview</button>
                        <button class="queue-icon-btn" data-action="edit" data-target="scene" data-id="${scene.id}" title="Modifier cette scène">${ICON_PENCIL}</button>
                        <button class="queue-icon-btn" data-action="toggle-default" data-target="scene" data-id="${scene.id}" data-is-default="${scene.isDefault ? 'true' : 'false'}" title="${scene.isDefault ? 'Retirer le statut de poster principal' : 'Définir comme poster principal (affiché quand rien d’autre n’est à l’écran)'}">${scene.isDefault ? ICON_STAR : ICON_STAR_OUTLINE}</button>
                        <button class="queue-icon-btn" data-action="add-to-rundown" data-target="scene" data-id="${scene.id}" data-label="${escapeHtmlDashboard(scene.name)}" title="Ajouter à la feuille de route">${ICON_PLUS}</button>
                        <button class="queue-icon-btn queue-remove" data-action="delete" data-target="scene" data-id="${scene.id}" title="Supprimer">${ICON_X}</button>
                    </div>
                </div>
            `;
    })
    .join('');
  updateMultiviewBusBar();

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
    // CORRECTIF (trouvé en ajoutant le badge Tally) : cette reconstruction ne
    // reprenait que le badge ⭐ Poster — le badge 🎯 Focus (déjà présent dans
    // la première passe ci-dessus) disparaissait donc silencieusement dès
    // cette seconde passe, à CHAQUE rendu de la galerie, y compris le tout
    // premier. Les 3 badges sont désormais recalculés ici de façon identique
    // à la première passe, plutôt que la moitié seulement.
    const isLive = scene.id === liveSceneId;
    const isPreview = !isLive && scene.id === previewSceneId;
    const badgeMarkup =
      (isLive
        ? '<span class="tally-badge tally-badge--program">PROGRAM</span>'
        : isPreview
          ? '<span class="tally-badge tally-badge--preview">PREVIEW</span>'
          : '') +
      (scene.isDefault ? `<span class="media-gallery-badge">${ICON_STAR} Poster</span>` : '') +
      (scene.focusMode ? `<span class="media-gallery-badge">${ICON_TARGET} Focus</span>` : '');
    const canvas = document.createElement('div');
    canvas.className = 'scene-preview-canvas';
    previewEl.innerHTML = badgeMarkup;
    previewEl.appendChild(canvas);
    window.renderSceneDom(scene, canvas);
  }
}

window.hideSceneNow = hideSceneNow;
window.importPptxSlides = importPptxSlides;
// AJOUT (chantier ultime — switcher multiview dual-bus Program/Preview) :
// data-action="preview" passe par registerAction() ci-dessus (jamais un
// onclick inline), mais cutToProgram() est aussi câblé au bouton #sceneCutBtn
// via event-bindings.js#CLICK_BINDINGS (window.cutToProgram()), même
// discipline que window.goLiveFromAirlock() dans airlock-preview.js.
window.cutToProgram = cutToProgram;

// AJOUT (chantier ultime — raccourci CUT/TAKE à la barre d'espace) : même
// garde "hors saisie" que tous les autres raccourcis clavier globaux de ce
// tableau de bord (voir isTypingContext(), utils.js). Cède PRIORITAIREMENT
// la frappe à la confirmation de verset en attente (trust-mode.js) si sa
// bannière est visible — un verset en attente de confirmation opérateur est
// un état plus urgent qu'un CUT de scène, les deux ne doivent jamais se
// disputer la même frappe. N'agit que si une Preview est réellement armée
// (sinon Espace ne fait rien ici, comme cutToProgram() lui-même le
// redirait par toast — pas la peine de spammer un toast à chaque Espace
// innocent tapé ailleurs dans l'app).
document.addEventListener('keydown', (e) => {
  if (e.code !== 'Space' && e.key !== ' ') return;
  if (isTypingContext()) return;
  // CORRECTIF (trouvé en écrivant test-multiview-switcher.js) : la bannière
  // démarre masquée via l'attribut HTML `hidden` (voir dashboard.html), pas
  // `style.display`, qui reste une chaîne VIDE tant qu'elle n'a encore
  // jamais été montrée/masquée par showPendingVerseBanner()/
  // hidePendingVerseBanner() (trust-mode.js) — comparer `=== 'none'`
  // traiterait donc à tort une page fraîchement chargée comme "bannière
  // visible". offsetParent (null quand display:none s'applique, quelle
  // qu'en soit la cause : attribut hidden, classe CSS, ou style inline)
  // reste correct dans tous les cas.
  const pendingVerseBanner = document.getElementById('pendingVerseBanner');
  if (pendingVerseBanner && pendingVerseBanner.offsetParent !== null) return;
  if (!previewSceneId) return;
  e.preventDefault();
  cutToProgram();
});

// triggerSceneStudioItem, deleteSceneStudioItem et toggleDefaultScene n'ont
// plus besoin de window — voir registerAction ci-dessous, elles n'étaient
// exposées que pour les onclick inline désormais remplacés par la
// délégation data-action. (openSceneComposer, importée ci-dessus depuis
// scene-composer.js, suit la même discipline dans son propre fichier.)
registerAction('scene', 'trigger', (el, data) => triggerSceneStudioItem(data.id));
// AJOUT (chantier ultime — switcher multiview dual-bus Program/Preview).
registerAction('scene', 'preview', (el, data) => setPreviewScene(data.id));
registerAction('scene', 'edit', (el, data) => openSceneComposer(data.id));
registerAction('scene', 'toggle-default', (el, data) =>
  toggleDefaultScene(data.id, data.isDefault === 'true')
);
registerAction('scene', 'add-to-rundown', (el, data) => {
  if (window.addToRundown) window.addToRundown('scene', data.id, data.label);
});
registerAction('scene', 'delete', (el, data) => deleteSceneStudioItem(data.id));
