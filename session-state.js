'use strict';
/**
 * session-state.js — État mutable de la session en cours
 *
 * Extrait de server.js (chantier de découpage du 2026-08-05) : avant, cet
 * état (langue d'affichage, dernier verset montré, historique, porte OBS...)
 * vivait en `let`/`const` au niveau module de server.js, accessible et
 * modifiable depuis n'importe quelle fonction du fichier. Ici, il est
 * encapsulé derrière des accesseurs — même comportement, mais les points de
 * lecture/écriture sont désormais explicites et traçables (un `grep
 * setDisplayLanguage` retrouve tous les endroits qui changent la langue,
 * ce qu'un `grep "displayLanguage ="` mélangé aux lectures ne permettait
 * pas aussi clairement).
 *
 * Ce module ne fait AUCUN appel réseau/IO et n'a AUCUNE dépendance vers le
 * reste de l'app — il est testable isolément.
 */

const MAX_HISTORY = 20;
const MAX_CONTEXT_TRANSCRIPTS = 10;
// TENTATIVE ABANDONNÉE (Chantier D, mission autonome — "rendre visible toute
// occurrence dédupliquée") : la mission suppose encore un bug "DEDUP_MS avale
// une deuxième citation légitime en silence" — CE bug était déjà corrigé par
// le Chantier 1 ci-dessous (dédoublonnage PAR ÉNONCÉ, pas seulement par
// référence+délai) avant le début de cette mission. Broadcaster un toast à
// chaque isDuplicateReference()===true a été prototypé puis ABANDONNÉ après
// mesure (pas supposé) : sur le corpus complet (45 énoncés), 14 suppressions
// pour 43 affichages — la quasi-totalité sont la cascade INTERNE normale
// partial→final d'un MÊME énoncé (le comportement voulu, invisible à raison)
// ou une ré-émission tardive de final Deepgram déjà affiché. Un toast à
// chaque fois aurait spammé l'opérateur en plein culte pour un fonctionnement
// correct, pas pour un vrai bug. S'il faut un jour rendre visible un cas de
// suppression, cibler UNIQUEMENT `refKey.startsWith('quote:')` (seul chemin
// qui utilise encore la règle temporelle simple, donc le seul où une
// citation VRAIMENT distincte pourrait un jour être avalée à tort) — jamais
// le chemin référence dite, déjà correct.
const DEDUP_MS = 30_000;
// AJOUT (chantier ASR, Étape 4 — reconstruction de références fragmentées) :
// fenêtre temporelle maximale (en ms) entre deux fragments consécutifs pour
// qu'ils soient considérés comme appartenant au MÊME énoncé et donc fusionnés
// avant détection. Calibrée sur les mesures réelles du corpus TTS (probe
// bloc1.wav) : les fragments d'un même énoncé arrivent à 1.4-2.3s d'intervalle
// (endpointing Deepgram 500ms + finalisation locale VAD 600ms), tandis que
// deux énoncés DISTINCTS du corpus sont séparés par ≥2.5s de silence (bloc5
// F1/F2 = 3s, bloc6 G1/G2 = 10s). 2600ms capture les uns sans mélanger les
// autres — le cas F1+F2 (romains:12:28 faux, testé) reste donc exclu.
//
// CORRECTIF (sonde probe-overwrites) : la fenêtre seule ne suffit PAS à
// distinguer « mêmes énoncé » de « énoncés consécutifs » quand le résidu du
// fragment précédent est encore dans le buffer (ex. « 2e Timothée chapitre »
// qui suit « 13 verset 4. » de l'énoncé C1) : le reset PAR NOM DE LIVRE
// (containsBookName, voir server.js) vide le buffer dès qu'un fragment
// commence un nouvel énoncé, ce qui rend la fenêtre large SANS RISQUE de
// Élargie à 15000ms pour couvrir D6 (Apocalypse chapitre 21 verset 4) : le
// probe-overwrites montre que le final « chapitre 21 verset 4. » arrive
// ~10.8s APRÈS « Apocalypse » (endpointing retardé sur bloc3.wav) — une
// fenêtre de 4000ms le laissait tomber et D6 restait jamais détecté (bench
// AVANT correctif). L'élargissement est SÛR car la séparation des énoncés
// consécutifs rapprochés (F1/F2 à 5s, 1.4-2.3s dans les blocs) est portée
// par le RESET sur nom de livre (server.js, Test 9) : chaque début d'énoncé
// contient un livre et vide le buffer AVANT le push. La fenêtre ne protège
// plus que des écarts extrêmes (>15s) où un final très retardé d'un énoncé
// ancien ne doit pas contaminer le buffer courant.
const FRAGMENT_FUSION_WINDOW_MS = 15000;
const MAX_FUSED_FRAGMENTS = 8;
// AJOUT (fusion audit production / round 8) : cinq bascules overlay
// (accessibilité + affichage) plus le tampon "culte complet" pour la
// mémoire des cultes (voir sermon-archive.js) — ajoutés dans une session
// parallèle avant l'existence de ce module, migrés ici à la fusion pour
// suivre la même discipline d'accesseurs que le reste de l'état.
const MAX_SERVICE_TRANSCRIPT_CHARS = 50_000;

// AJOUT (support bilingue FR/EN — commande vocale "repeat"/"répète") :
// dernière diffusion RE-DIFFUSABLE (verset ou média — voir
// REPEATABLE_ACTIONS dans server.js > broadcast()), tous types confondus.
// Distinct de lastReference/verseHistory ci-dessous, qui ne suivent QUE
// les versets et servent à un usage différent (anti-doublon, historique).
let lastBroadcast = null;
let displayLanguage = 'fr';
// AJOUT (support bilingue FR/EN de bout en bout) : langue dans laquelle le
// PASTEUR PARLE (ce que l'ASR doit décoder), délibérément distincte de
// displayLanguage ci-dessus (langue dans laquelle le verset s'AFFICHE).
// Ces deux réglages ne doivent JAMAIS être couplés automatiquement — voir
// setTranscriptionLanguage plus bas et son commentaire. null = pas de
// préférence de session : Groq garde sa détection automatique native
// (voir groq-wrapper.js), Deepgram garde son défaut 'fr' (voir
// deepgram-wrapper.js/deepgram-streaming.js) — comportement actuel
// préservé tant qu'aucune commande vocale ne change explicitement ceci.
let transcriptionLanguage = null;
let lastReference = null;
let lastShownAt = 0;
// AJOUT (Chantier 1 — dédoublonnage par énoncé) : identité (tracker.id) de
// l'énoncé qui a provoqué le dernier affichage, et texte normalisé qui a
// servi à cet affichage. Servent à distinguer :
//  - la CASCADE partiel stable → final officiel du MÊME énoncé (UNE action,
//    à supprimer) — signalée par lastShownUtteranceId === utteranceId ;
//  - un FINAL OFFICIEL DEEPGRAM très retardé (~7,5s, voir audio-capture.js)
//    qui redit à l'identique un texte déjà affiché (à supprimer aussi) mais
//    qui arrive sous le tracker de l'énoncé SUIVANT (Signal "text identique +
//    source deepgram-final") ;
//  - une NOUVELLE intention (un nouvel énoncé redit la même référence, ex.
//    corpus A1→A5) — à AFFICHER, quels que soient le texte et l'intervalle
//    (< DEDUP_MS), la mission étant « 10s plus tard, même référence =
//    nouvelle intention ».
let lastShownUtteranceId = null;
let lastShownText = null;
let obsGateOpen = true;
let obsGateReason = '';
let highContrastMode = false;
let captionsEnabled = false;
// AJOUT (sous-titres traduits en direct — voir caption-translator.js) :
// distinct de captionsEnabled (sous-titres bruts, même langue) et de
// langMode 'both' (traduction de VERSETS uniquement). Désactivé par défaut
// — opt-in explicite, coût en quota Groq/Gemini supplémentaire.
let translatedCaptionsEnabled = false;
let captionTargetLang = 'en';
let testPatternEnabled = false;
let backgroundPattern = 'none';
// AJOUT (habillage caméra — logo/titre, voir branding-store.js) : volontairement
// DE LA SESSION EN COURS, pas persisté — un titre ("Pasteur X — Culte du jour")
// resté affiché d'un culte à l'autre serait plus gênant qu'utile. Le logo et sa
// position, eux, sont persistés (voir branding-store.js) car ils changent rarement.
let brandingTitle = '';
let brandingSubtitle = '';
let brandingVisible = false;
// Distinct de recentTranscripts (fenêtre glissante de MAX_CONTEXT_TRANSCRIPTS
// fragments, pensée pour le contexte court du détecteur sémantique) : ce
// tampon accumule TOUT le culte en cours, borné en caractères pour éviter
// une croissance mémoire illimitée sur un service de plusieurs heures, et
// remis à zéro quand l'opérateur clôture le culte (voir 'getPostServiceRecap'
// dans server.js, seul signal de fin de service déjà présent dans l'app).
let fullServiceTranscript = '';

const verseHistory = [];
const recentTranscripts = [];
// Buffer de fragments transcits récents (chantier ASR, Étape 4) : chaque
// fragment (partial stable ou final) est horodaté et conservé dans une
// fenêtre glissante de FRAGMENT_FUSION_WINDOW_MS. La fusion sert à
// reconstruire la référence quand l'ASR a découpé un énoncé en plusieurs
// finals (voir le commentaire de FRAGMENT_FUSION_WINDOW_MS).
const recentFragments = [];

// --- Langue d'affichage ---
function getDisplayLanguage() {
  return displayLanguage;
}
function setDisplayLanguage(lang) {
  displayLanguage = lang;
}

// --- Langue de transcription (ASR) — voir le commentaire de la variable
// ci-dessus. setTranscriptionLanguage() ne touche JAMAIS displayLanguage,
// et setDisplayLanguage() ci-dessus ne touche JAMAIS transcriptionLanguage
// — c'est la règle centrale de ce chantier, appliquée ici au niveau le
// plus bas possible (aucun appelant ne peut accidentellement les coupler
// puisque ce module n'expose que deux paires d'accesseurs indépendantes). ---
function getTranscriptionLanguage() {
  return transcriptionLanguage;
}
function setTranscriptionLanguage(lang) {
  transcriptionLanguage = lang || null;
}

// --- Dernière diffusion re-diffusable (commande "repeat") ---
function getLastBroadcast() {
  return lastBroadcast;
}
function setLastBroadcast(action, payload) {
  lastBroadcast = { action, payload, timestamp: Date.now() };
}

// --- Anti-doublon (dernier verset affiché) ---
function getLastReference() {
  return lastReference;
}
function getLastShownAt() {
  return lastShownAt;
}

/**
 * Normalise un texte pour la comparaison de « re-émission tardive » :
 * casse, espaces, ponctuation de fin, séparateurs chapitre/verset
 * (« Jean 3:16 » ≡ « Jean 3 16. »). Compare le CONTENU de la référence, pas
 * la formulation exacte — deux formulations différentes (même référence)
 * restent des énoncés distincts.
 */
function normalizeShownText(text) {
  if (!text) return '';
  return text
    .toLowerCase()
    .replace(/[.,;:!?"'’`«»()[\]{}]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * @param {string} refKey - clé de référence (livre:chapitre:verset)
 * @param {number} [now] - horodatage courant
 * @param {Object} [ctx] - contexte d'énoncé :
 *   { utteranceId: (number|null), text: (string|null), source: (string|null) }
 * @returns {boolean} true si cet affichage doit être supprimé comme doublon
 *
 * CORRECTIF (Chantier 1 — cas cible A2, « Jean chapitre 3 verset 16 » dit
 * UNE seule fois) : l'ancienne règle (même refKey il y a moins de DEDUP_MS)
 * avalait les répétitions LÉGITIMES d'une même référence par des énoncés
 * DISTINCTS rapprochés (corpus A1→A5, écarts de 2,5-3,5s ; G2, 10s) — le
 * bench « textDetected mais jamais affiché ». La règle devient : ne
 * supprimer que (a) la cascade du MÊME énoncé (même utteranceId), ou
 * (b) une re-émission tardive d'un final officiel Deepgram redissant à
 * l'identique un texte déjà affiché (le final officiel arrive ~7,5s en
 * retard et peut être attribué au tracker de l'énoncé suivant). Toute autre
 * occurrence (nouvel énoncé) est une nouvelle intention.
 */
function isDuplicateReference(refKey, now = Date.now(), ctx = null) {
  if (lastReference !== refKey) return false;
  if (now - lastShownAt >= DEDUP_MS) return false;

  // Citations (refKey "quote:...") : le MÊME verset lu à voix haute deux fois
  // en moins de DEDUP_MS est une répétition de lecture (double diffusion
  // accidentelle du même segment) — on conserve la règle temporelle simple
  // (test integration-quote-match). Les citations n'ont ni énoncé distinct
  // ni partial/final : la règle « nouvelle intention par énoncé » ne
  // s'applique qu'aux RÉFÉRENCES DITES (refKey "livre:chapitre:verset").
  if (refKey.startsWith('quote:')) return true;

  const utteranceId = ctx && ctx.utteranceId;
  const source = ctx && ctx.source;
  const text = ctx && ctx.text;
  const sameUtterance =
    utteranceId != null && lastShownUtteranceId != null && utteranceId === lastShownUtteranceId;
  if (sameUtterance) {
    // DIAGNOSTIC (Chantier 3 — dédup) : log explicitement pourquoi un énoncé
    // distinct semble être la cascade du même énoncé — seul chemin de
    // suppression possible pour une source non deepgram-final.
    console.log(
      `[dedup] suppressed ref=${refKey} reason=same-utterance id=${utteranceId} lastShownUtteranceId=${lastShownUtteranceId} text="${(text || '').substring(0, 60)}" source=${source}`
    );
    return true;
  }

  // Énoncé différent : nouvelle intention, SAUF re-émission tardive d'un
  // final officiel Deepgram redissant (ou contenant seulement) du contenu
  // déjà affiché. Le final officiel arrive ~7,5 s en retard (voir
  // audio-capture.js), possiblement sous le tracker de l'énoncé SUIVANT, et
  // son texte est souvent PLUS COURT que le dernier texte affiché (le dernier
  // affichage provenait du texte cumulé des partials : « Jean 3 16. Jean »,
  // « Jean 3 16. Saint Jean 3 16 », ...). On compare donc par CONTENANCE :
  // le final (normalisé) est-il un sous-ensemble du dernier texte affiché
  // pour cette référence ? Oui → re-émission, on supprime. Un final PLUS LONG
  // (contenu véritablement nouveau) reste une nouvelle intention.
  if (source === 'deepgram-final' && lastShownText && text) {
    const normText = normalizeShownText(text);
    const normLast = normalizeShownText(lastShownText);
    if (normText && normLast && normLast.includes(normText)) {
      // DIAGNOSTIC (Chantier 3 — dédup) : re-émission tardive confirmée.
      console.log(
        `[dedup] suppressed ref=${refKey} reason=deepgram-resend text="${(text || '').substring(0, 60)}" lastShownText="${(lastShownText || '').substring(0, 60)}"`
      );
      return true;
    }
  }

  return false;
}

function recordShownReference(refKey, now = Date.now(), ctx = null) {
  lastReference = refKey;
  lastShownAt = now;
  lastShownUtteranceId = ctx && ctx.utteranceId != null ? ctx.utteranceId : null;
  lastShownText = ctx && ctx.text ? ctx.text : null;
}

function clearLastReference() {
  lastReference = null;
  lastShownUtteranceId = null;
  lastShownText = null;
}

// --- Porte OBS (multi-scène) ---
function getObsGate() {
  return { open: obsGateOpen, reason: obsGateReason };
}
function setObsGate(open, reason) {
  obsGateOpen = open;
  obsGateReason = reason || '';
}

// --- Historique des versets affichés ---
function getVerseHistory() {
  return verseHistory;
}
function pushHistory(entry) {
  verseHistory.unshift(entry);
  if (verseHistory.length > MAX_HISTORY) verseHistory.pop();
}

// --- Contexte récent (pour thème IA / détection sémantique) ---
function updateTranscriptContext(text) {
  recentTranscripts.push(text);
  if (recentTranscripts.length > MAX_CONTEXT_TRANSCRIPTS) recentTranscripts.shift();
}
function getRecentContext(maxChars = 300) {
  const context = recentTranscripts.slice(-5).join(' ');
  return context.length > maxChars ? context.slice(-maxChars) : context;
}
function getRecentTranscripts() {
  return recentTranscripts;
}

// --- Fusion de fragments (chantier ASR, Étape 4) ---
function pushTranscriptFragment(text, now = Date.now()) {
  const cleaned = (text || '').trim().replace(/\s+/g, ' ');
  if (!cleaned) return;
  recentFragments.push({ text: cleaned, at: now });
  const cutoff = now - FRAGMENT_FUSION_WINDOW_MS;
  while (recentFragments.length > 0 && recentFragments[0].at < cutoff) {
    recentFragments.shift();
  }
  if (recentFragments.length > MAX_FUSED_FRAGMENTS) {
    recentFragments.splice(0, recentFragments.length - MAX_FUSED_FRAGMENTS);
  }
}
/**
 * AJOUT (chantier ASR, Étape 4 — reset du buffer de fusion) : vide le buffer
 * de fragments quand un fragment contenant un NOM DE LIVRE arrive (début
 * d'un nouvel énoncé, voir containsBookName dans detector.js). Sans ce reset,
 * le résidu du fragment précédent se fusionnerait avec le fragment courant
 * (« 2e Timothée chapitre » + « 13 verset 4. » → 2timothee 13:4 FAUX).
 */
function resetTranscriptFragments() {
  recentFragments.length = 0;
}
/**
 * AJOUT (chantier ASR, Étape 4 — purge du résidu fautif) : retire le dernier
 * fragment poussé du buffer de fusion. Utilisé quand la fusion produit une
 * référence IMPOSSIBLE (chapitre au-delà du nombre réel du livre) : c'est le
 * signe que le dernier fragment est un résidu d'un énoncé précédent (final
 * retardé par l'endpointing, ex. « 13 verset 4. » arrivé après le début de
 * « 2e Timothée chapitre ») — on le retire pour que les fragments suivants
 * (ex. « 3 verset 16 ») puissent fusionner proprement avec le fragment de
 * livre qui le précède.
 */
function removeLastTranscriptFragment() {
  recentFragments.pop();
}
/**
 * Longueur du plus long chevauchement suffixe(a) ∩ préfixe(b), ou 0.
 */
function overlapLength(a, b) {
  const maxLen = Math.min(a.length, b.length);
  for (let len = maxLen; len > 0; len--) {
    if (a.endsWith(b.slice(0, len))) return len;
  }
  return 0;
}
/**
 * Fusionne les fragments dans leur ordre chronologique en éliminant les
 * redondances (les finals/partials cumulatifs répètent le début) :
 *   ["1 Corinthiens", "1 Corinthiens chapitre", "13 verset", "13 verset 4."]
 *   → "1 Corinthiens chapitre 13 verset 4."
 * Cas traités : fragment déjà contenu (skip), chevauchement suffixe/préfixe
 * (concaténer le suffixe non couvert), sinon concaténer avec un espace.
 */
function fuseFragments(fragments) {
  let acc = '';
  for (const frag of fragments) {
    const lowerAcc = acc.toLowerCase();
    const lowerFrag = frag.toLowerCase();
    if (!lowerAcc) {
      acc = frag;
      continue;
    }
    if (lowerAcc.includes(lowerFrag)) continue;
    const overlap = overlapLength(lowerAcc, lowerFrag);
    if (overlap > 0) {
      acc += frag.slice(overlap);
    } else {
      acc += ' ' + frag;
    }
  }
  return acc.trim();
}
/**
 * @returns {string} texte fusionné des fragments tombés dans la fenêtre
 *   FRAGMENT_FUSION_WINDOW_MS — vide si rien n'est fusionnable.
 */
function getFusedRecentText(now = Date.now()) {
  const cutoff = now - FRAGMENT_FUSION_WINDOW_MS;
  const inWindow = recentFragments.filter((f) => f.at >= cutoff);
  if (inWindow.length < 2) return '';
  const fused = fuseFragments(inWindow.map((f) => f.text));
  return fused;
}
function getRecentFragments() {
  return recentFragments;
}

// --- Accessibilité / affichage overlay (CSS pur côté client, aucun coût
// API/CPU — voir overlay.html) ---
function getHighContrast() {
  return highContrastMode;
}
function setHighContrast(enabled) {
  highContrastMode = !!enabled;
}
function getCaptionsEnabled() {
  return captionsEnabled;
}
function setCaptionsEnabled(enabled) {
  captionsEnabled = !!enabled;
}
function getTranslatedCaptionsEnabled() {
  return translatedCaptionsEnabled;
}
function setTranslatedCaptionsEnabled(enabled) {
  translatedCaptionsEnabled = !!enabled;
}
function getCaptionTargetLang() {
  return captionTargetLang;
}
function setCaptionTargetLang(lang) {
  captionTargetLang = typeof lang === 'string' && lang ? lang : 'en';
}
function getTestPattern() {
  return testPatternEnabled;
}
function setTestPattern(enabled) {
  testPatternEnabled = !!enabled;
}
function getBackgroundPattern() {
  return backgroundPattern;
}
function setBackgroundPattern(pattern) {
  backgroundPattern = pattern;
}

// --- Habillage caméra : titre/sous-titre en direct (voir branding-store.js
// pour le logo/position, persistés séparément) ---
function getBrandingText() {
  return { title: brandingTitle, subtitle: brandingSubtitle };
}
function setBrandingText(title, subtitle) {
  brandingTitle = (title || '').slice(0, 120);
  brandingSubtitle = (subtitle || '').slice(0, 160);
}
function getBrandingVisible() {
  return brandingVisible;
}
function setBrandingVisible(visible) {
  brandingVisible = !!visible;
}

// --- Transcription complète du culte en cours (mémoire des cultes — voir
// sermon-archive.js) ---
function appendFullServiceTranscript(text) {
  fullServiceTranscript += (fullServiceTranscript ? ' ' : '') + text;
  if (fullServiceTranscript.length > MAX_SERVICE_TRANSCRIPT_CHARS) {
    fullServiceTranscript = fullServiceTranscript.slice(-MAX_SERVICE_TRANSCRIPT_CHARS);
  }
}
function getFullServiceTranscript() {
  return fullServiceTranscript;
}
function resetFullServiceTranscript() {
  fullServiceTranscript = '';
}

module.exports = {
  DEDUP_MS,
  MAX_HISTORY,
  MAX_CONTEXT_TRANSCRIPTS,
  MAX_SERVICE_TRANSCRIPT_CHARS,
  getDisplayLanguage,
  setDisplayLanguage,
  getTranscriptionLanguage,
  setTranscriptionLanguage,
  getLastBroadcast,
  setLastBroadcast,
  getLastReference,
  getLastShownAt,
  isDuplicateReference,
  recordShownReference,
  clearLastReference,
  getObsGate,
  setObsGate,
  getVerseHistory,
  pushHistory,
  updateTranscriptContext,
  getRecentContext,
  getRecentTranscripts,
  pushTranscriptFragment,
  resetTranscriptFragments,
  removeLastTranscriptFragment,
  getFusedRecentText,
  getRecentFragments,
  getHighContrast,
  setHighContrast,
  getCaptionsEnabled,
  setCaptionsEnabled,
  getTranslatedCaptionsEnabled,
  setTranslatedCaptionsEnabled,
  getCaptionTargetLang,
  setCaptionTargetLang,
  getTestPattern,
  setTestPattern,
  getBackgroundPattern,
  setBackgroundPattern,
  getBrandingText,
  setBrandingText,
  getBrandingVisible,
  setBrandingVisible,
  appendFullServiceTranscript,
  getFullServiceTranscript,
  resetFullServiceTranscript,
};
