/**
 * dashboard/features/mood-theme.js — sélecteur d'ambiances (moods) et
 * motif de fond CSS. Extrait de dashboard/legacy-core.js (chantier de
 * modularisation).
 */
import { ws } from '../state.js';
import { showToast } from '../utils.js';

/* ======================================================================
           Sélecteur d'ambiances (moods)
           ====================================================================== */
export function renderMoodPicker(moods) {
  const container = document.getElementById('moodPicker');
  if (!container) return;
  if (!moods.length) {
    container.innerHTML = '<span class="text-note">Générateur d\'ambiances indisponible.</span>';
    return;
  }
  container.innerHTML = moods
    .map(
      (m) => `
                <button class="mood-btn" id="mood-btn-${m.id}" onclick="setMoodTheme('${m.id}')" title="${m.name}">
                    ${m.name}
                </button>
            `
    )
    .join('');
}

export function setMoodTheme(mood) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    showToast("Non connecté au serveur — impossible de changer l'ambiance.", 'error');
    return;
  }
  ws.send(JSON.stringify({ action: 'setMoodTheme', mood }));
}

export function setActiveMoodButton(mood) {
  document.querySelectorAll('.mood-btn').forEach((btn) => btn.classList.remove('active'));
  const active = document.getElementById(`mood-btn-${mood}`);
  if (active) active.classList.add('active');
}

// AJOUT (audit — affichage/sortie, gratuit/léger, session parallèle) :
// motif de fond CSS (voir #pattern-layer dans overlay.html) — indépendant
// de l'ambiance. Même schéma déterministe que setActiveMoodButton (id
// plutôt que l'objet event global, plus robuste).
export function setBackgroundPattern(pattern) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    showToast('Non connecté au serveur — impossible de changer le motif.', 'error');
    return;
  }
  ws.send(JSON.stringify({ action: 'setBackgroundPattern', pattern }));
  document
    .querySelectorAll('#patternPicker .mood-btn')
    .forEach((btn) => btn.classList.remove('active'));
  const active = document.getElementById(`pattern-btn-${pattern}`);
  if (active) active.classList.add('active');
}

// AJOUT (chantier "Prompt-to-Theme") : habillage sur mesure généré par IA
// depuis une description libre — voir ai-theme-generator.js#generateThemeFromPrompt
// côté serveur et le handler generateTheme dans reading-translation-ws-handlers.js.
export function generateThemeFromPromptUI() {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    showToast('Non connecté au serveur — impossible de générer un thème.', 'error');
    return;
  }
  const input = document.getElementById('themePromptInput');
  const statusEl = document.getElementById('themeGenerationStatus');
  const description = input ? input.value.trim() : '';
  if (!description) {
    if (statusEl) statusEl.textContent = 'Décrivez le thème voulu avant de générer.';
    return;
  }
  if (statusEl) statusEl.textContent = '⏳ Génération en cours...';
  ws.send(JSON.stringify({ action: 'generateTheme', description }));
}

// Réponse à 'themeGenerated' (voir ws-dispatch.js) — le nouveau thème a déjà
// été diffusé séparément via 'applyTheme' (l'overlay ET l'aperçu en direct
// du tableau de bord l'ont donc déjà reçu) ; ce texte de statut confirme
// juste à l'opérateur CE QUI a été appliqué, y compris quand la génération a
// échoué et que le repli garanti "Mission Control" a été appliqué à la place.
export function renderThemeGenerated(result) {
  const statusEl = document.getElementById('themeGenerationStatus');
  if (!statusEl) return;
  if (result.usedFallback) {
    statusEl.textContent = `⚠ Génération indisponible — repli sur "${result.themeName}".`;
  } else {
    statusEl.textContent = `✓ Thème "${result.themeName}" appliqué.`;
  }
}

window.setMoodTheme = setMoodTheme;
window.setBackgroundPattern = setBackgroundPattern;
window.generateThemeFromPromptUI = generateThemeFromPromptUI;

window.toggleAmbientMode = function (enabled) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ action: 'setAmbientMode', enabled }));
  showToast(enabled ? 'Cycle auto réactivé' : 'Cycle auto désactivé', 'info');
};
