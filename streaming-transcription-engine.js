'use strict';
/**
 * ============================================================================
 *  streaming-transcription-engine.js — AR-Grade Real-Time Transcription
 * ----------------------------------------------------------------------------
 *  Target: <800ms end-to-end latency for AR glasses performance
 *  Strategy: Hybrid streaming + batch approach with intelligent caching
 * ============================================================================
 */

const deepgramStreaming = require('./deepgram-streaming');
const groqWrapper = require('./groq-wrapper');
const bibleCache = require('./bible-offline-cache');
const logger = require('./logger');

class StreamingTranscriptionEngine {
  constructor() {
    this.streamingBuffer = [];
    this.finalResults = [];
    this.bibleContextCache = new Map();
    this.sermonContext = [];
    this.isStreaming = false;
    this.latencyTracker = {
      vad: 0,
      streaming: 0,
      final: 0,
      detection: 0,
      bible: 0,
      total: 0,
    };
  }

  /**
   * Initialize the streaming engine
   */
  async initialize() {
    logger.info('[StreamingEngine] Initializing AR-grade transcription engine');

    // Initialize Deepgram streaming
    if (deepgramStreaming.isAvailable()) {
      await deepgramStreaming.initialize();
      logger.info('[StreamingEngine] Deepgram streaming ready');
    } else {
      logger.warn('[StreamingEngine] Deepgram streaming not available, using batch mode');
    }

    // Pre-warm Bible cache with common verses
    await this.prewarmBibleCache();

    logger.info('[StreamingEngine] Initialization complete');
  }

  /**
   * Pre-warm Bible cache with frequently used verses
   */
  async prewarmBibleCache() {
    const commonVerses = [
      'Jean 3:16',
      'Jean 1:1',
      'Genèse 1:1',
      'Psaume 23:1',
      'Matthieu 6:33',
      'Philippiens 4:13',
      'Romains 8:28',
      '1 Jean 4:8',
    ];

    logger.info('[StreamingEngine] Pre-warming Bible cache with common verses');

    for (const reference of commonVerses) {
      try {
        await bibleCache.getVerse(reference);
      } catch (_e) {
        // Verse not in cache, that's okay
      }
    }

    logger.info('[StreamingEngine] Bible cache pre-warmed');
  }

  /**
   * Process audio chunk with streaming pipeline
   * @param {Buffer} audioChunk - Audio data
   * @param {Object} context - Current sermon context
   * @returns {Promise<Object>} Transcription results
   */
  async processAudioChunk(audioChunk, context = {}) {
    const startTime = Date.now();

    // Update sermon context
    this.updateSermonContext(context);

    // Stage 1: Streaming transcription (fast, <200ms)
    const streamingStart = Date.now();
    let streamingResult = null;

    if (deepgramStreaming.isAvailable()) {
      try {
        streamingResult = await deepgramStreaming.transcribeChunk(audioChunk);
        this.latencyTracker.streaming = Date.now() - streamingStart;

        // Return streaming result immediately for UI display
        if (streamingResult && streamingResult.text) {
          this.streamingBuffer.push({
            text: streamingResult.text,
            timestamp: Date.now(),
            isFinal: false,
          });

          logger.debug(
            `[StreamingEngine] Streaming result: "${streamingResult.text}" (${this.latencyTracker.streaming}ms)`
          );
        }
      } catch (e) {
        logger.warn('[StreamingEngine] Streaming failed:', e.message);
      }
    }

    // Stage 2: Parallel processing for final result
    const processingPromises = [];

    // Final transcription with Groq (higher accuracy)
    if (groqWrapper.isConfigured()) {
      processingPromises.push(
        this.getFinalTranscription(audioChunk).then((result) => ({
          type: 'final',
          data: result,
        }))
      );
    }

    // Pre-fetch likely Bible verses based on context
    processingPromises.push(
      this.prefetchBibleVerses(streamingResult?.text || '').then((result) => ({
        type: 'bible-prefetch',
        data: result,
      }))
    );

    // Wait for critical results
    const results = await Promise.allSettled(processingPromises);

    let finalTranscription = null;
    let biblePrefetch = null;

    results.forEach((result) => {
      if (result.status === 'fulfilled') {
        if (result.value.type === 'final') {
          finalTranscription = result.value.data;
        } else if (result.value.type === 'bible-prefetch') {
          biblePrefetch = result.value.data;
        }
      }
    });

    // Calculate total latency
    this.latencyTracker.total = Date.now() - startTime;

    const response = {
      streaming: streamingResult,
      final: finalTranscription,
      bibleCache: biblePrefetch,
      latency: { ...this.latencyTracker },
      timestamp: Date.now(),
    };

    logger.debug(`[StreamingEngine] Total latency: ${this.latencyTracker.total}ms`);

    return response;
  }

  /**
   * Get final high-accuracy transcription
   * @param {Buffer} audioChunk - Audio data
   * @returns {Promise<Object>} Final transcription result
   */
  async getFinalTranscription(audioChunk) {
    const startTime = Date.now();

    try {
      // Use Groq for high-accuracy final result
      const result = await groqWrapper.transcribeBuffer(audioChunk);

      this.latencyTracker.final = Date.now() - startTime;

      // Add to final results
      if (result && result.text) {
        this.finalResults.push({
          text: result.text,
          timestamp: Date.now(),
          isFinal: true,
          confidence: result.confidence,
        });
      }

      return result;
    } catch (e) {
      logger.error('[StreamingEngine] Final transcription failed:', e.message);
      return null;
    }
  }

  /**
   * Pre-fetch Bible verses based on transcription context
   * @param {string} text - Transcribed text
   * @returns {Promise<Object>} Prefetched verses
   */
  async prefetchBibleVerses(text) {
    const startTime = Date.now();

    if (!text || text.length < 10) {
      return null;
    }

    try {
      // Extract potential verse references from text
      const potentialReferences = this.extractVerseReferences(text);

      if (potentialReferences.length === 0) {
        return null;
      }

      // Pre-fetch these verses
      const prefetchPromises = potentialReferences.map((ref) =>
        bibleCache.getVerse(ref).catch(() => null)
      );

      const verses = await Promise.all(prefetchPromises);

      this.latencyTracker.bible = Date.now() - startTime;

      return {
        references: potentialReferences,
        verses: verses.filter((v) => v !== null),
      };
    } catch (e) {
      logger.warn('[StreamingEngine] Bible prefetch failed:', e.message);
      return null;
    }
  }

  /**
   * Extract potential verse references from text
   * @param {string} text - Text to analyze
   * @returns {Array<string>} Potential references
   */
  extractVerseReferences(text) {
    const references = [];

    // Common Bible book patterns (French and English)
    const bookPatterns = [
      /(?:Jean|John|Jean\s+\d+|John\s+\d+)/gi,
      /(?:Matthieu|Matthew|Matthieu\s+\d+|Matthew\s+\d+)/gi,
      /(?:Genèse|Genesis|Genèse\s+\d+|Genesis\s+\d+)/gi,
      /(?:Psaume|Psalm|Psaume\s+\d+|Psalm\s+\d+)/gi,
      /(?:Romains|Romans|Romains\s+\d+|Romans\s+\d+)/gi,
      /(?:Éphésiens|Ephesians|Éphésiens\s+\d+|Ephesians\s+\d+)/gi,
      /(?:Philippiens|Philippians|Philippiens\s+\d+|Philippians\s+\d+)/gi,
      /(?:1\s+Jean|1\s+John|1\s+Jean\s+\d+|1\s+John\s+\d+)/gi,
    ];

    // Verse reference patterns
    const versePatterns = [
      /(\d?\s*[\w\u00C0-\u00FF]+)\s*(\d+):(\d+)/g, // Book Chapter:Verse
      /(\d?\s*[\w\u00C0-\u00FF]+)\s*(\d+)[.,](\d+)/g, // Book Chapter.Verse
      /(\d?\s*[\w\u00C0-\u00FF]+)\s*(\d+)/g, // Book Chapter
    ];

    // Extract book mentions
    const books = new Set();
    bookPatterns.forEach((pattern) => {
      const matches = text.match(pattern);
      if (matches) {
        matches.forEach((match) => books.add(match.trim()));
      }
    });

    // Extract verse references
    versePatterns.forEach((pattern) => {
      let match;
      while ((match = pattern.exec(text)) !== null) {
        const reference = match[0].trim();
        if (reference.length > 3) {
          // Minimum reasonable reference
          references.push(reference);
        }
      }
    });

    return [...new Set(references)]; // Remove duplicates
  }

  /**
   * Update sermon context for better predictions
   * @param {Object} context - New context data
   */
  updateSermonContext(context) {
    if (context.topic) {
      this.sermonContext.push({
        type: 'topic',
        value: context.topic,
        timestamp: Date.now(),
      });
    }

    if (context.verses) {
      this.sermonContext.push({
        type: 'verse',
        value: context.verses,
        timestamp: Date.now(),
      });
    }

    // Keep only recent context (last 50 items)
    if (this.sermonContext.length > 50) {
      this.sermonContext = this.sermonContext.slice(-50);
    }
  }

  /**
   * Get current streaming buffer
   * @returns {Array<Object>} Streaming buffer
   */
  getStreamingBuffer() {
    return this.streamingBuffer;
  }

  /**
   * Get final results
   * @returns {Array<Object>} Final transcription results
   */
  getFinalResults() {
    return this.finalResults;
  }

  /**
   * Get latency statistics
   * @returns {Object} Latency tracker data
   */
  getLatencyStats() {
    return { ...this.latencyTracker };
  }

  /**
   * Clear buffers and reset state
   */
  clear() {
    this.streamingBuffer = [];
    this.finalResults = [];
    this.sermonContext = [];
    this.latencyTracker = {
      vad: 0,
      streaming: 0,
      final: 0,
      detection: 0,
      bible: 0,
      total: 0,
    };

    logger.info('[StreamingEngine] Buffers cleared');
  }

  /**
   * Check if streaming is available
   * @returns {boolean} Streaming availability
   */
  isStreamingAvailable() {
    return deepgramStreaming.isAvailable();
  }

  /**
   * Get engine status
   * @returns {Object} Engine status
   */
  getStatus() {
    return {
      streaming: this.isStreamingAvailable(),
      initialized: true,
      latency: this.getLatencyStats(),
      bufferSizes: {
        streaming: this.streamingBuffer.length,
        final: this.finalResults.length,
        context: this.sermonContext.length,
      },
    };
  }
}

module.exports = StreamingTranscriptionEngine;
