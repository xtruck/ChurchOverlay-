/**
 * dashboard/features/airlock-preview.js — "Airlock Preview" (brief produit,
 * priorité #2) : plutôt que d'envoyer un repère en direct immédiatement,
 * l'opérateur peut d'abord l'"armer" — cette carte affiche alors côte à côte
 * ce qui est réellement à l'écran maintenant et ce qui est prêt à partir,
 * avant un dernier geste explicite "Aller en direct".
 *
 * Portée V1 (voir aussi le commentaire de #airlockCard dans dashboard.html) :
 * - Armer ne fonctionne QUE depuis la feuille de route (pas de bouton "Armer"
 *   séparé sur les galeries média/scène) — l'endroit où un opérateur prépare
 *   déjà la suite du culte à l'avance.
 * - Un repère verset armé n'affiche que sa référence : le texte réel vient
 *   d'une recherche biblique faite CÔTÉ SERVEUR au moment de la diffusion
 *   (voir triggerRundownCue -> server.js), le reproduire ici demanderait un
 *   aller-retour réseau spéculatif pour un aperçu qui pourrait de toute façon
 *   différer (traduction active au moment réel du déclenchement). Honnête
 *   plutôt qu'un faux aperçu.
 * - "Aller en direct" déclenche TOUJOURS via triggerRundownCue(cueId) — le
 *   même chemin que le bouton "▶" de la feuille de route elle-même, jamais un
 *   second chemin (triggerMediaItem/triggerScene directs) qui pourrait un
 *   jour diverger dans son traitement côté serveur (historique de session,
 *   avancement de la feuille de route, etc.).
 * - "Différence entre l'actuel et le suivant" (spec produit) : pas de moteur
 *   de diff automatique en V1 — l'opérateur compare visuellement les deux
 *   colonnes, ce qui est déjà l'essentiel de la valeur de cette fonctionnalité
 *   et évite d'inventer une heuristique de comparaison peu fiable entre trois
 *   types de contenu très différents (verset/média/scène).
 */
import { ws, getHttpOrigin } from '../state.js';
import { showToast } from '../utils.js';
import { getMediaLibraryItems } from './media-library.js';
import { getSceneStudioItems } from './scene-studio.js';
import { getRundownCues, triggerRundownCue, refreshCueStatusChips } from './rundown.js';

let armedItem = null; // { cueId, type, label, previewItem } | null
let currentLive = null; // { type:'verse'|'media'|'scene', ... } | null

function resolveMediaUrl(item) {
  return getHttpOrigin() + '/media/' + encodeURIComponent(item.filename || '');
}

/**
 * Construit les données d'aperçu pour un repère de la feuille de route —
 * utilisé à la fois pour armer (données locales déjà en cache, voir l'en-tête
 * du module) et, indirectement, pour peindre la colonne "en direct" (données
 * qui viennent alors du message showVerse/showMedia/showScene lui-même, voir
 * setCurrentLive ci-dessous — même format de sortie pour que renderInto()
 * reste unique pour les deux colonnes).
 */
function buildCuePreviewData(cue) {
  if (cue.type === 'media') {
    const item = getMediaLibraryItems().find((m) => m.id === cue.mediaId);
    if (!item) return { type: 'media', missing: true, label: cue.label };
    return {
      type: 'media',
      label: item.label,
      mediaType: item.mediaType,
      mediaUrl: resolveMediaUrl(item),
    };
  }
  if (cue.type === 'scene') {
    const scene = getSceneStudioItems().find((s) => s.id === cue.sceneId);
    if (!scene) return { type: 'scene', missing: true, label: cue.label };
    return { type: 'scene', label: scene.name, scene };
  }
  return { type: 'verse', label: cue.label, reference: cue.reference };
}

// AJOUT (Focus Mode — voir focus-mode.js) : même rendu que la colonne "en
// direct" du sas — un opérateur en mode focus doit voir EXACTEMENT le même
// aperçu qu'ailleurs dans l'app, jamais une seconde implémentation qui
// pourrait diverger. Exporté sous ce nom (pas `renderInto`, trop générique
// hors de ce fichier) pour rester lisible depuis un autre module.
export const renderContentPreview = renderInto;

// AJOUT (Focus Mode) : source de vérité unique de "qu'est-ce qui est
// réellement à l'écran" — reste privée à ce module (currentLive), lue via ce
// getter plutôt que dupliquée dans un second état ailleurs.
export function getCurrentLive() {
  return currentLive;
}

// AJOUT (Cue Cards — idée créative, brief produit) : rundown.js a besoin de
// savoir "ce repère est-il actuellement armé ?" pour afficher son statut
// opérationnel (Armé), sans dupliquer armedItem dans un second état. Import
// circulaire avec rundown.js (qui importe déjà triggerRundownCue/
// getRundownCues d'ici) — sans risque : aucun des deux modules n'appelle ces
// fonctions au chargement, seulement depuis des gestionnaires déclenchés plus
// tard (voir la même discipline dans focus-mode.js, qui importe déjà les deux).
export function getArmedCueId() {
  return armedItem ? armedItem.cueId : null;
}

function renderInto(container, data) {
  if (!container) return;
  container.innerHTML = '';
  if (!data) {
    container.innerHTML = '<div class="airlock-empty-note">Rien à l’écran</div>';
    return;
  }
  if (data.missing) {
    container.innerHTML = `<div class="airlock-empty-note">« ${data.label || ''} » introuvable (supprimé de la médiathèque/du studio ?)</div>`;
    return;
  }
  if (data.type === 'media') {
    if (data.mediaType === 'video') {
      const video = document.createElement('video');
      video.src = data.mediaUrl;
      video.muted = true;
      video.autoplay = true;
      video.loop = true;
      video.playsInline = true;
      container.appendChild(video);
    } else {
      const img = document.createElement('img');
      img.src = data.mediaUrl;
      img.alt = data.label || '';
      container.appendChild(img);
    }
    return;
  }
  if (data.type === 'scene') {
    if (typeof window.renderSceneDom === 'function') {
      window.renderSceneDom(data.scene, container);
    } else {
      container.innerHTML = '<div class="airlock-empty-note">Aperçu de scène indisponible</div>';
    }
    return;
  }
  // 'verse'
  const wrap = document.createElement('div');
  wrap.className = 'airlock-verse-preview';
  const refEl = document.createElement('span');
  refEl.className = 'airlock-verse-ref';
  refEl.textContent = data.reference || data.label || '';
  wrap.appendChild(refEl);
  if (data.text) {
    const textEl = document.createElement('span');
    textEl.textContent = data.text;
    wrap.appendChild(textEl);
  } else {
    const noteEl = document.createElement('span');
    noteEl.textContent = 'Texte recherché au moment de la diffusion.';
    wrap.appendChild(noteEl);
  }
  container.appendChild(wrap);
}

function renderArmedColumn() {
  const container = document.getElementById('airlockArmedPreview');
  renderInto(container, armedItem ? armedItem.previewItem : null);
  if (container && !armedItem) {
    container.innerHTML =
      '<div class="airlock-empty-note">Aucun élément armé — bouton "Armer" sur un repère de la feuille de route</div>';
  }
  const disarmBtn = document.getElementById('airlockDisarmBtn');
  const goLiveBtn = document.getElementById('airlockGoLiveBtn');
  if (disarmBtn) disarmBtn.disabled = !armedItem;
  if (goLiveBtn) goLiveBtn.disabled = !armedItem;
}

function renderLiveColumn() {
  renderInto(document.getElementById('airlockLivePreview'), currentLive);
}

export function armRundownCue(cueId) {
  const cue = getRundownCues().find((c) => c.id === cueId);
  if (!cue) return;
  armedItem = { cueId, previewItem: buildCuePreviewData(cue) };
  renderArmedColumn();
  // AJOUT (Cue Cards) : voir le commentaire de getArmedCueId() ci-dessus —
  // ce changement d'état est purement local, la feuille de route doit être
  // prévenue explicitement pour que son badge "⏏ Armé" apparaisse.
  refreshCueStatusChips();
  showToast(`« ${cue.label} » armé — prêt dans le sas de diffusion.`, 'info');
}

export function disarmAirlock() {
  armedItem = null;
  renderArmedColumn();
  refreshCueStatusChips();
}

export function goLiveFromAirlock() {
  if (!armedItem) return;
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    showToast('Non connecté au serveur.', 'error');
    return;
  }
  triggerRundownCue(armedItem.cueId);
  disarmAirlock();
}

/**
 * Appelé depuis ws-dispatch.js (case showVerse/showMedia/showScene) — les
 * messages de diffusion transportent déjà tout le nécessaire à l'aperçu
 * (mediaUrl déjà résolue pour showMedia, background/elements déjà résolus
 * pour showScene grâce à resolveSceneMediaUrls() côté serveur), donc aucun
 * second aller-retour n'est nécessaire pour peindre la colonne "en direct".
 */
export function setCurrentLive(data) {
  currentLive = data;
  renderLiveColumn();
}

export function clearCurrentLive() {
  currentLive = null;
  renderLiveColumn();
}

// AJOUT : #airlockDisarmBtn/#airlockGoLiveBtn sont câblés dans
// dashboard/event-bindings.js (CLICK_BINDINGS), comme tous les autres
// boutons statiques de dashboard.html — jamais un addEventListener() ad hoc
// ici, pour ne pas réintroduire deux façons différentes de relier un clic
// dans la même page (voir l'en-tête d'event-bindings.js).
window.armRundownCue = armRundownCue;
window.disarmAirlock = disarmAirlock;
window.goLiveFromAirlock = goLiveFromAirlock;
