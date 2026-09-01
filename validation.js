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
  agentRun: {
    required: ['action', 'input'],
    optional: ['sessionId'],
    validators: {
      action: (value) => value === 'agentRun',
      input: (value) =>
        typeof value === 'string' && value.trim().length > 0 && value.length <= 4000,
      sessionId: (value) => typeof value === 'string' && value.length > 0 && value.length <= 120,
    },
  },
  agentResume: {
    required: ['action', 'runId', 'approvedToolCallIds'],
    optional: ['sessionId'],
    validators: {
      action: (value) => value === 'agentResume',
      runId: (value) => typeof value === 'string' && value.length > 0 && value.length <= 120,
      approvedToolCallIds: (value) =>
        Array.isArray(value) &&
        value.length <= 10 &&
        value.every((id) => typeof id === 'string' && id.length <= 120),
      sessionId: (value) => typeof value === 'string' && value.length > 0 && value.length <= 120,
    },
  },
  getSessionStats: {
    required: ['action'],
    optional: ['days'],
    validators: {
      action: (value) => value === 'getSessionStats',
      days: (value) => typeof value === 'number' && value > 0 && value <= 30,
    },
  },
  applyTheme: {
    // SECURITY (backend audit): `css` values previously reached
    // overlay.html's `root.style.setProperty(...)` completely unvalidated
    // — any string-typed field of any length, from any operator client.
    // Not script-executable (CSS custom property values aren't parsed as
    // code), but unbounded/malformed values could deface or crash the
    // live projector display mid-service. Each field is capped and
    // restricted to a plausible CSS-value shape.
    required: ['action', 'css'],
    optional: [],
    validators: {
      action: (value) => value === 'applyTheme',
      css: (value) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
        const allowedCssFields = new Set([
          'background',
          'color',
          'accentColor',
          'fontFamily',
          'borderColor',
          'glowColor',
          'shadowColor',
          'particleColor',
          'animation',
        ]);
        for (const [k, v] of Object.entries(value)) {
          if (!allowedCssFields.has(k)) return false;
          if (typeof v !== 'string' || v.length === 0 || v.length > 300) return false;
          // Reject characters with no legitimate use in a CSS value/keyword
          // (blocks stylesheet/selector breakout attempts and control chars).
          // eslint-disable-next-line no-control-regex -- intentional: blocking raw control bytes is the point.
          if (/[{};\\]|[\x00-\x1f]/.test(v)) return false;
        }
        return true;
      },
    },
  },
  // AJOUT (audit backend — Phase 1F, couverture de validation.SCHEMAS) :
  // famille médiathèque — sourcePath/label/triggerPhrases atteignaient
  // mediaLibrary.addItem() (media-library.js) sans aucune borne de type ou
  // de taille avant lui (media-library.js sanitize déjà en profondeur —
  // extension autorisée, tronque triggerPhrases/label — mais seulement
  // APRÈS avoir accepté n'importe quel JSON, y compris des tableaux/objets
  // là où une string est attendue). Valeurs alignées sur les constantes
  // réelles de media-library.js (TRANSITION_STYLES, limites internes).
  addMediaItem: {
    required: ['action', 'sourcePath'],
    optional: [
      'label',
      'triggerPhrases',
      'displayDurationMs',
      'includeInLoop',
      'transitionStyle',
      'setAsPoster',
    ],
    validators: {
      action: (value) => value === 'addMediaItem',
      sourcePath: (value) => typeof value === 'string' && value.length > 0 && value.length <= 1000,
      label: (value) => typeof value === 'string' && value.length <= 200,
      triggerPhrases: (value) =>
        Array.isArray(value) &&
        value.length <= 50 &&
        value.every((p) => typeof p === 'string' && p.length <= 300),
      displayDurationMs: (value) =>
        value === null || (typeof value === 'number' && value > 0 && value <= 3600000),
      includeInLoop: (value) => typeof value === 'boolean',
      transitionStyle: (value) =>
        typeof value === 'string' && ['fade', 'slide', 'zoom', 'cut'].includes(value),
      setAsPoster: (value) => typeof value === 'boolean',
    },
  },
  updateMediaItem: {
    required: ['action', 'id'],
    optional: ['displayDurationMs', 'transitionStyle'],
    validators: {
      action: (value) => value === 'updateMediaItem',
      id: (value) => typeof value === 'string' && value.length > 0 && value.length <= 100,
      displayDurationMs: (value) =>
        value === null || (typeof value === 'number' && value > 0 && value <= 3600000),
      transitionStyle: (value) =>
        typeof value === 'string' && ['fade', 'slide', 'zoom', 'cut'].includes(value),
    },
  },
  deleteMediaItem: {
    required: ['action', 'id'],
    optional: [],
    validators: {
      action: (value) => value === 'deleteMediaItem',
      id: (value) => typeof value === 'string' && value.length > 0 && value.length <= 100,
    },
  },
  // id absent/vide = retire le poster principal sans en désigner un nouveau
  // (voir server.js#setDefaultMediaItem) — donc requis seulement pour 'action'.
  setDefaultMediaItem: {
    required: ['action'],
    optional: ['id'],
    validators: {
      action: (value) => value === 'setDefaultMediaItem',
      id: (value) => typeof value === 'string' && value.length <= 100,
    },
  },
  // AJOUT (audit backend — Phase 1F, 2e lot) : studio de scènes. Comme pour
  // la médiathèque, scene-store.js sanitize déjà en profondeur (bornes par
  // élément, MAX_ELEMENTS_PER_SCENE, etc. — voir scene-store.js) ; ces
  // schémas ferment seulement la porte au niveau FORME (types, pas
  // string/array là où un objet/array est attendu) avant d'y arriver.
  addScene: {
    required: ['action', 'name'],
    optional: ['background', 'elements', 'triggerPhrases'],
    validators: {
      action: (value) => value === 'addScene',
      name: (value) => typeof value === 'string' && value.trim().length > 0 && value.length <= 200,
      background: (value) => isPlainObject(value),
      elements: (value) => Array.isArray(value) && value.length <= 50,
      triggerPhrases: (value) =>
        Array.isArray(value) &&
        value.length <= 50 &&
        value.every((p) => typeof p === 'string' && p.length <= 300),
    },
  },
  updateScene: {
    required: ['action', 'id'],
    optional: ['name', 'background', 'elements', 'triggerPhrases'],
    validators: {
      action: (value) => value === 'updateScene',
      id: (value) => typeof value === 'string' && value.length > 0 && value.length <= 100,
      name: (value) => typeof value === 'string' && value.trim().length > 0 && value.length <= 200,
      background: (value) => isPlainObject(value),
      elements: (value) => Array.isArray(value) && value.length <= 50,
      triggerPhrases: (value) =>
        Array.isArray(value) &&
        value.length <= 50 &&
        value.every((p) => typeof p === 'string' && p.length <= 300),
    },
  },
  deleteScene: {
    required: ['action', 'id'],
    optional: [],
    validators: {
      action: (value) => value === 'deleteScene',
      id: (value) => typeof value === 'string' && value.length > 0 && value.length <= 100,
    },
  },
  triggerScene: {
    required: ['action', 'id'],
    optional: [],
    validators: {
      action: (value) => value === 'triggerScene',
      id: (value) => typeof value === 'string' && value.length > 0 && value.length <= 100,
    },
  },
  hideScene: {
    required: ['action'],
    optional: [],
    validators: {
      action: (value) => value === 'hideScene',
    },
  },
  // id absent/vide = retire la scène par défaut (voir server.js#setDefaultScene).
  setDefaultScene: {
    required: ['action'],
    optional: ['id'],
    validators: {
      action: (value) => value === 'setDefaultScene',
      id: (value) => typeof value === 'string' && value.length <= 100,
    },
  },
  // sourcePath/destPath viennent du sélecteur de fichier natif Electron
  // (main.js#pick-pptx-file / pick-export-zip-path / pick-import-zip-path),
  // jamais un chemin construit librement par l'UI — voir les commentaires
  // dans server.js à côté de ces handlers. Bornes de type/longueur ici,
  // comme pour sourcePath de la médiathèque.
  importPptxSlides: {
    required: ['action', 'sourcePath'],
    optional: [],
    validators: {
      action: (value) => value === 'importPptxSlides',
      sourcePath: (value) => typeof value === 'string' && value.length > 0 && value.length <= 1000,
    },
  },
  exportService: {
    required: ['action', 'destPath'],
    optional: [],
    validators: {
      action: (value) => value === 'exportService',
      destPath: (value) => typeof value === 'string' && value.length > 0 && value.length <= 1000,
    },
  },
  importService: {
    required: ['action', 'sourcePath'],
    optional: [],
    validators: {
      action: (value) => value === 'importService',
      sourcePath: (value) => typeof value === 'string' && value.length > 0 && value.length <= 1000,
    },
  },
  // Bibliothèque de chants — song-library.js sanitize aussi en profondeur
  // (parseSections/MAX_SECTIONS_PER_SONG) ; lyrics plafonné très large ici
  // (aucun sermon/chant légitime ne l'atteint) juste pour éviter un payload
  // JSON abusif avant même d'atteindre ce parsing.
  addSong: {
    required: ['action', 'title'],
    optional: ['artist', 'lyrics', 'triggerPhrases'],
    validators: {
      action: (value) => value === 'addSong',
      title: (value) => typeof value === 'string' && value.trim().length > 0 && value.length <= 200,
      artist: (value) => typeof value === 'string' && value.length <= 200,
      lyrics: (value) => typeof value === 'string' && value.length <= 50000,
      triggerPhrases: (value) =>
        Array.isArray(value) &&
        value.length <= 50 &&
        value.every((p) => typeof p === 'string' && p.length <= 300),
    },
  },
  deleteSong: {
    required: ['action', 'id'],
    optional: [],
    validators: {
      action: (value) => value === 'deleteSong',
      id: (value) => typeof value === 'string' && value.length > 0 && value.length <= 100,
    },
  },
  showSongSection: {
    required: ['action', 'id'],
    optional: ['sectionIndex'],
    validators: {
      action: (value) => value === 'showSongSection',
      id: (value) => typeof value === 'string' && value.length > 0 && value.length <= 100,
      sectionIndex: (value) => Number.isInteger(value) && value >= 0 && value <= 200,
    },
  },
  // AJOUT (audit backend — Phase 1F, 3e lot) : mode confiance (Partie 2 —
  // auto/semi-auto/manuel, voir session-state.js#TRUST_MODES).
  setTrustMode: {
    required: ['action', 'mode'],
    optional: [],
    validators: {
      action: (value) => value === 'setTrustMode',
      mode: (value) => ['auto', 'semi-auto', 'manual'].includes(value),
    },
  },
  confirmPendingVerse: {
    required: ['action'],
    optional: [],
    validators: { action: (value) => value === 'confirmPendingVerse' },
  },
  dismissPendingVerse: {
    required: ['action'],
    optional: [],
    validators: { action: (value) => value === 'dismissPendingVerse' },
  },
  // Feuille de route / cue-list — bornes alignées sur rundown-store.js
  // (CUE_TYPES, MAX_LABEL_LENGTH) ; ce module sanitize aussi label/reference
  // en profondeur, comme pour la médiathèque et le studio de scènes.
  addRundownCue: {
    required: ['action', 'type', 'label'],
    optional: ['reference', 'mediaId', 'sceneId'],
    validators: {
      action: (value) => value === 'addRundownCue',
      type: (value) => ['verse', 'media', 'scene'].includes(value),
      label: (value) => typeof value === 'string' && value.trim().length > 0 && value.length <= 200,
      reference: (value) => typeof value === 'string' && value.length > 0 && value.length <= 200,
      mediaId: (value) => typeof value === 'string' && value.length > 0 && value.length <= 100,
      sceneId: (value) => typeof value === 'string' && value.length > 0 && value.length <= 100,
    },
  },
  removeRundownCue: {
    required: ['action', 'id'],
    optional: [],
    validators: {
      action: (value) => value === 'removeRundownCue',
      id: (value) => typeof value === 'string' && value.length > 0 && value.length <= 100,
    },
  },
  reorderRundownCues: {
    required: ['action', 'orderedIds'],
    optional: [],
    validators: {
      action: (value) => value === 'reorderRundownCues',
      orderedIds: (value) =>
        Array.isArray(value) &&
        value.length <= 200 &&
        value.every((id) => typeof id === 'string' && id.length <= 100),
    },
  },
  clearRundown: {
    required: ['action'],
    optional: [],
    validators: { action: (value) => value === 'clearRundown' },
  },
  triggerRundownCue: {
    required: ['action', 'id'],
    optional: [],
    validators: {
      action: (value) => value === 'triggerRundownCue',
      id: (value) => typeof value === 'string' && value.length > 0 && value.length <= 100,
    },
  },
  nextRundownCue: {
    required: ['action'],
    optional: [],
    validators: { action: (value) => value === 'nextRundownCue' },
  },
  // Caméras IP — ip-camera-store.js valide déjà url via URL_PATTERN ; ces
  // bornes ferment seulement la porte au niveau type/longueur avant lui.
  addIpCamera: {
    required: ['action', 'label', 'url'],
    optional: [],
    validators: {
      action: (value) => value === 'addIpCamera',
      label: (value) => typeof value === 'string' && value.trim().length > 0 && value.length <= 200,
      url: (value) => typeof value === 'string' && value.length > 0 && value.length <= 500,
    },
  },
  deleteIpCamera: {
    required: ['action', 'id'],
    optional: [],
    validators: {
      action: (value) => value === 'deleteIpCamera',
      id: (value) => typeof value === 'string' && value.length > 0 && value.length <= 100,
    },
  },
  generateCameraPairing: {
    required: ['action'],
    optional: [],
    validators: { action: (value) => value === 'generateCameraPairing' },
  },
  // AJOUT (audit backend — Phase 1F, 4e lot) : habillage caméra
  // (branding-store.js — sourcePath même sélecteur natif que la
  // médiathèque ; position/size ont déjà un repli silencieux vers une
  // valeur par défaut côté store si la valeur est inconnue, mais un client
  // qui envoie une valeur invalide mérite une erreur claire plutôt qu'un
  // "ça n'a rien fait" silencieux — même logique que setLanguage/setTrustMode).
  setBrandingLogo: {
    required: ['action', 'sourcePath'],
    optional: [],
    validators: {
      action: (value) => value === 'setBrandingLogo',
      sourcePath: (value) => typeof value === 'string' && value.length > 0 && value.length <= 1000,
    },
  },
  clearBrandingLogo: {
    required: ['action'],
    optional: [],
    validators: { action: (value) => value === 'clearBrandingLogo' },
  },
  setBrandingPosition: {
    required: ['action', 'position'],
    optional: [],
    validators: {
      action: (value) => value === 'setBrandingPosition',
      position: (value) => ['top-left', 'top-right', 'bottom-left', 'bottom-right'].includes(value),
    },
  },
  setBrandingSize: {
    required: ['action', 'size'],
    optional: [],
    validators: {
      action: (value) => value === 'setBrandingSize',
      size: (value) => ['small', 'medium', 'large'].includes(value),
    },
  },
  setBrandingText: {
    required: ['action'],
    optional: ['title', 'subtitle'],
    validators: {
      action: (value) => value === 'setBrandingText',
      title: (value) => typeof value === 'string' && value.length <= 120,
      subtitle: (value) => typeof value === 'string' && value.length <= 160,
    },
  },
  setBrandingVisible: {
    required: ['action', 'visible'],
    optional: [],
    validators: {
      action: (value) => value === 'setBrandingVisible',
      visible: (value) => typeof value === 'boolean',
    },
  },
  // Identité de marque du tableau de bord — bornes alignées sur
  // dashboard-branding-store.js (MAX_ORG_NAME_LENGTH, HEX_COLOR_RE).
  setDashboardOrgName: {
    required: ['action', 'organizationName'],
    optional: [],
    validators: {
      action: (value) => value === 'setDashboardOrgName',
      organizationName: (value) => typeof value === 'string' && value.length <= 60,
    },
  },
  setDashboardAccentColor: {
    required: ['action', 'accentColor'],
    optional: [],
    validators: {
      action: (value) => value === 'setDashboardAccentColor',
      accentColor: (value) => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value),
    },
  },
  setDashboardLogo: {
    required: ['action', 'sourcePath'],
    optional: [],
    validators: {
      action: (value) => value === 'setDashboardLogo',
      sourcePath: (value) => typeof value === 'string' && value.length > 0 && value.length <= 1000,
    },
  },
  clearDashboardLogo: {
    required: ['action'],
    optional: [],
    validators: { action: (value) => value === 'clearDashboardLogo' },
  },
};

/**
 * Un objet JSON "plain" (pas un tableau, pas null) — utilisé pour les
 * champs structurés (background de scène, etc.) où la forme détaillée est
 * déjà validée plus loin (scene-store.js) : on ferme seulement la porte au
 * niveau type ici (pas de string/array/number là où un objet est attendu).
 * @param {*} value
 * @returns {boolean}
 */
function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

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
  SCHEMAS,
};
