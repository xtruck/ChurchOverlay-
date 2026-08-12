/**
 * dashboard/features/poster-principal-card.js — carte "Poster principal"
 * partagée entre la médiathèque et le studio de scènes.
 *
 * AJOUT (studio de scènes, lot 5/6) : jusqu'ici cette carte vivait entière
 * dans media-library.js, qui ne connaissait qu'un seul type de poster
 * (un média). Depuis l'arbitrage croisé (lot 2, scene-store.js <->
 * media-library.js — un seul poster principal à la fois, scène OU média),
 * la carte doit refléter QUEL magasin est actuellement actif. Extrait dans
 * son propre fichier plutôt que dupliqué dans scene-studio.js : les deux
 * modules (media-library.js, scene-studio.js) alimentent ce fichier avec
 * leur liste à jour (updatePosterCardMediaItems/updatePosterCardSceneItems),
 * lui seul décide quoi afficher et lui seul envoie l'action WS de retrait —
 * une seule source de vérité pour "qui est le poster principal en ce moment",
 * jamais dupliquée entre les deux modules.
 */
import { ws } from '../state.js';
import { showToast } from '../utils.js';

let cachedMediaItems = [];
let cachedSceneItems = [];

export function updatePosterCardMediaItems(items) {
  cachedMediaItems = Array.isArray(items) ? items : [];
  renderPosterPrincipalCard();
}

export function updatePosterCardSceneItems(items) {
  cachedSceneItems = Array.isArray(items) ? items : [];
  renderPosterPrincipalCard();
}

function renderPosterPrincipalCard() {
  const empty = document.getElementById('defaultPosterEmpty');
  const active = document.getElementById('defaultPosterActive');
  const label = document.getElementById('defaultPosterLabel');
  if (!empty || !active || !label) return;

  // Mutuellement exclusifs PAR CONSTRUCTION (arbitrage croisé côté serveur,
  // lot 2 — setDefaultScene()/setDefaultItem() se démarquent l'un l'autre) :
  // au plus l'un des deux existe à un instant donné. La scène est vérifiée
  // en premier par simple convention (aucun des deux ne devrait jamais être
  // vrai simultanément).
  const defaultScene = cachedSceneItems.find((s) => s.isDefault);
  const defaultMedia = cachedMediaItems.find((m) => m.isDefault);

  if (defaultScene) {
    label.textContent = `🎬 ${defaultScene.name}`;
    empty.style.display = 'none';
    active.style.display = 'flex';
    active.dataset.id = defaultScene.id;
    active.dataset.type = 'scene';
  } else if (defaultMedia) {
    label.textContent = `${defaultMedia.mediaType === 'video' ? '🎬' : '🖼️'} ${defaultMedia.label}`;
    empty.style.display = 'none';
    active.style.display = 'flex';
    active.dataset.id = defaultMedia.id;
    active.dataset.type = 'media';
  } else {
    empty.style.display = 'block';
    active.style.display = 'none';
    delete active.dataset.id;
    delete active.dataset.type;
  }
}

export function clearDefaultPosterFromCard() {
  const active = document.getElementById('defaultPosterActive');
  const id = active && active.dataset.id;
  const type = active && active.dataset.type;
  if (!id) return;
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    showToast('Non connecté au serveur.', 'error');
    return;
  }
  // Sans id = retire le poster principal actuel, voir server.js#setDefaultScene/
  // setDefaultMediaItem (même convention dans les deux cas).
  ws.send(JSON.stringify({ action: type === 'scene' ? 'setDefaultScene' : 'setDefaultMediaItem' }));
  showToast('Poster principal retiré.', 'success');
}

window.clearDefaultPosterFromCard = clearDefaultPosterFromCard;
