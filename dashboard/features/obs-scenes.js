/**
 * dashboard/features/obs-scenes.js — panneau OBS Studio (scènes multiples),
 * piloté par IPC (window.churchOverlay), même famille que
 * propresenter-planning-center.js : la connexion elle-même vit dans le
 * process principal (accès à safeStorage pour le mot de passe), pas ici.
 *
 * Le module obs-controller.js et son pont IPC (main.js) existaient déjà et
 * étaient testés (test/test-obs-gating.js), mais sans aucune interface —
 * impossible de changer de scène OBS depuis le tableau de bord. Ce fichier
 * ne fait qu'exposer ce qui était déjà là.
 */
import { showToast, escapeHtmlDashboard } from '../utils.js';

export async function loadObsConfig() {
  if (!window.churchOverlay || !window.churchOverlay.getObsConfig) return;
  try {
    const cfg = await window.churchOverlay.getObsConfig();
    if (!cfg || !cfg.ok) return;
    const enabledInput = document.getElementById('obsEnabledInput');
    const urlInput = document.getElementById('obsUrlInput');
    if (enabledInput) enabledInput.checked = !!cfg.enabled;
    if (urlInput) urlInput.value = cfg.obsWebsocketUrl || 'ws://localhost:4455';
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
    await window.churchOverlay.setObsConfig({ enabled, obsWebsocketUrl, password });
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
      statusEl.textContent =
        result && result.ok && result.connected
          ? '✅ Connecté à OBS Studio'
          : '❌ ' + (result?.error || 'Échec de connexion');
    }
    if (result && result.ok && result.connected) {
      refreshObsScenes();
    }
  } catch (err) {
    if (statusEl) statusEl.textContent = '❌ ' + (err && err.message ? err.message : err);
  }
}

export async function refreshObsScenes() {
  if (!window.churchOverlay || !window.churchOverlay.obsListScenes) return;
  const listEl = document.getElementById('obsScenesList');
  if (listEl) listEl.innerHTML = '<span class="stat-label">Chargement des scènes...</span>';
  try {
    const result = await window.churchOverlay.obsListScenes();
    if (!result || !result.ok) {
      if (listEl) {
        listEl.innerHTML = `<span class="stat-label">❌ ${escapeHtmlDashboard(result?.error || 'Impossible de lister les scènes — OBS est-il connecté ?')}</span>`;
      }
      return;
    }
    if (listEl) {
      listEl.innerHTML = (result.scenes || [])
        .map(
          (name) =>
            `<button type="button" class="mood-btn" onclick="switchObsScene('${escapeHtmlDashboard(name).replace(/'/g, "\\'")}')">${escapeHtmlDashboard(name)}</button>`
        )
        .join('');
    }
  } catch (err) {
    if (listEl) {
      listEl.innerHTML = `<span class="stat-label">❌ ${escapeHtmlDashboard(err && err.message ? err.message : String(err))}</span>`;
    }
  }
}

export async function switchObsScene(sceneName) {
  if (!window.churchOverlay || !window.churchOverlay.obsSwitchScene) return;
  try {
    const result = await window.churchOverlay.obsSwitchScene(sceneName);
    if (result && result.ok) {
      showToast(`Scène OBS : ${sceneName}`, 'success');
    } else {
      showToast('Échec du changement de scène : ' + (result?.reason || 'erreur inconnue'), 'error');
    }
  } catch (err) {
    showToast('Échec : ' + (err && err.message ? err.message : err), 'error');
  }
}

export async function toggleObsRecording() {
  if (!window.churchOverlay || !window.churchOverlay.obsToggleRecording) return;
  try {
    const result = await window.churchOverlay.obsToggleRecording();
    if (result && result.ok) {
      showToast(
        result.recording ? '⏺ Enregistrement démarré' : '⏹ Enregistrement arrêté',
        'success'
      );
    } else {
      showToast("Échec de l'enregistrement : " + (result?.reason || 'erreur inconnue'), 'error');
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
    if (result && result.ok) {
      showToast(result.streaming ? '🔴 Direct démarré' : '⏹ Direct arrêté', 'success');
    } else {
      showToast('Échec du direct : ' + (result?.reason || 'erreur inconnue'), 'error');
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
window.switchObsScene = switchObsScene;
window.toggleObsRecording = toggleObsRecording;
window.toggleObsStreaming = toggleObsStreaming;
