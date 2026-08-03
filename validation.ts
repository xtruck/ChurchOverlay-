/**
 * ============================================================================
 *  validation.ts — Module de validation des messages WebSocket
 * ----------------------------------------------------------------------------
 *  Valide les messages entrants pour prévenir les injections et garantir
 *  l'intégrité des données.
 * ============================================================================
 */

'use strict';

import { ValidationResult, WebSocketMessage } from './types';

interface ValidatorFunction {
  (value: any): boolean;
}

interface Schema {
  required: string[];
  optional: string[];
  validators: Record<string, ValidatorFunction>;
}

interface Schemas {
  [action: string]: Schema;
}

/**
 * Schémas de validation pour les différentes actions
 */
const SCHEMAS: Schemas = {
  showVerse: {
    required: ['action', 'reference', 'text'],
    optional: ['durationMs', 'text_fr', 'text_en', 'langMode', 'provider', 'lang', 'autoDetected'],
    validators: {
      action: (value) => value === 'showVerse',
      reference: (value) => typeof value === 'string' && value.length > 0 && value.length <= 200,
      text: (value) => typeof value === 'string' && value.length > 0 && value.length <= 5000,
      durationMs: (value) => typeof value === 'number' && value > 0 && value <= 3600000, // Max 1 heure
      text_fr: (value) => value === null || (typeof value === 'string' && value.length <= 5000),
      text_en: (value) => value === null || (typeof value === 'string' && value.length <= 5000),
      langMode: (value) => typeof value === 'string' && ['fr', 'en', 'both'].includes(value),
      provider: (value) => typeof value === 'string' && value.length <= 100,
      lang: (value) => typeof value === 'string' && ['fr', 'en'].includes(value),
      autoDetected: (value) => typeof value === 'boolean',
    },
  },
  hideVerse: {
    required: ['action'],
    optional: [],
    validators: {
      action: (value) => value === 'hideVerse',
    },
  },
  updateVerse: {
    required: ['action', 'reference', 'text'],
    optional: ['durationMs'],
    validators: {
      action: (value) => value === 'updateVerse',
      reference: (value) => typeof value === 'string' && value.length > 0 && value.length <= 200,
      text: (value) => typeof value === 'string' && value.length > 0 && value.length <= 5000,
      durationMs: (value) => typeof value === 'number' && value > 0 && value <= 3600000,
    },
  },
  lookupReference: {
    required: ['action', 'reference'],
    optional: ['durationMs', 'language'],
    validators: {
      action: (value) => value === 'lookupReference',
      reference: (value) => typeof value === 'string' && value.length > 0 && value.length <= 200,
      durationMs: (value) => typeof value === 'number' && value > 0 && value <= 3600000,
      language: (value) =>
        typeof value === 'string' && ['fr', 'en', 'both'].includes(value.toLowerCase()),
    },
  },
  setLanguage: {
    required: ['action', 'language'],
    optional: [],
    validators: {
      action: (value) => value === 'setLanguage',
      language: (value) =>
        typeof value === 'string' && ['fr', 'en', 'both'].includes(value.toLowerCase()),
    },
  },
  setTranslation: {
    required: ['action', 'language', 'code'],
    optional: [],
    validators: {
      action: (value) => value === 'setTranslation',
      language: (value) => typeof value === 'string' && ['fr', 'en'].includes(value.toLowerCase()),
      code: (value) => typeof value === 'string' && /^[a-z0-9_-]{2,20}$/i.test(value),
    },
  },
  getState: {
    required: ['action'],
    optional: [],
    validators: { action: (value) => value === 'getState' },
  },
  getHistory: {
    required: ['action'],
    optional: [],
    validators: { action: (value) => value === 'getHistory' },
  },
  replayVerse: {
    required: ['action', 'id'],
    optional: ['durationMs'],
    validators: {
      action: (value) => value === 'replayVerse',
      id: (value) => typeof value === 'string' && value.length > 0 && value.length <= 100,
      durationMs: (value) => typeof value === 'number' && value > 0 && value <= 3600000,
    },
  },
  diagnostic: {
    required: ['action'],
    optional: [],
    validators: {
      action: (value) => value === 'diagnostic',
    },
  },
};

/**
 * Valide un message WebSocket
 * @param message - Le message à valider
 * @returns - { valid: boolean, error: string|null }
 */
function validateMessage(message: WebSocketMessage): ValidationResult {
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
      } catch (error: any) {
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
 * @param text - Texte à nettoyer
 * @returns - Texte nettoyé
 */
function sanitizeText(text: string | null): string {
  if (typeof text !== 'string') return String(text || '');

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
 * @param message - Message à valider et nettoyer
 * @returns - { valid: boolean, error: string|null, sanitized: Object|null }
 */
function validateAndSanitize(
  message: WebSocketMessage
): ValidationResult & { sanitized?: WebSocketMessage } {
  const validation = validateMessage(message);
  if (!validation.valid) {
    return validation;
  }

  // Pas d'échappement HTML ici : overlay.html affiche via textContent,
  // qui neutralise déjà tout risque d'injection. Échapper en plus les
  // entités (&, ', etc.) afficherait à l'écran des versets pollués par
  // du texte du type "qu&#x27;il" au lieu de "qu'il".
  return { valid: true, error: undefined, sanitized: { ...message } } as ValidationResult & {
    sanitized: WebSocketMessage;
  };
}

export { validateMessage, sanitizeText, validateAndSanitize, SCHEMAS };
