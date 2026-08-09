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

export function renderBibleTopics(topics) {
  const container = document.getElementById('bibleTopicChips');
  if (!container) return;
  container.innerHTML = (topics || [])
    .map(
      (topic) =>
        `<button class="mood-btn" onclick="searchBibleByTopic('${topic}')">${escapeHtmlDashboard(topic)}</button>`
    )
    .join('');
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
  const output = document.getElementById('bibleSearchOutput');
  if (output) output.innerHTML = '<span class="stat-label">⏳ Recherche en cours...</span>';
  ws.send(JSON.stringify({ action: 'searchBible', query }));
}

export function showFoundVerse(reference) {
  if (!requireWsOrWarn()) return;
  ws.send(JSON.stringify({ action: 'showVerse', reference }));
  showToast(`Affichage de ${reference}...`, 'info');
}

export function renderBibleSearchResults(message) {
  const output = document.getElementById('bibleSearchOutput');
  if (!output) return;
  const results = message.results || [];
  if (!results.length) {
    output.innerHTML = `<span class="stat-label">Aucun verset trouvé pour "${escapeHtmlDashboard(message.query || '')}".</span>`;
    return;
  }
  output.innerHTML = results
    .map(
      (r) => `<div class="queue-item">
                <span class="queue-item-ref">${escapeHtmlDashboard(r.reference)}</span>
                <div class="queue-item-actions">
                    <button class="queue-icon-btn queue-send" onclick="showFoundVerse('${r.reference}')" title="Afficher ce verset">▶</button>
                </div>
            </div>`
    )
    .join('');
}

export function renderBibleSearchError(message) {
  const output = document.getElementById('bibleSearchOutput');
  if (output) {
    output.innerHTML = `<span class="stat-label">❌ ${escapeHtmlDashboard(message.error || 'Recherche indisponible.')}</span>`;
  }
}

window.searchBibleByTopic = searchBibleByTopic;
window.showFoundVerse = showFoundVerse;
