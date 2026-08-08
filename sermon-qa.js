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
const sermonArchive = require('./sermon-archive');

const CHUNK_TARGET_CHARS = 600;
const TOP_K = 5;
const SCORE_THRESHOLD = 0.12;

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
 * Cherche, parmi TOUTES les prédications archivées, les passages les plus
 * pertinents pour une question donnée.
 * @param {string} question
 * @returns {Array<{date: string, theme: string|null, excerpt: string, score: number}>}
 */
function retrieveRelevantChunks(question) {
  const entries = sermonArchive.getAllTranscripts();
  const scored = [];

  for (const entry of entries) {
    for (const chunk of chunkText(entry.fullTranscript)) {
      const score = wordOverlapScore(question, chunk);
      if (score > 0) {
        scored.push({ date: entry.date, theme: entry.theme, excerpt: chunk, score });
      }
    }
  }

  return scored
    .filter((c) => c.score >= SCORE_THRESHOLD)
    .sort((a, b) => b.score - a.score)
    .slice(0, TOP_K);
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
 * @param {string} question
 * @returns {Promise<{ok: boolean, answered: boolean, answer?: string, sources?: Array, message?: string}>}
 */
async function askQuestion(question) {
  const trimmed = (question || '').trim();
  if (!trimmed) {
    return { ok: false, answered: false, message: 'Question vide.' };
  }

  const sources = retrieveRelevantChunks(trimmed);

  // GARDE-FOU (voir en-tête de fichier) : aucun contenu pertinent trouvé —
  // on s'arrête ICI, avant tout appel au LLM.
  if (sources.length === 0) {
    return {
      ok: true,
      answered: false,
      message:
        "Aucun contenu de prédication archivée ne correspond à cette question. L'assistant ne répond qu'à partir de prédications réellement prononcées et archivées — pas de réponse générée sans source à citer.",
    };
  }

  const sourcesBlock = sources
    .map((s, i) => `[Source ${i + 1} — ${formatSourceLabel(s)}]\n${s.excerpt}`)
    .join('\n\n');

  const prompt =
    `Tu réponds à une question d'un fidèle en te basant UNIQUEMENT sur les extraits de prédications ` +
    `ci-dessous, réellement prononcées dans cette église. Ne génère JAMAIS de contenu théologique de ` +
    `ton propre fonds — si les extraits ne répondent que partiellement, dis-le explicitement plutôt que ` +
    `de compléter avec autre chose. Cite la source (titre + date) pour chaque affirmation, en reprenant ` +
    `le numéro de source ("Source 1", "Source 2"...).\n\n${sourcesBlock}\n\nQuestion : ${trimmed}`;

  const result = await groqWrapper.chatCompletion(prompt, {
    temperature: 0.1,
    max_tokens: 500,
  });

  return {
    ok: true,
    answered: true,
    answer: result.text,
    // Renvoyées systématiquement AVEC la réponse, pas seulement citées dans
    // le texte généré — garantie au niveau de l'interface (voir dashboard.js)
    // que les sources restent visibles même si la réponse du modèle oublie
    // de toutes les mentionner explicitement.
    sources: sources.map((s) => ({
      label: formatSourceLabel(s),
      date: s.date,
      excerpt: s.excerpt,
    })),
  };
}

module.exports = {
  askQuestion,
  // Exposées pour tests unitaires (test-sermon-qa.js).
  chunkText,
  wordOverlapScore,
  retrieveRelevantChunks,
};
