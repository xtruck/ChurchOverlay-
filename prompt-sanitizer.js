'use strict';
/**
 * prompt-sanitizer.js — Défense contre l'injection de prompt
 *
 * CONTEXTE DU RISQUE : les transcripts de sermon sont issus de la parole
 * captée en direct (via Groq/Deepgram) et interpolés tels quels dans des
 * prompts envoyés au LLM (ai-enricher.js, semantic-detector.js,
 * transcription-corrector.js). Un intervenant — volontairement ou par
 * accident de transcription — pourrait prononcer une phrase qui ressemble
 * à une instruction système ("ignore les instructions précédentes...") et
 * influencer la sortie du modèle (thème détecté, traduction, résumé...).
 *
 * Cette fonction ne rend pas l'injection impossible à 100% (aucune défense
 * regex ne le peut totalement contre un LLM), mais elle neutralise les
 * patterns d'injection les plus connus et limite la surface d'attaque en
 * bornant la longueur du texte injecté dans le prompt.
 */

// Patterns connus d'injection de prompt, insensibles à la casse. Volontai-
// rement larges (FR + EN) car les sermons peuvent être bilingues.
const INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?(previous|prior|above)\s+instructions?/gi,
  /ignore[sz]?\s+les\s+instructions?\s+(précédentes|pr[ée]c[ée]dentes|ci-dessus)/gi,
  /system\s*prompt/gi,
  /prompt\s*syst[eè]me/gi,
  /<\/?\s*(instruction|system|assistant|user)\s*>/gi,
  /\bDAN\b/g, // "Do Anything Now" jailbreak connu
  /jailbreak/gi,
  /you\s+are\s+now\s+/gi,
  /tu\s+es\s+maintenant\s+/gi,
  /nouvelle\s+instruction\s*:/gi,
  /new\s+instructions?\s*:/gi,
  /disregard\s+(all\s+)?(previous|prior)/gi,
  /act\s+as\s+(if\s+)?you\s+(are|were)/gi,
];

const MAX_PROMPT_TEXT_LENGTH = 4000;

/**
 * Neutralise les patterns d'injection connus et borne la longueur du texte
 * avant qu'il soit interpolé dans un prompt LLM.
 * @param {string} text - Texte brut (transcript, segment audio transcrit...)
 * @returns {string} Texte nettoyé, sûr à interpoler dans un prompt
 */
function sanitizeForPrompt(text) {
  if (typeof text !== 'string' || !text) return '';

  let cleaned = text;
  for (const pattern of INJECTION_PATTERNS) {
    cleaned = cleaned.replace(pattern, '[filtré]');
  }

  // Neutralise aussi les tentatives de "fermer" le contexte du prompt avec
  // des guillemets/backticks en excès, qui pourraient faire croire au
  // modèle que la section "transcription" est terminée plus tôt que prévu.
  cleaned = cleaned.replace(/`{3,}/g, '```');

  if (cleaned.length > MAX_PROMPT_TEXT_LENGTH) {
    cleaned = cleaned.slice(0, MAX_PROMPT_TEXT_LENGTH);
  }

  return cleaned;
}

module.exports = { sanitizeForPrompt, MAX_PROMPT_TEXT_LENGTH };
