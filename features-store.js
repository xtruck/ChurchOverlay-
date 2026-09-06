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
const { writeJsonAtomic } = require('./persistence/atomic-json-store');

const BUILTIN_FILE = path.join(__dirname, 'config', 'features.json');

let userFile = null;

// CORRECTIF (audit performance) : readFeatures() est appelée depuis TOUT le
// pipeline d'affichage (getVerseDurationMs() seul l'appelle depuis 7+ sites
// différents, à chaque verset affiché) et refaisait jusqu'ici DEUX
// fs.readFileSync()+JSON.parse() synchrones à CHAQUE appel — un I/O disque
// redondant sur le chemin critique de latence, alors que le contenu ne
// change qu'aux appels de writeFeatures() (ou setUserDataDir(), qui change
// QUEL fichier utilisateur est lu). Invalidée sur ces deux seuls événements
// — tous les points d'écriture passent par writeFeatures() (vérifié : aucun
// fs.writeFileSync direct sur ces fichiers ailleurs dans le code).
let cachedFeatures = null;

/** @param {string} dir - dossier inscriptible (app.getPath('userData')) */
function setUserDataDir(dir) {
  userFile = dir ? path.join(dir, 'features.json') : null;
  cachedFeatures = null;
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
    out[key] =
      isPlainObject(value) && isPlainObject(base[key]) ? deepMerge(base[key], value) : value;
  }
  return out;
}

/**
 * Config effective = valeurs livrées + surcharges utilisateur.
 *
 * CORRECTIF (mutation directe déjà présente dans le code) : theme-loader.js
 * #setActiveTheme() fait `const features = readFeatures(); features.design
 * = ...; writeFeatures(features)` — une mutation en place de l'objet
 * renvoyé, sûre tant que chaque appel produisait un objet fraîchement
 * désérialisé (jamais partagé). Avec le cache ci-dessus, renvoyer
 * directement l'objet mis en cache exposerait CETTE mutation (et toute
 * autre du même genre, présente ou future) au cache lui-même, corrompant
 * silencieusement ce que tous les appelants suivants liraient jusqu'à la
 * prochaine écriture. structuredClone() sur chaque appel élimine ce risque
 * tout en gardant le seul gain recherché : éviter la lecture disque +
 * JSON.parse répétée, largement plus coûteuse qu'un clone en mémoire d'un
 * petit objet de config.
 */
function readFeatures() {
  if (cachedFeatures) return structuredClone(cachedFeatures);
  const builtin = readJsonFile(BUILTIN_FILE) || {};
  let result = builtin;
  if (userFile) {
    const override = readJsonFile(userFile);
    if (override) result = deepMerge(builtin, override);
  }
  cachedFeatures = result;
  return structuredClone(result);
}

/**
 * Écrit la config complète dans le fichier inscriptible (userData si
 * configuré, sinon config/features.json). Écriture atomique (voir
 * persistence/atomic-json-store.js — même module partagé maintenant utilisé
 * par tous les autres stores JSON) pour ne jamais laisser un JSON à moitié
 * écrit derrière un crash.
 */
function writeFeatures(features) {
  writeJsonAtomic(getWritableFile(), features);
  cachedFeatures = null;
}

module.exports = { setUserDataDir, readFeatures, writeFeatures, getWritableFile };
