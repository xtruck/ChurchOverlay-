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
import { ws } from '../state.js';
import { showToast, escapeHtmlDashboard } from '../utils.js';
import { updatePosterCardSceneItems } from './poster-principal-card.js';

let sceneStudioItems = [];

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
      return `
                <div class="media-gallery-card${scene.isDefault ? ' is-default' : ''}">
                    <div class="media-gallery-thumb scene-preview-thumb" id="scenePreview-${scene.id}">
                        ${badge}
                    </div>
                    <div class="media-gallery-body">
                        <div class="media-gallery-label" title="${escapeHtmlDashboard(scene.name)}">${escapeHtmlDashboard(scene.name)}</div>
                    </div>
                    <div class="media-gallery-actions">
                        <button class="btn btn-primary" onclick="triggerSceneStudioItem('${scene.id}')" title="Afficher maintenant sur l'overlay">▶ Afficher</button>
                        <button class="queue-icon-btn" onclick="toggleDefaultScene('${scene.id}', ${scene.isDefault ? 'true' : 'false'})" title="${scene.isDefault ? 'Retirer le statut de poster principal' : 'Définir comme poster principal (affiché quand rien d’autre n’est à l’écran)'}">${scene.isDefault ? '⭐' : '☆'}</button>
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
window.toggleDefaultScene = toggleDefaultScene;
