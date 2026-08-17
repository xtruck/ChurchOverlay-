'use strict';
/**
 * ai-enricher.js — Enrichissements IA pour ChurchOverlay
 *
 * Chaque fonction IA est INDÉPENDANTE et désactivable via features.json.
 * Utilise Google GenAI (gemini-3.6-flash) ou Groq via groq-wrapper.js.
 */

const { chatCompletion } = require('./groq-wrapper');
const { sanitizeForPrompt } = require('./prompt-sanitizer');
const { extractResponseText, extractJsonObject } = require('./llm-utils');

let features = {
  ai: {
    themeDetection: { enabled: true, intervalSec: 60 },
    liveTranslation: { enabled: true, targetLangs: ['en', 'es'] },
    sermonSummary: { enabled: true, intervalMin: 5 },
    postServiceRecap: { enabled: true, exportFormats: ['pdf', 'png'] },
    crossReferences: { enabled: true, maxRefs: 3 },
  },
};

try {
  features = require('./config/features.json');
} catch (_e) {
  // Use default fallback config
}

// ---------------------------------------------------------------------
// 1) DÉTECTION DU THÈME DU SERMON
// ---------------------------------------------------------------------
async function detectSermonTheme(transcriptBuffer) {
  if (features.ai?.themeDetection?.enabled === false) return null;
  if (!transcriptBuffer || transcriptBuffer.length < 50) return null;

  const prompt = `Tu analyses des extraits de sermon en français.
Extrais LE THÈME PRINCIPAL en 2-4 mots maximum + 3 mots-clés.
Transcription: "${sanitizeForPrompt(transcriptBuffer.slice(-2000))}"
Réponds uniquement en JSON valide: {"theme":"...","keywords":["...","...","..."]}`;

  try {
    const res = await chatCompletion(prompt, { json_mode: true, temperature: 0.2 });
    const parsed = extractJsonObject(extractResponseText(res));
    if (!parsed) return null;
    return { theme: parsed.theme, keywords: parsed.keywords || [] };
  } catch (e) {
    console.warn('[ai-enricher] Détection thème échouée:', e.message);
    return null;
  }
}

// ---------------------------------------------------------------------
// 2) TRADUCTION LIVE
// ---------------------------------------------------------------------
async function translateSegment(text, targetLang = 'en') {
  if (features.ai?.liveTranslation?.enabled === false) return null;
  if (!text || !text.trim()) return null;

  const prompt = `You are a live sermon translator. Translate the following French text into ${targetLang}. Preserve the spiritual tone. Reply with the translation ONLY, no explanations or quotes:
"${sanitizeForPrompt(text)}"`;

  try {
    const res = await chatCompletion(prompt, { temperature: 0.1, max_tokens: 200 });
    return extractResponseText(res) || null;
  } catch (e) {
    console.warn('[ai-enricher] Traduction live échouée:', e.message);
    return null;
  }
}

// ---------------------------------------------------------------------
// 3) RÉSUMÉ DU SERMON EN TEMPS RÉEL
// ---------------------------------------------------------------------
async function generateLiveSummary(fullTranscript) {
  if (features.ai?.sermonSummary?.enabled === false) return null;
  if (!fullTranscript || fullTranscript.length < 100) return null;

  const prompt = `Tu résumes un sermon en cours de prédication.
Produis un résumé concis de MAX 25 mots en français.
Format: "Le prédicateur explique que..."
Transcription récente: "${sanitizeForPrompt(fullTranscript.slice(-4000))}"`;

  try {
    const res = await chatCompletion(prompt, { temperature: 0.3, max_tokens: 100 });
    return extractResponseText(res) || null;
  } catch (e) {
    console.warn('[ai-enricher] Résumé live échoué:', e.message);
    return null;
  }
}

// ---------------------------------------------------------------------
// 4) POST-SERVICE : RECAP AUTO
// ---------------------------------------------------------------------
async function generatePostServiceRecap(fullTranscript, versesShown = []) {
  if (features.ai?.postServiceRecap?.enabled === false) return null;

  const verseList = Array.isArray(versesShown)
    ? versesShown.map((v) => (typeof v === 'string' ? v : v.reference || v.raw || '')).join(', ')
    : '';

  const prompt = `Tu es assistant pastoral. À partir de la transcription du sermon et des versets affichés, produis un récapitulatif.
TRANSCRIPTION:
"${sanitizeForPrompt((fullTranscript || '').slice(0, 10000))}"

VERSETS CITÉS: ${sanitizeForPrompt(verseList) || 'Aucun verset enregistré'}

Réponds uniquement en JSON avec cette structure exacte:
{
  "title": "Titre du sermon (max 8 mots)",
  "keyPoints": ["Point 1", "Point 2", "Point 3", "Point 4", "Point 5"],
  "application": "Application pratique pour la semaine",
  "memoryVerse": "Verset marquant à mémoriser"
}`;

  try {
    const res = await chatCompletion(prompt, {
      json_mode: true,
      temperature: 0.3,
      max_tokens: 600,
    });
    return extractJsonObject(extractResponseText(res));
  } catch (e) {
    console.warn('[ai-enricher] Récapitulatif post-service échoué:', e.message);
    return null;
  }
}

// ---------------------------------------------------------------------
// 5) CROSS-REFERENCES (renvois croisés automatiques)
// ---------------------------------------------------------------------
async function findCrossReferences(verseRef, verseText) {
  if (features.ai?.crossReferences?.enabled === false) return [];

  const prompt = `Tu es un exégète biblique. Pour le verset "${sanitizeForPrompt(verseRef)}: ${sanitizeForPrompt(verseText || '')}", identifie 2 à 3 versets bibliques liés (thèmes similaires ou parallèles).
Réponds uniquement en JSON: [{"ref": "Livre Chapitre:Verset", "reason": "Brève explication en français"}]`;

  try {
    const res = await chatCompletion(prompt, {
      json_mode: true,
      temperature: 0.2,
      max_tokens: 300,
    });
    const parsed = extractJsonObject(extractResponseText(res));
    return Array.isArray(parsed) ? parsed.slice(0, features.ai?.crossReferences?.maxRefs || 3) : [];
  } catch (e) {
    console.warn('[ai-enricher] Cross-references échouées:', e.message);
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
