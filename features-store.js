'use strict';
/**
 * ============================================================================
 *  features-store.js — Lecture/écriture de config/features.json
 * ----------------------------------------------------------------------------
 *  CORRECTIF (audit round 5) : theme-loader.js et main.js écrivaient
 *  directement dans <app>/config/features.json (thème actif, config OBS).
 *  Dans l'app packagée (electron-builder, asar: true), ce fichier vit à
 *  l'intérieur de app.asar, une archive EN LECTURE SEULE : tout
 *  fs.writeFileSync() y échoue (ENOTDIR/EACCES). Concrètement, chez un
 *  utilisateur installé via le .exe, changer de thème ou enregistrer la
 *  config OBS depuis le tableau de bord échouait systématiquement — alors
 *  que tout fonctionnait en développement (`npm start`, fichiers sur disque).
 *
 *  Ce module sépare donc :
 *    - la config LIVRÉE avec l'app (config/features.json, lecture seule) ;
 *    - les MODIFICATIONS de l'utilisateur, écrites dans un fichier
 *      features.json du dossier userData d'Electron (toujours inscriptible).
 *  La lecture fusionne les deux (l'utilisateur l'emporte), donc une nouvelle
 *  version de l'app peut ajouter des clés par défaut sans écraser les choix
 *  déjà faits.
 *
 *  Sans setUserDataDir() (tests, `node server.js` standalone), le
 *  comportement historique est conservé : tout se lit/écrit dans
 *  config/features.json.
 * ============================================================================
 */

const fs = require('fs');
const path = require('path');

const BUILTIN_FILE = path.join(__dirname, 'config', 'features.json');

let userFile = null;

/** @param {string} dir - dossier inscriptible (app.getPath('userData')) */
function setUserDataDir(dir) {
  userFile = dir ? path.join(dir, 'features.json') : null;
}

function getWritableFile() {
  return userFile || BUILTIN_FILE;
}

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(`[features-store] ${file} illisible, ignoré (${err.message}).`);
    }
    return null;
  }
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function deepMerge(base, override) {
  const out = { ...base };
  for (const [key, value] of Object.entries(override)) {
    out[key] = isPlainObject(value) && isPlainObject(base[key]) ? deepMerge(base[key], value) : value;
  }
  return out;
}

/** Config effective = valeurs livrées + surcharges utilisateur. */
function readFeatures() {
  const builtin = readJsonFile(BUILTIN_FILE) || {};
  if (!userFile) return builtin;
  const override = readJsonFile(userFile);
  return override ? deepMerge(builtin, override) : builtin;
}

/**
 * Écrit la config complète dans le fichier inscriptible (userData si
 * configuré, sinon config/features.json). Écriture atomique (tmp + rename)
 * pour ne jamais laisser un JSON à moitié écrit derrière un crash.
 */
function writeFeatures(features) {
  const target = getWritableFile();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(features, null, 2), 'utf8');
  fs.renameSync(tmp, target);
}

module.exports = { setUserDataDir, readFeatures, writeFeatures, getWritableFile };
