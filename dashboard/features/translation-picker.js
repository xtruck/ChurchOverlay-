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

// AJOUT (Chantier G, mission autonome — préparer la vente) : mention de
// licence affichée à côté du bouton de la traduction ACTIVE — jamais
// masquée, jamais optionnelle. On vend ce logiciel : une traduction sous
// droits affichée sans que personne ne l'ait remarqué est un risque réel,
// pas un détail cosmétique. Voir LICENCES-TRADUCTIONS.md.
export function renderTranslationPicker(translations) {
  const container = document.getElementById('translationPicker');
  if (!container || !translations) return;
  container.innerHTML = Object.entries(translations)
    .map(([lang, options]) => {
      const buttons = (options || [])
        .map(
          (t) =>
            `<button class="mood-btn${t.active ? ' active' : ''}" data-translation-lang="${lang}" data-translation-code="${t.code}" data-translation-license="${escapeHtmlDashboard(t.license || '')}" onclick="setBibleTranslation('${lang}', '${t.code}')">${escapeHtmlDashboard(t.label)}</button>`
        )
        .join('');
      const active = (options || []).find((t) => t.active);
      const licenseNote = active?.license
        ? `<span class="field-hint" data-translation-license-note="${lang}" style="opacity: 0.7">(${escapeHtmlDashboard(active.license)})</span>`
        : '';
      return `<div style="display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap">
                <span class="field-hint" style="min-width: 70px">${escapeHtmlDashboard(LANG_LABELS[lang] || lang)}</span>
                ${buttons}
                ${licenseNote}
              </div>`;
    })
    .join('');
}

export function setBibleTranslation(language, code) {
  if (!requireWsOrWarn()) return;
  ws.send(JSON.stringify({ action: 'setTranslation', language, code }));
}

export function updateActiveTranslationButton(language, code) {
  let activeLicense = null;
  document.querySelectorAll(`[data-translation-lang="${language}"]`).forEach((btn) => {
    const isActive = btn.dataset.translationCode === code;
    btn.classList.toggle('active', isActive);
    if (isActive) activeLicense = btn.dataset.translationLicense || null;
  });
  // AJOUT (Chantier G) : la mention de licence doit suivre la traduction
  // ACTIVE en temps réel (bascule voix/tableau de bord), pas seulement à
  // l'ouverture du tableau de bord — sinon un changement de traduction en
  // cours de culte pourrait laisser affichée la mention de la traduction
  // précédente.
  const note = document.querySelector(`[data-translation-license-note="${language}"]`);
  if (note && activeLicense) note.textContent = `(${activeLicense})`;
}

window.setBibleTranslation = setBibleTranslation;
