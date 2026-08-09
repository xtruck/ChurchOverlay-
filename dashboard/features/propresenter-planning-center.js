/**
 * dashboard/features/propresenter-planning-center.js — panneaux
 * ProPresenter (écran scène) et Planning Center Services (ordre du
 * culte), tous deux entièrement optionnels et pilotés par IPC
 * (window.churchOverlay), pas par WebSocket : les connexions elles-mêmes
 * vivent dans le process principal (accès à safeStorage pour les
 * secrets, comme pour OBS).
 * Extrait de dashboard/legacy-core.js (chantier de modularisation).
 */
import { showToast, escapeHtmlDashboard } from '../utils.js';

export async function loadProPresenterConfig() {
  if (!window.churchOverlay || !window.churchOverlay.getProPresenterConfig) return;
  try {
    const cfg = await window.churchOverlay.getProPresenterConfig();
    if (!cfg || !cfg.ok) return;
    const enabledInput = document.getElementById('ppEnabledInput');
    const hostInput = document.getElementById('ppHostInput');
    const portInput = document.getElementById('ppPortInput');
    const autoSendInput = document.getElementById('ppAutoSendInput');
    if (enabledInput) enabledInput.checked = !!cfg.enabled;
    if (hostInput) hostInput.value = cfg.host || 'localhost';
    if (portInput) portInput.value = cfg.port || 50001;
    if (autoSendInput) autoSendInput.checked = !!cfg.autoSendVerses;
  } catch (_err) {
    /* silencieux : panneau optionnel, pas d'erreur bloquante au chargement */
  }
}

export async function saveProPresenterConfig() {
  if (!window.churchOverlay || !window.churchOverlay.setProPresenterConfig) return;
  const enabled = !!document.getElementById('ppEnabledInput')?.checked;
  const host = document.getElementById('ppHostInput')?.value.trim() || 'localhost';
  const port = Number(document.getElementById('ppPortInput')?.value) || 50001;
  const autoSendVerses = !!document.getElementById('ppAutoSendInput')?.checked;
  const password = document.getElementById('ppPasswordInput')?.value || '';
  try {
    await window.churchOverlay.setProPresenterConfig({
      enabled,
      host,
      port,
      autoSendVerses,
      password,
    });
    const pwInput = document.getElementById('ppPasswordInput');
    if (pwInput) pwInput.value = '';
    showToast('Configuration ProPresenter enregistrée.', 'success');
  } catch (err) {
    showToast('Échec : ' + (err && err.message ? err.message : err), 'error');
  }
}

export async function connectProPresenter() {
  if (!window.churchOverlay || !window.churchOverlay.proPresenterConnect) return;
  const statusEl = document.getElementById('ppStatus');
  if (statusEl) statusEl.textContent = 'Connexion en cours...';
  try {
    const result = await window.churchOverlay.proPresenterConnect();
    if (statusEl) {
      statusEl.textContent =
        result && result.ok ? '✅ Connecté' : '❌ ' + (result?.error || 'Échec');
    }
  } catch (err) {
    if (statusEl) statusEl.textContent = '❌ ' + (err && err.message ? err.message : err);
  }
}

export async function sendProPresenterTestMessage() {
  if (!window.churchOverlay || !window.churchOverlay.proPresenterSendMessage) return;
  const input = document.getElementById('ppTestMessageInput');
  const text = input ? input.value.trim() : '';
  if (!text) return;
  try {
    const result = await window.churchOverlay.proPresenterSendMessage(text);
    if (result && result.ok) {
      showToast('Message envoyé à ProPresenter.', 'success');
      if (input) input.value = '';
    } else {
      showToast('Échec : ' + (result?.error || 'erreur inconnue'), 'error');
    }
  } catch (err) {
    showToast('Échec : ' + (err && err.message ? err.message : err), 'error');
  }
}

if (window.churchOverlay && window.churchOverlay.getProPresenterConfig) {
  loadProPresenterConfig();
}

/* ======================================================================
   Planning Center Services (ordre du culte, recommandation "sync Planning
   Center"). Lecture seule — voir planning-center-wrapper.js/main.js. Passe
   par IPC comme ProPresenter ci-dessus (le secret vit chiffré côté process
   principal via safeStorage).
   ====================================================================== */
export async function loadPlanningCenterConfig() {
  if (!window.churchOverlay || !window.churchOverlay.getPlanningCenterConfig) return;
  try {
    const cfg = await window.churchOverlay.getPlanningCenterConfig();
    if (!cfg || !cfg.ok) return;
    const enabledInput = document.getElementById('pcoEnabledInput');
    const appIdInput = document.getElementById('pcoAppIdInput');
    if (enabledInput) enabledInput.checked = !!cfg.enabled;
    if (appIdInput) appIdInput.value = cfg.appId || '';
  } catch (_err) {
    /* silencieux : panneau optionnel */
  }
}

export async function savePlanningCenterConfig() {
  if (!window.churchOverlay || !window.churchOverlay.setPlanningCenterConfig) return;
  const enabled = !!document.getElementById('pcoEnabledInput')?.checked;
  const appId = document.getElementById('pcoAppIdInput')?.value.trim() || '';
  const secret = document.getElementById('pcoSecretInput')?.value || '';
  try {
    await window.churchOverlay.setPlanningCenterConfig({ enabled, appId, secret });
    const secretInput = document.getElementById('pcoSecretInput');
    if (secretInput) secretInput.value = '';
    showToast('Configuration Planning Center enregistrée.', 'success');
  } catch (err) {
    showToast('Échec : ' + (err && err.message ? err.message : err), 'error');
  }
}

export async function fetchPlanningCenterPlan() {
  if (!window.churchOverlay || !window.churchOverlay.fetchPlanningCenterPlan) return;
  const statusEl = document.getElementById('pcoStatus');
  const itemsEl = document.getElementById('pcoPlanItems');
  if (statusEl) statusEl.textContent = 'Chargement...';
  if (itemsEl) itemsEl.innerHTML = '';
  try {
    const result = await window.churchOverlay.fetchPlanningCenterPlan();
    if (!result || !result.ok) {
      if (statusEl) statusEl.textContent = '❌ ' + (result?.error || 'Échec du chargement');
      return;
    }
    const dateLabel = result.planDate
      ? new Date(result.planDate).toLocaleDateString('fr-FR', {
          day: 'numeric',
          month: 'long',
          year: 'numeric',
        })
      : '';
    if (statusEl) {
      statusEl.textContent = `${escapeHtmlDashboard(result.planTitle)}${dateLabel ? ' — ' + dateLabel : ''}`;
    }
    if (itemsEl) {
      itemsEl.innerHTML = (result.items || [])
        .map(
          (item) =>
            `<div style="padding:0.3rem 0; border-bottom:1px solid var(--border-subtle);">${escapeHtmlDashboard(item.title)} <span style="color:var(--text-dim); font-size:0.78rem;">(${escapeHtmlDashboard(item.itemType)})</span></div>`
        )
        .join('');
    }
  } catch (err) {
    if (statusEl) statusEl.textContent = '❌ ' + (err && err.message ? err.message : err);
  }
}

if (window.churchOverlay && window.churchOverlay.getPlanningCenterConfig) {
  loadPlanningCenterConfig();
}

window.saveProPresenterConfig = saveProPresenterConfig;
window.connectProPresenter = connectProPresenter;
window.sendProPresenterTestMessage = sendProPresenterTestMessage;
window.savePlanningCenterConfig = savePlanningCenterConfig;
window.fetchPlanningCenterPlan = fetchPlanningCenterPlan;
