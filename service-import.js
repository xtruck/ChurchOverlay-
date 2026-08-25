/**
 * ============================================================================
 * service-import.js — Import "service portable" (Partie 7.1.2, IMPORT — la
 * moitié laissée délibérément non faite lors du chantier export, maintenant
 * construite avec l'attention dédiée qu'elle méritait)
 * ----------------------------------------------------------------------------
 * PROTECTION "ZIP SLIP" (CWE-22) — voir buildExportPlan()/service-export.js
 * pour le format produit. La protection habituelle contre le zip slip
 * consiste à valider chaque chemin de destination avant d'extraire une
 * entrée ARBITRAIRE du zip vers le disque. Cet importeur n'a PAS besoin de
 * cette forme générique : il ne fait JAMAIS "extraire l'entrée X vers le
 * chemin qu'elle indique elle-même". À la place :
 *   1. Seules DEUX clés fixes sont lues du zip : 'manifest.json' et, pour
 *      chaque média DÉCRIT PAR CE MANIFESTE, 'media/<filename>' — jamais un
 *      chemin arbitraire fourni par une entrée ZIP quelconque.
 *   2. Chaque fichier média extrait est écrit dans un fichier TEMPORAIRE
 *      dont le NOM est entièrement choisi ICI (crypto.randomUUID() + une
 *      extension déjà validée contre l'ALLOWLIST existante de
 *      media-library.js) — jamais le nom de fichier venu du zip/manifeste.
 *      path.basename() est appliqué avant d'en extraire l'extension, pour
 *      qu'aucun séparateur de chemin ne puisse s'y glisser.
 *   3. media-library.js#addItem() copie ensuite ce fichier temporaire vers
 *      SON PROPRE nom de fichier interne (id généré + extension) — jamais
 *      le nom venu de l'extérieur non plus.
 * Résultat : aucune écriture sur disque, à aucune étape, n'utilise un chemin
 * dérivé d'une donnée non fiable. Testé en `test/test-service-import.js`
 * avec un .zip délibérément hostile (nom de fichier "../../../evil.jpg"
 * dans le manifeste) pour vérifier que rien ne s'échappe du dossier
 * temporaire, pas seulement supposé sûr par construction.
 *
 * REMAPPAGE D'ID : scenes/rundown référencent des médias/scènes par id.
 * media-library.js#addItem()/scene-store.js#addScene() génèrent TOUJOURS un
 * nouvel id (jamais fait confiance à un id venu de l'extérieur — même
 * discipline que le reste de ce dépôt) : les anciens id du manifeste ne
 * correspondent donc plus à rien après import. Chaque étape construit une
 * table ancien-id -> nouvel-id, utilisée par les étapes suivantes pour
 * réécrire les références (background.mediaId d'une scène, mediaId d'un
 * élément image, mediaId/sceneId d'un repère de feuille de route).
 *
 * DÉGRADATION : un média manquant du zip, un format invalide, une scène dont
 * la référence média ne remappe plus vers rien — chaque cas est SAUTÉ et
 * comptabilisé (jamais une erreur qui interromprait tout l'import pour un
 * seul élément), sauf pour un repère de feuille de route dont la cible
 * requise (mediaId/sceneId) n'a pas pu être remappée : rundown-store.js
 * refuse déjà un repère sans cette référence (addCue() lève), donc il est
 * sauté plutôt que de créer un repère qui ne déclencherait jamais rien.
 * ============================================================================
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { readZipEntries } = require('./pptx-importer');

function sectionsToLyrics(sections) {
  return (Array.isArray(sections) ? sections : [])
    .map((s) => (s && typeof s.text === 'string' ? s.text : ''))
    .filter(Boolean)
    .join('\n\n');
}

/**
 * @param {string} zipPath
 * @param {Object} stores - { mediaLibrary, sceneStore, songLibrary, rundownStore }
 * @returns {Promise<Object>} résumé (compte importé/sauté par catégorie)
 */
async function importService(zipPath, stores) {
  const { mediaLibrary, sceneStore, songLibrary, rundownStore } = stores;

  const buf = fs.readFileSync(zipPath);
  const entries = readZipEntries(buf);

  const manifestBuf = entries.get('manifest.json');
  if (!manifestBuf) {
    throw new Error("manifest.json introuvable — ce n'est pas un export ChurchOverlay valide.");
  }
  let manifest;
  try {
    manifest = JSON.parse(manifestBuf.toString('utf8'));
  } catch (err) {
    throw new Error(`manifest.json illisible (${err.message})`, { cause: err });
  }

  const summary = {
    mediaImported: 0,
    mediaSkipped: 0,
    scenesImported: 0,
    scenesSkipped: 0,
    songsImported: 0,
    songsSkipped: 0,
    cuesImported: 0,
    cuesSkipped: 0,
  };

  // --- Médias : chaque fichier extrait vers un temp sûr, jamais le nom venu du zip ---
  const mediaIdMap = new Map();
  for (const item of Array.isArray(manifest.media) ? manifest.media : []) {
    let tempPath = null;
    try {
      const safeName = path.basename(typeof item.filename === 'string' ? item.filename : '');
      const ext = path.extname(safeName).toLowerCase();
      if (!mediaLibrary.ALLOWED_EXTENSIONS.has(ext)) {
        throw new Error(`extension non supportée : ${ext || '(aucune)'}`);
      }
      const entryBuf = entries.get(`media/${item.filename}`);
      if (!entryBuf) throw new Error('fichier média absent du zip');

      tempPath = path.join(os.tmpdir(), `churchoverlay-import-${crypto.randomUUID()}${ext}`);
      fs.writeFileSync(tempPath, entryBuf);

      const added = mediaLibrary.addItem({
        sourcePath: tempPath,
        label: item.label,
        triggerPhrases: item.triggerPhrases,
        displayDurationMs: item.displayDurationMs,
        includeInLoop: item.includeInLoop,
        transitionStyle: item.transitionStyle,
      });
      mediaIdMap.set(item.id, added.id);
      summary.mediaImported++;
    } catch (_err) {
      summary.mediaSkipped++;
    } finally {
      if (tempPath) {
        try {
          fs.unlinkSync(tempPath);
        } catch (_) {}
      }
    }
  }

  // --- Scènes : mediaId remappés, dégradent gracieusement si absents (même
  // philosophie que scene-store.js lui-même pour une référence disparue) ---
  const sceneIdMap = new Map();
  for (const scene of Array.isArray(manifest.scenes) ? manifest.scenes : []) {
    try {
      const background =
        scene.background && scene.background.type === 'media'
          ? { ...scene.background, mediaId: mediaIdMap.get(scene.background.mediaId) || null }
          : scene.background;
      const elements = (Array.isArray(scene.elements) ? scene.elements : []).map((el) =>
        el && el.type === 'image' ? { ...el, mediaId: mediaIdMap.get(el.mediaId) || null } : el
      );
      const added = sceneStore.addScene({
        name: scene.name,
        background,
        elements,
        triggerPhrases: scene.triggerPhrases,
      });
      sceneIdMap.set(scene.id, added.id);
      summary.scenesImported++;
    } catch (_err) {
      summary.scenesSkipped++;
    }
  }

  // --- Chants : reconstruit lyrics depuis sections (voir sectionsToLyrics) ---
  for (const song of Array.isArray(manifest.songs) ? manifest.songs : []) {
    try {
      songLibrary.addSong({
        title: song.title,
        artist: song.artist,
        lyrics: sectionsToLyrics(song.sections),
        triggerPhrases: song.triggerPhrases,
      });
      summary.songsImported++;
    } catch (_err) {
      summary.songsSkipped++;
    }
  }

  // --- Feuille de route : sautée (pas ajoutée à moitié) si sa cible média/
  // scène n'a pas pu être remappée -- addCue() l'exigerait de toute façon ---
  for (const cue of Array.isArray(manifest.rundown) ? manifest.rundown : []) {
    try {
      const data = { type: cue.type, label: cue.label };
      if (cue.type === 'verse') {
        data.reference = cue.reference;
      } else if (cue.type === 'media') {
        const newMediaId = mediaIdMap.get(cue.mediaId);
        if (!newMediaId) throw new Error('média référencé indisponible après import');
        data.mediaId = newMediaId;
      } else if (cue.type === 'scene') {
        const newSceneId = sceneIdMap.get(cue.sceneId);
        if (!newSceneId) throw new Error('scène référencée indisponible après import');
        data.sceneId = newSceneId;
      }
      rundownStore.addCue(data);
      summary.cuesImported++;
    } catch (_err) {
      summary.cuesSkipped++;
    }
  }

  return summary;
}

module.exports = { importService };
