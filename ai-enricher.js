'use strict';
/**
 * ai-enricher.js — Enrichissements IA pour ChurchOverlay
 *
 * Chaque fonction IA est INDÉPENDANTE et désactivable via features.json.
 * Toutes utilisent Emergent LLM Key (gratuit) via emergentintegrations.
 * Aucun appel réseau si la feature est désactivée.
 */

const { LlmChat, UserMessage } = require('emergentintegrations');
const features = require('./config/features.json');

const EMERGENT_KEY = process.env.EMERGENT_LLM_KEY;

// ---------------------------------------------------------------------
// 1) DÉTECTION DU THÈME DU SERMON
// ---------------------------------------------------------------------
async function detectSermonTheme(transcriptBuffer) {
  if (!features.ai.themeDetection.enabled) return null;
  if (transcriptBuffer.length < 200) return null;

  const chat = new LlmChat({
    api_key: EMERGENT_KEY,
    session_id: 'theme-detect',
    system_message: `Tu analyses des extraits de sermon en français.
Extrais LE THÈME PRINCIPAL en 2-4 mots maximum + 3 mots-clés.
Réponds uniquement en JSON: {"theme":"...","keywords":["...","...","..."]}`
  }).with_model('gemini', 'gemini-2.0-flash');

  try {
    const response = await chat.send_message(new UserMessage(transcriptBuffer.slice(-2000)));
    const parsed = JSON.parse(response);
    return { theme: parsed.theme, keywords: parsed.keywords };
  } catch (e) {
    console.warn('[ai-enricher] Détection thème échouée:', e.message);
    return null;
  }
}

// ---------------------------------------------------------------------
// 2) TRADUCTION LIVE (pour app compagnon)
// ---------------------------------------------------------------------
async function translateSegment(text, targetLang) {
  if (!features.ai.liveTranslation.enabled) return null;

  const chat = new LlmChat({
    api_key: EMERGENT_KEY,
    session_id: `translate-${targetLang}`,
    system_message: `You are a live sermon translator. Translate the following French text into ${targetLang}. Preserve the spiritual tone. Reply with the translation ONLY, no explanations.`
  }).with_model('claude', 'claude-haiku-4-5');

  try {
    return await chat.send_message(new UserMessage(text));
  } catch (e) {
    return null;
  }
}

// ---------------------------------------------------------------------
// 3) RÉSUMÉ DU SERMON EN TEMPS RÉEL (pour retardataires)
// ---------------------------------------------------------------------
async function generateLiveSummary(fullTranscript) {
  if (!features.ai.sermonSummary.enabled) return null;

  const chat = new LlmChat({
    api_key: EMERGENT_KEY,
    session_id: 'live-summary',
    system_message: `Tu résumes des sermons en cours de prédication.
Produis un résumé de MAX 20 mots en français, à la 3e personne.
Format: "Le pasteur explique que..."`
  }).with_model('gemini', 'gemini-2.0-flash');

  return await chat.send_message(new UserMessage(fullTranscript.slice(-4000)));
}

// ---------------------------------------------------------------------
// 4) POST-SERVICE : RECAP AUTO
// ---------------------------------------------------------------------
async function generatePostServiceRecap(fullTranscript, versesShown) {
  if (!features.ai.postServiceRecap.enabled) return null;

  const chat = new LlmChat({
    api_key: EMERGENT_KEY,
    session_id: 'post-service',
    system_message: `Tu es assistant pastoral. À partir de la transcription
complète d'un sermon et de la liste des versets cités, produis:
1. Un titre accrocheur (max 8 mots)
2. Un résumé en 5 points-clés
3. Une application pratique pour la semaine
4. Un verset à mémoriser (choisi parmi ceux cités)
Format: JSON strict.`
  }).with_model('claude', 'claude-sonnet-4-5');

  const prompt = `TRANSCRIPTION:\n${fullTranscript.slice(0, 15000)}
\n\nVERSETS CITÉS: ${versesShown.map(v => v.reference).join(', ')}`;

  const response = await chat.send_message(new UserMessage(prompt));
  return JSON.parse(response);
}

// ---------------------------------------------------------------------
// 5) CROSS-REFERENCES (renvois croisés automatiques)
// ---------------------------------------------------------------------
async function findCrossReferences(verseRef, verseText) {
  if (!features.ai.crossReferences.enabled) return [];

  const chat = new LlmChat({
    api_key: EMERGENT_KEY,
    session_id: 'cross-refs',
    system_message: `Tu es un exégète biblique. Pour un verset donné,
identifie 2-3 versets liés (parallèles, thèmes similaires, prophéties/accomplissements).
Réponds en JSON: [{"ref":"...","reason":"..."}, ...]`
  }).with_model('claude', 'claude-haiku-4-5');

  try {
    const response = await chat.send_message(
      new UserMessage(`${verseRef}: "${verseText}"`)
    );
    return JSON.parse(response).slice(0, features.ai.crossReferences.maxRefs);
  } catch (e) {
    return [];
  }
}

module.exports = {
  detectSermonTheme,
  translateSegment,
  generateLiveSummary,
  generatePostServiceRecap,
  findCrossReferences,
};
