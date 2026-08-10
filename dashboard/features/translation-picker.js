/**
 * dashboard/features/translation-picker.js — sélecteur de version
 * biblique (ex. Louis Segond 1910 vs Darby en français, KJV/WEB/ASV en
 * anglais — voir AVAILABLE_TRANSLATIONS dans bible-lookup-with-api.js).
 * Distinct du sélecteur de LANGUE d'affichage (FR/EN/bilingue, voir
 * setLanguage) juste au-dessus dans dashboard.html : ceci choisit la
 * VERSION du texte dans une langue donnée, pas la langue elle-même.
 *
 * setTranslation existait déjà côté serveur (diffuse translationChanged
 * à tous les tableaux de bord connectés) et la liste des traductions
 * disponibles arrive déjà dans le message 'init' envoyé à chaque
 * connexion (bibleLookup.listTranslations()) — les deux étaient ignorés
 * côté tableau de bord jusqu'ici (aucun case 'init' n'existait du tout
 * dans ws-dispatch.js).
 */
import { ws } from '../state.js';
import { escapeHtmlDashboard, requireWsOrWarn } from '../utils.js';

const LANG_LABELS = { fr: 'Français', en: 'Anglais' };

export function renderTranslationPicker(translations) {
  const container = document.getElementById('translationPicker');
  if (!container || !translations) return;
  container.innerHTML = Object.entries(translations)
    .map(([lang, options]) => {
      const buttons = (options || [])
        .map(
          (t) =>
            `<button class="mood-btn${t.active ? ' active' : ''}" data-translation-lang="${lang}" data-translation-code="${t.code}" onclick="setBibleTranslation('${lang}', '${t.code}')">${escapeHtmlDashboard(t.label)}</button>`
        )
        .join('');
      return `<div style="display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap">
                <span class="field-hint" style="min-width: 70px">${escapeHtmlDashboard(LANG_LABELS[lang] || lang)}</span>
                ${buttons}
              </div>`;
    })
    .join('');
}

export function setBibleTranslation(language, code) {
  if (!requireWsOrWarn()) return;
  ws.send(JSON.stringify({ action: 'setTranslation', language, code }));
}

export function updateActiveTranslationButton(language, code) {
  document.querySelectorAll(`[data-translation-lang="${language}"]`).forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.translationCode === code);
  });
}

window.setBibleTranslation = setBibleTranslation;
