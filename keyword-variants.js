/**
 * ============================================================================
 *  keyword-variants.js — Variantes phonétiques "chapitre"/"verset" (FR + EN)
 * ----------------------------------------------------------------------------
 *  AJOUT (support bilingue FR/EN, lot 11a) : fusion des listes de variantes
 *  phonétiques CHAPITRE_VARIANTS/VERSET_VARIANTS (detector.js) et
 *  CHAPTER_VARIANTS/VERSE_VARIANTS (detector-en.js) — déformations produites
 *  par Whisper (surtout en base/tiny sur bruit ambiant) que chaque détecteur
 *  corrige AVANT la correspondance d'alias, pour que "chapitois 3 vecc 16"
 *  soit quand même reconnu comme "chapitre 3 verset 16".
 *
 *  Miroir mécanique des littéraux existants — aucune variante ajoutée ou
 *  retirée dans ce lot, voir test-keyword-variants.js pour la preuve
 *  (deep-equal contre les tables historiques) et le contrôle de collision
 *  inter-langues (voir plus bas).
 *
 *  COLLISION FR/EN CONNUE ET VOLONTAIREMENT CONSERVÉE : 'verse' apparaît à
 *  la fois comme variante phonétique française de "verset" (Whisper avale
 *  parfois la syllabe finale) ET comme le mot anglais canonique lui-même.
 *  Documentée ici et couverte par le test de collision — SANS IMPACT
 *  PRATIQUE : la correction FR ne fait que réécrire "verse" en "verset"
 *  AVANT la correspondance d'alias de livre, qui reste ensuite strictement
 *  française (aucun alias FR ne contient "john", "psalm", etc.) — une
 *  phrase anglaise ("John chapter 3 verse 16") ne matche donc jamais le
 *  détecteur FR, collision ou pas.
 * ============================================================================
 */
'use strict';

/**
 * @type {{
 *   chapitre: { fr: string[], en: string[] },
 *   verset: { fr: string[], en: string[] },
 * }}
 * Clé : concept neutre (chapitre/verset). `fr`/`en` : variantes reconnues
 * par detector.js / detector-en.js respectivement, PREMIER élément de
 * chaque tableau = le mot canonique lui-même (jamais réécrit sur lui-même).
 */
const KEYWORD_VARIANTS = {
  chapitre: {
    fr: [
      'chapitre',
      'chappitois',
      'sabitoire',
      'chabitouale',
      'sapitois',
      'chapitois',
      'chappitre',
      'chappite',
      'chapite',
      'chapit',
      'chaptre',
    ],
    en: ['chapter', 'chapters', 'chap', 'chpt'],
  },
  verset: {
    fr: [
      'verset',
      'versets',
      'vecc',
      'vece',
      'vsc',
      'vc',
      'veille',
      'versai',
      'verse',
      'verce',
      'vercet',
      'versait',
      // CORRECTIF (audit — Ole, 2026-07-30) : "versus" reproduit en conditions
      // réelles — la reconnaissance vocale transforme parfois "verset" en
      // "versus" ("Jean 1 versus 1"). Voir detector.js pour l'historique complet.
      'versus',
    ],
    en: ['verse', 'verses', 'vs', 'v', 'vers'],
  },
};

module.exports = { KEYWORD_VARIANTS };
