'use strict';

/**
 * phone-camera-routes.js — Routes HTTP pour caméra téléphone par QR code.
 *
 * Extrait de server.js (D.2) : section auto-contenue avec son propre état
 * en mémoire (phoneCameraFrames Map) et ses propres routes HTTP.
 *
 * Dépendances injectées via contexte : app, express, phoneCameraPairing,
 * ipCameraStore, broadcast, log, warn, SERVER_PORT.
 */

const express = require('express');

const phoneCameraFrames = new Map();
const STALE_FRAME_MS = 8000;

function isFrameFresh(cameraId) {
  const frame = phoneCameraFrames.get(cameraId);
  return !!frame && Date.now() - frame.receivedAt < STALE_FRAME_MS;
}

function cleanupPhoneCameraStateForItem(item) {
  const match = item && item.url && item.url.match(/\/phone-camera-stream\/([a-f0-9-]+)$/);
  if (!match) return;
  const { phoneCameraPairing } = cleanupPhoneCameraStateForItem._deps || {};
  if (phoneCameraPairing) phoneCameraPairing.removeCamera(match[1]);
  phoneCameraFrames.delete(match[1]);
}

function getLanIpAddress() {
  const os = require('os');
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return null;
}

function registerRoutes(ctx) {
  const { app, phoneCameraPairing, ipCameraStore, broadcast, log, warn, SERVER_PORT } = ctx;
  cleanupPhoneCameraStateForItem._deps = { phoneCameraPairing };

  app.post('/phone-camera-pair', express.json({ limit: '1kb' }), (req, res) => {
    const pairCode = req.body && typeof req.body.pairCode === 'string' ? req.body.pairCode : '';
    const result = phoneCameraPairing.redeemPairingCode(pairCode);
    if (!result) {
      res.status(400).json({ error: 'Code de jumelage invalide ou expiré.' });
      return;
    }
    const lanIp = getLanIpAddress();
    if (lanIp) {
      try {
        ipCameraStore.addItem(
          {
            label: result.label || 'Téléphone (QR)',
            url: `http://${lanIp}:${SERVER_PORT}/phone-camera-stream/${result.cameraId}`,
          },
          cleanupPhoneCameraStateForItem
        );
        broadcast({ action: 'ipCamerasUpdated', items: ipCameraStore.listItems() });
      } catch (err) {
        warn('Phone camera: échec ajout médiathèque IP: ' + err.message);
      }
    }
    log('Phone camera: nouveau téléphone jumelé (' + result.cameraId + ')');
    res.json({ cameraId: result.cameraId, streamSecret: result.streamSecret });
  });

  app.post(
    '/phone-camera-frame/:id',
    express.raw({ type: 'image/jpeg', limit: '2mb' }),
    (req, res) => {
      const cameraId = req.params.id;
      const secret = req.header('X-Stream-Secret') || '';
      if (!phoneCameraPairing.isStreamSecretValid(cameraId, secret)) {
        res.status(403).json({ error: 'Secret de flux invalide.' });
        return;
      }
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        res.status(400).json({ error: 'Image manquante.' });
        return;
      }
      phoneCameraFrames.set(cameraId, { buffer: req.body, receivedAt: Date.now() });
      res.status(204).end();
    }
  );

  app.get('/phone-camera-stream/:id', (req, res) => {
    const cameraId = req.params.id;
    if (!phoneCameraPairing.isCameraPaired(cameraId) || !isFrameFresh(cameraId)) {
      res.status(404).end();
      return;
    }

    const boundary = 'churchoverlayframe';
    res.writeHead(200, {
      'Content-Type': `multipart/x-mixed-replace; boundary=${boundary}`,
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      Pragma: 'no-cache',
      Connection: 'close',
    });

    let lastSentAt = 0;
    const pushTimer = setInterval(() => {
      if (!isFrameFresh(cameraId)) {
        clearInterval(pushTimer);
        try {
          res.end();
        } catch (_e) {
          /* Déjà fermée */
        }
        return;
      }
      const frame = phoneCameraFrames.get(cameraId);
      if (!frame || frame.receivedAt === lastSentAt) return;
      lastSentAt = frame.receivedAt;
      try {
        res.write(
          `--${boundary}\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.buffer.length}\r\n\r\n`
        );
        res.write(frame.buffer);
        res.write('\r\n');
      } catch (_e) {
        /* Client déconnecté */
      }
    }, 150);

    req.on('close', () => clearInterval(pushTimer));
  });
}

module.exports = { registerRoutes, cleanupPhoneCameraStateForItem };
