'use strict';
/**
 * ai-enricher.js — Enrichissements IA pour ChurchOverlay
 *
 * Chaque fonction IA est INDÉPENDANTE et désactivable via features.json.
 * Utilise Google GenAI (gemini-3.6-flash) ou Groq via groq-wrapper.js.
 */

const { chatCompletion, isChatRateLimited } = require('./groq-wrapper');
const { sanitizeForPrompt } = require('./prompt-sanitizer');
const { extractResponseText, extractJsonObject } = require('./llm-utils');

// AJOUT (audit — surcharge Groq observée en direct, voir groq-wrapper.js
// #CHAT_RATE_LIMIT_COOLDOWN_MS) : chatCompletion() échoue déjà rapidement
// (sans appel réseau) pendant le cooldown — chaque fonction ci-dessous gère
// donc déjà cet échec correctement via son try/catch existant, SANS
// changement de comportement requis. Ce garde-fou explicite (au lieu de
// laisser tomber dans le catch) sert uniquement à distinguer, dans les
// logs, un enrichissement DÉLIBÉRÉMENT sauté (le budget Groq est réservé à
// la transcription en ce moment) d'un VRAI échec applicatif (JSON
// malformé, timeout, etc.) — utile pour un opérateur qui lirait les logs
// en plein culte et se demanderait pourquoi le thème/résumé ne se met
// plus à jour.
function skipIfChatRateLimited(featureLabel) {
  if (isChatRateLimited()) {
    console.log(
      `[ai-enricher] ${featureLabel} temporairement suspendu (quota Groq réservé à la transcription — reprise automatique dans quelques secondes).`
    );
    return true;
  }
  return false;
}

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
  if (skipIfChatRateLimited('Détection du thème')) return null;

  const prompt = `Tu analyses des extraits de sermon en français.
Extrais LE THÈME PRINCIPAL en 2-4 mots maximum + 3 mots-clés.
Transcription: "${sanitizeForPrompt(transcriptBuffer.slice(-2000))}"
Réponds uniquement en JSON valide: {"theme":"...","keywords":["...","...","..."]}`;

  // CORRECTIF (bug reproductible en usage réel — 3 occurrences en une
  // session, log de production) : `json_mode: true` demande à Groq
  // (response_format: {type:'json_object'}) de valider STRICTEMENT que la
  // completion entière est du JSON pur — GROQ_MODEL_CHAT ('openai/gpt-oss-
  // 20b') est un modèle de RAISONNEMENT (chaîne de pensée interne avant la
  // réponse finale), pas garanti de produire une sortie strictement
  // conforme sous ce mode strict à chaque appel ; d'où les 400
  // json_validate_failed à failed_generation VIDE (le modèle n'a rien
  // produit de conforme, pas du JSON malformé à réparer). semantic-
  // detector.js appelle ce MÊME modèle, pour une tâche comparable, SANS
  // json_mode — juste une instruction "réponds en JSON" dans le prompt +
  // extractJsonObject() (déjà tolérant : JSON brut, bloc ```json```, ou
  // premier { ... } trouvé dans une réponse libre) — et fonctionne de façon
  // fiable en usage réel (voir server.js, "[semantic] Detected..."). Retire
  // json_mode ici pour retomber sur ce même chemin déjà éprouvé, au lieu de
  // dépendre de la validation stricte de Groq. Le retry-une-fois est
  // conservé en défense en profondeur pour un aléa résiduel (le modèle ne
  // produit parfois toujours rien d'exploitable), mais ne devrait plus être
  // le mécanisme PRINCIPAL de fiabilité.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await chatCompletion(prompt, { temperature: 0.2 });
      const parsed = extractJsonObject(extractResponseText(res));
      if (!parsed) {
        if (attempt === 0) continue;
        return null;
      }
      return { theme: parsed.theme, keywords: parsed.keywords || [] };
    } catch (e) {
      const isRetryableJsonFailure = /json_validate_failed/.test(e.message || '');
      if (attempt === 0 && isRetryableJsonFailure) {
        continue;
      }
      console.warn('[ai-enricher] Détection thème échouée:', e.message);
      return null;
    }
  }
}

// ---------------------------------------------------------------------
// 2) TRADUCTION LIVE
// ---------------------------------------------------------------------
async function translateSegment(text, targetLang = 'en') {
  if (features.ai?.liveTranslation?.enabled === false) return null;
  if (!text || !text.trim()) return null;
  if (skipIfChatRateLimited('Traduction live')) return null;

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
  if (skipIfChatRateLimited('Résumé live')) return null;

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
  if (skipIfChatRateLimited('Récapitulatif post-service')) return null;

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
    // CORRECTIF (voir detectSermonTheme ci-dessus pour le diagnostic complet) :
    // même risque de 400 json_validate_failed avec GROQ_MODEL_CHAT (modèle
    // de raisonnement) sous json_mode strict — retiré au profit de
    // extractJsonObject(), déjà tolérant à une réponse libre.
    const res = await chatCompletion(prompt, {
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
  if (skipIfChatRateLimited('Versets connexes')) return [];

  const prompt = `Tu es un exégète biblique. Pour le verset "${sanitizeForPrompt(verseRef)}: ${sanitizeForPrompt(verseText || '')}", identifie 2 à 3 versets bibliques liés (thèmes similaires ou parallèles).
Réponds uniquement en JSON: [{"ref": "Livre Chapitre:Verset", "reason": "Brève explication en français"}]`;

  try {
    // CORRECTIF (voir detectSermonTheme plus haut pour le diagnostic complet) :
    // même risque de 400 json_validate_failed avec GROQ_MODEL_CHAT (modèle
    // de raisonnement) sous json_mode strict — retiré au profit de
    // extractJsonObject(), déjà tolérant à une réponse libre.
    const res = await chatCompletion(prompt, {
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
