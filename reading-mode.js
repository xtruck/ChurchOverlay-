// reading-mode.js
const { levenshteinDistance } = require('./levenshtein');

class ReadingMode {
  constructor({ getChapterVerses, onVerseAdvance }) {
    this.getChapterVerses = getChapterVerses; // (book, chapter) => Promise<[{num, text}]>
    this.onVerseAdvance = onVerseAdvance; // callback(verseObj) appelé quand on avance

    this.active = false;
    this.book = null;
    this.chapter = null;
    this.verses = [];
    this.currentIndex = -1; // index dans this.verses
    this.overlapThreshold = 0.4; // 40% de chevauchement de mots
    // AJOUT (suivi auto d'une plage annoncée, ex. "verset 5 à 7") : borne de
    // fin, en NUMÉRO de verset (pas index). `null` = pas de plage annoncée,
    // avance sans limite comme avant.
    this.endVerseNumber = null;
  }

  async start(book, chapter, startVerseNumber, endVerseNumber) {
    this.book = book;
    this.chapter = chapter;
    this.verses = await this.getChapterVerses(book, chapter);
    this.currentIndex = this.verses.findIndex((v) => v.num === startVerseNumber);
    if (this.currentIndex === -1) this.currentIndex = 0;
    // Une plage n'est "réelle" que si la fin dépasse le début (voir
    // detector.js, verseEnd vaut toujours verseStart quand aucune plage
    // n'a été prononcée) — sinon on garde le comportement historique
    // (avance sans limite).
    this.endVerseNumber =
      typeof endVerseNumber === 'number' && endVerseNumber > startVerseNumber
        ? endVerseNumber
        : null;
    this.active = true;
    return this.verses[this.currentIndex];
  }

  stop() {
    this.active = false;
    this.book = null;
    this.chapter = null;
    this.verses = [];
    this.currentIndex = -1;
    this.endVerseNumber = null;
  }

  _wordOverlapScore(transcriptFragment, verseText) {
    const norm = (s) =>
      s
        .toLowerCase()
        .replace(/[.,;:!?«»"']/g, '')
        .split(/\s+/)
        .filter((w) => w.length > 2); // ignore mots trop courts (bruit)

    const fragWords = new Set(norm(transcriptFragment));
    const verseWords = norm(verseText);

    if (verseWords.length === 0 || fragWords.size === 0) return 0;

    let matches = 0;
    for (const w of verseWords) {
      if (fragWords.has(w)) {
        matches++;
        continue;
      }
      // tolérance légère aux erreurs de transcription mot-à-mot
      for (const fw of fragWords) {
        if (levenshteinDistance(w, fw) <= 1 && Math.min(w.length, fw.length) > 3) {
          matches++;
          break;
        }
      }
    }
    return matches / verseWords.length;
  }

  /**
   * Appelé à chaque nouveau fragment transcrit pendant que reading mode est actif.
   * Retourne le verset détecté (avance auto) ou null si rien ne correspond assez.
   */
  processFragment(transcriptFragment) {
    if (!this.active || this.verses.length === 0) return null;

    const text = transcriptFragment.trim().toLowerCase();

    // Commandes spéciales
    if (/chapitre suivant|next chapter/i.test(text)) {
      return { command: 'nextChapter' };
    }

    // Un numéro de verset dit seul après navigation ("verset 17", "v17",
    // ou juste "17") — cas fréquent quand quelqu'un annonce le numéro
    // avant de reprendre la lecture, sans répéter livre+chapitre.
    const verseOnlyMatch = text.match(/^(?:verset\s+|v(?:erse)?\.?\s*)?(\d{1,3})$/i);
    if (verseOnlyMatch) {
      const num = parseInt(verseOnlyMatch[1], 10);
      const idx = this.verses.findIndex((v) => v.num === num);
      if (idx !== -1) {
        this.currentIndex = idx;
        const verse = this.verses[idx];
        this.onVerseAdvance(verse);
        return verse;
      }
    }

    // Comparaison au verset courant ET aux 2 suivants (tolère un saut de ligne manqué)
    // AJOUT (plage annoncée, ex. "verset 5 à 7") : un candidat AU-DELÀ de
    // endVerseNumber est exclu — on tient le dernier verset de la plage
    // plutôt que de continuer à suivre un contenu que le pasteur n'a pas
    // annoncé. `verset N`/`chapitre suivant` (ci-dessus) restent des
    // dérogations explicites, non affectées par cette borne.
    const candidates = [this.currentIndex, this.currentIndex + 1, this.currentIndex + 2].filter(
      (i) =>
        i >= 0 &&
        i < this.verses.length &&
        (this.endVerseNumber === null || this.verses[i].num <= this.endVerseNumber)
    );

    let best = null;
    let bestScore = 0;

    for (const idx of candidates) {
      const score = this._wordOverlapScore(text, this.verses[idx].text);
      if (score >= this.overlapThreshold && score > bestScore) {
        bestScore = score;
        best = idx;
      }
    }

    if (best !== null && best !== this.currentIndex) {
      this.currentIndex = best;
      const verse = this.verses[best];
      this.onVerseAdvance(verse);
      return verse;
    }

    // Si ça matche encore le verset courant, pas de changement mais pas d'échec
    if (best === this.currentIndex) {
      return this.verses[this.currentIndex];
    }

    return null; // rien ne correspond suffisamment
  }
}

module.exports = { ReadingMode };
