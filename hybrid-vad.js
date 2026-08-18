'use strict';
/**
 * ============================================================================
 *  hybrid-vad.js — Hybrid Voice Activity Detection for AR-Grade Performance
 * ----------------------------------------------------------------------------
 *  Combines multiple VAD approaches for maximum accuracy and responsiveness:
 *  1. Silero VAD (Neural Network) - Primary, most accurate
 *  2. WebRTC VAD - Fallback, lightweight
 *  3. Energy-based detection - Final fallback
 *
 *  Target: >95% accuracy with <100ms processing time
 * ============================================================================
 */

const sileroVad = require('./silero-vad');
const logger = require('./logger');

class HybridVAD {
  constructor() {
    this.silero = sileroVad;
    this.webrtcVad = null; // Optional WebRTC VAD
    this.energyDetector = new EnergyDetector();

    this.adaptiveThreshold = 0.02; // Default threshold
    this.noiseFloor = 0.0;
    this.speechHistory = [];
    this.maxHistorySize = 100;

    this.initialized = false;
    this.availableMethods = {
      silero: false,
      webrtc: false,
      energy: true,
    };

    this.performanceStats = {
      silero: { calls: 0, successes: 0, failures: 0, avgTime: 0 },
      webrtc: { calls: 0, successes: 0, failures: 0, avgTime: 0 },
      energy: { calls: 0, successes: 0, failures: 0, avgTime: 0 },
    };
  }

  /**
   * Initialize the hybrid VAD system
   */
  async initialize() {
    logger.info('[HybridVAD] Initializing hybrid VAD system');

    // Initialize Silero VAD
    try {
      const sileroInit = await this.silero.init();
      if (sileroInit.ok) {
        this.availableMethods.silero = true;
        logger.info('[HybridVAD] Silero VAD available');
      } else {
        logger.warn('[HybridVAD] Silero VAD initialization failed:', sileroInit.error);
      }
    } catch (e) {
      logger.error('[HybridVAD] Silero VAD initialization error:', e.message);
    }

    // Try to initialize WebRTC VAD (optional)
    try {
      // WebRTC VAD initialization would go here
      // For now, we'll mark as unavailable
      this.availableMethods.webrtc = false;
    } catch (_e) {
      this.availableMethods.webrtc = false;
    }

    this.initialized = true;

    logger.info('[HybridVAD] Initialization complete', {
      available: this.availableMethods,
    });
  }

  /**
   * Process audio chunk with hybrid VAD
   * @param {Float32Array} audioChunk - Audio samples
   * @returns {Promise<Object>} VAD result
   */
  async process(audioChunk) {
    if (!this.initialized) {
      await this.initialize();
    }

    const startTime = Date.now();

    // Update noise floor for adaptive threshold
    this.updateNoiseFloor(audioChunk);

    // Try Silero VAD first (most accurate)
    if (this.availableMethods.silero) {
      try {
        const result = await this.processWithSilero(audioChunk);
        this.updateStats('silero', Date.now() - startTime, true);

        // Update speech history for adaptive threshold
        this.updateSpeechHistory(result);

        return result;
      } catch (e) {
        logger.warn('[HybridVAD] Silero VAD failed, falling back:', e.message);
        this.updateStats('silero', Date.now() - startTime, false);
      }
    }

    // Fallback to WebRTC VAD
    if (this.availableMethods.webrtc) {
      try {
        const result = await this.processWithWebRTC(audioChunk);
        this.updateStats('webrtc', Date.now() - startTime, true);
        this.updateSpeechHistory(result);
        return result;
      } catch (e) {
        logger.warn('[HybridVAD] WebRTC VAD failed, falling back:', e.message);
        this.updateStats('webrtc', Date.now() - startTime, false);
      }
    }

    // Final fallback to energy-based detection
    const result = this.processWithEnergy(audioChunk);
    this.updateStats('energy', Date.now() - startTime, true);
    this.updateSpeechHistory(result);

    return result;
  }

  /**
   * Process with Silero VAD
   * @param {Float32Array} audioChunk - Audio samples
   * @returns {Promise<Object>} VAD result
   */
  async processWithSilero(audioChunk) {
    const streamState = this.silero.createStreamState();

    // Process in windows of 512 samples
    const results = [];
    const windowSize = this.silero.WINDOW_SAMPLES;

    for (let i = 0; i < audioChunk.length; i += windowSize) {
      const window = audioChunk.slice(i, i + windowSize);
      if (window.length === windowSize) {
        const probability = await this.silero.processWindow(window, streamState);
        results.push(probability);
      }
    }

    // Average probability across all windows
    const avgProbability = results.reduce((sum, p) => sum + p, 0) / results.length;

    // Apply adaptive threshold
    const adaptiveThreshold = this.adaptiveThreshold + this.noiseFloor;
    const isSpeech = avgProbability > adaptiveThreshold;

    return {
      isSpeech,
      confidence: avgProbability,
      method: 'silero',
      threshold: adaptiveThreshold,
      noiseFloor: this.noiseFloor,
    };
  }

  /**
   * Process with WebRTC VAD (placeholder)
   * @param {Float32Array} audioChunk - Audio samples
   * @returns {Promise<Object>} VAD result
   */
  async processWithWebRTC(audioChunk) {
    // WebRTC VAD implementation would go here
    // For now, return energy-based as fallback
    return this.processWithEnergy(audioChunk);
  }

  /**
   * Process with energy-based detection
   * @param {Float32Array} audioChunk - Audio samples
   * @returns {Object} VAD result
   */
  processWithEnergy(audioChunk) {
    const energy = this.energyDetector.calculateEnergy(audioChunk);
    const adaptiveThreshold = this.adaptiveThreshold + this.noiseFloor;
    const isSpeech = energy > adaptiveThreshold;

    return {
      isSpeech,
      confidence: Math.min(energy / adaptiveThreshold, 1.0),
      method: 'energy',
      threshold: adaptiveThreshold,
      noiseFloor: this.noiseFloor,
      energy: energy,
    };
  }

  /**
   * Update noise floor for adaptive threshold
   * @param {Float32Array} audioChunk - Audio samples
   */
  updateNoiseFloor(audioChunk) {
    const energy = this.energyDetector.calculateEnergy(audioChunk);

    // Use moving average for noise floor
    const alpha = 0.95; // Smoothing factor
    this.noiseFloor = alpha * this.noiseFloor + (1 - alpha) * energy;

    // Clamp noise floor to reasonable range
    this.noiseFloor = Math.max(0.001, Math.min(this.noiseFloor, 0.05));
  }

  /**
   * Update speech history for adaptive threshold
   * @param {Object} result - VAD result
   */
  updateSpeechHistory(result) {
    this.speechHistory.push({
      isSpeech: result.isSpeech,
      confidence: result.confidence,
      timestamp: Date.now(),
    });

    // Keep only recent history
    if (this.speechHistory.length > this.maxHistorySize) {
      this.speechHistory = this.speechHistory.slice(-this.maxHistorySize);
    }

    // Adjust adaptive threshold based on recent speech patterns
    this.adjustAdaptiveThreshold();
  }

  /**
   * Adjust adaptive threshold based on speech history
   */
  adjustAdaptiveThreshold() {
    if (this.speechHistory.length < 10) {
      return;
    }

    // Calculate recent speech ratio
    const recentHistory = this.speechHistory.slice(-20);
    const speechCount = recentHistory.filter((h) => h.isSpeech).length;
    const speechRatio = speechCount / recentHistory.length;

    // Adjust threshold to maintain optimal speech detection
    // Target: ~30-40% speech ratio in normal conversation
    if (speechRatio > 0.5) {
      // Too much speech detected, increase threshold
      this.adaptiveThreshold = Math.min(this.adaptiveThreshold * 1.05, 0.1);
    } else if (speechRatio < 0.2) {
      // Too little speech detected, decrease threshold
      this.adaptiveThreshold = Math.max(this.adaptiveThreshold * 0.95, 0.005);
    }
  }

  /**
   * Update performance statistics
   * @param {string} method - VAD method used
   * @param {number} time - Processing time
   * @param {boolean} success - Whether processing succeeded
   */
  updateStats(method, time, success) {
    const stats = this.performanceStats[method];
    stats.calls++;

    if (success) {
      stats.successes++;
      // Update average time
      stats.avgTime = (stats.avgTime * (stats.successes - 1) + time) / stats.successes;
    } else {
      stats.failures++;
    }
  }

  /**
   * Get performance statistics
   * @returns {Object} Performance stats
   */
  getPerformanceStats() {
    return JSON.parse(JSON.stringify(this.performanceStats));
  }

  /**
   * Get current adaptive threshold
   * @returns {number} Current threshold
   */
  getThreshold() {
    return this.adaptiveThreshold;
  }

  /**
   * Set adaptive threshold manually
   * @param {number} threshold - New threshold value
   */
  setThreshold(threshold) {
    this.adaptiveThreshold = Math.max(0.001, Math.min(threshold, 0.1));
    logger.info(`[HybridVAD] Threshold set to ${this.adaptiveThreshold}`);
  }

  /**
   * Get current noise floor
   * @returns {number} Current noise floor
   */
  getNoiseFloor() {
    return this.noiseFloor;
  }

  /**
   * Reset adaptive threshold to default
   */
  resetThreshold() {
    this.adaptiveThreshold = 0.02;
    this.noiseFloor = 0.0;
    this.speechHistory = [];
    logger.info('[HybridVAD] Threshold reset to default');
  }

  /**
   * Get VAD system status
   * @returns {Object} System status
   */
  getStatus() {
    return {
      initialized: this.initialized,
      availableMethods: this.availableMethods,
      currentThreshold: this.adaptiveThreshold,
      noiseFloor: this.noiseFloor,
      speechHistorySize: this.speechHistory.length,
      performance: this.getPerformanceStats(),
    };
  }

  /**
   * Clear speech history
   */
  clearHistory() {
    this.speechHistory = [];
    logger.info('[HybridVAD] Speech history cleared');
  }
}

/**
 * Energy-based VAD detector (simple fallback)
 */
class EnergyDetector {
  constructor() {
    this.sampleRate = 16000;
  }

  /**
   * Calculate RMS energy of audio chunk
   * @param {Float32Array} audioChunk - Audio samples
   * @returns {number} RMS energy
   */
  calculateEnergy(audioChunk) {
    let sum = 0;
    for (let i = 0; i < audioChunk.length; i++) {
      sum += audioChunk[i] * audioChunk[i];
    }
    return Math.sqrt(sum / audioChunk.length);
  }

  /**
   * Detect speech based on energy threshold
   * @param {Float32Array} audioChunk - Audio samples
   * @param {number} threshold - Energy threshold
   * @returns {boolean} Whether speech is detected
   */
  detectSpeech(audioChunk, threshold = 0.02) {
    const energy = this.calculateEnergy(audioChunk);
    return energy > threshold;
  }
}

module.exports = HybridVAD;
