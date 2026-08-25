'use strict';

const { Tool } = require('./tool');

function createChurchOverlayTools(services) {
  const { bibleLookup, detector, songLibrary, mediaLibrary, sceneStore, sessionState, broadcast } =
    services;
  const tools = [
    new Tool(
      {
        name: 'get_current_service_state',
        description: 'Read the current Church Overlay service state.',
        policy: 'auto',
        idempotent: true,
      },
      async () => ({
        currentVerse: sessionState.getLastReference(),
        displayLanguage: sessionState.getDisplayLanguage(),
        verseHistory: sessionState.getVerseHistory().slice(0, 10),
        recentTranscripts: sessionState.getRecentTranscripts().slice(-5),
      })
    ),
    new Tool(
      {
        name: 'search_songs',
        description: 'Search songs available in the Church Overlay library.',
        inputSchema: {
          type: 'object',
          required: ['query'],
          properties: { query: { type: 'string' } },
        },
        policy: 'auto',
        idempotent: true,
      },
      async ({ query }) =>
        songLibrary
          .listSongs()
          .filter((song) =>
            `${song.title} ${song.artist} ${(song.triggerPhrases || []).join(' ')}`
              .toLowerCase()
              .includes(query.toLowerCase())
          )
          .slice(0, 20)
    ),
    new Tool(
      {
        name: 'get_song',
        description: 'Get a song and its lyrics by id.',
        inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
        policy: 'auto',
        idempotent: true,
      },
      async ({ id }) => required(songLibrary.getSong(id), 'Song not found.')
    ),
    new Tool(
      {
        name: 'search_media',
        description: 'Search media available in the Church Overlay library.',
        inputSchema: {
          type: 'object',
          required: ['query'],
          properties: { query: { type: 'string' } },
        },
        policy: 'auto',
        idempotent: true,
      },
      async ({ query }) =>
        mediaLibrary
          .listItems()
          .filter((item) =>
            `${item.label} ${(item.triggerPhrases || []).join(' ')}`
              .toLowerCase()
              .includes(query.toLowerCase())
          )
          .slice(0, 20)
    ),
    new Tool(
      {
        name: 'search_bible',
        description: 'Resolve a real Bible reference using the existing Bible catalog.',
        inputSchema: {
          type: 'object',
          required: ['reference'],
          properties: { reference: { type: 'string' } },
        },
        policy: 'auto',
        idempotent: true,
      },
      async ({ reference }) =>
        required(detector.parseReference(reference), 'Bible reference not recognized.')
    ),
    new Tool(
      {
        name: 'get_bible_verse',
        description: 'Fetch the real Bible text for a recognized reference.',
        inputSchema: {
          type: 'object',
          required: ['reference'],
          properties: { reference: { type: 'string' } },
        },
        policy: 'auto',
        idempotent: true,
      },
      async ({ reference }) => {
        const parsed = required(
          detector.parseReference(reference),
          'Bible reference not recognized.'
        );
        return bibleLookup.getVerseMultilang(parsed, sessionState.getDisplayLanguage());
      }
    ),
    new Tool(
      {
        name: 'show_verse',
        description: 'Display a real Bible verse on the public overlay.',
        inputSchema: {
          type: 'object',
          required: ['reference'],
          properties: { reference: { type: 'string' }, durationMs: { type: 'number' } },
        },
        policy: 'confirm',
        idempotent: true,
      },
      async ({ reference, durationMs }) => {
        const parsed = required(
          detector.parseReference(reference),
          'Bible reference not recognized.'
        );
        const verse = await bibleLookup.getVerseMultilang(
          parsed,
          sessionState.getDisplayLanguage()
        );
        broadcast({
          action: 'showVerse',
          ...verse,
          durationMs: durationMs || 120000,
          triggeredByAgent: true,
        });
        return verse;
      }
    ),
    new Tool(
      {
        name: 'show_song_section',
        description: 'Display one section of a song on the public overlay.',
        inputSchema: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string' }, sectionIndex: { type: 'number' } },
        },
        policy: 'confirm',
        idempotent: true,
      },
      async ({ id, sectionIndex = 0 }) => {
        const song = required(songLibrary.getSong(id), 'Song not found.');
        const section = song.sections[sectionIndex];
        if (!section) throw new Error('Song section not found.');
        const payload = {
          action: 'showVerse',
          reference: `${song.title} — ${section.label}`,
          text: section.text,
          triggeredByAgent: true,
        };
        broadcast(payload);
        return payload;
      }
    ),
    new Tool(
      {
        name: 'trigger_media',
        description: 'Show a selected media item on the public overlay.',
        inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
        policy: 'confirm',
        idempotent: true,
      },
      async ({ id }) => {
        const item = required(mediaLibrary.getItem(id), 'Media item not found.');
        const payload = {
          action: 'showMedia',
          id: item.id,
          mediaType: item.mediaType,
          mediaUrl: `/media/${item.filename}`,
          label: item.label,
          displayDurationMs: item.displayDurationMs,
          transitionStyle: item.transitionStyle,
          detectedBy: 'agent',
        };
        broadcast(payload);
        return payload;
      }
    ),
    new Tool(
      {
        name: 'trigger_scene',
        description: 'Show a selected scene on the public overlay.',
        inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
        policy: 'confirm',
        idempotent: true,
      },
      async ({ id }) => {
        const scene = required(sceneStore.getItem(id), 'Scene not found.');
        const payload = { action: 'showScene', ...scene, detectedBy: 'agent' };
        broadcast(payload);
        return payload;
      }
    ),
  ];
  return tools;
}
function required(value, message) {
  if (!value) throw new Error(message);
  return value;
}
module.exports = { createChurchOverlayTools };
