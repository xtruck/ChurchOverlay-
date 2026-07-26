// levenshtein.js
function levenshteinDistance(a, b) {
  a = a.toLowerCase();
  b = b.toLowerCase();
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let curr = new Array(n + 1).fill(0);

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1,      // suppression
        curr[j - 1] + 1,  // insertion
        prev[j - 1] + cost // substitution
      );
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

// Seuil adaptatif : plus le nom est long, plus on tolère d'erreurs
function toleranceForLength(len) {
  if (len <= 4) return 1;   // "Marc", "Ruth", "Jean"
  if (len <= 8) return 2;   // "Matthieu", "Éphésiens"
  return 3;                 // "Philippiens", "Deutéronome"
}

/**
 * Trouve le meilleur nom de livre correspondant à un mot transcrit,
 * en tolérant les fautes de transcription Whisper/Groq.
 * @param {string} word - mot transcrit (ex: "Filipiens")
 * @param {string[]} knownBooks - liste des noms canoniques (ex: bookAliases)
 * @returns {{ book: string, distance: number } | null}
 */
function fuzzyMatchBook(word, knownBooks) {
  if (!word || word.length < 2) return null;

  let best = null;
  let bestDist = Infinity;

  for (const book of knownBooks) {
    // Filtre rapide : évite de calculer Levenshtein sur des mots
    // de longueur totalement incompatible (perf)
    if (Math.abs(book.length - word.length) > toleranceForLength(book.length) + 1) {
      continue;
    }

    const dist = levenshteinDistance(word, book);
    const threshold = toleranceForLength(book.length);

    if (dist <= threshold && dist < bestDist) {
      bestDist = dist;
      best = book;
    }
  }

  return best ? { book: best, distance: bestDist } : null;
}

module.exports = { levenshteinDistance, fuzzyMatchBook, toleranceForLength };
