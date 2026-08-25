/**
 * ============================================================================
 * service-export.js — Export "service portable" (Partie 7.1.2, EXPORT
 * uniquement — voir la note de portée en bas de fichier)
 * ----------------------------------------------------------------------------
 * Un seul fichier .zip contenant : un manifest.json (feuille de route +
 * scènes + chants + médiathèque, tels que renvoyés par les stores existants)
 * ET les fichiers médias RÉELLEMENT référencés (photos/vidéos) — pas
 * seulement leurs métadonnées, contrairement à un export JSON seul qui ne
 * tiendrait pas la promesse "médias compris".
 *
 * Écrit en streaming, jamais un média entier en mémoire (le document mission
 * mentionne explicitement des vidéos de 1 Go+) : chaque entrée fichier est
 * stockée en méthode STORED (les médias sont déjà compressés — DEFLATE ne
 * gagnerait rien et coûterait du CPU) et utilise un "data descriptor" après
 * les données (flag ZIP 0x0008, standard — voir l'annexe ZIP/PKWARE §4.3.9)
 * plutôt que d'écrire crc32/tailles dans l'en-tête local : ainsi jamais
 * besoin de revenir en arrière (seek) dans le flux de sortie une fois la
 * taille/le CRC32 connus, qui ne le sont qu'après avoir lu tout le fichier.
 * Le lecteur ZIP existant (pptx-importer.js#readZipEntries) lit déjà les
 * tailles/CRC32 depuis le RÉPERTOIRE CENTRAL, jamais l'en-tête local — un
 * fichier produit ici est donc directement relisible par lui, et par tout
 * lecteur ZIP standard (vérifié en test contre `unzip`/`python3 zipfile`).
 * ============================================================================
 */
'use strict';

const fs = require('fs');
const path = require('path');

const LOCAL_FILE_SIG = 0x04034b50;
const DATA_DESCRIPTOR_SIG = 0x08074b50;
const CENTRAL_DIR_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
const FLAG_DATA_DESCRIPTOR = 0x0008;

// --- CRC32 (table-based, standard — mêmes constantes que zlib/PKZIP) ------
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

// AJOUT : mise à jour INCRÉMENTALE (par morceau) — permet de calculer le
// CRC32 d'un fichier volumineux au fil de sa lecture, sans jamais le charger
// entier en mémoire pour le calculer d'un coup.
function crc32Update(state, buf) {
  let c = state;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return c >>> 0;
}

/**
 * Écrit un .zip en streaming à partir d'une liste d'entrées.
 * @param {string} outPath
 * @param {Array<{name: string, content?: Buffer|string, filePath?: string}>} entries
 *   Une entrée a soit `content` (petit contenu en mémoire, ex. manifest.json)
 *   soit `filePath` (fichier local streamé, ex. un média).
 * @returns {Promise<void>}
 */
function writeZip(outPath, entries) {
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(outPath);
    out.on('error', reject);

    function write(buf) {
      return new Promise((res, rej) => {
        out.write(buf, (err) => (err ? rej(err) : res()));
      });
    }

    (async () => {
      const central = [];
      let offset = 0;

      for (const entry of entries) {
        const nameBuf = Buffer.from(entry.name, 'utf8');
        const localOffset = offset;

        const localHeader = Buffer.alloc(30);
        localHeader.writeUInt32LE(LOCAL_FILE_SIG, 0);
        localHeader.writeUInt16LE(20, 4); // version needed
        localHeader.writeUInt16LE(FLAG_DATA_DESCRIPTOR, 6); // flags
        localHeader.writeUInt16LE(0, 8); // méthode = STORED
        localHeader.writeUInt16LE(0, 10);
        localHeader.writeUInt16LE(0, 12);
        localHeader.writeUInt32LE(0, 14); // crc32 : dans le data descriptor
        localHeader.writeUInt32LE(0, 18); // taille compressée : idem
        localHeader.writeUInt32LE(0, 22); // taille non compressée : idem
        localHeader.writeUInt16LE(nameBuf.length, 26);
        localHeader.writeUInt16LE(0, 28);
        await write(localHeader);
        await write(nameBuf);
        offset += localHeader.length + nameBuf.length;

        let crcState = 0xffffffff;
        let size = 0;

        if (entry.filePath) {
          await new Promise((res, rej) => {
            const rs = fs.createReadStream(entry.filePath);
            rs.on('data', (chunk) => {
              crcState = crc32Update(crcState, chunk);
              size += chunk.length;
            });
            rs.on('error', rej);
            rs.on('end', res);
            rs.pipe(out, { end: false });
          });
        } else {
          const buf = Buffer.isBuffer(entry.content)
            ? entry.content
            : Buffer.from(entry.content, 'utf8');
          crcState = crc32Update(crcState, buf);
          size = buf.length;
          await write(buf);
        }
        offset += size;
        const crc32 = (crcState ^ 0xffffffff) >>> 0;

        const dataDescriptor = Buffer.alloc(16);
        dataDescriptor.writeUInt32LE(DATA_DESCRIPTOR_SIG, 0);
        dataDescriptor.writeUInt32LE(crc32, 4);
        dataDescriptor.writeUInt32LE(size, 8); // STORED : compressée = non compressée
        dataDescriptor.writeUInt32LE(size, 12);
        await write(dataDescriptor);
        offset += dataDescriptor.length;

        central.push({ name: entry.name, crc32, size, localOffset });
      }

      const centralDirOffset = offset;
      for (const e of central) {
        const nameBuf = Buffer.from(e.name, 'utf8');
        const header = Buffer.alloc(46);
        header.writeUInt32LE(CENTRAL_DIR_SIG, 0);
        header.writeUInt16LE(20, 4); // version made by
        header.writeUInt16LE(20, 6); // version needed
        header.writeUInt16LE(FLAG_DATA_DESCRIPTOR, 8);
        header.writeUInt16LE(0, 10); // méthode
        header.writeUInt16LE(0, 12);
        header.writeUInt16LE(0, 14);
        header.writeUInt32LE(e.crc32, 16);
        header.writeUInt32LE(e.size, 20);
        header.writeUInt32LE(e.size, 24);
        header.writeUInt16LE(nameBuf.length, 28);
        header.writeUInt16LE(0, 30);
        header.writeUInt16LE(0, 32);
        header.writeUInt16LE(0, 34);
        header.writeUInt16LE(0, 36);
        header.writeUInt32LE(0, 38);
        header.writeUInt32LE(e.localOffset, 42);
        await write(header);
        await write(nameBuf);
        offset += header.length + nameBuf.length;
      }
      const centralDirSize = offset - centralDirOffset;

      const eocd = Buffer.alloc(22);
      eocd.writeUInt32LE(EOCD_SIG, 0);
      eocd.writeUInt16LE(0, 4);
      eocd.writeUInt16LE(0, 6);
      eocd.writeUInt16LE(central.length, 8);
      eocd.writeUInt16LE(central.length, 10);
      eocd.writeUInt32LE(centralDirSize, 12);
      eocd.writeUInt32LE(centralDirOffset, 16);
      eocd.writeUInt16LE(0, 20);
      await write(eocd);

      out.end(() => resolve());
    })().catch(reject);
  });
}

/**
 * Construit le manifest + la liste d'entrées ZIP pour un export complet du
 * service courant. Ne fait AUCUN I/O disque destructif — lit seulement les
 * stores et le dossier média existant.
 * @param {Object} stores - { rundownStore, sceneStore, mediaLibrary, songLibrary }
 * @param {string} userDataDir
 * @returns {{ manifest: Object, entries: Array }}
 */
function buildExportPlan(stores, userDataDir) {
  const { rundownStore, sceneStore, mediaLibrary, songLibrary } = stores;
  const mediaDir = path.join(userDataDir, 'media');

  const mediaItems = mediaLibrary.listItems();
  const entries = [];
  const manifestMedia = [];
  const skippedMedia = [];

  for (const item of mediaItems) {
    const srcPath = path.join(mediaDir, item.filename);
    if (!fs.existsSync(srcPath)) {
      // AJOUT : un média référencé mais absent du disque (voir fileMissing
      // dans media-library.js#listItems) — inclus dans le manifest sans son
      // fichier plutôt que de faire échouer tout l'export pour un seul média
      // orphelin. Signalé séparément pour rester honnête sur ce qui manque.
      skippedMedia.push({ id: item.id, label: item.label, filename: item.filename });
      continue;
    }
    entries.push({ name: `media/${item.filename}`, filePath: srcPath });
    manifestMedia.push(item);
  }

  // CORRECTIF : songLibrary.listSongs() ne renvoie QUE des métadonnées
  // légères (sectionCount, pas le texte des sections — voir son en-tête
  // "métadonnées seulement, pour une liste légère") : un export qui s'en
  // contenterait produirait des chants sans paroles, impossibles à
  // reconstruire. getSong(id) donne l'enregistrement complet.
  const songs = songLibrary
    .listSongs()
    .map((s) => songLibrary.getSong(s.id))
    .filter(Boolean);

  const manifest = {
    exportedAt: new Date().toISOString(),
    appVersion: require('./package.json').version,
    rundown: rundownStore.listCues(),
    scenes: sceneStore.listItems(),
    media: manifestMedia,
    skippedMedia,
    songs,
  };

  entries.unshift({ name: 'manifest.json', content: JSON.stringify(manifest, null, 2) });

  return { manifest, entries };
}

/**
 * Point d'entrée complet : construit le plan puis écrit le .zip.
 * @param {string} outPath
 * @param {Object} stores
 * @param {string} userDataDir
 * @returns {Promise<Object>} résumé (compte de médias inclus/manquants, etc.)
 */
async function exportService(outPath, stores, userDataDir) {
  const { manifest, entries } = buildExportPlan(stores, userDataDir);
  await writeZip(outPath, entries);
  return {
    rundownCount: manifest.rundown.length,
    sceneCount: manifest.scenes.length,
    mediaCount: manifest.media.length,
    skippedMediaCount: manifest.skippedMedia.length,
    songCount: manifest.songs.length,
  };
}

module.exports = { writeZip, buildExportPlan, exportService };

// ----------------------------------------------------------------------------
// PORTÉE ASSUMÉE (§7.1.2 du document mission) : EXPORT uniquement dans cette
// passe. L'IMPORT (côté réception) exige une extraction ZIP sûre contre les
// chemins "zip slip" (une entrée nommée "../../etc/quelquechose" pourrait
// sinon écrire hors du dossier de destination) — un sujet de sécurité qui
// mérite sa propre revue dédiée plutôt qu'un ajout précipité en fin de
// session. En attendant : le .zip produit ici s'ouvre avec n'importe quel
// outil ZIP standard (testé), donc reste utilisable manuellement (copier les
// fichiers du dossier media/, relire manifest.json) même sans import intégré.
// ----------------------------------------------------------------------------
