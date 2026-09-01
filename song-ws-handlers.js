'use strict';

/**
 * song-ws-handlers.js — Handlers WS de la bibliothèque de chants (Phase 2 —
 * modularisation du dispatch WS de server.js, même chantier que
 * media-ws-handlers.js/scene-ws-handlers.js).
 *
 * Extrait tel quel (comportement identique, seulement déplacé) :
 * getSongLibrary/addSong/deleteSong/showSongSection.
 *
 * Convention de handler : `async (ws, sanitized, requestId, sendError) => {}`
 * — voir media-ws-handlers.js pour le détail de la convention et le
 * mécanisme CATEGORY_HANDLERS dans server.js.
 *
 * @param {object} ctx
 * @param {object} ctx.songLibrary
 * @param {(obj: object) => void} ctx.broadcast
 * @param {(msg: string) => void} ctx.log
 * @param {(song: object, sectionIndex: number, detectedBy: string) => void} ctx.broadcastSongSection
 *   - diffuse une section de chant comme un 'showVerse' synthétique et
 *   l'enregistre dans l'historique ; reste défini dans server.js (aussi
 *   utilisée par la détection vocale, processTranscript, pas seulement ce
 *   handler manuel)
 * @returns {Map<string, (ws: object, sanitized: object, requestId: string|null, sendError: (error: string) => void) => Promise<void>>}
 */
function createHandlers(ctx) {
  const { songLibrary, broadcast, log, broadcastSongSection } = ctx;

  const handlers = new Map();

  // --- Bibliothèque de chants (mêmes conventions que la médiathèque —
  // media-ws-handlers.js : réponse directe au demandeur pour la lecture/
  // mutation de la liste, broadcast() pour ce que tous les clients doivent
  // voir) ---
  handlers.set('getSongLibrary', async (ws) => {
    ws.send(JSON.stringify({ action: 'songLibraryUpdated', songs: songLibrary.listSongs() }));
  });

  handlers.set('addSong', async (ws, sanitized) => {
    try {
      const song = songLibrary.addSong({
        title: sanitized.title,
        artist: sanitized.artist,
        lyrics: sanitized.lyrics,
        triggerPhrases: sanitized.triggerPhrases,
      });
      log(`Bibliothèque de chants : "${song.title}" ajouté (${song.sections.length} section(s))`);
      broadcast({ action: 'songLibraryUpdated', songs: songLibrary.listSongs() });
    } catch (err) {
      ws.send(JSON.stringify({ action: 'error', error: 'Chants : ' + err.message }));
    }
  });

  handlers.set('deleteSong', async (ws, sanitized) => {
    const removed = songLibrary.deleteSong(sanitized.id);
    if (removed) {
      broadcast({ action: 'songLibraryUpdated', songs: songLibrary.listSongs() });
    } else {
      ws.send(JSON.stringify({ action: 'error', error: 'Chants : chant introuvable' }));
    }
  });

  handlers.set('showSongSection', async (ws, sanitized) => {
    const song = songLibrary.getSong(sanitized.id);
    if (!song) {
      ws.send(JSON.stringify({ action: 'error', error: 'Chants : chant introuvable' }));
      return;
    }
    const sectionIndex = Number.isInteger(sanitized.sectionIndex) ? sanitized.sectionIndex : 0;
    broadcastSongSection(song, sectionIndex, 'manual');
  });

  return handlers;
}

module.exports = { createHandlers };
