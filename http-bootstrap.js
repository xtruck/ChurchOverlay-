'use strict';

/**
 * http-bootstrap.js — Création de l'app Express et du serveur HTTP brut
 * (middleware compression/statique, pas de route applicative — voir
 * http-routes.js pour ça).
 *
 * Extrait de server.js (Phase 3 — modularisation du bootstrap, même
 * chantier que http-routes.js/phone-camera-routes.js/worker-bootstrap.js).
 * Comportement identique à l'original, seulement déplacé — dépendances
 * injectées via un objet de contexte, comme les autres extractions de
 * cette même famille.
 *
 * NE couvre PAS : la création du serveur WebSocket (`wss = new
 * WebSocket.Server({ server: httpServer, ... })` reste dans server.js —
 * son handshake dépend de WS_AUTH_TOKEN/WS_VIEWER_TOKEN et son routeur
 * `wss.on('connection')` est le cœur du dispatch WS, volontairement
 * jamais déplacé hors de server.js), ni les routes applicatives
 * (http-routes.js/phone-camera-routes.js, enregistrées par l'appelant sur
 * l'`app` renvoyé ici), ni la notification d'erreur au process principal
 * en cas d'échec d'écoute (reste dans server.js — c'est un souci du
 * worker_thread, pas de l'app Express elle-même ; voir startListening()
 * ci-dessous, qui délègue via un callback plutôt que de connaître
 * parentPort/worker_threads).
 */

const express = require('express');
const compression = require('compression');
const http = require('http');
const path = require('path');

/**
 * Construit l'app Express (middleware compression/statique) et le serveur
 * HTTP brut qui l'enveloppe — sans l'attacher à un port (voir
 * startListening() plus bas).
 * @param {object} ctx
 * @param {string} ctx.appRoot - APP_ROOT (racine des fichiers statiques : dashboard.html, overlay.html, ...)
 * @param {string} ctx.userDataDir - USER_DATA_DIR (racine des ponts /media, /branding, /dashboard-branding)
 * @returns {{ app: import('express').Express, httpServer: import('http').Server }}
 */
function createHttpServer(ctx) {
  const { appRoot, userDataDir } = ctx;

  const app = express();
  // AJOUT (audit perf) : dashboard.html/dashboard.js (~230 Ko à eux deux)
  // étaient servis non compressés. Coût quasi nul en localhost (127.0.0.1 par
  // défaut), mais réel dès qu'un second poste rejoint via WS_HOST distant
  // (voir config-validator.js) — gzip/brotli sur toutes les réponses HTTP.
  app.use(compression());
  app.use(express.static(appRoot));
  // AJOUT (médiathèque) : overlay.html et dashboard.html sont chargés en
  // file:// (voir main.js) — cette route leur donne une URL http:// stable
  // pour les fichiers copiés dans <userData>/media/ par media-library.js,
  // sur le même principe pont que /api/verses pour les données JSON.
  app.use('/media', express.static(path.join(userDataDir, 'media')));
  // AJOUT (habillage caméra — logo) : même pont que /media ci-dessus, pour le
  // logo copié dans <userData>/branding/ par branding-store.js.
  app.use('/branding', express.static(path.join(userDataDir, 'branding')));
  // AJOUT (identité de marque du tableau de bord — revente en produit
  // "clé en main") : même pont, pour le logo copié dans
  // <userData>/dashboard-branding/ par dashboard-branding-store.js. Route
  // distincte de /branding ci-dessus — deux domaines sans recouvrement, voir
  // l'en-tête de dashboard-branding-store.js.
  app.use('/dashboard-branding', express.static(path.join(userDataDir, 'dashboard-branding')));

  const httpServer = http.createServer(app);
  return { app, httpServer };
}

/**
 * Démarre l'écoute — séparé de createHttpServer() ci-dessus pour que
 * l'appelant puisse attacher `wss` (WebSocket.Server) à `httpServer` AVANT
 * l'écoute effective (même ordre que le code original). `onReady`/`onError`
 * sont de simples callbacks : ce module ne connaît jamais parentPort ni
 * worker_threads, c'est à l'appelant (server.js) de décider quoi faire
 * d'une erreur d'écoute (alerte worker, log, code de sortie...).
 * @param {import('http').Server} httpServer
 * @param {object} opts
 * @param {number} opts.port
 * @param {string} opts.host
 * @param {() => void} [opts.onReady]
 * @param {(err: Error) => void} [opts.onError]
 */
function startListening(httpServer, { port, host, onReady, onError }) {
  httpServer.listen(port, host, () => {
    if (onReady) onReady();
  });
  httpServer.on('error', (err) => {
    if (onError) onError(err);
  });
}

module.exports = { createHttpServer, startListening };
