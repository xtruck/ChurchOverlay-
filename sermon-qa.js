'use strict';
/**
 * ============================================================================
 * sermon-qa.js — Assistant Q&R sur les prédications archivées (RAG local)
 * ----------------------------------------------------------------------------
 * AJOUT (cahier des charges — assistant IA sur les prédications). Pas
 * d'embeddings (pgvector, API payante) : découpage en fenêtres + score de
 * recouvrement de mots, même philosophie "gratuit/léger" que
 * sermon-archive.js/search() et bible-lookup-with-api.js/findByQuotedText.
 *
 * GARDE-FOU DUR (Point 5 du cahier des charges, voir aussi l'en-tête de
 * groq-wrapper.js) : askQuestion() n'appelle JAMAIS le LLM sans avoir
 * d'abord trouvé un contenu de prédication réellement pertinent. Si la
 * recherche par mots-clés ne trouve rien qui dépasse SCORE_THRESHOLD, la
 * fonction renvoie directement "aucun contenu correspondant" — ce n'est pas
 * qu'une instruction dans le prompt (le modèle pourrait l'oublier), c'est
 * une impossibilité structurelle : sans passage à citer, aucun appel n'est
 * fait du tout.
 * ============================================================================
 */

const groqWrapper = require('./groq-wrapper');
const ollamaWrapper = require('./ollama-wrapper');
const sermonArchive = require('./sermon-archive');
const sessionStore = require('./session-store');
const { sanitizeForPrompt } = require('./prompt-sanitizer');

const CHUNK_TARGET_CHARS = 600;
const TOP_K = 5;
const SCORE_THRESHOLD = 0.12;
// AJOUT (durcissement — fenêtrage dynamique) : budget de caractères pour
// L'ENSEMBLE des extraits envoyés au LLM (pas pour le prompt entier — les
// instructions/la question restent en plus). Une fenêtre de contexte de
// modèle local (Ollama, 4-8k tokens typiques pour DeepSeek/Qwen à cette
// taille) absorbe largement ce budget avec de la marge pour la réponse.
const MAX_CONTEXT_CHARS = 6000;
// AJOUT (durcissement — résilience LLM) : au-delà de ce délai, Ollama est
// considéré indisponible et le repli Groq est déclenché — voir
// chatCompletionResilient() ci-dessous.
const OLLAMA_TIMEOUT_MS = 5000;

function normalize(text) {
  return (text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// CORRECTIF (trouvé en écrivant les tests) : un simple filtre "longueur > 2"
// (repris de bible-lookup-with-api.js/significantWordSet, pensé pour
// comparer un verset à un AUTRE verset, un contexte différent) laisse
// passer des mots-outils français très fréquents ("est", "une", "des",
// "que"...) qui ont 3+ lettres. Sur une question COURTE ("Quelle est la
// recette du gâteau au chocolat ?"), un unique mot-outil partagé avec un
// passage de sermon ("...la grâce EST un don...") suffisait à dépasser
// SCORE_THRESHOLD — exactement le genre de faux positif que le garde-fou
// "jamais de réponse sans source pertinente" doit éviter.
const STOPWORDS_FR = new Set([
  'les',
  'des',
  'une',
  'est',
  'que',
  'qui',
  'sur',
  'car',
  'mais',
  'nous',
  'vous',
  'ils',
  'elle',
  'avec',
  'pour',
  'dans',
  'sont',
  'ont',
  'ces',
  'ses',
  'son',
  'sa',
  'ce',
  'cet',
  'cette',
  'tout',
  'tous',
  'toute',
  'toutes',
  'plus',
  'donc',
  'ainsi',
  'alors',
  'comme',
  'quand',
  'ete',
  'etre',
  'avoir',
]);

function significantWordSet(text) {
  return new Set(
    normalize(text)
      .split(' ')
      .filter((w) => w.length > 2 && !STOPWORDS_FR.has(w))
  );
}

// Même logique que wordOverlapSimilarity() dans bible-lookup-with-api.js
// (dupliquée plutôt que partagée — même convention que sermon-archive.js,
// qui a elle aussi sa propre implémentation locale plutôt qu'une dépendance
// croisée entre modules pour une poignée de lignes de calcul).
function wordOverlapScore(a, b) {
  const setA = significantWordSet(a);
  const setB = significantWordSet(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  const [smaller, larger] = setA.size <= setB.size ? [setA, setB] : [setB, setA];
  let overlap = 0;
  for (const w of smaller) if (larger.has(w)) overlap++;
  return overlap / smaller.size;
}

/**
 * Découpe un texte en fenêtres d'environ CHUNK_TARGET_CHARS caractères, sur
 * des frontières de phrase (pas au milieu d'un mot/d'une idée). Pas de
 * chevauchement entre fenêtres (simplicité — voir en-tête de fichier).
 * @param {string} text
 * @returns {string[]}
 */
function chunkText(text) {
  const sentences = (text || '')
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const chunks = [];
  let current = '';
  for (const sentence of sentences) {
    if (current && current.length + sentence.length + 1 > CHUNK_TARGET_CHARS) {
      chunks.push(current.trim());
      current = sentence;
    } else {
      current = current ? `${current} ${sentence}` : sentence;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

/**
 * AJOUT (durcissement — extraction du contexte en temps réel) : construit un
 * "entry" pseudo-archive à partir de la transcription DÉJÀ ACCUMULÉE du
 * culte EN COURS (table transcript_segments, voir session-store.js — la
 * même table qui alimente srt-export.js), pour que l'assistant Q&A puisse
 * répondre sur ce qui vient d'être dit AVANT même l'archivage post-culte
 * (getPostServiceRecap, voir ai-assistant-ws-handlers.js). Best-effort :
 * une erreur ici (DB non initialisée en test, etc.) dégrade silencieusement
 * vers "pas de contexte live", jamais une exception qui casserait la
 * recherche archivée existante.
 * @param {number} [sessionStartedAt] - epoch ms du début du culte en cours
 * @returns {{date: string, theme: string, fullTranscript: string, live: true}|null}
 */
function buildLiveEntry(sessionStartedAt) {
  if (!sessionStartedAt) return null;
  let segments;
  try {
    segments = sessionStore.getTranscriptSegmentsSince(sessionStartedAt);
  } catch (_err) {
    return null;
  }
  if (!Array.isArray(segments) || segments.length === 0) return null;

  const fullTranscript = segments
    .map((s) => s && s.text)
    .filter(Boolean)
    .join(' ');
  if (!fullTranscript.trim()) return null;

  return {
    date: new Date(sessionStartedAt).toISOString(),
    theme: 'Culte en cours',
    fullTranscript,
    live: true,
  };
}

/**
 * AJOUT (durcissement — fenêtrage dynamique) : sélectionne, PARMI des
 * fenêtres déjà triées par pertinence décroissante, celles qui tiennent dans
 * MAX_CONTEXT_CHARS — glouton avec essai du suivant si le meilleur restant
 * ne rentre plus (maximise l'information utile dans le budget), jamais en
 * coupant une fenêtre en deux : chaque fenêtre vient de chunkText(), déjà
 * bornée à une frontière de phrase. C'est ce qui garantit "sans tronquer les
 * idées clés" — une idée est soit entièrement incluse, soit absente.
 * @param {Array<{excerpt: string, score: number}>} scoredChunks
 * @returns {Array<object>}
 */
function selectChunksWithinBudget(scoredChunks) {
  const sorted = [...scoredChunks].sort((a, b) => b.score - a.score);
  const selected = [];
  let totalChars = 0;
  for (const chunk of sorted) {
    if (selected.length >= TOP_K) break;
    if (totalChars + chunk.excerpt.length > MAX_CONTEXT_CHARS) continue;
    selected.push(chunk);
    totalChars += chunk.excerpt.length;
  }
  return selected;
}

/**
 * Cherche, parmi TOUTES les prédications archivées ET la transcription du
 * culte EN COURS (si sessionStartedAt est fourni), les passages les plus
 * pertinents pour une question donnée.
 * @param {string} question
 * @param {{ sessionStartedAt?: number }} [options]
 * @returns {Array<{date: string, theme: string|null, excerpt: string, score: number, live?: boolean}>}
 */
function retrieveRelevantChunks(question, options = {}) {
  const entries = sermonArchive.getAllTranscripts().slice();
  const liveEntry = buildLiveEntry(options.sessionStartedAt);
  if (liveEntry) entries.push(liveEntry);

  const scored = [];

  for (const entry of entries) {
    for (const chunk of chunkText(entry.fullTranscript)) {
      const score = wordOverlapScore(question, chunk);
      if (score > 0) {
        scored.push({
          date: entry.date,
          theme: entry.theme,
          excerpt: chunk,
          score,
          live: !!entry.live,
        });
      }
    }
  }

  return selectChunksWithinBudget(scored.filter((c) => c.score >= SCORE_THRESHOLD));
}

function formatSourceLabel(source) {
  const date = new Date(source.date).toLocaleDateString('fr-FR', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
  return `${source.theme || 'Prédication'} (${date})`;
}

/**
 * AJOUT (durcissement — résilience LLM) : interroge Ollama EN PRIORITÉ
 * (local, gratuit) ; toute erreur — indisponibilité, timeout
 * (OLLAMA_TIMEOUT_MS), réponse vide — bascule de façon TRANSPARENTE vers
 * groq-wrapper.js (qui a lui-même déjà son propre repli interne Gemini,
 * voir groq-wrapper.js#chatCompletion). L'appelant ne voit jamais l'échec
 * intermédiaire, seulement le `provider` qui a finalement répondu (utile
 * pour le diagnostic/l'affichage dashboard, jamais bloquant).
 * @param {string} prompt
 * @param {Object} [options]
 * @returns {Promise<{text: string, model: string, usage: Object, provider: 'ollama'|'groq'}>}
 */
async function chatCompletionResilient(prompt, options = {}) {
  try {
    const result = await ollamaWrapper.chatCompletion(prompt, {
      ...options,
      timeoutMs: OLLAMA_TIMEOUT_MS,
    });
    return { ...result, provider: 'ollama' };
  } catch (err) {
    console.warn(
      `[sermon-qa] Ollama local indisponible/timeout (${err.message}) — repli sur Groq.`
    );
    const result = await groqWrapper.chatCompletion(prompt, options);
    return { ...result, provider: 'groq' };
  }
}

/**
 * @param {string} question
 * @param {{ sessionStartedAt?: number }} [options] - sessionStartedAt : epoch
 *   ms du début du culte en cours, pour inclure sa transcription déjà
 *   accumulée dans la recherche (voir retrieveRelevantChunks/buildLiveEntry).
 *   Omis (tests, appel hors contexte de culte) -> recherche archives
 *   seulement, comportement HISTORIQUE inchangé.
 * @returns {Promise<{ok: boolean, answered: boolean, answer?: string, provider?: string, sources?: Array, message?: string}>}
 */
async function askQuestion(question, options = {}) {
  const rawTrimmed = (question || '').trim();
  if (!rawTrimmed) {
    return { ok: false, answered: false, message: 'Question vide.' };
  }
  // AJOUT (durcissement — défense en profondeur) : ai-assistant-ws-handlers.js
  // sanitise déjà la question opérateur avant d'appeler askQuestion(), mais
  // ce module ne doit pas dépendre aveuglément d'un appelant particulier
  // pour rester sûr (idempotent sur un texte déjà nettoyé — sans coût).
  const trimmed = sanitizeForPrompt(rawTrimmed);

  const sources = retrieveRelevantChunks(trimmed, options);

  // GARDE-FOU (voir en-tête de fichier) : aucun contenu pertinent trouvé —
  // on s'arrête ICI, avant tout appel au LLM.
  if (sources.length === 0) {
    return {
      ok: true,
      answered: false,
      message:
        "Aucun contenu de prédication archivée ou du culte en cours ne correspond à cette question. L'assistant ne répond qu'à partir de prédications réellement prononcées — pas de réponse générée sans source à citer.",
    };
  }

  // CORRECTIF (durcissement — gap d'injection trouvé en auditant ce fichier
  // contre la menace documentée en en-tête de prompt-sanitizer.js) : les
  // extraits (s.excerpt) sont de la PAROLE CAPTÉE EN DIRECT, exactement le
  // vecteur d'injection que ce fichier existe pour neutraliser — jusqu'ici
  // seule la question de l'opérateur passait par sanitizeForPrompt(), les
  // extraits de sermon étaient interpolés bruts dans le prompt.
  const sourcesBlock = sources
    .map((s, i) => `[Source ${i + 1} — ${formatSourceLabel(s)}]\n${sanitizeForPrompt(s.excerpt)}`)
    .join('\n\n');

  const prompt =
    `Tu réponds à une question d'un fidèle en te basant UNIQUEMENT sur les extraits de prédications ` +
    `ci-dessous, réellement prononcées dans cette église (certains peuvent provenir du culte encore en ` +
    `cours). Ne génère JAMAIS de contenu théologique de ton propre fonds — si les extraits ne répondent ` +
    `que partiellement, dis-le explicitement plutôt que de compléter avec autre chose. Cite la source ` +
    `(titre + date) pour chaque affirmation, en reprenant le numéro de source ("Source 1", "Source 2"...).` +
    `\n\n${sourcesBlock}\n\nQuestion : ${trimmed}`;

  const result = await chatCompletionResilient(prompt, {
    temperature: 0.1,
    max_tokens: 500,
  });

  return {
    ok: true,
    answered: true,
    answer: result.text,
    provider: result.provider,
    // Renvoyées systématiquement AVEC la réponse, pas seulement citées dans
    // le texte généré — garantie au niveau de l'interface (voir dashboard.js)
    // que les sources restent visibles même si la réponse du modèle oublie
    // de toutes les mentionner explicitement.
    sources: sources.map((s) => ({
      label: formatSourceLabel(s),
      date: s.date,
      excerpt: s.excerpt,
      live: !!s.live,
    })),
  };
}

/**
 * AJOUT (durcissement — nouvelle capacité) : sélectionne des fenêtres
 * (déjà bornées à une frontière de phrase par chunkText()) RÉPARTIES sur
 * TOUTE la plage d'indices, du début à la fin — contrairement à
 * selectChunksWithinBudget() (qui trie par SCORE de pertinence à une
 * question), il n'y a ici aucune question à comparer : un résumé "du culte
 * jusqu'ici" doit rester représentatif du DÉBUT et de la FIN du service, pas
 * seulement des derniers mots prononcés.
 * @param {Array<string>} items
 * @param {number} maxCount
 * @returns {Array<string>}
 */
function pickEvenlySpaced(items, maxCount) {
  if (items.length <= maxCount) return items.slice();
  if (maxCount <= 1) return items.slice(0, 1);
  const picked = [];
  for (let i = 0; i < maxCount; i++) {
    const idx = Math.floor((i * (items.length - 1)) / (maxCount - 1));
    picked.push(items[idx]);
  }
  return [...new Set(picked)];
}

/**
 * AJOUT (durcissement — fenêtrage dynamique pour le résumé) : si la
 * transcription complète tient dans MAX_CONTEXT_CHARS, elle est utilisée
 * telle quelle. Sinon, échantillonnage réparti (voir pickEvenlySpaced) sur
 * des fenêtres ENTIÈRES (jamais coupées en milieu de phrase).
 * @param {string} fullTranscript
 * @returns {string[]}
 */
function selectChunksForSummary(fullTranscript) {
  const chunks = chunkText(fullTranscript);
  const totalChars = chunks.reduce((sum, c) => sum + c.length, 0);
  if (totalChars <= MAX_CONTEXT_CHARS) return chunks;

  const maxChunks = Math.max(2, Math.floor(MAX_CONTEXT_CHARS / CHUNK_TARGET_CHARS));
  return pickEvenlySpaced(chunks, maxChunks);
}

/**
 * AJOUT (durcissement — nouvelle capacité, action WS sermonQaSummary) :
 * résume la transcription DÉJÀ ACCUMULÉE du culte EN COURS (table
 * transcript_segments) — DISTINCT de l'action existante getLiveSummary
 * (ai-enricher.js + sessionState.getRecentTranscripts(), une fenêtre
 * glissante de 10 fragments EN MÉMOIRE) : ici, la totalité du culte
 * persistée en base est considérée, fenêtrée dynamiquement (voir
 * selectChunksForSummary) pour rester dans le budget de contexte du modèle
 * sans jamais tronquer une phrase.
 * @param {{ sessionStartedAt?: number }} [options]
 * @returns {Promise<{ok: boolean, summarized: boolean, summary?: string, provider?: string, message?: string}>}
 */
async function summarizeCurrentService(options = {}) {
  const liveEntry = buildLiveEntry(options.sessionStartedAt);
  if (!liveEntry) {
    return {
      ok: true,
      summarized: false,
      message: "Aucune transcription n'a encore été enregistrée pour le culte en cours.",
    };
  }

  const windowed = selectChunksForSummary(liveEntry.fullTranscript);
  // Même correctif de sanitisation que askQuestion() ci-dessus — la
  // transcription en direct est de la parole captée, jamais interpolée
  // brute dans un prompt.
  const safeTranscript = windowed.map((chunk) => sanitizeForPrompt(chunk)).join('\n\n');

  const prompt =
    `Résume en français, de façon concise et fidèle, les points principaux abordés jusqu'ici dans ce ` +
    `culte, à partir UNIQUEMENT de la transcription ci-dessous (parole captée en direct, peut contenir ` +
    `des coquilles de transcription). Ne complète JAMAIS avec du contenu théologique de ton propre ` +
    `fonds.\n\n${safeTranscript}`;

  const result = await chatCompletionResilient(prompt, {
    temperature: 0.2,
    max_tokens: 400,
  });

  return { ok: true, summarized: true, summary: result.text, provider: result.provider };
}

module.exports = {
  askQuestion,
  summarizeCurrentService,
  // Exposées pour tests unitaires (test-sermon-qa.js).
  chunkText,
  wordOverlapScore,
  retrieveRelevantChunks,
  buildLiveEntry,
  selectChunksWithinBudget,
  selectChunksForSummary,
  pickEvenlySpaced,
  MAX_CONTEXT_CHARS,
};
