/**
 * ============================================================================
 *  analytics.js — Analytics and metrics system for xtruck
 * ----------------------------------------------------------------------------
 *  Provides comprehensive analytics including usage statistics, popular verses,
 *  performance metrics, and insights for optimization.
 * ============================================================================
 */

'use strict';

const fs = require('fs');
const path = require('path');

class AnalyticsSystem {
  constructor() {
    this.metrics = {
      // Usage metrics
      totalSessions: 0,
      totalVersesDisplayed: 0,
      totalTranscriptions: 0,
      totalVoiceCommands: 0,
      
      // Performance metrics
      averageTranscriptionLatency: 0,
      averageDetectionConfidence: 0,
      systemUptime: 0,
      
      // Content metrics
      popularVerses: new Map(),
      popularBooks: new Map(),
      languageDistribution: new Map(),
      
      // Session metrics
      sessionDuration: [],
      peakConcurrentUsers: 0,
      
      // Error metrics
      transcriptionErrors: 0,
      detectionErrors: 0,
      networkErrors: 0
    };

    this.currentSession = {
      startTime: null,
      versesDisplayed: 0,
      transcriptions: 0,
      voiceCommands: 0,
      languagesUsed: new Set()
    };

    this.dataFile = path.join(__dirname, 'analytics-data.json');
    this.loadMetrics();
  }

  /**
   * Load metrics from file
   */
  loadMetrics() {
    try {
      if (fs.existsSync(this.dataFile)) {
        const data = JSON.parse(fs.readFileSync(this.dataFile, 'utf8'));
        
        // Convert arrays back to Maps
        this.metrics.popularVerses = new Map(data.popularVerses || []);
        this.metrics.popularBooks = new Map(data.popularBooks || []);
        this.metrics.languageDistribution = new Map(data.languageDistribution || []);
        
        // Merge other metrics
        Object.assign(this.metrics, {
          totalSessions: data.totalSessions || 0,
          totalVersesDisplayed: data.totalVersesDisplayed || 0,
          totalTranscriptions: data.totalTranscriptions || 0,
          totalVoiceCommands: data.totalVoiceCommands || 0,
          averageTranscriptionLatency: data.averageTranscriptionLatency || 0,
          averageDetectionConfidence: data.averageDetectionConfidence || 0,
          systemUptime: data.systemUptime || 0,
          sessionDuration: data.sessionDuration || [],
          peakConcurrentUsers: data.peakConcurrentUsers || 0,
          transcriptionErrors: data.transcriptionErrors || 0,
          detectionErrors: data.detectionErrors || 0,
          networkErrors: data.networkErrors || 0
        });
        
        console.log('[Analytics] Metrics loaded from file');
      }
    } catch (error) {
      console.warn('[Analytics] Could not load metrics:', error.message);
    }
  }

  /**
   * Save metrics to file
   */
  saveMetrics() {
    try {
      const data = {
        // Convert Maps to arrays for JSON serialization
        popularVerses: Array.from(this.metrics.popularVerses.entries()),
        popularBooks: Array.from(this.metrics.popularBooks.entries()),
        languageDistribution: Array.from(this.metrics.languageDistribution.entries()),
        
        // Other metrics
        totalSessions: this.metrics.totalSessions,
        totalVersesDisplayed: this.metrics.totalVersesDisplayed,
        totalTranscriptions: this.metrics.totalTranscriptions,
        totalVoiceCommands: this.metrics.totalVoiceCommands,
        averageTranscriptionLatency: this.metrics.averageTranscriptionLatency,
        averageDetectionConfidence: this.metrics.averageDetectionConfidence,
        systemUptime: this.metrics.systemUptime,
        sessionDuration: this.metrics.sessionDuration,
        peakConcurrentUsers: this.metrics.peakConcurrentUsers,
        transcriptionErrors: this.metrics.transcriptionErrors,
        detectionErrors: this.metrics.detectionErrors,
        networkErrors: this.metrics.networkErrors
      };
      
      fs.writeFileSync(this.dataFile, JSON.stringify(data, null, 2));
      console.log('[Analytics] Metrics saved to file');
    } catch (error) {
      console.error('[Analytics] Could not save metrics:', error.message);
    }
  }

  /**
   * Start a new session
   */
  startSession() {
    this.currentSession.startTime = Date.now();
    this.currentSession.versesDisplayed = 0;
    this.currentSession.transcriptions = 0;
    this.currentSession.voiceCommands = 0;
    this.currentSession.languagesUsed.clear();
    
    this.metrics.totalSessions++;
    console.log('[Analytics] New session started');
  }

  /**
   * End current session
   */
  endSession() {
    if (!this.currentSession.startTime) return;
    
    const duration = Date.now() - this.currentSession.startTime;
    this.metrics.sessionDuration.push(duration);
    
    // Keep only last 100 session durations
    if (this.metrics.sessionDuration.length > 100) {
      this.metrics.sessionDuration.shift();
    }
    
    this.currentSession.startTime = null;
    this.saveMetrics();
    console.log('[Analytics] Session ended, duration:', duration, 'ms');
  }

  /**
   * Track verse display
   */
  trackVerseDisplay(reference, book) {
    this.currentSession.versesDisplayed++;
    this.metrics.totalVersesDisplayed++;
    
    // Track popular verses
    const count = this.metrics.popularVerses.get(reference) || 0;
    this.metrics.popularVerses.set(reference, count + 1);
    
    // Track popular books
    const bookCount = this.metrics.popularBooks.get(book) || 0;
    this.metrics.popularBooks.set(book, bookCount + 1);
  }

  /**
   * Track transcription
   */
  trackTranscription(latency = null) {
    this.currentSession.transcriptions++;
    this.metrics.totalTranscriptions++;
    
    if (latency) {
      // Update average latency
      const currentAvg = this.metrics.averageTranscriptionLatency;
      const total = this.metrics.totalTranscriptions;
      this.metrics.averageTranscriptionLatency = 
        ((currentAvg * (total - 1)) + latency) / total;
    }
  }

  /**
   * Track voice command
   */
  trackVoiceCommand(command) {
    this.currentSession.voiceCommands++;
    this.metrics.totalVoiceCommands++;
  }

  /**
   * Track language usage
   */
  trackLanguageUsage(language) {
    this.currentSession.languagesUsed.add(language);
    
    const count = this.metrics.languageDistribution.get(language) || 0;
    this.metrics.languageDistribution.set(language, count + 1);
  }

  /**
   * Track detection confidence
   */
  trackDetectionConfidence(confidence) {
    const currentAvg = this.metrics.averageDetectionConfidence;
    const total = this.metrics.totalVersesDisplayed;
    this.metrics.averageDetectionConfidence = 
      ((currentAvg * (total - 1)) + confidence) / total;
  }

  /**
   * Track error
   */
  trackError(type) {
    switch (type) {
      case 'transcription':
        this.metrics.transcriptionErrors++;
        break;
      case 'detection':
        this.metrics.detectionErrors++;
        break;
      case 'network':
        this.metrics.networkErrors++;
        break;
    }
  }

  /**
   * Update peak concurrent users
   */
  updatePeakUsers(count) {
    if (count > this.metrics.peakConcurrentUsers) {
      this.metrics.peakConcurrentUsers = count;
    }
  }

  /**
   * Get comprehensive analytics report
   */
  getAnalyticsReport() {
    const avgSessionDuration = this.metrics.sessionDuration.length > 0
      ? this.metrics.sessionDuration.reduce((a, b) => a + b, 0) / this.metrics.sessionDuration.length
      : 0;

    const topVerses = Array.from(this.metrics.popularVerses.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);

    const topBooks = Array.from(this.metrics.popularBooks.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);

    const languageStats = Array.from(this.metrics.languageDistribution.entries())
      .map(([lang, count]) => ({
        language: lang,
        count: count,
        percentage: this.metrics.totalVersesDisplayed > 0 
          ? (count / this.metrics.totalVersesDisplayed * 100).toFixed(1)
          : 0
      }));

    return {
      overview: {
        totalSessions: this.metrics.totalSessions,
        totalVersesDisplayed: this.metrics.totalVersesDisplayed,
        totalTranscriptions: this.metrics.totalTranscriptions,
        totalVoiceCommands: this.metrics.totalVoiceCommands,
        systemUptime: this.metrics.systemUptime
      },
      performance: {
        averageTranscriptionLatency: Math.round(this.metrics.averageTranscriptionLatency),
        averageDetectionConfidence: (this.metrics.averageDetectionConfidence * 100).toFixed(1) + '%',
        averageSessionDuration: Math.round(avgSessionDuration / 1000 / 60), // in minutes
        peakConcurrentUsers: this.metrics.peakConcurrentUsers
      },
      content: {
        topVerses: topVerses.map(([ref, count]) => ({ reference: ref, count })),
        topBooks: topBooks.map(([book, count]) => ({ book, count })),
        languageDistribution: languageStats
      },
      errors: {
        transcriptionErrors: this.metrics.transcriptionErrors,
        detectionErrors: this.metrics.detectionErrors,
        networkErrors: this.metrics.networkErrors,
        totalErrors: this.metrics.transcriptionErrors + this.metrics.detectionErrors + this.metrics.networkErrors
      },
      currentSession: {
        duration: this.currentSession.startTime 
          ? Date.now() - this.currentSession.startTime 
          : 0,
        versesDisplayed: this.currentSession.versesDisplayed,
        transcriptions: this.currentSession.transcriptions,
        voiceCommands: this.currentSession.voiceCommands,
        languagesUsed: Array.from(this.currentSession.languagesUsed)
      }
    };
  }

  /**
   * Get insights and recommendations
   */
  getInsights() {
    const insights = [];
    const report = this.getAnalyticsReport();

    // Performance insights
    if (report.performance.averageTranscriptionLatency > 2000) {
      insights.push({
        type: 'performance',
        severity: 'warning',
        message: 'High transcription latency detected',
        recommendation: 'Consider using a faster Whisper model or optimizing audio processing'
      });
    }

    if (report.performance.averageDetectionConfidence < 0.7) {
      insights.push({
        type: 'accuracy',
        severity: 'warning',
        message: 'Low detection confidence',
        recommendation: 'Consider training the ML detector with more examples or adjusting confidence thresholds'
      });
    }

    // Usage insights
    if (report.content.topBooks.length > 0) {
      const topBook = report.content.topBooks[0];
      insights.push({
        type: 'usage',
        severity: 'info',
        message: `Most popular book: ${topBook.book}`,
        recommendation: `Consider creating quick-access shortcuts for ${topBook.book}`
      });
    }

    // Error insights
    if (report.errors.totalErrors > report.overview.totalTranscriptions * 0.1) {
      insights.push({
        type: 'reliability',
        severity: 'error',
        message: 'High error rate detected',
        recommendation: 'Review system logs and check network connectivity'
      });
    }

    // Language insights
    if (report.content.languageDistribution.length > 1) {
      insights.push({
        type: 'usage',
        severity: 'info',
        message: 'Multi-language usage detected',
        recommendation: 'Ensure all language models are properly configured'
      });
    }

    return insights;
  }

  /**
   * Reset metrics
   */
  resetMetrics() {
    this.metrics = {
      totalSessions: 0,
      totalVersesDisplayed: 0,
      totalTranscriptions: 0,
      totalVoiceCommands: 0,
      averageTranscriptionLatency: 0,
      averageDetectionConfidence: 0,
      systemUptime: 0,
      popularVerses: new Map(),
      popularBooks: new Map(),
      languageDistribution: new Map(),
      sessionDuration: [],
      peakConcurrentUsers: 0,
      transcriptionErrors: 0,
      detectionErrors: 0,
      networkErrors: 0
    };
    
    this.saveMetrics();
    console.log('[Analytics] Metrics reset');
  }

  /**
   * Export analytics data
   */
  exportAnalytics(format = 'json') {
    const report = this.getAnalyticsReport();
    
    switch (format) {
      case 'json':
        return JSON.stringify(report, null, 2);
      case 'csv':
        return this.convertToCSV(report);
      default:
        return JSON.stringify(report, null, 2);
    }
  }

  /**
   * Convert report to CSV format
   */
  convertToCSV(report) {
    const lines = [];
    
    // Overview
    lines.push('Overview');
    lines.push('Metric,Value');
    Object.entries(report.overview).forEach(([key, value]) => {
      lines.push(`${key},${value}`);
    });
    lines.push('');
    
    // Performance
    lines.push('Performance');
    lines.push('Metric,Value');
    Object.entries(report.performance).forEach(([key, value]) => {
      lines.push(`${key},${value}`);
    });
    lines.push('');
    
    // Top Verses
    lines.push('Top Verses');
    lines.push('Reference,Count');
    report.content.topVerses.forEach(({ reference, count }) => {
      lines.push(`${reference},${count}`);
    });
    
    return lines.join('\n');
  }
}

// Create singleton instance
const analytics = new AnalyticsSystem();

module.exports = {
  AnalyticsSystem,
  startSession: () => analytics.startSession(),
  endSession: () => analytics.endSession(),
  trackVerseDisplay: (ref, book) => analytics.trackVerseDisplay(ref, book),
  trackTranscription: (latency) => analytics.trackTranscription(latency),
  trackVoiceCommand: (command) => analytics.trackVoiceCommand(command),
  trackLanguageUsage: (lang) => analytics.trackLanguageUsage(lang),
  trackDetectionConfidence: (conf) => analytics.trackDetectionConfidence(conf),
  trackError: (type) => analytics.trackError(type),
  updatePeakUsers: (count) => analytics.updatePeakUsers(count),
  getAnalyticsReport: () => analytics.getAnalyticsReport(),
  getInsights: () => analytics.getInsights(),
  resetMetrics: () => analytics.resetMetrics(),
  exportAnalytics: (format) => analytics.exportAnalytics(format)
};