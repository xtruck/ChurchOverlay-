#!/usr/bin/env node
'use strict';
/**
 * ============================================================================
 * mcp/server.js — Serveur MCP pour ChurchOverlay (chantier 4.5)
 * ----------------------------------------------------------------------------
 * Expose un sous-ensemble d'actions WS déjà implémentées et validées de
 * server.js comme outils MCP, pour qu'un client compatible (Claude Desktop,
 * Claude Code, tout autre client MCP) puisse piloter le service EN DIRECT en
 * langage naturel — ex. "affiche Jean 3:16" ou "montre la scène d'accueil".
 * Aucune nouvelle voie d'accès : ce process se connecte au serveur
 * ChurchOverlay déjà en cours d'exécution comme n'importe quel client
 * opérateur (voir mcp/church-ws-client.js), avec le même WS_AUTH_TOKEN si
 * configuré.
 *
 * ------------------------------------------------------------------------
 * PÉRIMÈTRE (délibérément restreint à un sous-ensemble sûr) : seules les
 * actions dont le handler et le contrat de réponse dans server.js ont été
 * vérifiés directement en écrivant ce fichier sont exposées — show_verse,
 * hide_verse, search_bible, list_media/list_scenes, trigger_media/
 * trigger_scene, hide_media/hide_scene. Volontairement absentes de cette
 * première itération, à ajouter dans un chantier dédié une fois vérifiées :
 *   - apply_theme : le validateur `applyTheme` (validation.js) attend des
 *     champs CSS PLATS (background, accentColor...) alors que les thèmes
 *     nommés de theme-loader.js (claire/nuit) produisent des variables CSS
 *     (--bg, --accent...) — les deux formats ne correspondent PAS, et
 *     aucune traduction entre eux n'existe ailleurs dans ce dépôt. Exposer
 *     un outil "apply_theme(nom)" sans vérifier comment le tableau de bord
 *     fait réellement cette conversion risquerait de renvoyer un succès
 *     silencieux qui n'affiche rien à l'écran.
 *   - emergency_clear / obs-switch-scene : présents dans OPERATOR_ACTIONS
 *     (permissions) mais aucun handler `sanitized.action === '...'`
 *     correspondant trouvé dans server.js au moment d'écrire ce fichier —
 *     à confirmer avant d'exposer un outil dessus (pas de faux sentiment de
 *     contrôle sur une action qui pourrait ne pas être câblée).
 * Destructeur (delete media/scene) volontairement jamais exposé : un outil
 * MCP mal formulé par un LLM ne doit pas pouvoir supprimer un média/scène.
 *
 * ------------------------------------------------------------------------
 * INSTALLATION (client MCP quelconque — ex. Claude Desktop, config JSON) :
 *   {
 *     "mcpServers": {
 *       "churchoverlay": {
 *         "command": "node",
 *         "args": ["<chemin-absolu-vers-ce-repo>/mcp/server.js"],
 *         "env": { "WS_AUTH_TOKEN": "<le même jeton que server.js, si configuré>" }
 *       }
 *     }
 *   }
 * Le serveur ChurchOverlay (server.js / npm run dev, ou l'app packagée) doit
 * déjà tourner — ce process ne le démarre pas, il s'y connecte.
 * ============================================================================
 */

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');

const { ChurchOverlayClient } = require('./church-ws-client');

function textResult(text) {
  return { content: [{ type: 'text', text }] };
}

function errorResult(err) {
  return { content: [{ type: 'text', text: `Erreur : ${err.message}` }], isError: true };
}

function buildServer(client) {
  const server = new McpServer({ name: 'churchoverlay', version: '1.0.0' });

  server.registerTool(
    'show_verse',
    {
      title: 'Afficher un verset',
      description:
        'Affiche une référence biblique (ex. "Jean 3:16", "Romains 8:28-30") sur l\'overlay projeté en direct.',
      inputSchema: {
        reference: z.string().min(1).max(200).describe('Référence biblique, ex. "Jean 3:16"'),
      },
    },
    async ({ reference }) => {
      try {
        const res = await client.callAction(
          'showVerse',
          { reference },
          { successActions: ['showVerse'] }
        );
        return textResult(`Verset affiché : ${res.reference || reference}.`);
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    'hide_verse',
    {
      title: 'Masquer le verset',
      description: "Masque le verset actuellement affiché sur l'overlay projeté.",
      inputSchema: {},
    },
    async () => {
      try {
        await client.callAction('hideVerse', {}, { successActions: ['hideVerse'] });
        return textResult('Verset masqué.');
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    'search_bible',
    {
      title: 'Rechercher un passage biblique par sujet',
      description:
        'Cherche des versets par sujet/thème (ex. "pardon", "grâce", "fils prodigue") plutôt que par référence exacte.',
      inputSchema: {
        query: z.string().min(1).max(200),
        topK: z.number().int().min(1).max(20).optional(),
      },
    },
    async ({ query, topK }) => {
      try {
        const res = await client.callAction(
          'searchBible',
          { query, topK },
          { successActions: ['searchResults', 'searchError'] }
        );
        if (!res.results || res.results.length === 0) {
          return textResult(`Aucun résultat pour "${query}".`);
        }
        const lines = res.results.map(
          (r) => `- ${r.reference} (${r.source}, score ${r.score.toFixed(2)})`
        );
        return textResult(`Résultats pour "${query}" :\n${lines.join('\n')}`);
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    'list_media',
    {
      title: 'Lister la médiathèque',
      description: 'Liste les photos/vidéos disponibles dans la médiathèque (id, libellé, type).',
      inputSchema: {},
    },
    async () => {
      try {
        const res = await client.callAction(
          'getMediaLibrary',
          {},
          { successActions: ['mediaLibraryUpdated'] }
        );
        const items = res.items || [];
        if (items.length === 0) return textResult('Médiathèque vide.');
        const lines = items.map((i) => `- ${i.id} : ${i.label} (${i.mediaType})`);
        return textResult(lines.join('\n'));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    'list_scenes',
    {
      title: 'Lister les scènes',
      description: 'Liste les scènes composées disponibles (studio de scènes) — id et nom.',
      inputSchema: {},
    },
    async () => {
      try {
        const res = await client.callAction(
          'getSceneLibrary',
          {},
          { successActions: ['sceneLibraryUpdated'] }
        );
        const scenes = res.scenes || [];
        if (scenes.length === 0) return textResult('Aucune scène.');
        const lines = scenes.map((s) => `- ${s.id} : ${s.name}`);
        return textResult(lines.join('\n'));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    'trigger_media',
    {
      title: 'Déclencher un média',
      description:
        "Affiche un élément de la médiathèque sur l'overlay. Utiliser list_media d'abord pour obtenir l'id.",
      inputSchema: { id: z.string().min(1) },
    },
    async ({ id }) => {
      try {
        const res = await client.callAction(
          'triggerMediaItem',
          { id },
          { successActions: ['showMedia'] }
        );
        return textResult(`Média affiché : ${res.label || id}.`);
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    'hide_media',
    {
      title: 'Masquer le média',
      description: "Masque le média actuellement affiché sur l'overlay.",
      inputSchema: {},
    },
    async () => {
      try {
        await client.callAction('hideMedia', {}, { successActions: ['hideMedia'] });
        return textResult('Média masqué.');
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    'trigger_scene',
    {
      title: 'Déclencher une scène',
      description:
        "Affiche une scène composée (studio de scènes) sur l'overlay. Utiliser list_scenes d'abord pour obtenir l'id.",
      inputSchema: { id: z.string().min(1) },
    },
    async ({ id }) => {
      try {
        const res = await client.callAction(
          'triggerScene',
          { id },
          { successActions: ['showScene'] }
        );
        return textResult(`Scène affichée : ${res.name || id}.`);
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    'hide_scene',
    {
      title: 'Masquer la scène',
      description: "Masque la scène actuellement affichée sur l'overlay.",
      inputSchema: {},
    },
    async () => {
      try {
        await client.callAction('hideScene', {}, { successActions: ['hideScene'] });
        return textResult('Scène masquée.');
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  return server;
}

async function main() {
  const client = new ChurchOverlayClient();
  try {
    await client.connect();
  } catch (err) {
    console.error(
      `[mcp-server] Impossible de se connecter à ChurchOverlay (${client.url}) : ${err.message}. ` +
        "Le serveur ChurchOverlay doit déjà être démarré (npm run dev, ou l'app packagée)."
    );
    process.exit(1);
  }

  const server = buildServer(client);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[mcp-server] Connecté à ChurchOverlay, en écoute sur stdio (MCP).');
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[mcp-server] Erreur fatale:', err);
    process.exit(1);
  });
}

module.exports = { buildServer, textResult, errorResult };
