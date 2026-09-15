/**
 * dashboard/features/media-wall.js — Mur Média : grille de déclenchement
 * rapide (photos/vidéos) pendant le culte, recherche instantanée, touches
 * 1-9, testeur de phrase déclencheuse. Operator-essential — regardé et
 * utilisé EN DIRECT, contrairement à la médiathèque (ajout/organisation/
 * groupes) qui reste dans media-library.js.
 *
 * La liste elle-même (mediaLibraryItems) reste possédée par
 * media-library.js — diffusée par le serveur (mediaLibraryUpdated) à ce
 * fichier ET à ce module-ci sur le même message (voir ws-dispatch.js) ;
 * ce module lit toujours l'état déjà à jour via getMediaLibraryItems(),
 * jamais une copie locale, pour rester identique au comportement d'origine
 * (les deux rendus partageaient auparavant la même variable de module).
 * (redesign IA — étape 2, scission live/config du fichier
 * dashboard/features/media-library.js d'origine, voir
 * DASHBOARD-IA-REDESIGN-PROPOSAL.md.)
 */
import { ws, getHttpOrigin } from '../state.js';
import { showToast, escapeHtmlDashboard, isTypingContext } from '../utils.js';
import { getMediaLibraryItems, triggerMediaLibraryItem } from './media-library.js';
import { registerAction } from '../action-delegator.js';

// AJOUT (Partie 2.3 — Mur Média, états par tuile) : "à l'écran" et "déjà
// utilisé" changent à CHAQUE déclenchement — un média peut être montré des
// dizaines de fois pendant un culte. Reconstruire toute la grille en
// innerHTML à chaque fois (comme mediaLibraryUpdated, plus bas) ne passerait
// pas le test de charge du cahier des charges (200 médias, déclenchement
// <300ms) : on bascule seulement les classes CSS des tuiles concernées,
// jamais un re-rendu complet pour ces deux états.
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
  const list = Array.isArray(items) ? items : getMediaLibraryItems();
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
        <div class="media-gallery-card${stateClasses}" data-media-id="${item.id}" style="cursor:pointer" data-action="card-click" data-target="media" data-id="${item.id}">
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

function triggerMediaWallItem(id) {
  const item = getMediaLibraryItems().find((i) => i.id === id);
  if (item && item.fileMissing) {
    showToast(`❌ "${item.label}" : fichier introuvable sur le disque, non déclenché.`, 'error');
    return;
  }
  if (item) triggerMediaLibraryItem(item.id);
}

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
  const items = getMediaLibraryItems();
  cards.forEach((card) => {
    const item = items.find((i) => i.id === card.dataset.mediaId);
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
  const item = getMediaLibraryItems().find((i) => i.id === card.dataset.mediaId);
  if (item && !item.fileMissing) triggerMediaLibraryItem(item.id);
});

registerAction('media', 'card-click', (el, data) => triggerMediaWallItem(data.id));
