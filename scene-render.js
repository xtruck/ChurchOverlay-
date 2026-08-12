/**
 * ============================================================================
 * scene-render.js — Rendu partagé d'une scène (studio de scènes)
 * ----------------------------------------------------------------------------
 * AJOUT (studio de scènes, lot 5/6) : extrait d'overlay.html (lot 4), qui le
 * définissait auparavant en interne — SEUL endroit où la correspondance
 * "position preset -> pourcentages du cadre" et "élément de scène -> DOM"
 * est écrite, chargé À LA FOIS par overlay.html (le projecteur) et
 * dashboard.html (l'aperçu du studio). "Ce que l'opérateur voit en éditant"
 * et "ce qui est sur le projecteur" ne peuvent donc jamais diverger : ce
 * n'est pas juste une factorisation de code, c'est le levier de fiabilité
 * central de ce lot (voir integration-scene-overlay-lifecycle.js, qui
 * verrouille déjà ce rendu côté overlay — test-render-scene-dom.js verrouille
 * maintenant la fonction elle-même, testée une seule fois, utilisée deux fois).
 *
 * Chargé en SCRIPT CLASSIQUE (pas de module ES, aucune étape de build) —
 * même convention que camera-capture.js (voir dashboard.html) : définit
 * `SCENE_POSITION_PCT`/`renderSceneDom` comme variables globales directement
 * utilisables par tout script classique chargé après ce fichier
 * (overlay.html), ET expose `window.SCENE_POSITION_PCT`/`window.renderSceneDom`
 * pour les modules ES qui en ont besoin (dashboard/features/scene-studio.js).
 * Exporté aussi via module.exports pour permettre un test Node direct sans
 * navigateur des parties qui n'en ont pas besoin (aucune ici pour l'instant —
 * renderSceneDom() manipule le DOM par nature, testé via Playwright, voir
 * test/test-render-scene-dom.js).
 * ============================================================================
 */
'use strict';

// AJOUT (studio de scènes) : grille de positions 3x3, résolue en
// pourcentages du cadre. Ancrage par le CENTRE de l'élément (voir
// renderSceneDom() ci-dessous, transform: translate(-50%, -50%)) —
// fonctionne identiquement pour un bloc de texte (largeur variable) et une
// image (largeur fixée par widthPct), quelle que soit la position choisie.
const SCENE_POSITION_PCT = {
  'top-left': { xPct: 10, yPct: 10 },
  'top-center': { xPct: 50, yPct: 10 },
  'top-right': { xPct: 90, yPct: 10 },
  'center-left': { xPct: 10, yPct: 50 },
  center: { xPct: 50, yPct: 50 },
  'center-right': { xPct: 90, yPct: 50 },
  'bottom-left': { xPct: 10, yPct: 90 },
  'bottom-center': { xPct: 50, yPct: 90 },
  'bottom-right': { xPct: 90, yPct: 90 },
};

/**
 * Construit le DOM d'une scène dans `container` (vidé d'abord). Ignore
 * silencieusement tout élément mal formé (type inconnu, image sans mediaUrl
 * exploitable — mediaId supprimé côté médiathèque, voir resolveSceneMediaUrls()
 * dans server.js) : un rendu partiel vaut toujours mieux qu'un écran figé ou
 * une exception qui bloquerait tout le reste de la page (overlay ou aperçu
 * dashboard).
 * @param {Object|null} scene - { background, elements } (mediaUrl déjà résolues)
 * @param {HTMLElement} container
 */
function renderSceneDom(scene, container) {
  container.innerHTML = '';
  container.style.background = '';
  if (!scene) return;

  const background = scene.background || {};
  if (background.type === 'media' && background.mediaUrl) {
    const bgImg = document.createElement('img');
    bgImg.className = 'scene-background-img';
    bgImg.src = background.mediaUrl;
    bgImg.alt = '';
    container.appendChild(bgImg);
  } else if (background.type === 'color' && background.color) {
    container.style.background = background.color;
  }

  for (const el of scene.elements || []) {
    if (!el || (el.type !== 'text' && el.type !== 'image')) continue;
    if (el.type === 'image' && !el.mediaUrl) continue;

    const pos = SCENE_POSITION_PCT[el.position] || SCENE_POSITION_PCT.center;
    const wrapper = document.createElement('div');
    wrapper.className = 'scene-element ' + (el.type === 'image' ? 'scene-image' : 'scene-text');
    wrapper.style.left = pos.xPct + '%';
    wrapper.style.top = pos.yPct + '%';
    wrapper.style.transform = `translate(-50%, -50%) rotate(${el.rotationDeg || 0}deg)`;

    if (el.type === 'image') {
      wrapper.style.width = (el.widthPct || 18) + '%';
      const img = document.createElement('img');
      img.src = el.mediaUrl;
      img.alt = '';
      wrapper.appendChild(img);
    } else {
      wrapper.style.fontFamily = el.fontFamily || 'Merriweather';
      wrapper.style.fontSize = (el.fontSizePct || 6) + 'vh';
      wrapper.style.fontWeight = String(el.fontWeight || 400);
      wrapper.style.color = el.color || '#FFFFFF';
      wrapper.style.textAlign = el.align || 'center';
      wrapper.textContent = el.text || '';
    }

    container.appendChild(wrapper);
  }
}

// CORRECTIF (trouvé en testant ce lot dans un vrai navigateur) : nommé
// sceneRenderApi, PAS `api` — overlay.html ET dashboard.html chargent ce
// fichier comme script CLASSIQUE aux côtés d'autres scripts classiques
// (camera-capture.js dans dashboard.html), qui partagent tous la MÊME
// portée globale (contrairement à des modules ES ou des fichiers Node
// séparés) : `const api` entrait en collision avec le `const api` déjà
// déclaré par camera-capture.js, provoquant une SyntaxError
// (redéclaration) qui empêchait TOUT le reste du tableau de bord de
// s'initialiser.
const sceneRenderApi = { SCENE_POSITION_PCT, renderSceneDom };

if (typeof module !== 'undefined' && module.exports) {
  module.exports = sceneRenderApi;
}
if (typeof window !== 'undefined') {
  window.SCENE_POSITION_PCT = SCENE_POSITION_PCT;
  window.renderSceneDom = renderSceneDom;
}
