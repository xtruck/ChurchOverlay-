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
const DEDUP_MS = 30_000;

let displayLanguage = 'fr';
let lastReference = null;
let lastShownAt = 0;
let obsGateOpen = true;
let obsGateReason = '';

const verseHistory = [];
const recentTranscripts = [];

// --- Langue d'affichage ---
function getDisplayLanguage() {
  return displayLanguage;
}
function setDisplayLanguage(lang) {
  displayLanguage = lang;
}

// --- Anti-doublon (dernier verset affiché) ---
function getLastReference() {
  return lastReference;
}
function getLastShownAt() {
  return lastShownAt;
}
/**
 * @returns {boolean} true si refKey est un doublon du dernier verset montré
 *   il y a moins de DEDUP_MS — ne modifie PAS l'état (lecture seule).
 */
function isDuplicateReference(refKey, now = Date.now()) {
  return lastReference === refKey && now - lastShownAt < DEDUP_MS;
}
function recordShownReference(refKey, now = Date.now()) {
  lastReference = refKey;
  lastShownAt = now;
}
function clearLastReference() {
  lastReference = null;
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

module.exports = {
  DEDUP_MS,
  MAX_HISTORY,
  MAX_CONTEXT_TRANSCRIPTS,
  getDisplayLanguage,
  setDisplayLanguage,
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
};
