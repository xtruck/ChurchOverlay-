/**
 * ============================================================================
 *  book-catalog.js — Catalogue bilingue des livres bibliques (FR + EN)
 * ----------------------------------------------------------------------------
 *  AJOUT (support bilingue FR/EN, lot 8) : fusion MÉCANIQUE des tables BOOKS
 *  de detector.js (alias français) et detector-en.js (alias anglais) — les
 *  deux fichiers exportaient déjà chacune leur BOOKS avant ce lot, la fusion
 *  a donc été générée directement depuis ces exports (pas retapée à la
 *  main), pour éliminer tout risque de faute de frappe/oubli d'alias.
 *
 *  La clé de chaque entrée (ex. 'jean', 'apocalypse') est le SLUG FRANÇAIS —
 *  déjà la clé interne canonique partagée par detector.js, detector-en.js,
 *  HELLOAO_BOOK_CODES (bible-offline-cache.js), reading-mode.js et le
 *  dédoublonnage `refKey` de server.js. Ce module ne change PAS cette
 *  convention, il ne fait que documenter et rassembler ce qui existait déjà
 *  de façon fragmentée dans deux fichiers séparés.
 *
 *  PORTÉE DE CE LOT : additif seulement. detector.js et detector-en.js ne
 *  sont PAS encore modifiés pour consommer ce catalogue — voir le lot 10
 *  (cutover) qui fera ce remplacement, avec pour condition explicite que
 *  test-detector.js et test-detector-en.js passent SANS AUCUNE modification.
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
  abdias: { fr: ['abdias', 'ab', 'livre d abdias', 'prophete abdias'], en: ['obadiah', 'obad'] },
  jonas: { fr: ['jonas', 'jon', 'livre de jonas', 'prophete jonas'], en: ['jonah'] },
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
    en: ['john', 'jn'],
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
  },
  jude: { fr: ['jude', 'epitre de jude', 'lettre de jude', 'jd'], en: ['jude'] },
  apocalypse: {
    fr: ['apocalypse', 'ap', 'livre de l apocalypse', 'revelation'],
    en: ['revelation', 'revelations', 'rev'],
  },
};

module.exports = { BOOK_CATALOG };
