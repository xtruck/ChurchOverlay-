/**
 * ============================================================================
 * semantic-detector.js — AI-Powered Implicit Bible Verse Detection
 * ============================================================================
 * Detects when a speaker references a Bible passage IMPLICITLY
 * (e.g. "that passage where Jesus calms the storm" → Mark 4:39)
 * 
 * Uses Groq LLM (llama-3.1-8b-instant) with smart caching and confidence scoring.
 * Falls back gracefully when offline or API limits hit.
 * 
 * Integration: Drop into your project, require in server.js, call after
 * detectBilingual() returns null.
 * ============================================================================
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// -----------------------------------------------------------------------
// Configuration
// -----------------------------------------------------------------------
const CONFIG = {
  // Groq model — fast, cheap, good at structured output
  MODEL: 'llama-3.1-8b-instant',
  // Only run semantic detection if regex fails AND text looks "biblical"
  BIBLICAL_KEYWORDS: [
    'jesus', 'christ', 'dieu', 'god', 'seigneur', 'lord', 'esprit', 'spirit',
    'bible', 'ecriture', 'scripture', 'evangile', 'gospel', 'apôtre', 'apostle',
    'prophète', 'prophet', 'moïse', 'moses', 'abraham', 'david', 'paul', 'pierre',
    'marie', 'mary', 'ciel', 'heaven', 'enfer', 'hell', 'péché', 'sin',
    'salut', 'salvation', 'foi', 'faith', 'amour', 'love', 'grâce', 'grace',
    'passage', 'histoire', 'story', 'verset', 'verse', 'chapitre', 'chapter',
    'parole', 'word', 'promesse', 'promise', 'miracle', 'miracle', 'guérison',
    'healing', 'résurrection', 'resurrection', 'croix', 'cross', 'temple',
    'église', 'church', 'sacrifice', 'sacrifice', 'alliance', 'covenant',
    'délivrance', 'deliverance', 'repentance', 'repentance', 'baptême',
    'baptism', 'mariage', 'marriage', 'dix', 'commandements', 'commandments'
  ],
  // Confidence threshold — below this, we don't trust the LLM
  MIN_CONFIDENCE: 0.75,
  // Cache settings
  CACHE_MAX_SIZE: 200,
  CACHE_TTL_MS: 1000 * 60 * 30, // 30 minutes
  // Rate limiting — don't hammer Groq
  MAX_CALLS_PER_MINUTE: 20,
  // Recent context window (last N transcripts for context)
  CONTEXT_WINDOW_SIZE: 5,
};

// -----------------------------------------------------------------------
// In-memory caches
// -----------------------------------------------------------------------
const semanticCache = new Map(); // hash -> { result, timestamp }
const recentCalls = []; // timestamps of recent API calls

// -----------------------------------------------------------------------
// Biblical keyword pre-filter
// -----------------------------------------------------------------------
function looksBiblical(text) {
  const normalized = text.toLowerCase().normalize('NFD').replace(/\u0300-\u036f/g, '');
  return CONFIG.BIBLICAL_KEYWORDS.some(kw => normalized.includes(kw));
}

// -----------------------------------------------------------------------
// Rate limiter
// -----------------------------------------------------------------------
function canMakeCall() {
  const now = Date.now();
  const oneMinuteAgo = now - 60000;
  // Remove old entries
  while (recentCalls.length > 0 && recentCalls[0] < oneMinuteAgo) {
    recentCalls.shift();
  }
  return recentCalls.length < CONFIG.MAX_CALLS_PER_MINUTE;
}

function recordCall() {
  recentCalls.push(Date.now());
}

// -----------------------------------------------------------------------
// Cache helpers
// -----------------------------------------------------------------------
function getCacheKey(text, context) {
  const data = text + '|' + (context || '');
  return crypto.createHash('sha256').update(data).digest('hex').slice(0, 16);
}

function getCached(hash) {
  const entry = semanticCache.get(hash);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CONFIG.CACHE_TTL_MS) {
    semanticCache.delete(hash);
    return null;
  }
  return entry.result;
}

function setCached(hash, result) {
  if (semanticCache.size >= CONFIG.CACHE_MAX_SIZE) {
    const firstKey = semanticCache.keys().next().value;
    semanticCache.delete(firstKey);
  }
  semanticCache.set(hash, { result, timestamp: Date.now() });
}

// -----------------------------------------------------------------------
// Build the LLM prompt
// -----------------------------------------------------------------------
function buildPrompt(text, contextHistory) {
  const context = contextHistory.length > 0
    ? `Recent sermon context (last ${contextHistory.length} fragments):\n` +
      contextHistory.map((t, i) => `${i + 1}. "${t}"`).join('\n')
    : 'No prior context available.';

  return `You are a biblical reference detector for a live church sermon transcription system.

TASK: Analyze the following sermon transcript fragment and determine if the speaker is implicitly or explicitly referencing a specific Bible passage, story, person, or teaching.

${context}

Current fragment to analyze: "${text}"

RULES:
1. If the speaker mentions a specific Bible reference (e.g., "Jean 3:16", "Romains 8"), extract it precisely.
2. If the speaker describes a biblical story/event/person without naming the reference (e.g., "the passage where Jesus calms the storm", "when David fought Goliath", "the story of the prodigal son"), identify the PRIMARY Bible reference.
3. If the speaker quotes or paraphrases a verse without citing it, try to identify the source.
4. If multiple passages could match, choose the MOST LIKELY one based on sermon context.
5. If NO biblical reference is present, return null.
6. French book names are acceptable in the reference field.

Respond ONLY with valid JSON in this exact format:
{
  "reference": "BOOK CHAPTER:VERSE" or null,
  "confidence": 0.0 to 1.0,
  "reasoning": "brief explanation in French",
  "alternativeRefs": ["optional secondary references"]
}

Examples:
- "le passage où Jésus marche sur l'eau" → {"reference": "Matthieu 14:25", "confidence": 0.92, "reasoning": "Jésus marche sur l'eau", "alternativeRefs": ["Marc 6:48", "Jean 6:19"]}
- "l'histoire du fils prodigue" → {"reference": "Luc 15:11", "confidence": 0.95, "reasoning": "Parabole du fils prodigue", "alternativeRefs": []}
- "Paul dit aux Corinthiens" → {"reference": "1 Corinthiens 1:1", "confidence": 0.88, "reasoning": "Paul écrit aux Corinthiens", "alternativeRefs": ["2 Corinthiens 1:1"]}
- "nous devons aimer nos ennemis" → {"reference": "Matthieu 5:44", "confidence": 0.85, "reasoning": "Aimer ses ennemis", "alternativeRefs": ["Luc 6:27"]}
- "le café est bon ce matin" → {"reference": null, "confidence": 0.0, "reasoning": "Aucune référence biblique", "alternativeRefs": []}`;
}

// -----------------------------------------------------------------------
// Parse LLM response
// -----------------------------------------------------------------------
function parseResponse(rawText) {
  try {
    // Try to extract JSON from markdown code blocks or raw text
    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    const parsed = JSON.parse(jsonMatch[0]);

    if (!parsed.reference || parsed.reference === null || parsed.reference === 'null') {
      return null;
    }

    const confidence = typeof parsed.confidence === 'number' ? parsed.confidence : 0;
    if (confidence < CONFIG.MIN_CONFIDENCE) {
      console.log('[semantic] Confidence too low:', confidence, '-', parsed.reasoning);
      return null;
    }

    // Parse reference format: "BOOK CHAPTER:VERSE" or "BOOK CHAPTER"
    const refMatch = parsed.reference.match(/^(.+?)\s+(\d+)(?::(\d+))?$/i);
    if (!refMatch) {
      console.log('[semantic] Could not parse reference format:', parsed.reference);
      return null;
    }

    return {
      book: refMatch[1].trim().toLowerCase(),
      chapter: parseInt(refMatch[2], 10),
      verseStart: refMatch[3] ? parseInt(refMatch[3], 10) : undefined,
      verseEnd: undefined,
      raw: parsed.reference,
      confidence: confidence,
      reasoning: parsed.reasoning || '',
      alternativeRefs: parsed.alternativeRefs || [],
      detectedBy: 'semantic',
    };
  } catch (err) {
    console.warn('[semantic] Failed to parse LLM response:', err.message);
    return null;
  }
}

// -----------------------------------------------------------------------
// Main detection function
// -----------------------------------------------------------------------
class SemanticDetector {
  constructor(groqWrapper) {
    this.groq = groqWrapper;
    this.contextHistory = []; // Rolling window of recent transcripts
  }

  addContext(text) {
    this.contextHistory.push(text);
    if (this.contextHistory.length > CONFIG.CONTEXT_WINDOW_SIZE) {
      this.contextHistory.shift();
    }
  }

  async detect(text) {
    // 1. Pre-filter: must look biblical
    if (!looksBiblical(text)) {
      return null;
    }

    // 2. Check cache
    const cacheKey = getCacheKey(text, this.contextHistory.join('|'));
    const cached = getCached(cacheKey);
    if (cached) {
      console.log('[semantic] Cache hit:', cached.raw);
      return cached;
    }

    // 3. Rate limit check
    if (!canMakeCall()) {
      console.log('[semantic] Rate limited, skipping');
      return null;
    }

    // 4. Call Groq LLM
    try {
      recordCall();
      console.log('[semantic] Querying LLM for:', text.substring(0, 80) + '...');

      const prompt = buildPrompt(text, this.contextHistory);
      const response = await this.groq.chatCompletion(prompt, {
        model: CONFIG.MODEL,
        temperature: 0.1, // Low temp for consistency
        max_tokens: 256,
      });

      const result = parseResponse(response.text || response);

      if (result) {
        console.log(`[semantic] Detected: ${result.raw} (confidence: ${result.confidence.toFixed(2)}) — ${result.reasoning}`);
        setCached(cacheKey, result);
      } else {
       <response clipped><NOTE>Result is longer than **10000 characters**, will be **truncated**.</NOTE>
