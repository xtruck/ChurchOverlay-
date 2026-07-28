/**
 * ============================================================================
 *  validation.js — Module de validation des messages WebSocket
 * ----------------------------------------------------------------------------
 *  Valide les messages entrants pour prévenir les injections et garantir
 *  l'intégrité des données.
 * ============================================================================
 */

'use strict';

/**
 * Schémas de validation pour les différentes actions
 */
const SCHEMAS = {
  showVerse: {
    required: ['action', 'reference', 'text'],
    optional: ['durationMs'],
    validators: {
      action: (value) => value === 'showVerse',
      reference: (value) => typeof value === 'string' && value.length > 0 && value.length <= 200,
      text: (value) => typeof value === 'string' && value.length > 0 && value.length <= 5000,
      durationMs: (value) => typeof value === 'number' && value > 0 && value <= 3600000 // Max 1 heure
    }
  },
  hideVerse: {
    required: ['action'],
    optional: [],
    validators: {
      action: (value) => value === 'hideVerse'
    }
  },
  updateVerse: {
    required: ['action', 'reference', 'text'],
    optional: ['durationMs'],
    validators: {
      action: (value) => value === 'updateVerse',
      reference: (value) => typeof value === 'string' && value.length > 0 && value.length <= 200,
      text: (value) => typeof value === 'string' && value.length > 0 && value.length <= 5000,
      durationMs: (value) => typeof value === 'number' && value > 0 && value <= 3600000
    }
  },
  lookupReference: {
    required: ['action', 'reference'],
    optional: ['durationMs'],
    validators: {
      action: (value) => value === 'lookupReference',
      reference: (value) => typeof value === 'string' && value.length > 0 && value.length <= 200,
      durationMs: (value) => typeof value === 'number' && value > 0 && value <= 3600000
    }
  },
  getStatistics: {
    required: ['action'],
    optional: [],
    validators: {
      action: (value) => value === 'getStatistics'
    }
  },
  confirmVerse: {
    required: ['action', 'reference'],
    optional: ['durationMs'],
    validators: {
      action: (value) => value === 'confirmVerse',
      reference: (value) => typeof value === 'string' && value.length > 0 && value.length <= 200,
      durationMs: (value) => typeof value === 'number' && value > 0 && value <= 3600000
    }
  },
  startSermonAnalysis: {
    required: ['action'],
    optional: [],
    validators: {
      action: (value) => value === 'startSermonAnalysis'
    }
  },
  getSermonAnalysis: {
    required: ['action'],
    optional: [],
    validators: {
      action: (value) => value === 'getSermonAnalysis'
    }
  },
  getSermonSummary: {
    required: ['action'],
    optional: [],
    validators: {
      action: (value) => value === 'getSermonSummary'
    }
  },
  endSermonAnalysis: {
    required: ['action'],
    optional: [],
    validators: {
      action: (value) => value === 'endSermonAnalysis'
    }
  },
  setLanguage: {
    required: ['action', 'language'],
    optional: [],
    validators: {
      action: (value) => value === 'setLanguage',
      language: (value) => typeof value === 'string' && value.length === 2 && ['fr', 'en', 'es'].includes(value)
    }
  },
  getLanguage: {
    required: ['action'],
    optional: [],
    validators: {
      action: (value) => value === 'getLanguage'
    }
  },
  getSupportedLanguages: {
    required: ['action'],
    optional: [],
    validators: {
      action: (value) => value === 'getSupportedLanguages'
    }
  },
  getVoiceCommands: {
    required: ['action'],
    optional: [],
    validators: {
      action: (value) => value === 'getVoiceCommands'
    }
  },
  getVoiceCommandHistory: {
    required: ['action'],
    optional: ['limit'],
    validators: {
      action: (value) => value === 'getVoiceCommandHistory',
      limit: (value) => typeof value === 'number' && value > 0 && value <= 100
    }
  },
  getVoiceStatistics: {
    required: ['action'],
    optional: [],
    validators: {
      action: (value) => value === 'getVoiceStatistics'
    }
  },
  getAnalyticsReport: {
    required: ['action'],
    optional: [],
    validators: {
      action: (value) => value === 'getAnalyticsReport'
    }
  },
  getAnalyticsInsights: {
    required: ['action'],
    optional: [],
    validators: {
      action: (value) => value === 'getAnalyticsInsights'
    }
  },
  exportAnalytics: {
    required: ['action'],
    optional: ['format'],
    validators: {
      action: (value) => value === 'exportAnalytics',
      format: (value) => typeof value === 'string' && ['json', 'csv'].includes(value)
    }
  },
  getCloudSyncStatus: {
    required: ['action'],
    optional: [],
    validators: {
      action: (value) => value === 'getCloudSyncStatus'
    }
  },
  getCloudBackups: {
    required: ['action'],
    optional: ['type'],
    validators: {
      action: (value) => value === 'getCloudBackups',
      type: (value) => typeof value === 'string' && ['sermon', 'verse', 'analytics'].includes(value)
    }
  },
  restoreFromBackup: {
    required: ['action', 'backupId'],
    optional: [],
    validators: {
      action: (value) => value === 'restoreFromBackup',
      backupId: (value) => typeof value === 'number' && value > 0
    }
  },
  cleanupCloudBackups: {
    required: ['action'],
    optional: ['days'],
    validators: {
      action: (value) => value === 'cleanupCloudBackups',
      days: (value) => typeof value === 'number' && value > 0
    }
  },
  exportCloudData: {
    required: ['action'],
    optional: [],
    validators: {
      action: (value) => value === 'exportCloudData'
    }
  },
  importCloudData: {
    required: ['action', 'data'],
    optional: [],
    validators: {
      action: (value) => value === 'importCloudData',
      data: (value) => typeof value === 'object' && value !== null
    }
  }
};

/**
 * Valide un message WebSocket
 * @param {Object} message - Le message à valider
 * @returns {Object} - { valid: boolean, error: string|null }
 */
function validateMessage(message) {
  // Vérifier que c'est un objet
  if (!message || typeof message !== 'object') {
    return { valid: false, error: 'Message doit être un objet JSON' };
  }

  // Vérifier que l'action est présente
  if (!message.action || typeof message.action !== 'string') {
    return { valid: false, error: 'Action manquante ou invalide' };
  }

  // Récupérer le schéma pour cette action
  const schema = SCHEMAS[message.action];
  if (!schema) {
    return { valid: false, error: `Action inconnue: ${message.action}` };
  }

  // Vérifier les champs requis
  for (const field of schema.required) {
    if (!(field in message)) {
      return { valid: false, error: `Champ requis manquant: ${field}` };
    }
  }

  // Valider chaque champ avec son validateur
  for (const [field, validator] of Object.entries(schema.validators)) {
    if (field in message) {
      try {
        if (!validator(message[field])) {
          return { valid: false, error: `Valeur invalide pour le champ: ${field}` };
        }
      } catch (error) {
        return { valid: false, error: `Erreur de validation pour ${field}: ${error.message}` };
      }
    }
  }

  // Vérifier qu'il n'y a pas de champs supplémentaires non autorisés
  const allowedFields = new Set([...schema.required, ...schema.optional]);
  for (const field of Object.keys(message)) {
    if (!allowedFields.has(field)) {
      return { valid: false, error: `Champ non autorisé: ${field}` };
    }
  }

  return { valid: true, error: null };
}

/**
 * Nettoie les données pour prévenir les injections XSS
 * @param {string} text - Texte à nettoyer
 * @returns {string} - Texte nettoyé
 */
function sanitizeText(text) {
  if (typeof text !== 'string') return text;
  
  // Échapper les caractères HTML dangereux
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;')
    .replace(/\//g, '&#x2F;');
}

/**
 * Valide et nettoie un message complet
 * @param {Object} message - Message à valider et nettoyer
 * @returns {Object} - { valid: boolean, error: string|null, sanitized: Object|null }
 */
function validateAndSanitize(message) {
  const validation = validateMessage(message);
  if (!validation.valid) {
    return validation;
  }

  // Pas d'échappement HTML ici : overlay.html affiche via textContent,
  // qui neutralise déjà tout risque d'injection. Échapper en plus les
  // entités (&, ', etc.) afficherait à l'écran des versets pollués par
  // du texte du type "qu&#x27;il" au lieu de "qu'il".
  return { valid: true, error: null, sanitized: { ...message } };
}

module.exports = {
  validateMessage,
  sanitizeText,
  validateAndSanitize,
  SCHEMAS
};