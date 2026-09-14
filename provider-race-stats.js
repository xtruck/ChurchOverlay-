'use strict';
/**
 * ============================================================================
 *  provider-race-stats.js — compteurs glissants sur l'issue de la course
 *  Groq/Deepgram (voir groq-wrapper.js#transcribeWithFallback).
 * ----------------------------------------------------------------------------
 *  transcribeWithFallback() lance TOUJOURS Deepgram en parallèle de Groq
 *  (sauf circuit Groq ouvert, voir isCircuitOpen()) mais n'utilise son
 *  résultat que si Groq expire ou échoue — dans le cas normal (Groq gagne),
 *  l'appel Deepgram a quand même été facturé pour rien. Ce module compte les
 *  4 issues possibles pour permettre de juger, avec de vrais chiffres plutôt
 *  qu'une impression, si ce double appel systématique vaut son coût ou si un
 *  mode "Groq primaire, Deepgram uniquement en repli déclenché" ferait
 *  aussi bien.
 *
 *  Compteurs cumulatifs (pas un ring buffer ici : contrairement à une
 *  latence, un TAUX n'a pas besoin d'expirer les anciens échantillons pour
 *  rester lisible — voir resetForTests()/formatStats() pour une fenêtre
 *  "depuis le dernier redémarrage").
 * ============================================================================
 */

let counts = {
  groqWins: 0,
  deepgramFallbackWins: 0,
  circuitSkips: 0,
  bothFailed: 0,
};

/** Groq a répondu avant expiration, sans erreur — le chemin normal. */
function recordGroqWin() {
  counts.groqWins++;
}

/** Groq a expiré ou échoué, Deepgram a fourni le résultat final utilisé. */
function recordDeepgramFallbackWin() {
  counts.deepgramFallbackWins++;
}

/** Circuit Groq ouvert : Deepgram appelé directement, Groq jamais tenté. */
function recordCircuitSkip() {
  counts.circuitSkips++;
}

/** Ni Groq ni Deepgram n'ont produit de résultat exploitable. */
function recordBothFailed() {
  counts.bothFailed++;
}

function getStats() {
  const total =
    counts.groqWins + counts.deepgramFallbackWins + counts.circuitSkips + counts.bothFailed;
  // AJOUT : "appels Deepgram gaspillés" = tous les cas où Deepgram a été
  // lancé en parallèle par précaution mais dont le résultat n'a jamais été
  // utilisé (Groq a gagné la course normalement). Exclut circuitSkips (là,
  // Deepgram est le seul appelé, rien n'est gaspillé) et bothFailed (les
  // deux étaient nécessaires, l'échec ne change rien à la nécessité de
  // l'appel).
  const wastedDeepgramCalls = counts.groqWins;
  return { ...counts, total, wastedDeepgramCalls };
}

/**
 * @returns {string|null} une recommandation textuelle une fois qu'il y a
 *   assez d'échantillons pour qu'un taux ait un sens (sinon null : pas
 *   assez de données, mieux vaut se taire qu'inventer une tendance).
 */
function getRecommendation() {
  const stats = getStats();
  const racedTotal = stats.groqWins + stats.deepgramFallbackWins;
  if (racedTotal < MIN_SAMPLES_FOR_RECOMMENDATION) return null;
  const fallbackRate = stats.deepgramFallbackWins / racedTotal;
  if (fallbackRate < LOW_FALLBACK_RATE_THRESHOLD) {
    return (
      `taux de repli Deepgram très faible (${(fallbackRate * 100).toFixed(1)}%, ` +
      `n=${racedTotal}) — Groq seul avec Deepgram déclenché À LA DEMANDE (plutôt ` +
      `qu'appelé en parallèle sur CHAQUE énoncé) économiserait probablement ` +
      `${stats.wastedDeepgramCalls} appel(s) Deepgram sans perte de résultat mesurable.`
    );
  }
  return (
    `taux de repli Deepgram significatif (${(fallbackRate * 100).toFixed(1)}%, ` +
    `n=${racedTotal}) — la course en parallèle sur chaque énoncé reste justifiée : ` +
    `Groq seul aurait manqué ce taux d'énoncés (délai supplémentaire du repli séquentiel).`
  );
}

const MIN_SAMPLES_FOR_RECOMMENDATION = 20;
const LOW_FALLBACK_RATE_THRESHOLD = 0.05;

function formatStats() {
  const stats = getStats();
  const pct = (n) => (stats.total === 0 ? '0.0' : ((n / stats.total) * 100).toFixed(1));
  const lines = [
    '[PROVIDER-RACE]',
    `groqWins: ${stats.groqWins} (${pct(stats.groqWins)}%)`,
    `deepgramFallbackWins: ${stats.deepgramFallbackWins} (${pct(stats.deepgramFallbackWins)}%)`,
    `circuitSkips: ${stats.circuitSkips} (${pct(stats.circuitSkips)}%)`,
    `bothFailed: ${stats.bothFailed} (${pct(stats.bothFailed)}%)`,
    `appels Deepgram gaspillés (Groq a gagné quand même): ${stats.wastedDeepgramCalls}`,
  ];
  const recommendation = getRecommendation();
  if (recommendation) lines.push(`Recommandation: ${recommendation}`);
  return lines.join('\n');
}

// AJOUT test — repartir d'un état propre entre deux scénarios.
function _reset() {
  counts = { groqWins: 0, deepgramFallbackWins: 0, circuitSkips: 0, bothFailed: 0 };
}

module.exports = {
  recordGroqWin,
  recordDeepgramFallbackWin,
  recordCircuitSkip,
  recordBothFailed,
  getStats,
  getRecommendation,
  formatStats,
  _reset,
  MIN_SAMPLES_FOR_RECOMMENDATION,
  LOW_FALLBACK_RATE_THRESHOLD,
};
