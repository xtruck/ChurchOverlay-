/**
 * ============================================================================
 *  sermon-analyzer.js — AI-powered sermon analysis and summarization
 * ----------------------------------------------------------------------------
 *  Provides real-time sermon analysis including key point extraction,
 *  theme identification, and summarization capabilities.
 * ============================================================================
 */

'use strict';

class SermonAnalyzer {
  constructor() {
    this.transcripts = [];
    this.keyPoints = [];
    this.themes = [];
    this.currentSummary = '';
    this.wordCount = 0;
    this.startTime = null;
    
    // Keywords for theme identification
    this.themeKeywords = {
      'amour': ['amour', 'charité', 'bienveillance', 'compassion', 'grâce'],
      'foi': ['foi', 'confiance', 'croyance', 'fidélité', 'assurance'],
      'espérance': ['espérance', 'espoir', 'avenir', 'promesse', 'attente'],
      'salut': ['salut', 'rédemption', 'délivrance', 'sauvetage', 'grâce'],
      'prière': ['prière', 'prier', 'supplication', 'intercession', 'adoration'],
      'justice': ['justice', 'équité', 'droit', 'jugement', 'vérité'],
      'paix': ['paix', 'réconciliation', 'harmonie', 'calme', 'sérénité'],
      'persévérance': ['persévérance', 'endurance', 'patience', 'constance', 'fermeté'],
      'service': ['service', 'servir', 'ministère', 'aide', 'assistance'],
      'communauté': ['communauté', 'église', 'assemblée', 'corps', 'ensemble']
    };
  }

  /**
   * Start a new sermon analysis session
   */
  startSession() {
    this.transcripts = [];
    this.keyPoints = [];
    this.themes = [];
    this.currentSummary = '';
    this.wordCount = 0;
    this.startTime = Date.now();
    console.log('[Sermon Analyzer] Nouvelle session démarrée');
  }

  /**
   * Add transcript segment for analysis
   */
  addTranscript(text) {
    if (!text || text.trim().length === 0) return;
    
    this.transcripts.push({
      text: text.trim(),
      timestamp: Date.now()
    });
    
    this.wordCount += text.split(/\s+/).length;
    this.analyzeContent(text);
    this.updateSummary();
  }

  /**
   * Analyze content for key points and themes
   */
  analyzeContent(text) {
    const lowerText = text.toLowerCase();
    
    // Extract potential key points (sentences with important keywords)
    const sentences = text.split(/[.!?]+/);
    sentences.forEach(sentence => {
      if (this.isKeyPoint(sentence)) {
        this.addKeyPoint(sentence.trim());
      }
    });
    
    // Identify themes
    this.identifyThemes(lowerText);
  }

  /**
   * Check if a sentence is a key point
   */
  isKeyPoint(sentence) {
    const keywords = ['important', 'essentiel', 'clé', 'fondamental', 'crucial', 
                     'souvenez', 'rappelez', 'notons', 'retenons', 'principe'];
    const lowerSentence = sentence.toLowerCase();
    
    // Key points are often longer sentences with emphasis words
    return sentence.split(/\s+/).length > 8 && 
           keywords.some(keyword => lowerSentence.includes(keyword));
  }

  /**
   * Add a key point (avoiding duplicates)
   */
  addKeyPoint(point) {
    const normalized = point.toLowerCase().replace(/\s+/g, ' ');
    const exists = this.keyPoints.some(kp => 
      kp.text.toLowerCase().replace(/\s+/g, ' ') === normalized
    );
    
    if (!exists) {
      this.keyPoints.push({
        text: point,
        timestamp: Date.now()
      });
      
      // Keep only the most recent 10 key points
      if (this.keyPoints.length > 10) {
        this.keyPoints.shift();
      }
    }
  }

  /**
   * Identify themes in the text
   */
  identifyThemes(text) {
    for (const [theme, keywords] of Object.entries(this.themeKeywords)) {
      const matches = keywords.filter(keyword => text.includes(keyword));
      if (matches.length > 0) {
        this.addTheme(theme, matches.length);
      }
    }
  }

  /**
   * Add or update a theme
   */
  addTheme(theme, strength) {
    const existing = this.themes.find(t => t.name === theme);
    if (existing) {
      existing.strength += strength;
      existing.mentions++;
    } else {
      this.themes.push({
        name: theme,
        strength: strength,
        mentions: 1
      });
    }
    
    // Sort themes by strength
    this.themes.sort((a, b) => b.strength - a.strength);
  }

  /**
   * Generate a summary of the sermon so far
   */
  updateSummary() {
    if (this.transcripts.length === 0) return '';
    
    // Get the most recent content
    const recentTranscripts = this.transcripts.slice(-5);
    const recentText = recentTranscripts.map(t => t.text).join(' ');
    
    // Build summary with key points and themes
    let summary = '';
    
    // Add top themes
    if (this.themes.length > 0) {
      const topThemes = this.themes.slice(0, 3).map(t => t.name).join(', ');
      summary += `Thèmes principaux: ${topThemes}. `;
    }
    
    // Add key points
    if (this.keyPoints.length > 0) {
      const recentKeyPoints = this.keyPoints.slice(-3).map(kp => kp.text).join(' ');
      summary += `Points clés: ${recentKeyPoints}`;
    }
    
    this.currentSummary = summary;
  }

  /**
   * Get current analysis results
   */
  getAnalysis() {
    const duration = this.startTime ? Date.now() - this.startTime : 0;
    
    return {
      duration: duration,
      wordCount: this.wordCount,
      transcriptCount: this.transcripts.length,
      keyPoints: this.keyPoints,
      themes: this.themes.slice(0, 5), // Top 5 themes
      summary: this.currentSummary,
      recentTranscript: this.transcripts.length > 0 
        ? this.transcripts[this.transcripts.length - 1].text 
        : ''
    };
  }

  /**
   * Get a detailed summary
   */
  getDetailedSummary() {
    const analysis = this.getAnalysis();
    
    let summary = `=== Analyse du Sermon ===\n`;
    summary += `Durée: ${Math.round(analysis.duration / 1000 / 60)} minutes\n`;
    summary += `Mots: ${analysis.wordCount}\n`;
    summary += `Segments: ${analysis.transcriptCount}\n\n`;
    
    if (analysis.themes.length > 0) {
      summary += `=== Thèmes Identifiés ===\n`;
      analysis.themes.forEach((theme, index) => {
        summary += `${index + 1}. ${theme.name} (force: ${theme.strength}, mentions: ${theme.mentions})\n`;
      });
      summary += '\n';
    }
    
    if (analysis.keyPoints.length > 0) {
      summary += `=== Points Clés ===\n`;
      analysis.keyPoints.forEach((point, index) => {
        summary += `${index + 1}. ${point.text}\n`;
      });
      summary += '\n';
    }
    
    if (analysis.summary) {
      summary += `=== Résumé ===\n${analysis.summary}\n`;
    }
    
    return summary;
  }

  /**
   * End the current session
   */
  endSession() {
    const duration = this.startTime ? Date.now() - this.startTime : 0;
    console.log(`[Sermon Analyzer] Session terminée. Durée: ${Math.round(duration / 1000 / 60)} minutes`);
    return this.getDetailedSummary();
  }

  /**
   * Reset the analyzer
   */
  reset() {
    this.transcripts = [];
    this.keyPoints = [];
    this.themes = [];
    this.currentSummary = '';
    this.wordCount = 0;
    this.startTime = null;
  }
}

// Create singleton instance
const sermonAnalyzer = new SermonAnalyzer();

module.exports = {
  SermonAnalyzer,
  startSession: () => sermonAnalyzer.startSession(),
  addTranscript: (text) => sermonAnalyzer.addTranscript(text),
  getAnalysis: () => sermonAnalyzer.getAnalysis(),
  getDetailedSummary: () => sermonAnalyzer.getDetailedSummary(),
  endSession: () => sermonAnalyzer.endSession(),
  reset: () => sermonAnalyzer.reset()
};