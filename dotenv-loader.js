'use strict';
/**
 * dotenv-loader.js — Chargement minimal de fichiers .env, sans dépendance
 *
 * CORRECTIF CRITIQUE (transcription qui ne démarre jamais malgré des clés
 * API renouvelées, visualiseur audio qui ne bouge pas) : main.js ne
 * chargeait jamais .env dans process.env avant de démarrer le worker
 * server.js — seul `npm run server-only` (mode développement, via le flag
 * Node --env-file-if-exists) le faisait. L'app Electron réelle démarrait
 * donc TOUJOURS avec les seules variables d'environnement déjà présentes
 * dans le process (celles de l'OS, quasiment jamais celles d'un .env de
 * projet) — chaque réglage placé dans .env (MIC_SILENCE_THRESHOLD, PORT
 * personnalisé, WS_HOST...) était silencieusement ignoré par l'app réelle.
 *
 * Extrait dans son propre module (sans require('electron')) pour être
 * testable en Node pur — voir test/test-dotenv-loader.js.
 */

const fs = require('fs');

/**
 * Analyse le contenu texte d'un fichier .env et ajoute chaque paire
 * clé=valeur dans targetEnv — SANS écraser une clé déjà présente (une
 * vraie variable d'environnement système reste toujours prioritaire).
 * @param {string} raw - contenu texte du fichier .env
 * @param {object} targetEnv - objet à enrichir (typiquement process.env)
 */
function parseEnvContent(raw, targetEnv) {
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key && !(key in targetEnv)) {
      targetEnv[key] = value;
    }
  }
}

/**
 * Cherche un fichier .env parmi candidatePaths (dans l'ordre) et charge le
 * PREMIER trouvé dans targetEnv. Ne fusionne jamais plusieurs fichiers.
 * @param {object} targetEnv - objet à enrichir (typiquement process.env)
 * @param {string[]} candidatePaths - chemins à essayer, dans l'ordre
 * @param {(msg: string) => void} [onLoaded] - callback appelé avec le
 *   chemin du fichier effectivement chargé (pour logger)
 * @returns {string|null} le chemin chargé, ou null si aucun fichier trouvé
 */
function loadDotEnvInto(targetEnv, candidatePaths, onLoaded) {
  for (const envPath of candidatePaths) {
    let raw;
    try {
      raw = fs.readFileSync(envPath, 'utf8');
    } catch (_e) {
      continue; // fichier absent à cet emplacement : on essaie le suivant
    }
    parseEnvContent(raw, targetEnv);
    if (onLoaded) onLoaded(envPath);
    return envPath;
  }
  return null;
}

module.exports = { parseEnvContent, loadDotEnvInto };
