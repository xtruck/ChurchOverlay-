/**
 * dashboard/features/mood-theme.js — motif de fond CSS et générateur de
 * thème par IA. Extrait de dashboard/legacy-core.js (chantier de
 * modularisation).
 *
 * SUPPRIMÉ (retour opérateur direct — "je n'aime pas ce panneau [la
 * palette d'ambiances], à retirer") : renderMoodPicker()/setMoodTheme()/
 * setActiveMoodButton()/toggleAmbientMode() pilotaient les deux palettes
 * de boutons Joie/Paix/Repentance/... (#moodPicker dans le tiroir d'outils
 * secondaires, #ppMoodPicker dans la console Opérateur) — les deux
 * conteneurs DOM ont été retirés de dashboard.html, ces fonctions n'ont
 * donc plus aucun appelant. L'action WS 'setMoodTheme' elle-même (voir
 * action-registry.js/validation.js) et le système de thèmes
 * (config/themes/*.json) restent pleinement fonctionnels côté serveur —
 * seul ce point d'entrée manuel côté tableau de bord a été retiré ; un
 * thème peut toujours être appliqué autrement (génération IA ci-dessous,
 * commande vocale, MCP...).
 */
import { ws } from '../state.js';
import { showToast } from '../utils.js';
import { registerAction } from '../action-delegator.js';

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
  if (statusEl) statusEl.textContent = 'Génération en cours...';
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
    statusEl.textContent = `Génération indisponible — repli sur "${result.themeName}".`;
  } else {
    statusEl.textContent = `Thème "${result.themeName}" appliqué.`;
  }
}

window.setBackgroundPattern = setBackgroundPattern;
// CONSERVÉ (chantier nettoyage dashboard) : window.generateThemeFromPromptUI
// reste nécessaire — dashboard.html#themePromptInput l'appelle encore via
// onkeydown="...generateThemeFromPromptUI()" (touche Entrée), un attribut
// DISTINCT de onclick, hors du périmètre de cette purge (voir le rapport de
// session). Le bouton "Générer" lui-même, en revanche, passe désormais
// par data-action/data-target (voir juste en dessous).
window.generateThemeFromPromptUI = generateThemeFromPromptUI;
registerAction('theme-prompt', 'generate', () => generateThemeFromPromptUI());
