/** Détecte les références bibliques citées en français dans une transcription. */
'use strict';

// AJOUT (audit — inspiré de Rhema, correspondance floue sur les noms de
// livres). Voir levenshtein.js pour le détail : ce module ne connaît aucun
// nom de livre, il ne fait que comparer des chaînes.
const { correctBookNameFuzzy } = require('./levenshtein');
// CUTOVER (support bilingue FR/EN, lot 10) : BOOKS était auparavant un
// littéral dupliqué (à l'identique) entre ce fichier et detector-en.js —
// voir book-catalog.js (lot 8), qui fusionne déjà les deux et sert
// maintenant de SOURCE UNIQUE. Dérivé ici (pas retapé) pour garantir un
// contenu strictement identique à l'ancien littéral — verrouillé par
// test-book-catalog.js (lot 8) et par le fait que test-detector.js (ce
// fichier) passe sans aucune modification.
const { BOOK_CATALOG } = require('./book-catalog');
const BOOKS = Object.fromEntries(Object.entries(BOOK_CATALOG).map(([key, { fr }]) => [key, fr]));

// CUTOVER (support bilingue FR/EN, lot 11a) : ces listes de déformations
// phonétiques Whisper étaient auparavant un littéral dupliqué (côté FR)
// distinct de celui de detector-en.js — voir keyword-variants.js, qui
// fusionne désormais les deux et sert de SOURCE UNIQUE, avec un contrôle de
// collision FR/EN permanent (test-keyword-variants.js). Étendez les listes
// dans keyword-variants.js désormais, pas ici.
const { KEYWORD_VARIANTS } = require('./keyword-variants');
const CHAPITRE_VARIANTS = KEYWORD_VARIANTS.chapitre.fr;
const VERSET_VARIANTS = KEYWORD_VARIANTS.verset.fr;

function correctPhoneticNoise(text) {
  let result = text;
  result = result.replace(/\bce\s*(\d{1,3})\s*(?:eme|e)?\s*chapitre\b/gi, 'chapitre $1');
  result = result.replace(/\bce2chapitre\b/gi, 'chapitre 2');
  result = result.replace(/\bce\s*chapitre\b/gi, 'chapitre');
  for (const variant of CHAPITRE_VARIANTS) {
    if (variant === 'chapitre') continue;
    result = result.replace(new RegExp(`\\b${escapeRegExp(variant)}\\b`, 'gi'), 'chapitre');
  }
  for (const variant of VERSET_VARIANTS) {
    if (variant === 'verset' || variant === 'versets') continue;
    result = result.replace(new RegExp(`\\b${escapeRegExp(variant)}\\b`, 'gi'), 'verset');
  }
  return result;
}

function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// AJOUT (cahier des charges — précision contextuelle) : indices qu'une
// citation biblique est réellement INTENTIONNELLE plutôt qu'une simple
// coïncidence de mots ("chapitre" au sens figuré, un nom de livre qui
// apparaît par hasard dans une autre phrase). Volontairement large sur les
// verbes/tournures (la parole prononcée ne reproduira jamais exactement une
// formulation) mais chaque entrée reste sans ambiguïté : aucune n'apparaît
// naturellement hors d'une introduction de citation.
const INTRO_PHRASES_PATTERN =
  /\b(?:il est ecrit|comme (?:il est )?ecrit|comme (?:le )?dit la bible|la parole (?:de dieu )?dit|selon l ecriture|les ecritures disent|la bible dit|comme nous (?:le )?dit|ouvrons (?:nos bibles )?(?:dans|en|a)|lisons (?:dans|en)|je lis (?:dans|en))\b/i;

/**
 * Indique si le texte contient une tournure d'introduction de citation
 * biblique ("il est écrit...", "comme dit la Bible...") — un indice fort
 * qu'une référence détectée à proximité est une VRAIE citation, pas une
 * coïncidence de mots.
 * @param {string} text - texte brut (sera normalisé en interne)
 * @returns {boolean}
 */
function hasIntroductionPhrase(text) {
  return INTRO_PHRASES_PATTERN.test(normalize(String(text || '')));
}

function normalize(value) {
  const base = String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[’']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return correctPhoneticNoise(base);
}

// CUTOVER (support bilingue FR/EN, lot 10) : voir number-words.js (lot 9),
// fusion des tables NUMBER_WORDS de ce fichier et de detector-en.js. La
// composition FR ("quatre-vingt" -> 80, pas 24) est préservée à l'identique
// dans number-words.js#numberWordsToDigits(text, 'fr') — verrouillée par
// test-number-words.js et par le fait que test-detector.js (ce fichier)
// passe sans aucune modification.
const { numberWordsToDigits: sharedNumberWordsToDigits } = require('./number-words');

function numberWordsToDigits(text) {
  return sharedNumberWordsToDigits(text, 'fr');
}

const aliases = Object.entries(BOOKS)
  .flatMap(([book, names]) => names.map((name) => ({ book, name })))
  .sort((a, b) => b.name.length - a.name.length);

// EXTRACTION (support bilingue FR/EN, lot 11b) : corps de boucle de
// matchAgainstAliases ci-dessous, isolé pour UN SEUL alias — nécessaire
// pour que bilingual-matcher.js (lot 11b) puisse entrelacer les alias FR et
// EN dans UNE SEULE boucle triée par longueur, plutôt que deux boucles
// séquentielles (FR entière, puis EN entière). Extraction MÉCANIQUE : tous
// les `continue` de la boucle d'origine deviennent `return null` (même
// effet — passer à l'alias suivant), aucune logique de matching modifiée.
// Comportement inchangé pour detectExact()/detect() ci-dessous — verrouillé
// par le fait que test-detector.js passe sans aucune modification.
function testAlias(normalized, name) {
  const escaped = escapeRegExp(name).replace(/\s+/g, '\\s+');

  // Inverted Spoken Pattern 1: "verset 16 du chapitre 3 de Jean"
  const invPattern1 = new RegExp(
    `\\bverset(?:s)?\\s+(\\d{1,3})(?:\\s*(?:-|a|à|au)\\s*(\\d{1,3}))?\\s+(?:du|de|dans|au)?\\s*chapitre\\s+(\\d{1,3})\\s+(?:de|du|dans|de\\s+l|d|sur)?\\s*${escaped}\\b`,
    'i'
  );
  const mInv1 = normalized.match(invPattern1);
  if (mInv1) {
    const vStart = Number(mInv1[1]);
    const vEnd = mInv1[2] ? Number(mInv1[2]) : vStart;
    const ch = Number(mInv1[3]);
    if (ch > 0 && ch <= 150 && vStart > 0 && vStart <= 200 && vEnd >= vStart && vEnd <= 200) {
      return { chapter: ch, verseStart: vStart, verseEnd: vEnd, raw: mInv1[0].trim() };
    }
  }

  // Inverted Spoken Pattern 2: "chapitre 3 de Jean verset 16"
  const invPattern2 = new RegExp(
    `\\bchapitre\\s+(\\d{1,3})\\s+(?:de|du|dans|de\\s+l|d|sur)?\\s*${escaped}\\s+(?:au\\s+|le\\s+|les\\s+)?verset(?:s)?\\s+(\\d{1,3})(?:\\s*(?:-|a|à|au)\\s*(\\d{1,3}))?\\b`,
    'i'
  );
  const mInv2 = normalized.match(invPattern2);
  if (mInv2) {
    const ch = Number(mInv2[1]);
    const vStart = Number(mInv2[2]);
    const vEnd = mInv2[3] ? Number(mInv2[3]) : vStart;
    if (ch > 0 && ch <= 150 && vStart > 0 && vStart <= 200 && vEnd >= vStart && vEnd <= 200) {
      return { chapter: ch, verseStart: vStart, verseEnd: vEnd, raw: mInv2[0].trim() };
    }
  }

  // Inverted Spoken Pattern 3: "verset 16 de Jean 3"
  const invPattern3 = new RegExp(
    `\\bverset(?:s)?\\s+(\\d{1,3})(?:\\s*(?:-|a|à|au)\\s*(\\d{1,3}))?\\s+(?:dans|de|du)?\\s*${escaped}\\s+(?:chapitre\\s+)?(\\d{1,3})\\b`,
    'i'
  );
  const mInv3 = normalized.match(invPattern3);
  if (mInv3) {
    const vStart = Number(mInv3[1]);
    const vEnd = mInv3[2] ? Number(mInv3[2]) : vStart;
    const ch = Number(mInv3[3]);
    if (ch > 0 && ch <= 150 && vStart > 0 && vStart <= 200 && vEnd >= vStart && vEnd <= 200) {
      return { chapter: ch, verseStart: vStart, verseEnd: vEnd, raw: mInv3[0].trim() };
    }
  }

  const requireExplicitChapitre = name.length <= 2;
  const chapitreKeyword = requireExplicitChapitre ? `chapitre\\s+` : `(?:chapitre\\s+)?`;

  // Standard Pattern
  //
  // CORRECTIF (audit — détecteur "pas assez performant", donnait le
  // chapitre entier au lieu du verset précis) : deux notations orales/
  // écrites très courantes de référence biblique n'étaient pas
  // reconnues, faute de verset capturé : "Jean 3.16" (point comme
  // séparateur — tout aussi naturel que ":" à l'oral transcrit) et
  // "Jean 3 v16" / "Jean 3 v. 16" (abréviation "v" pour "verset", très
  // répandue). Dans les deux cas, le verset entier était perdu et
  // detector.js retombait sur la référence "chapitre seul" la plus
  // faible — d'où le chapitre complet affiché au lieu du verset attendu.
  const pattern = new RegExp(
    `(?:^|\\s)${escaped}\\s+` + // Book name
      chapitreKeyword + // "chapitre"
      `(\\d{1,3})` + // Chapter (group 1)
      `(?:` + // Start optional verse group
      `\\s*` + // Optional whitespace
      `(?:` +
      `[:,.]\\s*` + // Colon, comma, OR period ("Jean 3.16")
      `(?:(?:verset(?:s)?|v\\.?)\\s+)?` + // Optional "verset"/"v"/"v." after separator
      `(\\d{1,3})` + // Verse start (group 2)
      `|` +
      `\\s+(?:verset(?:s)?|v\\.?)\\s+` + // " verset " OR " v " OR " v. " (abréviation)
      `(\\d{1,3})` + // Verse start (group 3)
      `|` +
      `\\s+` + // Just whitespace
      `(\\d{1,3})` + // Verse start (group 4)
      `)` +
      `(?:` + // Optional verse range
      `\\s*` +
      `(?:-|a|à|au)` + // Range separator
      `\\s*` +
      `(\\d{1,3})` + // Verse end (group 5)
      `)?` +
      `)?` +
      `(?=$|[\\s,.;!?)])`, // Word boundary
    'i'
  );

  const match = normalized.match(pattern);
  if (!match) return null;

  const chapter = Number(match[1]);

  // Get verse start from whichever group captured it (2, 3, or 4)
  const verseStart =
    match[2] || match[3] || match[4] ? Number(match[2] || match[3] || match[4]) : undefined;

  // Get verse end (group 5) or default to verse start
  const verseEnd = match[5] ? Number(match[5]) : verseStart;

  // Validation
  if (chapter > 0 && chapter <= 150) {
    // NB: verseStart peut valoir 0 (ex. transcription erronée "verset 0"),
    // qui est une valeur "falsy" en JS — on doit donc tester
    // `!== undefined` et non `verseStart` seul, sinon 0 échappait à la
    // validation de plage ci-dessous.
    if (verseStart !== undefined && (verseStart <= 0 || verseStart > 200)) return null;
    if (verseEnd !== undefined && (verseEnd < verseStart || verseEnd > 200)) return null;

    return {
      chapter,
      verseStart,
      verseEnd,
      raw: match[0].trim(),
    };
  }

  return null;
}

// Boucle de détection exacte (regex par alias), extraite de detect() pour
// pouvoir être rejouée une seconde fois sur un texte corrigé par la
// correspondance floue (voir detect() ci-dessous) sans dupliquer la logique.
function matchAgainstAliases(normalized) {
  for (const { book, name } of aliases) {
    const result = testAlias(normalized, name);
    if (result) return { book, ...result };
  }
  return null;
}

// AJOUT (cahier des charges — score de confiance) : ajouté ICI, en
// enveloppant les points de sortie de matchAgainstAliases(), plutôt que
// dans ses 4 "return" internes — évite de toucher cette fonction dense et
// déjà bien réglée (regex inversées + pattern standard) juste pour y coller
// un champ. 'high' : verset explicitement précisé (référence non ambiguë,
// c'est exactement la condition du court-circuit "appel direct", voir
// server.js processTranscript). 'medium' : référence "chapitre seul" (une
// vraie référence, mais moins précise). Les correspondances FLOUES
// (fuzzyMatch plus bas) ne dépassent jamais 'medium', quelle que soit la
// précision du verset — le nom du livre lui-même y est une supposition.
function withConfidence(match) {
  if (!match) return match;
  return { ...match, confidence: match.verseStart !== undefined ? 'high' : 'medium' };
}

function detectExact(text) {
  const normalized = numberWordsToDigits(normalize(text));
  return withConfidence(matchAgainstAliases(normalized));
}

function detect(text) {
  const normalized = numberWordsToDigits(normalize(text));
  const exact = matchAgainstAliases(normalized);
  if (exact) return withConfidence(exact);

  // AJOUT (audit — inspiré de Rhema, correspondance floue). Aucune
  // correspondance exacte : peut-être que Whisper/Groq a mal transcrit le
  // nom du livre ("Filipiens" au lieu de "Philippiens", "Gen" déformé en
  // "Jan"...) alors que le reste de la phrase (chapitre/verset) est correct.
  // On tente une seule correction, on rejoue la même détection dessus, et on
  // s'arrête là : ce n'est qu'un filet de secours ciblé, pas une boucle de
  // réessais illimitée.
  const corrected = correctBookNameFuzzy(normalized, aliases);
  if (!corrected) return null;

  const fuzzyMatch = matchAgainstAliases(corrected.text);
  if (!fuzzyMatch) return null;

  // CORRECTIF (audit — faux positif résiduel découvert après le correctif
  // sur les alias courts ci-dessus) : "vous êtes deux témoins" (aucune
  // référence biblique) se faisait corriger en "vous actes 2 témoins" par
  // le fuzzy matching ("etes" ~ "actes", distance 2, alias de 5 lettres —
  // donc non couvert par la garde "chapitre obligatoire" qui ne vise que
  // les alias <=2 lettres), puis matchait le format le plus faible
  // possible : "livre + numéro nu", sans "chapitre" ni verset. Ce format
  // est acceptable pour un match EXACT (le nom du livre est alors une
  // preuve suffisante à lui seul), mais beaucoup trop faible pour un match
  // FUZZY, où l'identité même du livre est déjà une supposition. On exige
  // donc, uniquement sur ce chemin fuzzy, une preuve contextuelle
  // supplémentaire : soit le mot "chapitre" est explicitement présent,
  // soit un verset est spécifié (":16", ", verset 16"...). C'est déjà le
  // cas de tous les tests fuzzy existants ("Filipiens 2:5", "Jan 3:16"...
  // — tous au format deux-points+verset), donc cette garde ne change rien
  // pour eux.
  const hasChapitreKeyword = /\bchapitre\b/i.test(fuzzyMatch.raw);
  const hasVerseSpecified = fuzzyMatch.verseStart !== undefined;
  // AJOUT (cahier des charges — précision contextuelle) : une tournure
  // d'introduction de citation ("il est écrit...") sur le texte ORIGINAL
  // (pas le texte corrigé par le fuzzy matching, qui ne porte que le nom du
  // livre corrigé) est une preuve tout aussi valable que "chapitre"/verset
  // explicite — réduit les faux NÉGATIFS sur de vraies citations
  // paraphrasées ("comme il est écrit dans Filipiens 2") qui étaient
  // rejetées jusqu'ici faute de mot "chapitre" ou de verset précis.
  const hasIntroPhrase = hasIntroductionPhrase(text);
  if (!hasChapitreKeyword && !hasVerseSpecified && !hasIntroPhrase) {
    console.log(
      `[detector] Correspondance floue rejetée (preuve insuffisante — ni "chapitre", ni verset, ni tournure d'introduction) : ` +
        `"${corrected.original}" → "${corrected.name}"`
    );
    return null;
  }

  console.log(
    `[detector] Correspondance floue : "${corrected.original}" → "${corrected.name}" ` +
      `(distance ${corrected.distance})`
  );
  // CORRECTIF : une correspondance floue (nom de livre deviné, pas certain)
  // était renvoyée avec exactement la même forme qu'une correspondance
  // exacte — server.js n'avait donc aucun moyen de la traiter différemment
  // (ex. demander confirmation avant affichage). On l'annote. confidence
  // plafonnée à 'medium' quelle que soit la précision du verset : le nom du
  // livre lui-même reste une supposition sur ce chemin.
  return {
    ...fuzzyMatch,
    confidence: 'medium',
    fuzzy: true,
    fuzzyDistance: corrected.distance,
    fuzzyOriginal: corrected.original,
  };
}

// Quick test when run directly
if (require.main === module) {
  console.log('=== Testing detector.js ===\n');

  const tests = [
    // Formats that should work
    { text: 'Jean chapitre 3, verset 4', expected: true },
    { text: 'Jean 3:4', expected: true },
    { text: 'Jean 3:4-6', expected: true },
    { text: 'Matthieu chapitre 5, verset 3', expected: true },
    { text: 'Psaumes 23:1', expected: true },
    { text: '1 Corinthiens 13:4-7', expected: true },
    { text: 'Jean chapitre 3 versets 16 à 18', expected: true },
    { text: 'Romains 8:28', expected: true },
    { text: 'Apocalypse 21:4', expected: true },

    // Edge cases
    // Chapitre seul, sans verset : DOIT être détecté (voir tests/test-detector.js,
    // suite officielle, cas "Psaume 23" avec verseStart/verseEnd undefined).
    { text: 'Jean 3', expected: true },
    { text: 'Jean chapitre 3', expected: true },

    // Phonetic variations (Whisper errors)
    { text: 'Jean chappitois 3, vece 4', expected: true },
    { text: 'Jean sapitois 3, vsc 4', expected: true },

    // AJOUT (audit — correspondance floue Levenshtein, inspirée de Rhema) :
    // erreurs de transcription sur le NOM DU LIVRE lui-même (distinct des
    // variantes phonétiques "chapitre"/"verset" testées ci-dessus).
    { text: 'Filipiens 2:5', expected: true }, // Philippiens mal transcrit
    { text: 'Ruthe 1:16', expected: true }, // Ruth + résidu
    { text: 'Efesiens 4:32', expected: true }, // Éphésiens mal transcrit
    { text: 'Jan 3:16', expected: true }, // Jean mal transcrit

    // Should NOT match
    { text: "Ce qu'il va manger", expected: false },
    { text: 'Merci beaucoup', expected: false },
    { text: 'Obrigada', expected: false },

    // Mixed language
    { text: 'Se abarde', expected: false },
  ];

  let passed = 0;
  let failed = 0;

  tests.forEach(({ text, expected }) => {
    const result = detect(text);
    const detected = result !== null;
    const status = detected === expected ? '✅' : '❌';

    if (detected === expected) passed++;
    else failed++;

    console.log(`${status} "${text}"`);
    if (result) {
      console.log(
        `   → ${result.book} ${result.chapter}:${result.verseStart || ''}${result.verseEnd && result.verseEnd !== result.verseStart ? '-' + result.verseEnd : ''}`
      );
    } else if (expected) {
      console.log(`   → Expected match but got null`);
    }
    console.log('');
  });

  console.log(`=== Results: ${passed} passed, ${failed} failed ===`);
}

/**
 * AJOUT (audit — inspiré de Rhema, "changement de traduction à la voix").
 * Détecte une phrase de commande demandant de changer de traduction
 * biblique en cours de culte (ex: "passons en Darby", "lis en Segond"),
 * distincte d'une référence de verset classique. Volontairement permissive
 * sur le verbe déclencheur (la reconnaissance vocale ne rendra jamais
 * exactement la même formulation deux fois), mais stricte sur le nom de
 * traduction : seules 'segond' et 'darby' sont reconnues (les deux seules
 * traductions françaises disponibles via des APIs libres de droits — voir
 * bible-lookup-with-api.js/AVAILABLE_TRANSLATIONS).
 * @param {string} text - Segment de transcription à analyser
 * @returns {{ code: 'lsg'|'darby' }|null}
 */
function detectTranslationSwitch(text) {
  const normalized = normalize(text);
  // Verbe déclencheur, conjugué correctement (le français ne forme pas
  // "nous passons" en collant "e"+"ons" à l'infinitif — piège sur lequel la
  // première version de cette regex trébuchait). Prépositions optionnelles
  // ("en", "à", "vers", "sur", "la", "le") car "utilisons la Darby" est tout
  // aussi naturel que "passons en Darby" à l'oral.
  const match = normalized.match(
    /\b(?:lis(?:ons|ez)?|lire|lecture|passe(?:z)?|passons|repasse(?:z)?|repassons|retourne(?:z)?|retournons|change(?:z)?|changeons|utilise(?:z)?|utilisons)\b.{0,25}?\b(?:en|a|vers|sur|la|le)?\s*(segond|louis\s*segond|darby)\b/
  );
  if (!match) return null;
  const code = match[1].startsWith('darby') ? 'darby' : 'lsg';
  return { code };
}

module.exports = {
  detect,
  detectExact,
  normalize,
  numberWordsToDigits,
  detectTranslationSwitch,
  hasIntroductionPhrase,
  BOOKS,
  // AJOUT (support bilingue FR/EN, lot 11b) : exports additifs pour
  // bilingual-matcher.js (moteur d'appariement bilingue en un seul passage,
  // voir ce fichier) — aucun appelant existant n'est affecté, ces exports
  // n'existaient simplement pas avant.
  aliases,
  testAlias,
};
