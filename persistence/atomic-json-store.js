'use strict';
/**
 * ============================================================================
 *  persistence/atomic-json-store.js — écriture JSON atomique partagée
 * ----------------------------------------------------------------------------
 *  Généralise le pattern déjà utilisé par features-store.js (seul store à
 *  écrire en tmp+rename avant ce module — tous les autres, media-library.js/
 *  scene-store.js/rundown-store.js/song-library.js/sermon-archive.js/
 *  branding-store.js/dashboard-branding-store.js/ip-camera-store.js,
 *  écrivaient directement fs.writeFileSync() sur le fichier final : un crash
 *  pendant l'écriture pouvait y laisser un JSON tronqué, relu comme corrompu
 *  au prochain démarrage — voir la récupération par défaut déjà présente
 *  dans chacun de ces stores, JSON.parse() en échec -> repli silencieux sur
 *  un index vide).
 *
 *  CORRECTIF par rapport au pattern features-store.js d'origine : celui-ci
 *  utilisait un suffixe `.tmp` fixe — deux écritures rapprochées du MÊME
 *  fichier (ex. glisser-déposer qui réordonne puis affine l'ordre) pouvaient
 *  donc se marcher dessus sur le même fichier temporaire. Suffixe
 *  aléatoire ici (PID + compteur) pour que deux écritures concurrentes du
 *  même store ne collisionnent jamais sur le même chemin temporaire.
 *
 *  N'écrit JAMAIS directement — writeJsonAtomic() est le seul point d'écriture
 *  que chaque store doit appeler depuis sa propre fonction writeIndex/
 *  writeConfig/writeArchive, qui garde son nom et sa signature actuels (ce
 *  module ne change aucune API publique de store, seulement leur
 *  implémentation interne).
 *
 *  Lève en cas d'échec (comme fs.writeFileSync/fs.renameSync le faisaient
 *  déjà) plutôt que de retourner un {ok,error} : chaque appelant existant
 *  (main.js, theme-loader.js, les handlers WS de server.js) gère déjà cette
 *  erreur exactement comme avant — aucun site d'appel n'a besoin de changer.
 *
 *  Écrit via open/write/fsync/close explicites (pas le raccourci
 *  fs.writeFileSync) pour forcer les données sur le disque physique avant le
 *  rename — writeFileSync ferme le descripteur mais ne garantit pas que le
 *  cache d'écriture de l'OS a été vidé ; un rename juste après protège contre
 *  un crash DE L'APPLICATION mais pas contre une coupure de courant si les
 *  données n'ont pas encore quitté le cache. Le fichier temporaire est
 *  toujours nettoyé si une étape échoue avant le rename, pour ne jamais
 *  laisser de `.tmp` orphelin dans le dossier userData.
 * ============================================================================
 */

const fs = require('fs');
const path = require('path');
const process = require('process');

let tmpCounter = 0;

/**
 * Écrit `data` (déjà sérialisable) en JSON dans `targetPath`, de façon
 * atomique (fichier temporaire unique, fsync, puis rename).
 *
 * @param {string} targetPath - chemin final du fichier JSON
 * @param {*} data - valeur à sérialiser (JSON.stringify, indenté)
 */
function writeJsonAtomic(targetPath, data) {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const tmpPath = `${targetPath}.${process.pid}-${tmpCounter++}.tmp`;
  const json = JSON.stringify(data, null, 2);

  let fd;
  try {
    fd = fs.openSync(tmpPath, 'w');
    fs.writeSync(fd, json, 0, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmpPath, targetPath);
  } catch (err) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch (_closeErr) {
        /* déjà en échec, ne masque pas l'erreur d'origine */
      }
    }
    try {
      fs.unlinkSync(tmpPath);
    } catch (_unlinkErr) {
      /* rien à nettoyer si le tmp n'a jamais été créé — pas une erreur */
    }
    throw err;
  }
}

module.exports = { writeJsonAtomic };
