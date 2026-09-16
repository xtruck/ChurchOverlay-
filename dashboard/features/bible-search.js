/**
 * dashboard/features/bible-search.js — recherche de versets par thème
 * (getTopics/searchBible côté serveur, voir bible-semantic-search.js).
 *
 * IMPORTANT (honnêteté) : le vrai index vectoriel n'est pas implémenté
 * côté serveur — searchByVector() dans bible-semantic-search.js est un
 * stub qui renvoie toujours [] (log "not yet implemented"). Le matching
 * réel aujourd'hui est un rapprochement par mot-clé sur une douzaine de
 * thèmes prédéfinis (TOPIC_INDEX : amour, foi, pardon, grâce, paix...).
 * Ce module et son libellé UI parlent donc de "recherche par thème",
 * jamais de "recherche IA/sémantique" — ne pas survendre.
 *
 * Les références renvoyées par le serveur (topics et résultats de
 * recherche) proviennent toutes de TOPIC_INDEX, une liste fixe côté
 * serveur — jamais de texte saisi par un opérateur. Insérées telles
 * quelles dans les attributs onclick ci-dessous, comme pour les autres
 * identifiants internes de confiance ailleurs dans le tableau de bord
 * (item.id dans ip-cameras.js, song.id dans song-library.js...).
 */
import { ws } from '../state.js';
import { showToast, escapeHtmlDashboard, requireWsOrWarn } from '../utils.js';
import { registerAction } from '../action-delegator.js';

// AJOUT (redesign — pas d'emoji comme icône structurelle) : remplace le ❌
// littéral ci-dessous.
const ICON_ERROR =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align: -1px;" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="M15 9l-6 6M9 9l6 6"></path></svg>';

export function renderBibleTopics(topics) {
  const container = document.getElementById('bibleTopicChips');
  if (!container) return;
  container.innerHTML = (topics || [])
    .map(
      (topic) =>
        `<button class="mood-btn" data-action="search" data-target="bible-topic" data-topic="${escapeHtmlDashboard(topic)}">${escapeHtmlDashboard(topic)}</button>`
    )
    .join('');
}

// AJOUT (redesign IA — étape 3, fusion Studio Pro) : #ppAiSearchResults est
// la cible de recherche du Studio Pro (voir executeAiSemanticSearch() dans
// propresenter-studio.js, qui appelle cette même fonction) — remplit les
// DEUX conteneurs avec le même contenu réel, jamais une copie divergente.
function forEachSearchOutput(fn) {
  ['bibleSearchOutput', 'ppAiSearchResults'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) fn(el);
  });
}

export function searchBibleByTopic(topic) {
  if (!requireWsOrWarn()) return;
  const input = document.getElementById('bibleSearchInput');
  const query = topic || (input ? input.value.trim() : '');
  if (!query) {
    showToast('Tapez un thème ou cliquez un des boutons ci-dessus.', 'error');
    return;
  }
  if (input && topic) input.value = topic;
  forEachSearchOutput((el) => {
    el.innerHTML = '<span class="stat-label">⏳ Recherche en cours...</span>';
  });
  ws.send(JSON.stringify({ action: 'searchBible', query }));
}

export function showFoundVerse(reference) {
  if (!requireWsOrWarn()) return;
  // AJOUT : voir le commentaire équivalent dans verse-session-display.js
  // > showManualVerse() — validation.js exige un champ `text` non vide
  // pour tout message client 'showVerse', jamais lu par le handler
  // serveur (qui refait sa propre recherche), donc purement cosmétique
  // ici, jamais affiché nulle part.
  ws.send(JSON.stringify({ action: 'showVerse', reference, text: reference }));
  showToast(`Affichage de ${reference}...`, 'info');
}

export function renderBibleSearchResults(message) {
  const results = message.results || [];
  const html = !results.length
    ? `<span class="stat-label">Aucun verset trouvé pour "${escapeHtmlDashboard(message.query || '')}".</span>`
    : results
        .map(
          (r) => `<div class="queue-item">
                <span class="queue-item-ref">${escapeHtmlDashboard(r.reference)}</span>
                <div class="queue-item-actions">
                    <button class="queue-icon-btn queue-send" data-action="show" data-target="found-verse" data-reference="${escapeHtmlDashboard(r.reference)}" title="Afficher ce verset">▶</button>
                </div>
            </div>`
        )
        .join('');
  forEachSearchOutput((el) => {
    el.innerHTML = html;
  });
}

export function renderBibleSearchError(message) {
  const html = `<span class="stat-label">${ICON_ERROR} ${escapeHtmlDashboard(message.error || 'Recherche indisponible.')}</span>`;
  forEachSearchOutput((el) => {
    el.innerHTML = html;
  });
}

// CONSERVÉ : le bouton statique "Rechercher" (#searchBibleByTopicBtn, voir
// event-bindings.js#CLICK_BINDINGS) l'appelle encore sans argument (lit
// #bibleSearchInput lui-même) — un appel DISTINCT des puces de thème
// ci-dessus, qui passent désormais par data-action/data-target.
window.searchBibleByTopic = searchBibleByTopic;
// AJOUT (chantier nettoyage dashboard — purge des onclick inline) :
// showFoundVerse() n'a plus d'appelant hors de ce module (voir
// data-action="show" data-target="found-verse" ci-dessus) — retiré.
registerAction('bible-topic', 'search', (el, data) => searchBibleByTopic(data.topic));
registerAction('found-verse', 'show', (el, data) => showFoundVerse(data.reference));
