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
    errorMessage: 'PORT doit être un nombre entre 1 et 65535'
  },
  AUDIO_DEVICE: {
    type: 'string',
    required: false,
    default: '',
    validate: (value) => typeof value === 'string',
    errorMessage: 'AUDIO_DEVICE doit être une chaîne de caractères'
  },
  NODE_ENV: {
    type: 'string',
    required: false,
    default: 'development',
    validate: (value) => ['development', 'production', 'test'].includes(value),
    errorMessage: 'NODE_ENV doit être development, production ou test'
  }
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

  for (const [name, schema] of Object.entries(ENV_SCHEMA)) {
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
    config
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
  console.log('[config-validator] Validation des variables d\'environnement...');
  const envValidation = validateEnvironment();
  if (!envValidation.valid) {
    errors.push(...envValidation.errors);
  }
  console.log('[config-validator] Variables d\'environnement validées');

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
      "repli si Groq échoue ou est indisponible."
    );
  }

  // 3. Capture audio native (getUserMedia)
  // CORRECTIF (v0.5.0) : la capture micro passe désormais par une fenêtre
  // Electron cachée (voir main.js/capture.html) — elle n'existe QUE dans
  // l'app packagée/lancée via Electron. En usage standalone
  // (`node server.js` / `npm run server-only`), il n'y a plus aucun
  // contexte Chromium pour appeler getUserMedia : la capture audio est
  // indisponible dans ce mode, contrairement à avant (FFmpeg tournait
  // sans Electron). Ce n'est pas un bug de ce module — c'est une
  // conséquence de l'architecture — mais mieux vaut le dire clairement
  // au démarrage plutôt que de laisser le pipeline tourner à vide.
  if (!process.workerData && !process.env.APP_ROOT) {
    warnings.push(
      "Capture audio : ce processus semble démarré hors de l'app Electron " +
      "(node server.js direct). La capture micro native (getUserMedia) a " +
      "besoin d'une fenêtre Chromium fournie par Electron et ne fonctionnera " +
      "pas dans ce mode — utilisez l'application ChurchOverlay packagée."
    );
  }
  if (envValidation.config.AUDIO_DEVICE) {
    console.log('[config-validator] Périphérique audio configuré:', envValidation.config.AUDIO_DEVICE);
  } else {
    warnings.push(
      "Aucun périphérique audio configuré (AUDIO_DEVICE) : un micro sera " +
      "détecté et présélectionné automatiquement depuis l'écran de " +
      "configuration (setup.html)."
    );
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    config: envValidation.config
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
    result.errors.forEach(error => console.log(`  - ${error}`));
  }

  if (result.warnings.length > 0) {
    console.log('\nAvertissements:');
    result.warnings.forEach(warning => console.log(`  - ${warning}`));
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
  ENV_SCHEMA
};
