/**
 * ============================================================================
 *  config-validator.js — Module de validation de la configuration
 * ----------------------------------------------------------------------------
 *  Valide les variables d'environnement et la configuration au démarrage
 * ============================================================================
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

/**
 * Schémas de validation pour les variables d'environnement
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
  FFMPEG_PATH: {
    type: 'string',
    required: false,
    default: 'ffmpeg',
    validate: (value) => typeof value === 'string' && value.length > 0,
    errorMessage: 'FFMPEG_PATH doit être un chemin valide non vide'
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
 * Vérifie si FFmpeg est disponible
 * @param {string} ffmpegPath - Chemin vers FFmpeg
 * @returns {Promise<Object>} - { available: boolean, error: string|null }
 */
async function checkFFmpeg(ffmpegPath = 'ffmpeg') {
  return new Promise((resolve) => {
    const ffmpegCheck = spawn(ffmpegPath, ['-version']);
    
    ffmpegCheck.on('error', () => {
      resolve({ available: false, error: `FFmpeg non trouvé: ${ffmpegPath}` });
    });
    
    ffmpegCheck.on('close', (code) => {
      if (code !== 0) {
        resolve({ available: false, error: `FFmpeg a retourné un code d'erreur: ${code}` });
      } else {
        resolve({ available: true, error: null });
      }
    });
    
    // Timeout après 5 secondes
    setTimeout(() => {
      ffmpegCheck.kill();
      resolve({ available: false, error: 'Timeout lors de la vérification de FFmpeg' });
    }, 5000);
  });
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

  // 2. Vérifier FFmpeg
  console.log('[config-validator] Vérification de FFmpeg...');
  const ffmpegPath = envValidation.config.FFMPEG_PATH || 'ffmpeg';
  const ffmpegCheck = await checkFFmpeg(ffmpegPath);
  if (!ffmpegCheck.available) {
    warnings.push(`FFmpeg n'est pas disponible: ${ffmpegCheck.error}. La capture audio sera désactivée.`);
  } else {
    console.log('[config-validator] FFmpeg est disponible');
  }

  // 3. Vérifier les fichiers requis
  console.log('[config-validator] Vérification des fichiers requis...');
  
  const whisperServerPath = path.join(__dirname, 'whisper', 'whisper-server.exe');
  const whisperServerCheck = checkFileExists(whisperServerPath);
  if (!whisperServerCheck.exists) {
    warnings.push('whisper-server.exe non trouvé. La transcription sera désactivée.');
  } else {
    console.log('[config-validator] whisper-server.exe trouvé');
  }

  const modelPath = path.join(__dirname, 'whisper', 'models', 'ggml-tiny.bin');
  const modelCheck = checkFileExists(modelPath);
  if (!modelCheck.exists) {
    warnings.push('Modèle Whisper non trouvé. La transcription sera désactivée.');
  } else {
    console.log('[config-validator] Modèle Whisper trouvé');
  }

  // 4. Vérifier le périphérique audio si FFmpeg est disponible
  if (ffmpegCheck.available && envValidation.config.AUDIO_DEVICE) {
    console.log('[config-validator] Périphérique audio configuré:', envValidation.config.AUDIO_DEVICE);
  } else if (ffmpegCheck.available) {
    warnings.push('Aucun périphérique audio configuré (AUDIO_DEVICE). La capture audio sera désactivée.');
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
  checkFFmpeg,
  checkFileExists,
  validateSystemConfig,
  displayValidationResults,
  ENV_SCHEMA
};