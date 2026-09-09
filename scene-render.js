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

  // AJOUT (chantier overlay/composeur multi-scènes — Mode Focus, style
  // ProPresenter/OBS) : assombrit + floute UNIQUEMENT le calque
  // d'arrière-plan (média ou couleur), jamais les calques texte/image
  // posés par-dessus (voir la boucle `scene.elements` plus bas, hors de ce
  // filtre) — c'est tout le principe du Mode Focus : mettre en valeur le
  // texte du verset/chant en estompant ce qu'il y a derrière, sans jamais
  // le rendre lui-même flou. filter (pas d'opacité) : opacity assombrirait
  // en LAISSANT VOIR le fond (transparence), alors que brightness() réduit
  // vraiment sa luminance — plus proche de l'effet recherché en régie.
  const FOCUS_MODE_FILTER = 'brightness(0.35) blur(6px)';
  const background = scene.background || {};
  if (background.type === 'media' && background.mediaUrl) {
    const bgImg = document.createElement('img');
    bgImg.className = 'scene-background-img';
    bgImg.src = background.mediaUrl;
    bgImg.alt = '';
    if (scene.focusMode) bgImg.style.filter = FOCUS_MODE_FILTER;
    container.appendChild(bgImg);
  } else if (background.type === 'color' && background.color) {
    // CORRECTIF (trouvé en écrivant ce chantier) : poser le filtre
    // directement sur `container` flouterait/assombrirait TOUT ce qu'il
    // contient, y compris les calques texte/image ajoutés juste après
    // (mêmes enfants du même conteneur) — exactement l'inverse du Mode
    // Focus. Un calque de fond dédié (même classe `.scene-background-img`
    // que le cas média ci-dessus, qui la positionne déjà en plein cadre
    // via `#scene-layer .scene-background-img`/`.scene-preview-canvas
    // .scene-background-img` — voir overlay.html/dashboard.css) isole le
    // filtre au fond seul, comme pour le cas média.
    const bgDiv = document.createElement('div');
    bgDiv.className = 'scene-background-img';
    bgDiv.style.background = background.color;
    if (scene.focusMode) bgDiv.style.filter = FOCUS_MODE_FILTER;
    container.appendChild(bgDiv);
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
      // CORRECTIF (trouvé en testant l'aperçu du composeur dans un vrai
      // navigateur) : 'vh' se résout TOUJOURS contre la fenêtre entière du
      // navigateur, jamais contre `container` lui-même — inoffensif sur
      // l'overlay réel (qui EST le viewport), mais un texte "9% de la
      // hauteur" dans une petite vignette d'aperçu du tableau de bord se
      // dessinait alors à 9% de la fenêtre ENTIÈRE du tableau de bord,
      // démesuré et rogné. 'cqh' (container query height) se résout contre
      // le conteneur ayant container-type:size le plus proche — #scene-layer
      // (overlay.html), .scene-preview-canvas et
      // .scene-composer-preview-frame (dashboard.css) le déclarent tous les
      // trois, donc identique sur l'overlay réel, correct dans l'aperçu.
      wrapper.style.fontSize = (el.fontSizePct || 6) + 'cqh';
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
