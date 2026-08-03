/**
 * ============================================================================
 *  levenshtein.js — Correction floue des noms de livres bibliques
 * ----------------------------------------------------------------------------
 *  AJOUT (audit — inspiré de Rhema, correspondance floue sur les noms de
 *  livres). Rhema calcule une distance de Levenshtein entre ce que
 *  Whisper/Groq a transcrit et les noms de livres connus, avec un seuil qui
 *  s'adapte à la longueur du nom, ce qui absorbe les erreurs de transcription
 *  courantes ("Filipiens" → "Philippiens", "Gen" → "Jean", ...).
 *
 *  detector.js et detector-en.js n'avaient jusqu'ici AUCUNE tolérance de ce
 *  type : un livre mal transcrit par Groq/Deepgram = détection ratée, quelle
 *  que soit la qualité du reste de la phrase (chapitre/verset corrects).
 *
 *  Ce module est volontairement générique et sans dépendance aux deux
 *  détecteurs (FR/EN) : il prend en entrée la liste d'alias déjà construite
 *  par chacun d'eux (`{ book, name }[]`, triée par longueur décroissante) et
 *  ne connaît donc aucun nom de livre en dur — il est réutilisable tel quel
 *  pour n'importe quelle langue ajoutée plus tard.
 * ============================================================================
 */
'use strict';

/**
 * Distance de Levenshtein classique (nombre minimal d'insertions,
 * suppressions ou substitutions pour passer de `a` à `b`).
 * Implémentation en deux lignes de tableau (O(n) mémoire au lieu de O(m*n)).
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function levenshteinDistance(a, b) {
  a = String(a || '').toLowerCase();
  b = String(b || '').toLowerCase();
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  let prev = new Array(n + 1);
  let curr = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1, // suppression
        curr[j - 1] + 1, // insertion
        prev[j - 1] + cost // substitution
      );
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

/**
 * Seuil de tolérance adaptatif : plus le nom de livre est long, plus on
 * accepte d'erreurs de transcription sans risquer de faux positifs entre
 * deux noms de livres différents mais courts (ex: "job" / "joel").
 * @param {number} len - longueur du nom canonique (alias)
 * @returns {number}
 */
function toleranceForLength(len) {
  if (len <= 4) return 1; // "marc", "ruth", "jean", "john"
  if (len <= 8) return 2; // "matthieu", "ephesiens", "matthew"
  return 3; // "philippiens", "deuteronome", "philippians"
}

function tokenize(text) {
  return String(text || '')
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Longueur minimale d'un alias pour être éligible à la correspondance floue.
 *
 * CORRECTIF (audit — faux positifs découverts via test d'intégration
 * end-to-end du Reading Mode) : plusieurs livres ont des alias très courts
 * (2-3 lettres : "es" pour Ésaïe, "mc" pour Marc, "ps" pour Psaumes...). Sur
 * un alias aussi court, une tolérance de distance 1 (voir
 * toleranceForLength) capte quasiment n'importe quel mot français courant
 * de longueur voisine — "es" matche "est", "ses", "les", "mes", "tes"...
 * Exemple réel reproduit en test : la phrase "nous savons que tu es un
 * docteur" (aucune référence biblique) était faussement détectée comme
 * "Ésaïe 1" (le "es" de "tu es" + le "un" converti en chiffre "1" par
 * numberWordsToDigits). Le match EXACT sur ces alias courts reste inchangé
 * (une abréviation délibérée comme "Mc 3:5" doit continuer à fonctionner) —
 * seule la tolérance aux erreurs de transcription est désactivée en
 * dessous de ce seuil, car son bénéfice (rattraper une vraie faute de
 * Whisper/Groq sur un nom de livre) est largement dépassé par son coût
 * (déclencher sur du langage courant) pour des alias aussi courts.
 */
const MIN_FUZZY_ALIAS_LENGTH = 4;

/**
 * Cherche, dans un texte déjà normalisé, la fenêtre de mots la plus proche
 * (au sens Levenshtein) d'un alias de livre connu, et propose une correction.
 *
 * Ne renvoie une correction QUE si la distance est strictement positive :
 * une correspondance exacte (distance 0) est déjà couverte par la détection
 * regex classique — inutile de la retraiter ici. C'est un filet de secours,
 * pas un remplacement du chemin rapide existant.
 *
 * @param {string} normalizedText - texte déjà passé par normalize()
 * @param {{book: string, name: string}[]} aliasEntries - alias déjà triés
 *   par longueur de `name` décroissante (comme construit par detector.js)
 * @returns {{ text: string, book: string, name: string, original: string, distance: number }|null}
 *   `text` est le texte corrigé (fenêtre remplacée par le nom canonique),
 *   prêt à être repassé dans le même moteur de détection par référence.
 */
function correctBookNameFuzzy(normalizedText, aliasEntries) {
  const tokens = tokenize(normalizedText);
  if (tokens.length === 0 || !Array.isArray(aliasEntries) || aliasEntries.length === 0) {
    return null;
  }

  let best = null;

  for (const { book, name } of aliasEntries) {
    if (name.length < MIN_FUZZY_ALIAS_LENGTH) continue; // voir note ci-dessus

    const nameWordCount = name.split(/\s+/).length;
    const threshold = toleranceForLength(name.length);

    for (let i = 0; i + nameWordCount <= tokens.length; i++) {
      const window = tokens.slice(i, i + nameWordCount).join(' ');

      // Filtre rapide : évite de calculer Levenshtein sur des fenêtres dont
      // la longueur est de toute façon hors de portée du seuil (perf — la
      // boucle complète est alias × position, potentiellement des milliers
      // d'itérations par segment transcrit).
      if (Math.abs(window.length - name.length) > threshold + 1) continue;

      const dist = levenshteinDistance(window, name);
      if (dist === 0) continue; // déjà géré par la détection exacte
      if (dist <= threshold && (!best || dist < best.distance)) {
        best = { start: i, end: i + nameWordCount, name, book, distance: dist };
      }
    }
  }

  if (!best) return null;

  const correctedTokens = tokens.slice();
  const original = tokens.slice(best.start, best.end).join(' ');
  correctedTokens.splice(best.start, best.end - best.start, ...best.name.split(/\s+/));

  return {
    text: correctedTokens.join(' '),
    book: best.book,
    name: best.name,
    original,
    distance: best.distance,
  };
}

module.exports = { levenshteinDistance, toleranceForLength, correctBookNameFuzzy };
