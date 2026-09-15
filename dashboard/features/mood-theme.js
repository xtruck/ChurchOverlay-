/**
 * dashboard/features/mood-theme.js — sélecteur d'ambiances (moods) et
 * motif de fond CSS. Extrait de dashboard/legacy-core.js (chantier de
 * modularisation).
 */
import { ws } from '../state.js';
import { showToast } from '../utils.js';
import { registerAction } from '../action-delegator.js';

/* ======================================================================
           Sélecteur d'ambiances (moods)
           ====================================================================== */
// AJOUT (redesign IA — étape 3, fusion Studio Pro / Direct Classique) :
// rendue à l'IDENTIQUE dans deux emplacements, tous deux à l'intérieur
// d'#propresenter-live (Opérateur) depuis la fusion — le sélecteur détaillé
// (#moodPicker, ex-"Direct Classique", relocalisé tel quel) et la palette
// compacte du Studio Pro (#ppMoodPicker, classe .pp-mood-pill pour son
// thème visuel sombre) — même liste réelle de thèmes (config/themes/*.json),
// jamais deux implémentations divergentes. Remplace l'ancienne palette
// Studio Pro (6 boutons
// "Minimal Sombre"/"Or Solennel"/... codés en dur, envoyant une action WS
// 'setTheme' jamais enregistrée dans action-registry.js — donc rejetée
// silencieusement par le serveur, sans le moindre effet réel). data-id
// sert déjà à data-action="set" (voir registerAction ci-dessous) ;
// data-mood-btn est un doublon délibéré du même id, ciblable par
// querySelectorAll depuis setActiveMoodButton() pour mettre à jour TOUTES
// les copies du même bouton à la fois (un simple id serait dupliqué entre
// les deux conteneurs, invalide en HTML et invisible à getElementById au-
// delà de la première correspondance).
const MOOD_PICKER_TARGETS = [
  { id: 'moodPicker', btnClass: 'mood-btn' },
  { id: 'ppMoodPicker', btnClass: 'pp-mood-pill' },
];

export function renderMoodPicker(moods) {
  for (const { id, btnClass } of MOOD_PICKER_TARGETS) {
    const container = document.getElementById(id);
    if (!container) continue;
    if (!moods.length) {
      container.innerHTML = '<span class="text-note">Générateur d\'ambiances indisponible.</span>';
      continue;
    }
    container.innerHTML = moods
      .map(
        (m) => `
                <button class="${btnClass}" data-mood-btn="${m.id}" data-action="set" data-target="mood" data-id="${m.id}" title="${m.name}">
                    ${m.name}
                </button>
            `
      )
      .join('');
  }
}

export function setMoodTheme(mood) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    showToast("Non connecté au serveur — impossible de changer l'ambiance.", 'error');
    return;
  }
  ws.send(JSON.stringify({ action: 'setMoodTheme', mood }));
}

export function setActiveMoodButton(mood) {
  document.querySelectorAll('[data-mood-btn]').forEach((btn) => btn.classList.remove('active'));
  document
    .querySelectorAll(`[data-mood-btn="${mood}"]`)
    .forEach((btn) => btn.classList.add('active'));
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

// AJOUT (chantier nettoyage dashboard — purge des onclick inline) : les
// boutons d'ambiance générés par renderMoodPicker() ci-dessus passent
// désormais par data-action/data-target — window.setMoodTheme n'a donc
// plus aucun appelant restant, retiré (contrairement à
// window.setBackgroundPattern juste en dessous, toujours appelé par les
// boutons #pattern-btn-* via event-bindings.js#CLICK_BINDINGS — conservé).
registerAction('mood', 'set', (el, data) => setMoodTheme(data.id));

window.setBackgroundPattern = setBackgroundPattern;
// CONSERVÉ (chantier nettoyage dashboard) : window.generateThemeFromPromptUI
// reste nécessaire — dashboard.html#themePromptInput l'appelle encore via
// onkeydown="...generateThemeFromPromptUI()" (touche Entrée), un attribut
// DISTINCT de onclick, hors du périmètre de cette purge (voir le rapport de
// session). Le bouton "✨ Générer" lui-même, en revanche, passe désormais
// par data-action/data-target (voir juste en dessous).
window.generateThemeFromPromptUI = generateThemeFromPromptUI;
registerAction('theme-prompt', 'generate', () => generateThemeFromPromptUI());

window.toggleAmbientMode = function (enabled) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ action: 'setAmbientMode', enabled }));
  showToast(enabled ? 'Cycle auto réactivé' : 'Cycle auto désactivé', 'info');
};
