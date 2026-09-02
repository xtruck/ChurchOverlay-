/**
 * dashboard/features/next-cue-confidence.js — "Next Cue Confidence" (brief
 * produit, priorité #1) : avant qu'un repère (média/scène/verset) de la
 * feuille de route parte en direct, vérifie automatiquement ce qui est
 * réellement détectable côté client et renvoie un statut simple —
 * Prêt / À vérifier / Bloqué — plutôt que de laisser l'opérateur découvrir
 * un problème une fois le repère déjà à l'écran devant l'assemblée.
 *
 * Portée V1, honnête sur ses limites (voir aussi checkCueReadiness ci-dessous) :
 * - Média manquant/introuvable sur disque : couvert (bloquant).
 * - Piste audio absente d'une vidéo : couvert quand HTMLMediaElement.audioTracks
 *   est disponible (Chromium/Electron) — sinon ignoré silencieusement (statut
 *   'unknown' interne, jamais présenté comme "pas de son" à tort).
 * - Débordement de texte d'une scène : couvert, mesuré en rendant réellement
 *   la scène (renderSceneDom(), voir scene-render.js) dans un cadre hors-écran
 *   à l'exact ratio 16:9 de l'overlay réel.
 * - Contraste texte/fond d'une scène : couvert UNIQUEMENT pour un fond de
 *   type couleur unie (formule de contraste WCAG) — un fond image ne peut pas
 *   être échantillonné de façon fiable sans lire les pixels réels ; ignoré
 *   plutôt que d'inventer un résultat.
 * - Police manquante : couvert via document.fonts.check() — les fontes de ce
 *   projet sont chargées une fois via <link> Google Fonts, donc soit déjà
 *   prêtes, soit jamais chargeables (pas de scénario "en cours de chargement"
 *   à gérer pour un aperçu déclenché après le premier rendu de la page).
 * - Format d'affichage (portrait affiché plein écran en fond 16:9) : couvert
 *   pour les médias, via les dimensions naturelles de l'image/vidéo.
 * - Résolution de sortie réelle de la fenêtre overlay : PAS couvert en V1 —
 *   le tableau de bord n'a aujourd'hui aucun canal pour connaître la
 *   résolution réelle de la fenêtre overlay (fenêtre Electron séparée, pas de
 *   message WS qui la rapporte). Documenté plutôt que simulé.
 * - Statut de connexion : couvert (état du WebSocket du tableau de bord
 *   lui-même — pas une preuve que l'overlay/le projecteur est allumé, mais le
 *   seul signal dont ce module dispose sans aller-retour serveur dédié).
 */
import { ws, getHttpOrigin } from '../state.js';
import { getMediaLibraryItems } from './media-library.js';
import { getSceneStudioItems } from './scene-studio.js';

const FALLBACK_HEX = '#ffffff';

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  const clean = m ? m[1] : FALLBACK_HEX.slice(1);
  return {
    r: parseInt(clean.slice(0, 2), 16),
    g: parseInt(clean.slice(2, 4), 16),
    b: parseInt(clean.slice(4, 6), 16),
  };
}

function srgbChannelToLinear(c8bit) {
  const c = c8bit / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function relativeLuminance(hex) {
  const { r, g, b } = hexToRgb(hex);
  return (
    0.2126 * srgbChannelToLinear(r) +
    0.7152 * srgbChannelToLinear(g) +
    0.0722 * srgbChannelToLinear(b)
  );
}

// Formule de contraste WCAG 2.x standard — (L1+0.05)/(L2+0.05), L1 la plus claire.
function contrastRatio(hexA, hexB) {
  const la = relativeLuminance(hexA);
  const lb = relativeLuminance(hexB);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

// Seuil volontairement plus permissif que le 4.5:1 "texte normal" du WCAG AA :
// ce sont des surtitres/versets projetés en très grand (souvent >6% de la
// hauteur d'écran, largement au-dessus du seuil "grand texte" du WCAG, qui
// tolère déjà 3:1). En dessous, le texte reste lisible dans de bonnes
// conditions mais mérite un coup d'œil avant un vrai culte en salle éclairée.
const MIN_CONTRAST_RATIO = 3;

async function urlIsReachable(url) {
  try {
    const res = await fetch(url, { method: 'HEAD', cache: 'no-store' });
    return res.ok;
  } catch {
    return false;
  }
}

function probeImageDimensions(url) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

function probeVideoMeta(url) {
  return new Promise((resolve) => {
    const video = document.createElement('video');
    video.muted = true;
    video.preload = 'metadata';
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      video.src = '';
      video.load();
      resolve(result);
    };
    video.onloadedmetadata = () => {
      // AJOUT : audioTracks est marqué expérimental par le MDN mais bien
      // implémenté par Chromium/Electron pour <video> — au cas où ce ne
      // serait pas le cas dans une version future, hasAudio reste `null`
      // ("inconnu") plutôt que d'affirmer à tort une absence de son.
      const hasAudio =
        video.audioTracks && typeof video.audioTracks.length === 'number'
          ? video.audioTracks.length > 0
          : null;
      finish({ width: video.videoWidth, height: video.videoHeight, hasAudio });
    };
    video.onerror = () => finish(null);
    video.src = url;
  });
}

// Ratio 16:9 = référence de sortie de ce projet (voir overlay.html,
// stage-display.html — tous conçus pour cette proportion). Tolérance large
// (±15%) : on ne veut signaler que les écarts qui recadreraient vraiment mal
// un fond plein écran (ex. une photo portrait de téléphone), pas chipoter sur
// un 16:10 quasi identique.
const TARGET_ASPECT_RATIO = 16 / 9;
const ASPECT_RATIO_TOLERANCE = 0.15;

function aspectRatioIsOffTarget(width, height) {
  if (!width || !height) return false;
  const ratio = width / height;
  return Math.abs(ratio - TARGET_ASPECT_RATIO) / TARGET_ASPECT_RATIO > ASPECT_RATIO_TOLERANCE;
}

let offscreenFrame = null;
function getOffscreenSceneFrame() {
  if (offscreenFrame && offscreenFrame.isConnected) return offscreenFrame;
  const wrapper = document.createElement('div');
  // AJOUT : largeur en pixels fixe (contrairement à .scene-composer-preview-frame
  // qui utilise width:100% d'un parent visible) — ce conteneur n'a pas de
  // parent dimensionné puisqu'il vit hors écran, donc width:100% collapserait
  // à 0. 960px est arbitraire mais sans conséquence : toutes les valeurs de
  // renderSceneDom() (position, fontSize) sont en %/cqh, donc proportionnelles
  // à cette largeur quel que soit le nombre choisi — seul le RATIO 16:9 compte
  // pour que le débordement mesuré corresponde à ce qui se passerait réellement
  // sur l'overlay.
  wrapper.style.cssText =
    'position:fixed; left:-9999px; top:-9999px; width:960px; visibility:hidden; pointer-events:none;';
  const frame = document.createElement('div');
  frame.className = 'scene-composer-preview-frame';
  wrapper.appendChild(frame);
  document.body.appendChild(wrapper);
  offscreenFrame = frame;
  return frame;
}

// Débordement : un élément texte de renderSceneDom() est positionné en
// absolu (left/top en %, transform: translate(-50%,-50%)) — jamais contraint
// par une boîte, donc "déborder" ne peut se détecter qu'en comparant son
// rectangle réel (après mise en page) aux bords du cadre. Un dépassement
// mineur (quelques px, arrondis sous-pixel) est toléré.
const OVERFLOW_TOLERANCE_PX = 2;

function measureSceneTextOverflow(scene) {
  const frame = getOffscreenSceneFrame();
  window.renderSceneDom(scene, frame);
  const frameBox = frame.getBoundingClientRect();
  const overflowing = [];
  frame.querySelectorAll('.scene-text').forEach((el) => {
    const box = el.getBoundingClientRect();
    const overflows =
      box.left < frameBox.left - OVERFLOW_TOLERANCE_PX ||
      box.top < frameBox.top - OVERFLOW_TOLERANCE_PX ||
      box.right > frameBox.right + OVERFLOW_TOLERANCE_PX ||
      box.bottom > frameBox.bottom + OVERFLOW_TOLERANCE_PX;
    if (overflows) overflowing.push(el.textContent.slice(0, 40));
  });
  return overflowing;
}

async function missingFontFamilies(fontFamilies) {
  if (!document.fonts || typeof document.fonts.check !== 'function') return [];
  try {
    await document.fonts.ready;
  } catch {
    /* tant pis, on vérifie quand même l'état courant */
  }
  const unique = [...new Set(fontFamilies.filter(Boolean))];
  return unique.filter((family) => {
    try {
      return !document.fonts.check(`16px "${family}"`);
    } catch {
      return false; // nom de police illisible par l'API : ne pas accuser à tort
    }
  });
}

function resolveMediaItem(mediaId) {
  return getMediaLibraryItems().find((m) => m.id === mediaId) || null;
}

function mediaItemUrl(item) {
  return getHttpOrigin() + '/media/' + encodeURIComponent(item.filename || '');
}

/**
 * @param {{status:'ready'|'attention'|'blocked', checks:Array}} acc
 * @param {string} id
 * @param {boolean} ok
 * @param {'blocked'|'attention'} severity - sévérité SI ok===false
 * @param {string} message
 */
function record(acc, id, ok, severity, message) {
  acc.checks.push({ id, ok, message: ok ? '' : message });
  if (ok) return;
  if (severity === 'blocked') acc.status = 'blocked';
  else if (acc.status !== 'blocked') acc.status = 'attention';
}

async function checkMediaCue(cue, acc) {
  const item = resolveMediaItem(cue.mediaId);
  if (!item) {
    record(
      acc,
      'media-exists',
      false,
      'blocked',
      'Média introuvable dans la médiathèque (supprimé ?).'
    );
    return;
  }
  const url = mediaItemUrl(item);
  const reachable = await urlIsReachable(url);
  record(acc, 'media-file', reachable, 'blocked', 'Fichier introuvable sur le disque.');
  if (!reachable) return;

  if (item.mediaType === 'video') {
    const meta = await probeVideoMeta(url);
    if (meta) {
      if (meta.hasAudio === false) {
        record(
          acc,
          'media-audio',
          false,
          'attention',
          'Aucune piste audio détectée dans cette vidéo.'
        );
      }
      record(
        acc,
        'media-aspect',
        !aspectRatioIsOffTarget(meta.width, meta.height),
        'attention',
        'Proportions très éloignées du 16:9 — recadrage important attendu en plein écran.'
      );
    }
  } else {
    const dims = await probeImageDimensions(url);
    if (dims) {
      record(
        acc,
        'media-aspect',
        !aspectRatioIsOffTarget(dims.width, dims.height),
        'attention',
        'Proportions très éloignées du 16:9 — recadrage important attendu en plein écran.'
      );
    }
  }
}

async function checkSceneCue(cue, acc) {
  const scene = getSceneStudioItems().find((s) => s.id === cue.sceneId);
  if (!scene) {
    record(acc, 'scene-exists', false, 'blocked', 'Scène introuvable (supprimée ?).');
    return;
  }

  const background = scene.background || {};
  const danglingBackground = background.type === 'media' && !background.mediaUrl;
  const danglingElements = (scene.elements || []).filter(
    (el) => el.type === 'image' && !el.mediaUrl
  );
  record(
    acc,
    'scene-media',
    !danglingBackground && danglingElements.length === 0,
    'blocked',
    'Un média référencé par cette scène a été supprimé de la médiathèque.'
  );

  if (typeof window.renderSceneDom === 'function') {
    const overflowing = measureSceneTextOverflow(scene);
    record(
      acc,
      'scene-overflow',
      overflowing.length === 0,
      'attention',
      `Texte débordant du cadre : « ${overflowing[0]}${overflowing[0] && overflowing[0].length >= 40 ? '…' : ''} »`
    );

    const textElements = (scene.elements || []).filter((el) => el.type === 'text');
    if (background.type === 'color' && background.color) {
      const lowContrast = textElements.filter(
        (el) => contrastRatio(el.color || '#ffffff', background.color) < MIN_CONTRAST_RATIO
      );
      record(
        acc,
        'scene-contrast',
        lowContrast.length === 0,
        'attention',
        'Contraste texte/fond faible — vérifier la lisibilité en salle.'
      );
    }

    const missingFonts = await missingFontFamilies(textElements.map((el) => el.fontFamily));
    record(
      acc,
      'scene-fonts',
      missingFonts.length === 0,
      'attention',
      `Police non chargée, repli navigateur : ${missingFonts.join(', ')}.`
    );
  }
}

/**
 * @param {{type:'verse'|'media'|'scene', mediaId?:string, sceneId?:string}} cue
 * @returns {Promise<{status:'ready'|'attention'|'blocked', checks:Array<{id:string, ok:boolean, message:string}>}>}
 */
export async function checkCueReadiness(cue) {
  const acc = { status: 'ready', checks: [] };
  record(
    acc,
    'connection',
    !!ws && ws.readyState === WebSocket.OPEN,
    'blocked',
    'Tableau de bord non connecté au serveur.'
  );

  if (cue.type === 'media') {
    await checkMediaCue(cue, acc);
  } else if (cue.type === 'scene') {
    await checkSceneCue(cue, acc);
  }
  // 'verse' : le texte vient d'une recherche biblique côté serveur au moment
  // du déclenchement (aucun contenu pré-existant à auditer côté client) —
  // seul le statut de connexion ci-dessus s'applique.

  return acc;
}

export const READINESS_LABELS = {
  ready: { icon: '✓', text: 'Prêt', className: 'cue-readiness-ready' },
  attention: { icon: '⚠', text: 'À vérifier', className: 'cue-readiness-attention' },
  blocked: { icon: '✕', text: 'Bloqué', className: 'cue-readiness-blocked' },
  checking: { icon: '…', text: 'Vérification…', className: 'cue-readiness-checking' },
};
