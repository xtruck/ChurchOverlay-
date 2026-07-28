/**
 * ============================================================================
 *  voice-commands.js — AI-powered voice command system
 * ----------------------------------------------------------------------------
 *  Enables hands-free control of the xtruck system using voice commands.
 *  Processes transcribed text and identifies actionable commands.
 * ============================================================================
 */

'use strict';

class VoiceCommandProcessor {
  constructor() {
    // Command patterns and their corresponding actions
    this.commands = {
      // Display control
      showVerse: {
        patterns: [
          /(?:montre|affiche|présente|show|display)\s+(?:le\s+)?verset/i,
          /(?:ouvre|open)\s+(?:le\s+)?verset/i,
          /verset\s+(?:suivant|next)/i
        ],
        action: 'showVerse',
        extractReference: true
      },
      hideVerse: {
        patterns: [
          /(?:cache|masque|hide|close)\s+(?:le\s+)?verset/i,
          /(?:ferme|close)\s+(?:le\s+)?verset/i,
          /(?:enlève|remove)\s+(?:le\s+)?verset/i
        ],
        action: 'hideVerse',
        extractReference: false
      },
      updateVerse: {
        patterns: [
          /(?:change|modifie|update)\s+(?:le\s+)?verset/i,
          /(?:remplace|replace)\s+(?:le\s+)?verset/i
        ],
        action: 'updateVerse',
        extractReference: true
      },
      
      // Navigation
      nextSlide: {
        patterns: [
          /(?:suivant|next)\s+(?:diapositive|slide|page)/i,
          /(?:avance|advance)/i
        ],
        action: 'nextSlide',
        extractReference: false
      },
      previousSlide: {
        patterns: [
          /(?:précédent|previous)\s+(?:diapositive|slide|page)/i,
          /(?:retour|back)\s+(?:en\s+arrière|back)/i
        ],
        action: 'previousSlide',
        extractReference: false
      },
      
      // Timer control
      pauseTimer: {
        patterns: [
          /(?:pause|arrêt|stop)\s+(?:le\s+)?(?:temps|timer|minuterie)/i,
          /(?:suspend|suspend)\s+(?:le\s+)?(?:temps|timer)/i
        ],
        action: 'pauseTimer',
        extractReference: false
      },
      resumeTimer: {
        patterns: [
          /(?:reprend|resume|continue|reprends)\s+(?:le\s+)?(?:temps|timer|minuterie)/i,
          /(?:redémarre|restart|redémarres)\s+(?:le\s+)?(?:temps|timer)/i
        ],
        action: 'resumeTimer',
        extractReference: false
      },
      extendTime: {
        patterns: [
          /(?:étends|étendre|extend|ajoute|ajouter|add)\s+(?:le\s+)?(?:temps|time)/i,
          /(?:plus\s+de\s+temps|more\s+time)/i,
          /(?:ajoute|ajouter|add)\s+(?:du\s+)?(?:temps|time)/i
        ],
        action: 'extendTime',
        extractReference: false,
        extractDuration: true
      },
      
      // System control
      startAnalysis: {
        patterns: [
          /(?:démarre|démarrer|start|begin|commence|commencer|démarrer)\s+(?:l'?\s+)?(?:analyse|analysis)/i,
          /(?:démarre|démarrer|start|begin|commence|commencer)\s+(?:l'?\s+)?(?:analyse|analysis)/i
        ],
        action: 'startSermonAnalysis',
        extractReference: false
      },
      stopAnalysis: {
        patterns: [
          /(?:arrête|stop|end)\s+(?:l'?\s+)?(?:analyse|analysis)/i,
          /(?:termine|finish|complete)\s+(?:l'?\s+)?(?:analyse|analysis)/i
        ],
        action: 'endSermonAnalysis',
        extractReference: false
      },
      getSummary: {
        patterns: [
          /(?:résumé|summary|sommaire)/i,
          /(?:donne|give)\s+(?:moi\s+)?(?:le\s+)?(?:résumé|summary)/i
        ],
        action: 'getSermonSummary',
        extractReference: false
      },
      
      // Language control
      setLanguage: {
        patterns: [
          /(?:langue|language)\s+(?:français|french|fr)/i,
          /(?:langue|language)\s+(?:anglais|english|en)/i,
          /(?:langue|language)\s+(?:espagnol|spanish|es)/i
        ],
        action: 'setLanguage',
        extractReference: false,
        extractLanguage: true
      },
      
      // Help
      help: {
        patterns: [
          /(?:aide|help|assistance)/i,
          /(?:quels|what)\s+(?:sont|are)\s+(?:les\s+)?(?:commandes|commands)/i
        ],
        action: 'help',
        extractReference: false
      }
    };

    // Command history
    this.commandHistory = [];
    this.maxHistorySize = 50;
  }

  /**
   * Process text to identify voice commands
   */
  processCommand(text) {
    if (!text || text.trim().length === 0) {
      return null;
    }

    const normalized = text.toLowerCase().trim();
    
    for (const [commandName, commandConfig] of Object.entries(this.commands)) {
      for (const pattern of commandConfig.patterns) {
        const match = normalized.match(pattern);
        if (match) {
          const command = this.buildCommand(commandName, commandConfig, text, match);
          this.addToHistory(command);
          return command;
        }
      }
    }

    return null;
  }

  /**
   * Build command object from match
   */
  buildCommand(commandName, config, originalText, match) {
    const command = {
      action: config.action,
      originalText: originalText,
      timestamp: Date.now(),
      confidence: this.calculateConfidence(match[0], originalText)
    };

    // Extract reference if needed
    if (config.extractReference) {
      command.reference = this.extractReference(originalText);
    }

    // Extract duration if needed
    if (config.extractDuration) {
      command.duration = this.extractDuration(originalText);
    }

    // Extract language if needed
    if (config.extractLanguage) {
      command.language = this.extractLanguage(originalText);
    }

    return command;
  }

  /**
   * Calculate confidence score for command detection
   */
  calculateConfidence(matchedPattern, originalText) {
    const similarity = this.calculateSimilarity(matchedPattern.toLowerCase(), originalText.toLowerCase());
    return Math.min(similarity, 1);
  }

  /**
   * Calculate similarity between two strings
   */
  calculateSimilarity(str1, str2) {
    const longer = str1.length > str2.length ? str1 : str2;
    const shorter = str1.length > str2.length ? str2 : str1;
    
    if (longer.length === 0) return 1;
    
    const editDistance = this.levenshteinDistance(longer, shorter);
    return (longer.length - editDistance) / longer.length;
  }

  /**
   * Calculate Levenshtein distance
   */
  levenshteinDistance(str1, str2) {
    const matrix = [];
    
    for (let i = 0; i <= str2.length; i++) {
      matrix[i] = [i];
    }
    
    for (let j = 0; j <= str1.length; j++) {
      matrix[0][j] = j;
    }
    
    for (let i = 1; i <= str2.length; i++) {
      for (let j = 1; j <= str1.length; j++) {
        if (str2.charAt(i - 1) === str1.charAt(j - 1)) {
          matrix[i][j] = matrix[i - 1][j - 1];
        } else {
          matrix[i][j] = Math.min(
            matrix[i - 1][j - 1] + 1,
            matrix[i][j - 1] + 1,
            matrix[i - 1][j] + 1
          );
        }
      }
    }
    
    return matrix[str2.length][str1.length];
  }

  /**
   * Extract Bible reference from text
   */
  extractReference(text) {
    // Use the existing detector
    const { detect } = require('./ml-detector');
    const reference = detect(text);
    return reference ? reference.raw : null;
  }

  /**
   * Extract duration from text
   */
  extractDuration(text) {
    const patterns = [
      /(\d+)\s*(?:secondes?|seconds?|s)/i,
      /(\d+)\s*(?:minutes?|minutes?|m)/i,
      /(\d+)\s*(?:heures?|hours?|h)/i
    ];

    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match) {
        const value = parseInt(match[1]);
        if (pattern.toString().includes('second')) return value * 1000;
        if (pattern.toString().includes('minute')) return value * 60 * 1000;
        if (pattern.toString().includes('hour')) return value * 60 * 60 * 1000;
      }
    }

    return null;
  }

  /**
   * Extract language from text
   */
  extractLanguage(text) {
    const lower = text.toLowerCase();
    if (lower.includes('français') || lower.includes('french') || lower.includes('fr')) return 'fr';
    if (lower.includes('anglais') || lower.includes('english') || lower.includes('en')) return 'en';
    if (lower.includes('espagnol') || lower.includes('spanish') || lower.includes('es')) return 'es';
    return null;
  }

  /**
   * Add command to history
   */
  addToHistory(command) {
    this.commandHistory.push(command);
    if (this.commandHistory.length > this.maxHistorySize) {
      this.commandHistory.shift();
    }
  }

  /**
   * Get command history
   */
  getHistory(limit = 10) {
    return this.commandHistory.slice(-limit);
  }

  /**
   * Get available commands
   */
  getAvailableCommands() {
    return Object.keys(this.commands).map(key => ({
      name: key,
      action: this.commands[key].action,
      patterns: this.commands[key].patterns.map(p => p.toString())
    }));
  }

  /**
   * Add custom command
   */
  addCustomCommand(name, pattern, action, options = {}) {
    this.commands[name] = {
      patterns: [pattern],
      action: action,
      extractReference: options.extractReference || false,
      extractDuration: options.extractDuration || false,
      extractLanguage: options.extractLanguage || false
    };
  }

  /**
   * Remove command
   */
  removeCommand(name) {
    if (this.commands[name]) {
      delete this.commands[name];
      return true;
    }
    return false;
  }

  /**
   * Clear history
   */
  clearHistory() {
    this.commandHistory = [];
  }

  /**
   * Get statistics
   */
  getStatistics() {
    const commandCounts = {};
    this.commandHistory.forEach(cmd => {
      commandCounts[cmd.action] = (commandCounts[cmd.action] || 0) + 1;
    });

    return {
      totalCommands: this.commandHistory.length,
      commandCounts: commandCounts,
      averageConfidence: this.commandHistory.length > 0
        ? this.commandHistory.reduce((sum, cmd) => sum + cmd.confidence, 0) / this.commandHistory.length
        : 0
    };
  }
}

// Create singleton instance
const voiceCommandProcessor = new VoiceCommandProcessor();

module.exports = {
  VoiceCommandProcessor,
  processCommand: (text) => voiceCommandProcessor.processCommand(text),
  getHistory: (limit) => voiceCommandProcessor.getHistory(limit),
  getAvailableCommands: () => voiceCommandProcessor.getAvailableCommands(),
  addCustomCommand: (name, pattern, action, options) => voiceCommandProcessor.addCustomCommand(name, pattern, action, options),
  removeCommand: (name) => voiceCommandProcessor.removeCommand(name),
  clearHistory: () => voiceCommandProcessor.clearHistory(),
  getStatistics: () => voiceCommandProcessor.getStatistics()
};