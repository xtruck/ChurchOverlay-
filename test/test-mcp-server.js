'use strict';
/**
 * Tests unitaires pour mcp/server.js — buildServer() et les 9 outils MCP.
 * ChurchOverlayClient mocké (voir test-mcp-church-ws-client.js pour les
 * tests du client WS lui-même, contre un vrai ws.Server) — ici on teste
 * uniquement que chaque outil MCP appelle la bonne action WS avec les bons
 * paramètres et formate correctement la réponse/l'erreur.
 */
const { buildServer } = require('../mcp/server');

let passed = 0;
let failed = 0;
function check(name, cond) {
  if (cond) {
    console.log('[TEST] ✓', name);
    passed++;
  } else {
    console.error('[TEST] ✗', name);
    failed++;
  }
}

function textOf(result) {
  return result.content && result.content[0] && result.content[0].text;
}

async function run() {
  const calls = [];
  const responses = {}; // action -> response object OR Error to throw
  const fakeClient = {
    callAction: async (action, payload, options) => {
      calls.push({ action, payload, options });
      const configured = responses[action];
      if (configured instanceof Error) throw configured;
      return configured || { action: action + 'Ack' };
    },
  };
  const server = buildServer(fakeClient);
  const tool = (name) => server._registeredTools[name];

  check(
    'buildServer: les 9 outils attendus sont enregistrés',
    [
      'show_verse',
      'hide_verse',
      'search_bible',
      'list_media',
      'list_scenes',
      'trigger_media',
      'hide_media',
      'trigger_scene',
      'hide_scene',
    ].every((n) => !!tool(n))
  );

  // --- show_verse ---
  responses.showVerse = { action: 'showVerse', reference: 'Jean 3:16' };
  {
    const r = await tool('show_verse').handler({ reference: 'Jean 3:16' });
    const call = calls[calls.length - 1];
    check('show_verse: appelle showVerse avec la référence', call.action === 'showVerse' && call.payload.reference === 'Jean 3:16');
    check('show_verse: successActions = [showVerse]', call.options.successActions.includes('showVerse'));
    check('show_verse: texte de confirmation', /Jean 3:16/.test(textOf(r)));
    check('show_verse: pas isError', !r.isError);
  }

  // --- hide_verse ---
  responses.hideVerse = { action: 'hideVerse' };
  {
    const r = await tool('hide_verse').handler({});
    check('hide_verse: appelle hideVerse', calls[calls.length - 1].action === 'hideVerse');
    check('hide_verse: confirmation', /masqué/i.test(textOf(r)));
  }

  // --- search_bible : résultats ---
  responses.searchBible = {
    action: 'searchResults',
    query: 'amour',
    results: [{ reference: 'Jean 3:16', source: 'keyword', score: 1 }],
  };
  {
    const r = await tool('search_bible').handler({ query: 'amour' });
    const call = calls[calls.length - 1];
    check('search_bible: appelle searchBible avec query', call.action === 'searchBible' && call.payload.query === 'amour');
    check(
      'search_bible: successActions inclut searchResults ET searchError',
      call.options.successActions.includes('searchResults') && call.options.successActions.includes('searchError')
    );
    check('search_bible: résultats formatés', /Jean 3:16/.test(textOf(r)) && /keyword/.test(textOf(r)));
  }

  // --- search_bible : aucun résultat ---
  responses.searchBible = { action: 'searchResults', query: 'xyz', results: [] };
  {
    const r = await tool('search_bible').handler({ query: 'xyz' });
    check('search_bible: message clair si 0 résultat', /Aucun résultat/.test(textOf(r)));
  }

  // --- list_media ---
  responses.getMediaLibrary = {
    action: 'mediaLibraryUpdated',
    items: [{ id: 'm1', label: 'Logo', mediaType: 'image' }],
  };
  {
    const r = await tool('list_media').handler({});
    check('list_media: appelle getMediaLibrary', calls[calls.length - 1].action === 'getMediaLibrary');
    check('list_media: liste formatée avec id', /m1/.test(textOf(r)) && /Logo/.test(textOf(r)));
  }

  // --- list_media : vide ---
  responses.getMediaLibrary = { action: 'mediaLibraryUpdated', items: [] };
  {
    const r = await tool('list_media').handler({});
    check('list_media: message clair si médiathèque vide', /vide/i.test(textOf(r)));
  }

  // --- list_scenes ---
  responses.getSceneLibrary = {
    action: 'sceneLibraryUpdated',
    scenes: [{ id: 's1', name: "Écran d'accueil" }],
  };
  {
    const r = await tool('list_scenes').handler({});
    check('list_scenes: appelle getSceneLibrary', calls[calls.length - 1].action === 'getSceneLibrary');
    check('list_scenes: liste formatée', /s1/.test(textOf(r)) && /accueil/.test(textOf(r)));
  }

  // --- trigger_media : succès ---
  responses.triggerMediaItem = { action: 'showMedia', id: 'm1', label: 'Logo' };
  {
    const r = await tool('trigger_media').handler({ id: 'm1' });
    const call = calls[calls.length - 1];
    check('trigger_media: appelle triggerMediaItem avec id', call.action === 'triggerMediaItem' && call.payload.id === 'm1');
    check('trigger_media: confirmation avec label', /Logo/.test(textOf(r)));
  }

  // --- trigger_media : erreur (id inconnu) ---
  responses.triggerMediaItem = new Error('Médiathèque : élément introuvable');
  {
    const r = await tool('trigger_media').handler({ id: 'bogus' });
    check('trigger_media: isError = true sur échec', r.isError === true);
    check('trigger_media: message d\'erreur propagé', /introuvable/.test(textOf(r)));
  }

  // --- hide_media ---
  responses.hideMedia = { action: 'hideMedia' };
  {
    const r = await tool('hide_media').handler({});
    check('hide_media: appelle hideMedia', calls[calls.length - 1].action === 'hideMedia');
    check('hide_media: confirmation', /masqué/i.test(textOf(r)));
  }

  // --- trigger_scene : succès ---
  responses.triggerScene = { action: 'showScene', id: 's1', name: "Écran d'accueil" };
  {
    const r = await tool('trigger_scene').handler({ id: 's1' });
    const call = calls[calls.length - 1];
    check('trigger_scene: appelle triggerScene avec id', call.action === 'triggerScene' && call.payload.id === 's1');
    check('trigger_scene: confirmation avec nom', /accueil/.test(textOf(r)));
  }

  // --- trigger_scene : erreur ---
  responses.triggerScene = new Error('Studio de scènes : scène introuvable');
  {
    const r = await tool('trigger_scene').handler({ id: 'bogus' });
    check('trigger_scene: isError = true sur échec', r.isError === true);
  }

  // --- hide_scene ---
  responses.hideScene = { action: 'hideScene' };
  {
    const r = await tool('hide_scene').handler({});
    check('hide_scene: appelle hideScene', calls[calls.length - 1].action === 'hideScene');
    check('hide_scene: confirmation', /masqué/i.test(textOf(r)));
  }

  // --- show_verse : erreur serveur (référence invalide) ---
  responses.showVerse = new Error('Référence invalide.');
  {
    const r = await tool('show_verse').handler({ reference: 'zzz' });
    check('show_verse: isError = true sur référence invalide', r.isError === true);
    check('show_verse: message d\'erreur propagé', /invalide/.test(textOf(r)));
  }

  console.log(`\n=== Résultat mcp/server : ${passed}/${passed + failed} ===`);
  if (failed > 0) process.exit(1);
}

run();
