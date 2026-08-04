/**
 * ============================================================================
 *  config-validator.js — Module de validation de la configuration
 * ----------------------------------------------------------------------------
 *  Valide les variables d'environnement et la configuration au démarrage
 *
 *  CORRECTIF CRITIQUE : ce fichier contenait par erreur le code du test
 *  (test/test-config-validator.js) au lieu du vrai module — server.js
 *  plantait dès le démarrage car validateSystemConfig/displayValidationResults
 *  n'existaient plus. Restauré ici, ET nettoyé de toute référence à FFmpeg
 *  (capture audio désormais native via getUserMedia dans dashboard.html/
 *  setup.html, voir audio-capture.js).
 *
 *  CORRECTIF (audit round 4) : ce fichier référençait encore capture.html /
 *  capture-preload.js, des fichiers orphelins d'une architecture antérieure
 *  (fenêtre Electron cachée dédiée à la capture) jamais reliés à main.js et
 *  absents de package.json > build.files — donc jamais empaquetés. La
 *  capture réelle passe par getUserMedia directement dans dashboard.html et
 *  setup.html (fenêtres visibles), qui poussent des chunks PCM à main.js via
 *  le canal IPC 'audio-pcm-chunk'. Les deux fichiers orphelins ont été
 *  supprimés du dépôt ; les commentaires ci-dessous sont corrigés en
 *  conséquence.
 * ============================================================================
 */

'use strict';

const fs = require('fs');

/**
 * Schémas de validation pour les variables d'environnement
 * NOTE : FFMPEG_PATH a été retiré (plus de binaire externe à configurer,
 * la capture micro passe par getUserMedia dans une fenêtre Electron cachée).
 */
const ENV_SCHEMA = {
  PORT: {
    type: 'number',
    required: false,
    default: 8765,
    validate: (value) => value > 0 && value < 65536,
    errorMessage: 'PORT doit être un nombre entre 1 et 65535',
  },
  NODE_ENV: {
    type: 'string',
    required: false,
    default: 'development',
    validate: (value) => ['development', 'production', 'test'].includes(value),
    errorMessage: 'NODE_ENV doit être development, production ou test',
  },
  WS_HOST: {
    type: 'string',
    required: false,
    default: '127.0.0.1',
    validate: (value) => typeof value === 'string' && value.trim().length > 0,
    errorMessage: 'WS_HOST doit être une adresse non vide (ex: 127.0.0.1)',
  },
  MAX_CONNECTIONS: {
    type: 'number',
    required: false,
    default: 10,
    validate: (value) => value > 0 && value <= 1000,
    errorMessage: 'MAX_CONNECTIONS doit être un nombre entre 1 et 1000',
  },
  MAX_MESSAGES_PER_MINUTE: {
    type: 'number',
    required: false,
    default: 60,
    validate: (value) => value > 0 && value <= 10000,
    errorMessage: 'MAX_MESSAGES_PER_MINUTE doit être un nombre entre 1 et 10000',
  },
  // CORRECTIF (checklist mise en production, point 1) : jeton partagé exigé
  // pour ouvrir une connexion WebSocket (voir server.js, wss.on('connection')).
  // Pas de contrainte de format : c'est un secret opaque, comparé tel quel.
  // Pas de valeur par défaut : si absent, l'authentification WS reste
  // désactivée (comportement historique, avec avertissement — voir
  // validateSystemConfig ci-dessous).
  WS_AUTH_TOKEN: {
    type: 'string',
    required: false,
    default: undefined,
    validate: (value) => typeof value === 'string' && value.trim().length > 0,
    errorMessage: "WS_AUTH_TOKEN ne doit pas être une chaîne vide ou composée uniquement d'espaces",
  },
  // SECURITY (backend audit) : jeton distinct pour les clients en lecture
  // seule (overlay affiché dans OBS). Avant, l'overlay se connectait avec
  // WS_AUTH_TOKEN — le même jeton "plein pouvoir" que le tableau de bord —
  // donc toute fuite de l'URL overlay (collée dans OBS comme Browser
  // Source, exportable avec une scène OBS) donnait un contrôle opérateur
  // complet, pas un accès lecture seule.
  WS_VIEWER_TOKEN: {
    type: 'string',
    required: false,
    default: undefined,
    validate: (value) => typeof value === 'string' && value.trim().length > 0,
    errorMessage:
      "WS_VIEWER_TOKEN ne doit pas être une chaîne vide ou composée uniquement d'espaces",
  },
};

/**
 * Valide une variable d'environnement
 * @param {string} name - Nom de la variable
 * @param {string} value - Valeur de la variable
 * @returns {Object} - { valid: boolean, error: string|null, parsedValue: any }
 */
function validateEnvVar(name, value) {
  const schema = ENV_SCHEMA[name];
  if (!schema) {
    // Variable non reconnue, on l'accepte mais on ne la valide pas
    return { valid: true, error: null, parsedValue: value };
  }

  // Si la variable n'est pas définie et n'est pas requise
  if (value === undefined || value === null || value === '') {
    if (schema.required) {
      return { valid: false, error: `${name} est requis`, parsedValue: null };
    }
    return { valid: true, error: null, parsedValue: schema.default };
  }

  // Conversion selon le type
  let parsedValue = value;
  if (schema.type === 'number') {
    parsedValue = Number(value);
    if (isNaN(parsedValue)) {
      return { valid: false, error: `${name} doit être un nombre`, parsedValue: null };
    }
  }

  // Validation personnalisée
  if (schema.validate && !schema.validate(parsedValue)) {
    return { valid: false, error: schema.errorMessage, parsedValue: null };
  }

  return { valid: true, error: null, parsedValue };
}

/**
 * Valide toutes les variables d'environnement
 * @returns {Object} - { valid: boolean, errors: Array, config: Object }
 */
function validateEnvironment() {
  const errors = [];
  const config = {};

  for (const name of Object.keys(ENV_SCHEMA)) {
    const value = process.env[name];
    const validation = validateEnvVar(name, value);

    if (!validation.valid) {
      errors.push(validation.error);
    } else {
      config[name] = validation.parsedValue;
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    config,
  };
}

/**
 * Vérifie si un fichier existe
 * @param {string} filePath - Chemin du fichier
 * @returns {Object} - { exists: boolean, error: string|null }
 */
function checkFileExists(filePath) {
  try {
    const exists = fs.existsSync(filePath);
    return { exists, error: null };
  } catch (error) {
    return { exists: false, error: `Erreur lors de la vérification du fichier: ${error.message}` };
  }
}

/**
 * Valide la configuration complète du système
 * @returns {Promise<Object>} - { valid: boolean, errors: Array, warnings: Array }
 */
async function validateSystemConfig() {
  const errors = [];
  const warnings = [];

  // 1. Valider les variables d'environnement
  console.log("[config-validator] Validation des variables d'environnement...");
  const envValidation = validateEnvironment();
  if (!envValidation.valid) {
    errors.push(...envValidation.errors);
  }
  console.log("[config-validator] Variables d'environnement validées");

  // 2. Clés de transcription cloud (aucun filet local depuis la suppression
  // de Whisper — Groq est désormais le seul fournisseur obligatoire)
  if (!process.env.GROQ_API_KEY) {
    warnings.push(
      "GROQ_API_KEY n'est pas défini. Aucun fournisseur de transcription " +
        "principal n'est configuré : la détection automatique de versets ne " +
        "fonctionnera pas tant que cette clé n'est pas renseignée (voir .env.example)."
    );
  }
  if (!process.env.DEEPGRAM_API_KEY) {
    warnings.push(
      "DEEPGRAM_API_KEY n'est pas défini (optionnel) : pas de fournisseur de " +
        'repli si Groq échoue ou est indisponible.'
    );
  }

  // 2bis. Authentification WebSocket (checklist mise en production, point 1)
  if (!process.env.WS_AUTH_TOKEN) {
    warnings.push(
      "WS_AUTH_TOKEN n'est pas défini : le serveur WebSocket accepte toute " +
        'connexion sans authentification. Sans risque tant que WS_HOST=127.0.0.1 ' +
        '(par défaut) — server.js refuse désormais de démarrer sur un WS_HOST ' +
        'non local sans ce jeton (voir README.md).'
    );
  } else if (!process.env.WS_VIEWER_TOKEN) {
    warnings.push(
      "WS_VIEWER_TOKEN n'est pas défini : l'overlay OBS devra utiliser le " +
        'jeton opérateur (WS_AUTH_TOKEN) pour se connecter, ce qui lui donne ' +
        "un contrôle complet du pipeline au lieu d'un accès lecture seule. " +
        'Définir WS_VIEWER_TOKEN (≥16 caractères, différent de WS_AUTH_TOKEN) ' +
        'pour un vrai cloisonnement — voir README.md.'
    );
  }

  // 3. Capture audio native (getUserMedia)
  // La capture micro se fait directement dans les fenêtres visibles
  // dashboard.html / setup.html (getUserMedia), qui poussent les chunks PCM
  // à main.js via IPC ('audio-pcm-chunk') — voir audio-capture.js. Il n'y a
  // plus de fenêtre Electron cachée dédiée ni de sélection de périphérique
  // par variable d'environnement : le micro est choisi depuis l'écran de
  // configuration (setup.html). En usage standalone (`node server.js` /
  // `npm run server-only`), il n'y a aucun contexte Chromium disponible :
  // la capture audio est indisponible dans ce mode.
  if (!process.workerData && !process.env.APP_ROOT) {
    warnings.push(
      "Capture audio : ce processus semble démarré hors de l'app Electron " +
        '(node server.js direct). La capture micro native (getUserMedia) a ' +
        "besoin d'une fenêtre Chromium fournie par Electron et ne fonctionnera " +
        "pas dans ce mode — utilisez l'application ChurchOverlay packagée."
    );
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    config: envValidation.config,
  };
}

/**
 * Affiche les résultats de validation
 * @param {Object} result - Résultat de validateSystemConfig
 */
function displayValidationResults(result) {
  console.log('\n=== Résultats de la validation ===');

  if (result.valid) {
    console.log('✓ Configuration valide');
  } else {
    console.log('✗ Configuration invalide');
  }

  if (result.errors.length > 0) {
    console.log('\nErreurs:');
    result.errors.forEach((error) => console.log(`  - ${error}`));
  }

  if (result.warnings.length > 0) {
    console.log('\nAvertissements:');
    result.warnings.forEach((warning) => console.log(`  - ${warning}`));
  }

  if (result.errors.length === 0 && result.warnings.length === 0) {
    console.log('\n✓ Tout est correctement configuré');
  }

  console.log('================================\n');
}

module.exports = {
  validateEnvVar,
  validateEnvironment,
  checkFileExists,
  validateSystemConfig,
  displayValidationResults,
  ENV_SCHEMA,
};
