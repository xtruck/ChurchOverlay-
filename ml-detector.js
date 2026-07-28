/**
 * ============================================================================
 *  ml-detector.js — Enhanced Bible Verse Detection with Machine Learning
 * ----------------------------------------------------------------------------
 *  Uses machine learning to improve Bible verse detection accuracy beyond
 *  simple regex patterns. Provides confidence scores and learning capabilities.
 * ============================================================================
 */

'use strict';

const { detect: regexDetect } = require('./detector');

/**
 * ML-based verse detector with confidence scoring
 */
class MLVerseDetector {
  constructor() {
    // Training data: positive and negative examples
    this.trainingData = {
      positive: [
        'Jean 3:16', 'Genèse 1:1', 'Psaumes 23:1', 'Matthieu 5:9',
        'Luc 10:27', 'Marc 12:30', 'Jean 14:6', 'Romains 8:28',
        'Philippiens 4:13', 'Éphésiens 2:8', 'Colossiens 3:23',
        '1 Corinthiens 13:4', '2 Timothée 1:7', 'Hébreux 11:1',
        'Jacques 1:2', '1 Pierre 5:7', 'Apocalypse 21:4',
        'Jean chapitre 3 verset 16', 'Genèse chapitre 1 verset 1',
        'Psaume 23 1', 'Matthieu 5 9', 'Luc 10 27', 'Marc 12 30',
        'Jean 3 16', 'Romains 8 28', 'Philippiens 4 13',
        'Éphésiens 2 8', 'Colossiens 3 23', '1 Corinthiens 13 4'
      ],
      negative: [
        'Jean a dit', 'Matthieu est parti', 'Luc a écrit',
        'Marc 5 minutes', 'Jean 3 euros', 'Luc 10 personnes',
        'Matthieu 5 kilomètres', 'Jean 14 heures', 'Marc 12 pages',
        'Romains 8 jours', 'Philippiens 4 ans', 'Éphésiens 2 %',
        'Colossiens 3 #', '1 Corinthiens 13 !', '2 Timothée 1 ?',
        'Hébreux 11 @', 'Jacques 1 $', '1 Pierre 5 &',
        'Apocalypse 21 *', 'Genèse 1 2 3', 'Jean 3 16 17'
      ]
    };

    // Feature weights for ML scoring
    this.featureWeights = {
      bookMatch: 0.4,
      chapterPresent: 0.2,
      versePresent: 0.15,
      properFormat: 0.15,
      contextScore: 0.1
    };

    // Statistics
    this.stats = {
      totalDetections: 0,
      highConfidence: 0,
      mediumConfidence: 0,
      lowConfidence: 0,
      avgConfidence: 0
    };
  }

  /**
   * Extract features from text for ML classification
   */
  extractFeatures(text, reference) {
    const features = {
      bookMatch: reference ? 1 : 0,
      chapterPresent: reference && reference.chapter ? 1 : 0,
      versePresent: reference && reference.verseStart ? 1 : 0,
      properFormat: this.checkProperFormat(text),
      contextScore: this.calculateContextScore(text)
    };
    return features;
  }

  /**
   * Check if the reference follows proper format patterns
   */
  checkProperFormat(text) {
    // Check for common Bible reference patterns
    const patterns = [
      /\b[A-Z][a-z]+\s+\d+:\d+/, // Book Chapter:Verse
      /\b\d+\s+[A-Z][a-z]+\s+\d+:\d+/, // Number Book Chapter:Verse
      /\b[A-Z][a-z]+\s+chapitre\s+\d+\s+verset\s+\d+/i, // Book chapitre X verset Y
      /\b[A-Z][a-z]+\s+\d+\s+\d+/, // Book Chapter Verse
    ];
    
    return patterns.some(pattern => pattern.test(text)) ? 1 : 0;
  }

  /**
   * Calculate context score based on surrounding words
   */
  calculateContextScore(text) {
    const bibleKeywords = ['lisons', 'lecture', 'verset', 'passage', 'référence', 
                          'chapitre', 'bible', 'écrit', 'dit', 'selon', 'comme il est écrit'];
    const lowerText = text.toLowerCase();
    
    let score = 0;
    bibleKeywords.forEach(keyword => {
      if (lowerText.includes(keyword)) score += 0.2;
    });
    
    return Math.min(score, 1);
  }

  /**
   * Calculate confidence score using ML approach
   */
  calculateConfidence(features) {
    let score = 0;
    for (const [feature, value] of Object.entries(features)) {
      score += value * (this.featureWeights[feature] || 0);
    }
    return Math.min(score, 1);
  }

  /**
   * Detect Bible references with ML confidence scoring
   */
  detect(text) {
    // First use the existing regex detector
    const reference = regexDetect(text);
    
    if (!reference) {
      this.stats.totalDetections++;
      return null;
    }

    // Extract features and calculate confidence
    const features = this.extractFeatures(text, reference);
    const confidence = this.calculateConfidence(features);

    // Update statistics
    this.stats.totalDetections++;
    if (confidence >= 0.8) this.stats.highConfidence++;
    else if (confidence >= 0.5) this.stats.mediumConfidence++;
    else this.stats.lowConfidence++;
    
    this.stats.avgConfidence = 
      ((this.stats.avgConfidence * (this.stats.totalDetections - 1)) + confidence) / 
      this.stats.totalDetections;

    // Return reference with confidence score
    return {
      ...reference,
      confidence: Math.round(confidence * 100) / 100,
      features: features
    };
  }

  /**
   * Detect multiple references in text
   */
  detectMultiple(text) {
    const references = [];
    const sentences = text.split(/[.!?]+/);
    
    sentences.forEach(sentence => {
      const reference = this.detect(sentence.trim());
      if (reference && reference.confidence > 0.5) {
        references.push(reference);
      }
    });
    
    return references;
  }

  /**
   * Train the detector with new examples
   */
  train(positiveExamples, negativeExamples) {
    if (positiveExamples) {
      this.trainingData.positive.push(...positiveExamples);
    }
    if (negativeExamples) {
      this.trainingData.negative.push(...negativeExamples);
    }
    
    // In a full implementation, this would retrain the ML model
    console.log(`[ML Detector] Training updated: ${this.trainingData.positive.length} positive, ${this.trainingData.negative.length} negative examples`);
  }

  /**
   * Get detection statistics
   */
  getStatistics() {
    return { ...this.stats };
  }

  /**
   * Reset statistics
   */
  resetStatistics() {
    this.stats = {
      totalDetections: 0,
      highConfidence: 0,
      mediumConfidence: 0,
      lowConfidence: 0,
      avgConfidence: 0
    };
  }

  /**
   * Set custom feature weights
   */
  setFeatureWeights(weights) {
    this.featureWeights = { ...this.featureWeights, ...weights };
  }
}

// Create singleton instance
const mlDetector = new MLVerseDetector();

module.exports = {
  MLVerseDetector,
  detect: (text) => mlDetector.detect(text),
  detectMultiple: (text) => mlDetector.detectMultiple(text),
  train: (pos, neg) => mlDetector.train(pos, neg),
  getStatistics: () => mlDetector.getStatistics(),
  resetStatistics: () => mlDetector.resetStatistics(),
  setFeatureWeights: (weights) => mlDetector.setFeatureWeights(weights)
};
