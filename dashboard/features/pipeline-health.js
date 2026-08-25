/**
 * dashboard/features/pipeline-health.js — bannières d'état du pipeline
 * (erreur worker, échecs de transcription consécutifs), copie des
 * liens overlay/habillage caméra pour OBS, et redémarrage manuel du
 * pipeline.
 * Extrait de dashboard/legacy-core.js (chantier de modularisation).
 */
import { state } from '../state.js';
import { showToast } from '../utils.js';

// --- Bannière d'erreur pipeline (voir CORRECTIF plus haut dans le HTML) ---
export function setPipelineAlert(payload) {
  const banner = document.getElementById('pipelineAlertBanner');
  const icon = document.getElementById('pipelineAlertIcon');
  const msg = document.getElementById('pipelineAlertMessage');
  if (!banner || !msg) return;

  if (!payload || payload.clear) {
    banner.style.display = 'none';
    banner.classList.remove('pipeline-banner--error', 'pipeline-banner--warning');
    return;
  }

  const isError = (payload.severity || 'warning') === 'error';
  banner.classList.toggle('pipeline-banner--error', isError);
  banner.classList.toggle('pipeline-banner--warning', !isError);
  banner.style.display = 'flex';
  if (icon) icon.textContent = isError ? '⛔' : '⚠️';
  msg.textContent = payload.message || 'Le pipeline a rencontré un problème.';
}

if (window.churchOverlay && window.churchOverlay.onPipelineAlert) {
  window.churchOverlay.onPipelineAlert(setPipelineAlert);
}

// AJOUT (audit — état de repli visible, session parallèle) : bannière
// distincte de pipelineAlertBanner ci-dessus (qui couvre le crash-loop du
// worker) — celle-ci se résorbe automatiquement dès qu'une transcription
// réussit (voir action 'pipelineHealth'), sans bouton de redémarrage : la
// retry est déjà automatique côté serveur (voir transcribeWithRetry() dans
// server.js). Palette alignée sur setPipelineAlert ci-dessus.
export function setTranscriptionHealth(payload) {
  const banner = document.getElementById('transcriptionHealthBanner');
  const icon = document.getElementById('transcriptionHealthIcon');
  const msg = document.getElementById('transcriptionHealthMessage');
  if (!banner || !msg) return;

  if (!payload || payload.status === 'ok') {
    banner.style.display = 'none';
    banner.classList.remove('pipeline-banner--error', 'pipeline-banner--warning');
    return;
  }

  const isDegraded = payload.status === 'degraded';
  banner.classList.toggle('pipeline-banner--error', isDegraded);
  banner.classList.toggle('pipeline-banner--warning', !isDegraded);
  banner.style.display = 'flex';
  if (icon) icon.textContent = isDegraded ? '⛔' : '⚠️';
  msg.textContent = isDegraded
    ? `Transcription en difficulté (${payload.consecutiveFailures || 1} échec(s) d'affilée) — nouvelle tentative automatique en cours.`
    : `Nouvelle tentative de transcription (${payload.attempt}/${payload.maxAttempts})...`;
}

// Au chargement, on récupère aussi l'état courant (utile si l'alerte a
// été émise avant que le tableau de bord ait fini de charger).
if (window.churchOverlay && window.churchOverlay.getStatus) {
  window.churchOverlay
    .getStatus()
    .then((s) => {
      if (s && s.status === 'error') {
        setPipelineAlert({
          severity: 'error',
          message:
            'Le pipeline audio est arrêté après plusieurs erreurs. Cliquez sur "Redémarrer le pipeline".',
        });
      }
      if (s && s.overlayUrl) applyOverlayUrl(s.overlayUrl);
      if (s && s.brandingOverlayUrl) applyBrandingOverlayUrl(s.brandingOverlayUrl);
    })
    .catch(() => {});
}

// CORRECTIF (audit — "je ne vois plus le lien à coller dans OBS") :
// main.js calcule déjà overlayUrl (avec le jeton WS_VIEWER_TOKEN requis
// depuis que l'authentification WebSocket est générée automatiquement à
// chaque démarrage) et le pousse via l'évènement IPC 'status-update' —
// preload.js exposait déjà onStatusUpdate(), mais dashboard.js ne
// l'écoutait jamais. Résultat : ce lien n'était affiché NULLE PART dans
// l'interface, y compris l'aperçu iframe de l'onglet "Overlay" (chargé
// sans jeton, donc lui-même incapable de se connecter au serveur).
export function applyOverlayUrl(url) {
  if (!url || url === state.overlayUrl) return;
  state.overlayUrl = url;
  const input = document.getElementById('overlayUrlInput');
  if (input) input.value = url;
  const frame = document.getElementById('overlayFrame');
  if (frame && !frame.dataset.loadedWithToken) {
    frame.src = url;
    frame.dataset.loadedWithToken = '1';
  }
}

export function copyOverlayUrl() {
  if (!state.overlayUrl) {
    showToast('Lien overlay pas encore disponible — attendez que le pipeline démarre.', 'error');
    return;
  }
  navigator.clipboard
    .writeText(state.overlayUrl)
    .then(() => {
      showToast(
        "Lien copié — collez-le dans OBS comme URL d'une Source Navigateur (Browser Source)",
        'success'
      );
    })
    .catch(() => {
      showToast(
        'Copie automatique impossible — sélectionnez le champ et copiez manuellement.',
        'error'
      );
    });
}

// AJOUT (habillage caméra) : même mécanisme que applyOverlayUrl() ci-dessus,
// pour le lien de branding-overlay.html (Source Navigateur OBS séparée, à
// empiler au-dessus de la caméra).
export function applyBrandingOverlayUrl(url) {
  if (!url || url === state.brandingOverlayUrl) return;
  state.brandingOverlayUrl = url;
  const input = document.getElementById('brandingOverlayUrlInput');
  if (input) input.value = url;
}

export function copyBrandingOverlayUrl() {
  if (!state.brandingOverlayUrl) {
    showToast('Lien pas encore disponible — attendez que le pipeline démarre.', 'error');
    return;
  }
  navigator.clipboard
    .writeText(state.brandingOverlayUrl)
    .then(() => {
      showToast(
        'Lien copié — collez-le dans OBS comme Source Navigateur, au-dessus de la caméra',
        'success'
      );
    })
    .catch(() => {
      showToast(
        'Copie automatique impossible — sélectionnez le champ et copiez manuellement.',
        'error'
      );
    });
}

// AJOUT (§7.1.5 — promouvoir l'existant sous-exploité) : companion.html/
// stage-display.html/announcement-loop.html existaient, fonctionnaient et
// étaient testés, mais leur lien n'était affiché NULLE PART dans
// l'interface — exactement le défaut déjà corrigé pour overlay.html/
// branding-overlay.html ci-dessus. Même mécanisme (apply = mémorise + pousse
// dans le champ, copy = presse-papiers + toast), factorisé ici plutôt que
// triplé : ces 3 pages n'ont pas d'iframe à recharger (contrairement à
// overlay.html), donc pas besoin de la logique dataset.loadedWithToken.
function makeNetworkUrlHandlers(stateKey, inputId, copyHintText) {
  return {
    apply(url) {
      if (!url || url === state[stateKey]) return;
      state[stateKey] = url;
      const input = document.getElementById(inputId);
      if (input) input.value = url;
    },
    copy() {
      if (!state[stateKey]) {
        showToast('Lien pas encore disponible — attendez que le pipeline démarre.', 'error');
        return;
      }
      navigator.clipboard
        .writeText(state[stateKey])
        .then(() => showToast(copyHintText, 'success'))
        .catch(() =>
          showToast(
            'Copie automatique impossible — sélectionnez le champ et copiez manuellement.',
            'error'
          )
        );
    },
  };
}

const companionUrlHandlers = makeNetworkUrlHandlers(
  'companionUrl',
  'companionUrlInput',
  "Lien copié — ouvrez-le sur le téléphone/tablette d'un membre de l'assemblée (même réseau Wi-Fi)"
);
export const applyCompanionUrl = companionUrlHandlers.apply;
export const copyCompanionUrl = companionUrlHandlers.copy;

const stageDisplayUrlHandlers = makeNetworkUrlHandlers(
  'stageDisplayUrl',
  'stageDisplayUrlInput',
  'Lien copié — ouvrez-le sur un écran/tablette dédié au conducteur de louange'
);
export const applyStageDisplayUrl = stageDisplayUrlHandlers.apply;
export const copyStageDisplayUrl = stageDisplayUrlHandlers.copy;

const announcementLoopUrlHandlers = makeNetworkUrlHandlers(
  'announcementLoopUrl',
  'announcementLoopUrlInput',
  "Lien copié — ouvrez-le sur l'écran d'accueil/du hall pour un diaporama d'annonces en boucle"
);
export const applyAnnouncementLoopUrl = announcementLoopUrlHandlers.apply;
export const copyAnnouncementLoopUrl = announcementLoopUrlHandlers.copy;

if (window.churchOverlay && window.churchOverlay.onStatusUpdate) {
  window.churchOverlay.onStatusUpdate((payload) => {
    if (payload && payload.overlayUrl) applyOverlayUrl(payload.overlayUrl);
    if (payload && payload.brandingOverlayUrl) applyBrandingOverlayUrl(payload.brandingOverlayUrl);
    if (payload && payload.companionUrl) applyCompanionUrl(payload.companionUrl);
    if (payload && payload.stageDisplayUrl) applyStageDisplayUrl(payload.stageDisplayUrl);
    if (payload && payload.announcementLoopUrl) {
      applyAnnouncementLoopUrl(payload.announcementLoopUrl);
    }
  });
}

let restartInFlight = false;
export async function restartPipeline() {
  if (restartInFlight || !window.churchOverlay || !window.churchOverlay.requestRestart) return;
  restartInFlight = true;
  showToast('Redémarrage du pipeline en cours...', 'info');
  try {
    await window.churchOverlay.requestRestart();
    showToast('Pipeline redémarré', 'success');
  } catch (e) {
    showToast('Échec du redémarrage : ' + (e && e.message ? e.message : e), 'error');
  } finally {
    restartInFlight = false;
  }
}

window.copyOverlayUrl = copyOverlayUrl;
window.copyBrandingOverlayUrl = copyBrandingOverlayUrl;
window.copyCompanionUrl = copyCompanionUrl;
window.copyStageDisplayUrl = copyStageDisplayUrl;
window.copyAnnouncementLoopUrl = copyAnnouncementLoopUrl;
window.restartPipeline = restartPipeline;
