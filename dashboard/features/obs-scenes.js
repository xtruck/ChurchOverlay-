/**
 * dashboard/features/obs-scenes.js — panneau de télécommande OBS STUDIO
 * (logiciel de diffusion EXTERNE), piloté par IPC (window.churchOverlay),
 * même famille que propresenter-planning-center.js : la connexion elle-même
 * vit dans le process principal (accès à safeStorage pour le mot de passe),
 * pas ici.
 *
 * PRÉCISION (déjà source de confusion) : ce panneau change les SCÈNES D'OBS
 * STUDIO (le logiciel externe) et peut mettre en pause la transcription
 * ChurchOverlay selon son état (voir features.json#broadcast.multiScene,
 * obs-controller.js#evaluateGate, session-state.js#getObsGate). Il n'a AUCUN
 * rapport avec le Multiview de scènes ChurchOverlay (voir scene-studio.js /
 * dashboard.html#sceneStudioList, panneau "Multiview — Studio de scènes") —
 * celui-là affiche et diffuse les scènes COMPOSÉES DANS ChurchOverlay,
 * indépendamment de tout logiciel externe. Les deux ne partagent aucun code,
 * aucun état, aucune action WS.
 *
 * Le module obs-controller.js et son pont IPC (main.js) existaient déjà et
 * étaient testés (test/test-obs-gating.js), mais sans aucune interface —
 * impossible de changer de scène OBS depuis le tableau de bord. Ce fichier
 * ne fait qu'exposer ce qui était déjà là.
 */
import { showToast, escapeHtmlDashboard } from '../utils.js';
import { registerAction } from '../action-delegator.js';

// AJOUT (redesign — pas d'emoji comme icône structurelle) : remplace les
// emoji littéraux (✅/❌/🔴/⏺/⏹) concaténés ci-dessous dans des chaînes
// .textContent/.innerHTML.
const ICON_CHECK =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" style="vertical-align: -1px;" aria-hidden="true"><path d="M5 12l5 5L20 7"></path></svg>';
const ICON_ERROR =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align: -1px;" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="M15 9l-6 6M9 9l6 6"></path></svg>';

export async function loadObsConfig() {
  if (!window.churchOverlay || !window.churchOverlay.getObsConfig) return;
  try {
    const cfg = await window.churchOverlay.getObsConfig();
    if (!cfg || !cfg.success) return;
    const enabledInput = document.getElementById('obsEnabledInput');
    const urlInput = document.getElementById('obsUrlInput');
    if (enabledInput) enabledInput.checked = !!cfg.data.enabled;
    if (urlInput) urlInput.value = cfg.data.obsWebsocketUrl || 'ws://localhost:4455';
  } catch (_err) {
    /* silencieux : panneau optionnel, pas d'erreur bloquante au chargement */
  }
}

export async function saveObsConfig() {
  if (!window.churchOverlay || !window.churchOverlay.setObsConfig) return;
  const enabled = !!document.getElementById('obsEnabledInput')?.checked;
  const obsWebsocketUrl =
    document.getElementById('obsUrlInput')?.value.trim() || 'ws://localhost:4455';
  const password = document.getElementById('obsPasswordInput')?.value || '';
  try {
    const result = await window.churchOverlay.setObsConfig({ enabled, obsWebsocketUrl, password });
    if (!result || !result.success) {
      throw new Error(result?.error || 'Échec inconnu.');
    }
    const pwInput = document.getElementById('obsPasswordInput');
    if (pwInput) pwInput.value = '';
    showToast('Configuration OBS enregistrée.', 'success');
  } catch (err) {
    showToast('Échec : ' + (err && err.message ? err.message : err), 'error');
  }
}

export async function connectObs() {
  if (!window.churchOverlay || !window.churchOverlay.obsConnect) return;
  const statusEl = document.getElementById('obsStatus');
  if (statusEl) statusEl.textContent = 'Connexion en cours...';
  try {
    const result = await window.churchOverlay.obsConnect();
    if (statusEl) {
      statusEl.innerHTML =
        result && result.success
          ? `${ICON_CHECK} Connecté à OBS Studio`
          : `${ICON_ERROR} ${escapeHtmlDashboard(result?.error || 'Échec de connexion')}`;
    }
    if (result && result.success) {
      refreshObsScenes();
    }
  } catch (err) {
    if (statusEl)
      statusEl.innerHTML = `${ICON_ERROR} ${escapeHtmlDashboard(err && err.message ? err.message : String(err))}`;
  }
}

export async function refreshObsScenes() {
  if (!window.churchOverlay || !window.churchOverlay.obsListScenes) return;
  const listEl = document.getElementById('obsScenesList');
  if (listEl) listEl.innerHTML = '<span class="stat-label">Chargement des scènes...</span>';
  try {
    const result = await window.churchOverlay.obsListScenes();
    if (!result || !result.success) {
      if (listEl) {
        listEl.innerHTML = `<span class="stat-label">${ICON_ERROR} ${escapeHtmlDashboard(result?.error || 'Impossible de lister les scènes — OBS est-il connecté ?')}</span>`;
      }
      return;
    }
    if (listEl) {
      listEl.innerHTML = (result.data.scenes || [])
        .map(
          (name) =>
            `<button type="button" class="mood-btn" data-action="switch" data-target="obs-scene" data-name="${escapeHtmlDashboard(name)}">${escapeHtmlDashboard(name)}</button>`
        )
        .join('');
    }
  } catch (err) {
    if (listEl) {
      listEl.innerHTML = `<span class="stat-label">${ICON_ERROR} ${escapeHtmlDashboard(err && err.message ? err.message : String(err))}</span>`;
    }
  }
}

export async function switchObsScene(sceneName) {
  if (!window.churchOverlay || !window.churchOverlay.obsSwitchScene) return;
  try {
    const result = await window.churchOverlay.obsSwitchScene(sceneName);
    if (result && result.success) {
      showToast(`Scène OBS : ${sceneName}`, 'success');
    } else {
      showToast('Échec du changement de scène : ' + (result?.error || 'erreur inconnue'), 'error');
    }
  } catch (err) {
    showToast('Échec : ' + (err && err.message ? err.message : err), 'error');
  }
}

export async function toggleObsRecording() {
  if (!window.churchOverlay || !window.churchOverlay.obsToggleRecording) return;
  try {
    const result = await window.churchOverlay.obsToggleRecording();
    if (result && result.success) {
      showToast(
        result.data?.recording ? 'Enregistrement démarré' : 'Enregistrement arrêté',
        'success'
      );
    } else {
      showToast("Échec de l'enregistrement : " + (result?.error || 'erreur inconnue'), 'error');
    }
  } catch (err) {
    showToast('Échec : ' + (err && err.message ? err.message : err), 'error');
  }
}

// AJOUT (Partie 3.1 — StreamStart/StreamStop) : même structure que
// toggleObsRecording ci-dessus.
export async function toggleObsStreaming() {
  if (!window.churchOverlay || !window.churchOverlay.obsToggleStreaming) return;
  try {
    const result = await window.churchOverlay.obsToggleStreaming();
    if (result && result.success) {
      showToast(result.data?.streaming ? 'Direct démarré' : 'Direct arrêté', 'success');
    } else {
      showToast('Échec du direct : ' + (result?.error || 'erreur inconnue'), 'error');
    }
  } catch (err) {
    showToast('Échec : ' + (err && err.message ? err.message : err), 'error');
  }
}

if (window.churchOverlay && window.churchOverlay.getObsConfig) {
  loadObsConfig();
}

window.saveObsConfig = saveObsConfig;
window.connectObs = connectObs;
window.refreshObsScenes = refreshObsScenes;
// AJOUT (chantier nettoyage dashboard — purge des onclick inline) : les
// boutons de scène OBS générés par refreshObsScenes() ci-dessus passent
// désormais par data-action/data-target — window.switchObsScene n'a plus
// d'appelant restant.
registerAction('obs-scene', 'switch', (el, data) => switchObsScene(data.name));
window.toggleObsRecording = toggleObsRecording;
window.toggleObsStreaming = toggleObsStreaming;
