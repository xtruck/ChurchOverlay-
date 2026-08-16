/**
 * ============================================================================
 *  book-catalog.js — Catalogue bilingue des livres bibliques (FR + EN)
 * ----------------------------------------------------------------------------
 *  AJOUT (support bilingue FR/EN, lot 8) : fusion MÉCANIQUE des tables BOOKS
 *  de detector.js (alias français) et detector-en.js (alias anglais) — les
 *  deux fichiers exportaient déjà chacune leur BOOKS avant ce lot, la fusion
 *  a donc été générée directement depuis ces exports (pas retapée à la
 *  main), pour éliminer tout risque de faute de frappe/oubli d'alias.
 *  detector.js/detector-en.js consomment ce catalogue depuis le lot 10
 *  (cutover) — voir les commits "Lot 8/14" à "Lot 11b/14" (git log) pour
 *  l'historique complet.
 *
 *  ============================================================================
 *  DOCUMENTATION CANONIQUE (lot 12, clôture — aucun changement de code) :
 *  clé canonique interne des livres bibliques dans TOUTE l'app
 *  ============================================================================
 *
 *  La clé de chaque entrée (ex. 'jean', 'apocalypse') est le SLUG FRANÇAIS —
 *  et c'est la SEULE clé interne utilisée pour identifier un livre biblique
 *  PARTOUT dans ChurchOverlay, quelle que soit la langue parlée par le
 *  prédicateur ou affichée à l'écran. Consommateurs confirmés (lecture
 *  directe du code, pas une supposition) :
 *    - detector.js / detector-en.js : `BOOKS`, dérivé de BOOK_CATALOG (lot 10)
 *    - bilingual-matcher.js : `COMBINED_ALIASES` (lot 11b)
 *    - bible-offline-cache.js : `HELLOAO_BOOK_CODES` (clés du cache local)
 *    - reading-mode.js : navigation chapitre/verset (`currentBook`)
 *    - server.js : dédoublonnage d'historique (`refKey`)
 *    - bible-lookup-with-api.js : voir DISPLAY_NAMES/DISPLAY_NAMES_EN/label()
 *      ci-dessous — le SEUL endroit qui traduit cette clé vers un nom
 *      affichable.
 *
 *  TRADUCTION VERS L'AFFICHAGE — bible-lookup-with-api.js#label() est le
 *  SEUL point de l'application qui convertit la clé canonique française en
 *  nom de livre LISIBLE, dans la langue d'AFFICHAGE demandée (`displayLanguage`,
 *  totalement indépendante de la langue parlée — voir session-state.js) :
 *  `label({book, chapter, verseStart, verseEnd}, lang)` pioche dans
 *  DISPLAY_NAMES ('jean' -> 'Jean') ou DISPLAY_NAMES_EN ('jean' -> 'John')
 *  selon `lang`. Aucun autre fichier ne doit dupliquer cette traduction —
 *  toute nouvelle surface d'affichage (dashboard, overlay, export) doit
 *  passer par label(), pas réinventer un dictionnaire de noms de livres.
 *
 *  DÉCISION EXPLICITE — PAS DE RENOMMAGE, PAS DE CHAMP PARALLÈLE : le slug
 *  français ('jean') reste la clé canonique même pour un prédicateur qui ne
 *  parle jamais français. Deux alternatives ont été délibérément écartées :
 *    1. Renommer la clé interne en un identifiant neutre (ex. 'JHN', code
 *       osis/usfm) : aurait nécessité de toucher SIMULTANÉMENT tous les
 *       consommateurs listés ci-dessus (risque de régression élevé pour un
 *       simple renommage cosmétique) sans bénéfice fonctionnel — la clé
 *       n'est JAMAIS affichée telle quelle à l'opérateur ou à l'assemblée
 *       (toujours traduite via label() en amont), donc son origine
 *       linguistique est invisible en pratique.
 *    2. Ajouter un champ `book` parallèle neutre en plus de la clé
 *       existante : aurait dupliqué la source de vérité (deux façons de
 *       désigner "Jean/John"), ouvrant la porte à une désynchronisation
 *       future entre les deux — exactement le genre de fragmentation que ce
 *       lot (8-12) a pour but d'éliminer, pas de reproduire sous une autre
 *       forme.
 *  Le slug français est donc un CHOIX HISTORIQUE ASSUMÉ (ChurchOverlay a
 *  démarré comme app francophone), pas un défaut à corriger — traité comme
 *  un simple identifiant opaque par le reste du code, au même titre qu'un
 *  UUID ou un code ISO l'aurait été.
 * ============================================================================
 */
'use strict';

/**
 * @type {Object<string, { fr: string[], en: string[] }>}
 * Clé : slug français canonique. `fr`/`en` : alias oraux reconnus par
 * detector.js / detector-en.js respectivement pour ce livre.
 */
const BOOK_CATALOG = {
  genese: {
    fr: ['genese', 'gen', 'livre de la genese', 'livre de genese'],
    en: ['genesis', 'gen'],
  },
  exode: {
    fr: ['exode', 'exo', 'livre de l exode', 'livre d exode'],
    en: ['exodus', 'exod', 'exo'],
  },
  levitique: { fr: ['levitique', 'lev', 'livre du levitique'], en: ['leviticus', 'lev'] },
  nombres: { fr: ['nombres', 'nom', 'livre des nombres'], en: ['numbers', 'num'] },
  deuteronome: {
    fr: ['deuteronome', 'deut', 'livre du deuteronome'],
    en: ['deuteronomy', 'deut'],
  },
  josue: { fr: ['josue', 'jos', 'livre de josue'], en: ['joshua', 'josh'] },
  juges: { fr: ['juges', 'jug', 'livre des juges'], en: ['judges', 'judg'] },
  ruth: { fr: ['ruth', 'livre de ruth', 'rt'], en: ['ruth'] },
  '1samuel': {
    fr: [
      '1 samuel',
      '1er samuel',
      '1ere samuel',
      'premier samuel',
      'premier livre de samuel',
      '1 livre de samuel',
      'i samuel',
    ],
    en: ['1 samuel', 'first samuel', 'i samuel'],
  },
  '2samuel': {
    fr: [
      '2 samuel',
      '2eme samuel',
      'deuxieme samuel',
      'second samuel',
      'deuxieme livre de samuel',
      '2 livre de samuel',
      'ii samuel',
    ],
    en: ['2 samuel', 'second samuel', 'ii samuel'],
  },
  '1rois': {
    fr: [
      '1 rois',
      '1er rois',
      'premier rois',
      'premier livre des rois',
      '1 livre des rois',
      'i rois',
    ],
    en: ['1 kings', 'first kings', 'i kings'],
  },
  '2rois': {
    fr: [
      '2 rois',
      '2eme rois',
      'deuxieme rois',
      'second rois',
      'deuxieme livre des rois',
      '2 livre des rois',
      'ii rois',
    ],
    en: ['2 kings', 'second kings', 'ii kings'],
  },
  '1chroniques': {
    fr: [
      '1 chroniques',
      '1er chroniques',
      'premier chroniques',
      'premier livre des chroniques',
      'i chroniques',
    ],
    en: ['1 chronicles', 'first chronicles', 'i chronicles'],
  },
  '2chroniques': {
    fr: [
      '2 chroniques',
      '2eme chroniques',
      'deuxieme chroniques',
      'second chroniques',
      'deuxieme livre des chroniques',
      'ii chroniques',
    ],
    en: ['2 chronicles', 'second chronicles', 'ii chronicles'],
  },
  esdras: { fr: ['esdras', 'livre d esdras', 'esd'], en: ['ezra'] },
  nehemie: { fr: ['nehemie', 'livre de nehemie', 'ne'], en: ['nehemiah', 'neh'] },
  esther: { fr: ['esther', 'livre d esther', 'est'], en: ['esther', 'esth'] },
  job: { fr: ['job', 'livre de job', 'jb'], en: ['job'] },
  psaumes: {
    fr: ['psaumes', 'psaume', 'ps', 'livre des psaumes', 'somme', 'sommes', 'tome', 'tomes'],
    en: ['psalms', 'psalm', 'ps'],
  },
  proverbes: { fr: ['proverbes', 'prov', 'livre des proverbes'], en: ['proverbs', 'prov'] },
  ecclesiaste: {
    fr: ['ecclesiaste', 'qohélet', 'qohelet', 'livre de l ecclesiaste'],
    en: ['ecclesiastes', 'eccl'],
  },
  cantique: {
    fr: ['cantique des cantiques', 'cantique', 'ct', 'cantique de salomon'],
    en: ['song of solomon', 'song of songs', 'canticles'],
  },
  esaie: { fr: ['esaie', 'es', 'livre d esaie', 'prophete esaie'], en: ['isaiah', 'isa'] },
  jeremie: {
    fr: ['jeremie', 'jer', 'livre de jeremie', 'prophete jeremie'],
    en: ['jeremiah', 'jer'],
  },
  lamentations: {
    fr: ['lamentations', 'lam', 'lamentations de jeremie'],
    en: ['lamentations', 'lam'],
  },
  ezechiel: {
    fr: ['ezechiel', 'ez', 'livre d ezechiel', 'prophete ezechiel'],
    en: ['ezekiel', 'ezek'],
  },
  daniel: { fr: ['daniel', 'dan', 'livre de daniel', 'prophete daniel'], en: ['daniel', 'dan'] },
  osee: { fr: ['osee', 'os', 'livre d osee', 'prophete osee'], en: ['hosea', 'hos'] },
  joel: { fr: ['joel', 'jl', 'livre de joel', 'prophete joel'], en: ['joel'] },
  amos: { fr: ['amos', 'am', 'livre d amos', 'prophete amos'], en: ['amos'] },
  // AJOUT (Chantier A.1 — livres à chapitre unique) : "Philémon verset 6"
  // (sans "chapitre") renvoyait null — le pattern standard de detector.js/
  // detector-en.js exige toujours un numéro de chapitre juste après le nom
  // du livre. Marqueur singleChapter posé ICI (donnée), pas dans les
  // détecteurs — voir SINGLE_CHAPTER_BOOKS plus bas, dérivé mécaniquement.
  abdias: {
    fr: ['abdias', 'ab', 'livre d abdias', 'prophete abdias'],
    en: ['obadiah', 'obad'],
    singleChapter: true,
  },
  jonas: { fr: ['jonas', 'livre de jonas', 'prophete jonas'], en: ['jonah'] },
  michee: { fr: ['michee', 'mi', 'livre de michee', 'prophete michee'], en: ['micah', 'mic'] },
  nahum: { fr: ['nahum', 'na', 'livre de nahum', 'prophete nahum'], en: ['nahum', 'nah'] },
  habacuc: {
    fr: ['habacuc', 'ha', 'livre d habacuc', 'prophete habacuc'],
    en: ['habakkuk', 'hab'],
  },
  sophonie: {
    fr: ['sophonie', 'so', 'livre de sophonie', 'prophete sophonie'],
    en: ['zephaniah', 'zeph'],
  },
  aggee: { fr: ['aggee', 'ag', 'livre d aggee', 'prophete aggee'], en: ['haggai', 'hag'] },
  zacharie: {
    fr: ['zacharie', 'za', 'livre de zacharie', 'prophete zacharie'],
    en: ['zechariah', 'zech'],
  },
  malachie: {
    fr: ['malachie', 'ml', 'livre de malachie', 'prophete malachie'],
    en: ['malachi', 'mal'],
  },
  matthieu: {
    fr: [
      'matthieu',
      'mathieu',
      'mt',
      'evangile de matthieu',
      'evangile selon matthieu',
      'evangile selon saint matthieu',
    ],
    en: ['matthew', 'matt', 'mt'],
  },
  marc: {
    fr: ['marc', 'mc', 'evangile de marc', 'evangile selon marc', 'evangile selon saint marc'],
    en: ['mark', 'mk'],
  },
  luc: {
    fr: ['luc', 'lc', 'evangile de luc', 'evangile selon luc', 'evangile selon saint luc'],
    en: ['luke', 'lk'],
  },
  jean: {
    fr: ['jean', 'jn', 'evangile de jean', 'evangile selon jean', 'evangile selon saint jean'],
    en: ['john', 'jn', 'jon'],
  },
  actes: { fr: ['actes des apotres', 'actes', 'ac', 'livre des actes'], en: ['acts'] },
  romains: {
    fr: ['romains', 'rom', 'rm', 'epitre aux romains', 'lettre aux romains'],
    en: ['romans', 'rom'],
  },
  '1corinthiens': {
    fr: [
      '1 corinthiens',
      '1er corinthiens',
      'premier corinthiens',
      'premiere aux corinthiens',
      '1ere aux corinthiens',
      'premiere lettre aux corinthiens',
      'premiere epitre aux corinthiens',
      'i corinthiens',
    ],
    en: ['1 corinthians', 'first corinthians', 'i corinthians'],
  },
  '2corinthiens': {
    fr: [
      '2 corinthiens',
      '2eme corinthiens',
      'deuxieme corinthiens',
      'seconde aux corinthiens',
      'deuxieme aux corinthiens',
      '2ere aux corinthiens',
      'deuxieme lettre aux corinthiens',
      'deuxieme epitre aux corinthiens',
      'ii corinthiens',
    ],
    en: ['2 corinthians', 'second corinthians', 'ii corinthians'],
  },
  galates: {
    fr: ['galates', 'ga', 'epitre aux galates', 'lettre aux galates'],
    en: ['galatians', 'gal'],
  },
  ephesiens: {
    fr: ['ephesiens', 'ep', 'epitre aux ephesiens', 'lettre aux ephesiens'],
    en: ['ephesians', 'eph'],
  },
  philippiens: {
    fr: ['philippiens', 'php', 'epitre aux philippiens', 'lettre aux philippiens'],
    en: ['philippians', 'phil'],
  },
  colossiens: {
    fr: ['colossiens', 'col', 'epitre aux colossiens', 'lettre aux colossiens'],
    en: ['colossians', 'col'],
  },
  '1thessaloniciens': {
    fr: [
      '1 thessaloniciens',
      '1er thessaloniciens',
      'premier thessaloniciens',
      'premiere aux thessaloniciens',
      'premiere epitre aux thessaloniciens',
      'i thessaloniciens',
    ],
    en: ['1 thessalonians', 'first thessalonians', 'i thessalonians'],
  },
  '2thessaloniciens': {
    fr: [
      '2 thessaloniciens',
      '2eme thessaloniciens',
      'deuxieme thessaloniciens',
      'deuxieme aux thessaloniciens',
      'deuxieme epitre aux thessaloniciens',
      'ii thessaloniciens',
    ],
    en: ['2 thessalonians', 'second thessalonians', 'ii thessalonians'],
  },
  '1timothee': {
    fr: [
      '1 timothee',
      '1er timothee',
      'premier timothee',
      'premiere a timothee',
      'premiere epitre a timothee',
      'i timothee',
    ],
    en: ['1 timothy', 'first timothy', 'i timothy'],
  },
  '2timothee': {
    fr: [
      '2 timothee',
      '2eme timothee',
      'deuxieme timothee',
      'deuxieme a timothee',
      'deuxieme epitre a timothee',
      'ii timothee',
    ],
    en: ['2 timothy', 'second timothy', 'ii timothy'],
  },
  tite: { fr: ['tite', 'epitre a tite', 'lettre a tite', 'tt'], en: ['titus'] },
  philemon: {
    fr: ['philemon', 'epitre a philemon', 'lettre a philemon', 'phm'],
    en: ['philemon', 'phlm'],
    singleChapter: true,
  },
  hebreux: {
    fr: ['hebreux', 'heb', 'epitre aux hebreux', 'lettre aux hebreux'],
    en: ['hebrews', 'heb'],
  },
  jacques: { fr: ['jacques', 'jc', 'epitre de jacques'], en: ['james', 'jas'] },
  '1pierre': {
    fr: [
      '1 pierre',
      '1er pierre',
      'premier pierre',
      'premiere de pierre',
      'premiere epitre de pierre',
      'i pierre',
    ],
    en: ['1 peter', 'first peter', 'i peter'],
  },
  '2pierre': {
    fr: [
      '2 pierre',
      '2eme pierre',
      'deuxieme pierre',
      'seconde de pierre',
      'deuxieme de pierre',
      'deuxieme epitre de pierre',
      'ii pierre',
    ],
    en: ['2 peter', 'second peter', 'ii peter'],
  },
  '1jean': {
    fr: [
      '1 jean',
      '1er jean',
      'premier jean',
      'premiere de jean',
      'premiere epitre de jean',
      'i jean',
    ],
    en: ['1 john', 'first john', 'i john'],
  },
  '2jean': {
    fr: [
      '2 jean',
      '2eme jean',
      'deuxieme jean',
      'deuxieme de jean',
      'deuxieme epitre de jean',
      'ii jean',
    ],
    en: ['2 john', 'second john', 'ii john'],
    singleChapter: true,
  },
  '3jean': {
    fr: [
      '3 jean',
      '3eme jean',
      'troisieme jean',
      'troisieme de jean',
      'troisieme epitre de jean',
      'iii jean',
    ],
    en: ['3 john', 'third john', 'iii john'],
    singleChapter: true,
  },
  jude: {
    fr: ['jude', 'epitre de jude', 'lettre de jude', 'jd'],
    en: ['jude'],
    singleChapter: true,
  },
  apocalypse: {
    fr: ['apocalypse', 'ap', 'livre de l apocalypse', 'revelation'],
    en: ['revelation', 'revelations', 'rev'],
  },
};

// AJOUT (Chantier A.1) : dérivé mécaniquement de BOOK_CATALOG, jamais retapé
// à la main — un livre marqué singleChapter: true ci-dessus apparaît ici
// automatiquement, une seule source de vérité. Consommé par
// detector.js/detector-en.js#testAlias() pour reconnaître "Philémon verset
// 6" (sans "chapitre") et pour réinterpréter "Philémon 6" (un seul nombre)
// comme chapitre 1 verset 6 plutôt que comme un chapitre 6 inexistant.
const SINGLE_CHAPTER_BOOKS = new Set(
  Object.entries(BOOK_CATALOG)
    .filter(([, entry]) => entry.singleChapter)
    .map(([key]) => key)
);

module.exports = { BOOK_CATALOG, SINGLE_CHAPTER_BOOKS };
