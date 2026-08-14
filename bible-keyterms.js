/**
 * ============================================================================
 *  bible-keyterms.js — Vocabulaire biblique pour le boosting STT
 * ----------------------------------------------------------------------------
 *  Centralise la liste des livres bibliques (FR), de leurs formes parlées,
 *  et du vocabulaire théologique courant, utilisée par :
 *    - groq-wrapper.js   → construit un `prompt` (contexte initial Whisper)
 *    - deepgram-wrapper.js / deepgram-streaming.js → construisent le
 *      paramètre `keyterm` (Nova-3 — voir buildDeepgramKeyterms() plus bas)
 *
 *  Objectif : réduire le taux d'erreur de transcription À LA SOURCE sur le
 *  vocabulaire spécifique au culte (au lieu de corriger après coup dans
 *  detector.js via CHAPITRE_VARIANTS/VERSET_VARIANTS).
 * ============================================================================
 */
'use strict';

// Noms de livres (formes canoniques, telles que détectées par detector.js).
const BOOK_NAMES_FR = [
  'Genèse',
  'Exode',
  'Lévitique',
  'Nombres',
  'Deutéronome',
  'Josué',
  'Juges',
  'Ruth',
  '1 Samuel',
  '2 Samuel',
  '1 Rois',
  '2 Rois',
  '1 Chroniques',
  '2 Chroniques',
  'Esdras',
  'Néhémie',
  'Esther',
  'Job',
  'Psaumes',
  'Proverbes',
  'Ecclésiaste',
  'Cantique des cantiques',
  'Ésaïe',
  'Jérémie',
  'Lamentations',
  'Ézéchiel',
  'Daniel',
  'Osée',
  'Joël',
  'Amos',
  'Abdias',
  'Jonas',
  'Michée',
  'Nahum',
  'Habacuc',
  'Sophonie',
  'Aggée',
  'Zacharie',
  'Malachie',
  'Matthieu',
  'Marc',
  'Luc',
  'Jean',
  'Actes',
  'Romains',
  '1 Corinthiens',
  '2 Corinthiens',
  'Galates',
  'Éphésiens',
  'Philippiens',
  'Colossiens',
  '1 Thessaloniciens',
  '2 Thessaloniciens',
  '1 Timothée',
  '2 Timothée',
  'Tite',
  'Philémon',
  'Hébreux',
  'Jacques',
  '1 Pierre',
  '2 Pierre',
  '1 Jean',
  '2 Jean',
  '3 Jean',
  'Jude',
  'Apocalypse',
];

// Formes parlées avec nombre en toutes lettres (utile car Whisper/Deepgram
// entendent souvent "premier corinthiens" avant de le convertir en "1").
const SPOKEN_FORMS_FR = [
  'premier Samuel',
  'deuxième Samuel',
  'premier Rois',
  'deuxième Rois',
  'premier Chroniques',
  'deuxième Chroniques',
  'premier Corinthiens',
  'deuxième Corinthiens',
  'premier Thessaloniciens',
  'deuxième Thessaloniciens',
  'premier Timothée',
  'deuxième Timothée',
  'premier Pierre',
  'deuxième Pierre',
  'premier Jean',
  'deuxième Jean',
  'troisième Jean',
];

// Vocabulaire théologique / liturgique fréquent en culte, souvent mal
// transcrit par les modèles STT généralistes.
const THEOLOGICAL_TERMS_FR = [
  'justification',
  'sanctification',
  'propitiation',
  'eschatologie',
  'expiation',
  'rédemption',
  'justice',
  'alliance',
  'baptême',
  'résurrection',
  'crucifixion',
  'salut',
  'repentance',
  'grâce',
  'miséricorde',
  'pardon',
  'réconciliation',
  'glorification',
  'prédestination',
  'souveraineté',
  'omniscience',
  'omnipotence',
  'trinité',
  'incarnation',
  'ascension',
  'transfiguration',
  'béatitudes',
  'tabernacle',
  "arche de l'alliance",
  'Melchisédek',
  'Nabuchodonosor',
  'chapitre',
  'verset',
  'Segond',
  'Darby',
];

/**
 * Retourne la liste complète des termes (livres + formes parlées + vocabulaire
 * théologique), dédupliquée.
 * @returns {string[]}
 */
function getAllKeyterms() {
  const all = [...BOOK_NAMES_FR, ...SPOKEN_FORMS_FR, ...THEOLOGICAL_TERMS_FR];
  return [...new Set(all)];
}

/**
 * Construit une chaîne de "prompt" pour l'API Groq/Whisper : Whisper utilise
 * ce texte comme contexte initial pour biaiser son vocabulaire, PAS comme
 * une instruction. Une phrase naturelle contenant les termes fonctionne
 * mieux qu'une simple liste virgule (limite ~224 tokens côté Whisper —
 * on reste sous ce seuil en se concentrant sur les livres, pas le vocabulaire
 * théologique complet).
 * @returns {string}
 */
function buildWhisperPrompt() {
  return (
    'Culte chrétien, lecture biblique. Livres cités : ' +
    BOOK_NAMES_FR.join(', ') +
    '. Formes parlées : ' +
    SPOKEN_FORMS_FR.join(', ') +
    '.'
  );
}

/**
 * Construit la valeur du paramètre `keyterm` pour l'API Deepgram (Nova-3) —
 * voir developers.deepgram.com/docs/keyterm, vérifié le 2026-08-14 avant
 * cette migration (Chantier 1a).
 *
 * CORRECTIF (migration nova-2 -> nova-3) : remplace buildDeepgramKeywords(),
 * qui construisait `terme:intensité` pour l'ANCIEN paramètre `keywords`
 * (Nova-2 uniquement, voir historique git). Le "Keyterm Prompting" de
 * Nova-3 est un mécanisme DIFFÉRENT, pas juste un renommage : un terme par
 * occurrence du paramètre (`?keyterm=Jean&keyterm=Corinthiens`, jamais de
 * virgule), AUCUNE syntaxe de poids/intensité (`terme:1.5` serait pris tel
 * quel comme littéral, pas interprété) — donc pas de paramètre `boost` ici,
 * contrairement à l'ancienne fonction.
 * @returns {string[]} tableau de termes bruts, un par élément (l'appelant
 *   construit `keyterm=${encodeURIComponent(terme)}` pour chacun)
 */
function buildDeepgramKeyterms() {
  return getAllKeyterms();
}

module.exports = {
  BOOK_NAMES_FR,
  SPOKEN_FORMS_FR,
  THEOLOGICAL_TERMS_FR,
  getAllKeyterms,
  buildWhisperPrompt,
  buildDeepgramKeyterms,
};
