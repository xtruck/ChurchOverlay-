/**
 * dashboard/features/mood-theme.js — sélecteur d'ambiances (moods) et
 * motif de fond CSS. Extrait de dashboard/legacy-core.js (chantier de
 * modularisation).
 */
import { ws } from '../legacy-core.js';
import { showToast } from '../utils.js';

/* ======================================================================
           Sélecteur d'ambiances (moods)
           ====================================================================== */
export function renderMoodPicker(moods) {
  const container = document.getElementById('moodPicker');
  if (!container) return;
  if (!moods.length) {
    container.innerHTML =
      '<span style="font-size:0.8rem; color:var(--text-dim);">Générateur d\'ambiances indisponible.</span>';
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

window.setMoodTheme = setMoodTheme;
window.setBackgroundPattern = setBackgroundPattern;
