/**
 * dashboard/features/overlay-theme-selector.js — sélecteur du thème
 * d'affichage overlay.html, piloté par IPC (window.churchOverlay), même
 * famille qu'obs-scenes.js.
 *
 * theme-loader.js et son pont IPC (main.js > list-themes/get-active-theme/
 * set-active-theme, exposés via preload.js) existaient déjà et étaient
 * testés (test/test-theme-loader.js), mais sans aucune interface pour
 * changer de thème depuis le tableau de bord — impossible de passer de
 * "Nuit" à l'un des thèmes "Studio Clair" sans éditer le JSON à la main.
 * Ce fichier ne fait qu'exposer ce qui était déjà là : le changement est
 * appliqué en direct sur overlay.html (voir main.js > 'set-active-theme' >
 * worker.postMessage('theme-changed') > server.js > broadcast('applyTheme')),
 * sans redémarrer le pipeline.
 */
import { escapeHtmlDashboard, showToast } from '../utils.js';

export async function loadOverlayThemeSelector() {
  const listEl = document.getElementById('overlayThemeList');
  if (!listEl) return;
  if (!window.churchOverlay || !window.churchOverlay.listThemes) {
    listEl.innerHTML =
      '<span class="stat-label">Disponible uniquement dans l’application ChurchOverlay (pas dans un navigateur).</span>';
    return;
  }
  try {
    const [listResult, activeResult] = await Promise.all([
      window.churchOverlay.listThemes(),
      window.churchOverlay.getActiveTheme(),
    ]);
    if (!listResult || !listResult.ok || !listResult.themes) {
      listEl.innerHTML = `<span class="stat-label">❌ ${escapeHtmlDashboard(listResult?.error || 'Impossible de charger les thèmes.')}</span>`;
      return;
    }
    const activeId =
      activeResult && activeResult.ok && activeResult.theme ? activeResult.theme.id : null;
    listEl.innerHTML = listResult.themes
      .map((t) => {
        const isActive = t.id === activeId;
        const safeId = escapeHtmlDashboard(t.id);
        return `<button type="button" class="mood-btn${isActive ? ' active' : ''}" data-theme-id="${safeId}" onclick="selectOverlayTheme('${safeId.replace(/'/g, "\\'")}')">${isActive ? '✓ ' : ''}${escapeHtmlDashboard(t.name)}</button>`;
      })
      .join('');
  } catch (err) {
    listEl.innerHTML = `<span class="stat-label">❌ ${escapeHtmlDashboard(err && err.message ? err.message : String(err))}</span>`;
  }
}

export async function selectOverlayTheme(themeId) {
  if (!window.churchOverlay || !window.churchOverlay.setActiveTheme) return;
  try {
    const result = await window.churchOverlay.setActiveTheme(themeId);
    if (result && result.ok) {
      showToast(`Thème overlay : ${result.theme?.name || themeId}`, 'success');
      loadOverlayThemeSelector();
    } else {
      showToast('Échec du changement de thème : ' + (result?.error || 'erreur inconnue'), 'error');
    }
  } catch (err) {
    showToast('Échec : ' + (err && err.message ? err.message : err), 'error');
  }
}

loadOverlayThemeSelector();

window.selectOverlayTheme = selectOverlayTheme;
