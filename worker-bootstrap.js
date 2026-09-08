'use strict';

/**
 * worker-bootstrap.js — Canal IPC parentPort <-> processus principal
 * (main.js) quand server.js tourne en worker_thread (voir
 * main.js/startServerWorker : recyclage 4h, redémarrage auto, budget
 * 3 crashes/60s — cette logique côté PARENT reste dans main.js, ce module
 * ne couvre que le côté WORKER).
 *
 * Extrait de server.js ("Worker IPC", Phase 3 — modularisation du
 * bootstrap, même chantier que http-bootstrap.js/http-routes.js/
 * phone-camera-routes.js). Comportement identique à l'original,
 * seulement déplacé — dépendances injectées via un objet de contexte.
 *
 * Sans effet si server.js tourne HORS worker_thread (parentPort absent —
 * `node server.js` en dev/test) : wireWorkerIpc() sort immédiatement,
 * comportement identique au `if (parentPort) { ... }` d'origine.
 *
 * NE couvre PAS : la signalisation `audio-pipeline-ready` (reste dans
 * server.js — étape finale de la séquence de démarrage du pipeline audio,
 * pas un message ENTRANT du worker IPC), ni la création de parentPort/
 * workerData elle-même (`require('worker_threads')`, tout en haut de
 * server.js — nécessaire dès la résolution d'APP_ROOT/USER_DATA_DIR, bien
 * avant que ce module existe).
 */

/**
 * @param {object} ctx
 * @param {import('worker_threads').MessagePort|null} ctx.parentPort
 * @param {object} ctx.audioCapture
 * @param {() => void} ctx.stopAmbientMoodLoop
 * @param {import('ws').Server} ctx.wss
 * @param {{ stopCleanup: () => void }} ctx.connRateLimiter
 * @param {{ close: () => void }} ctx.sessionStore
 * @param {() => void} ctx.closeChurchAgent
 * @param {{ shutdown: () => Promise<void> }|null} ctx.plugins
 * @param {(obj: object) => void} ctx.broadcast
 * @param {object} ctx.sessionState
 * @param {(action: string) => void} ctx.handleHotkeyAction
 * @param {(msg: string) => void} ctx.log
 */
function wireWorkerIpc(ctx) {
  const {
    parentPort,
    audioCapture,
    stopAmbientMoodLoop,
    wss,
    connRateLimiter,
    sessionStore,
    closeChurchAgent,
    plugins,
    broadcast,
    sessionState,
    handleHotkeyAction,
    log,
  } = ctx;

  if (!parentPort) return;

  parentPort.on('message', (msg) => {
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'shutdown') {
      log('Shutdown requested by main process');
      audioCapture.stopRecording();
      stopAmbientMoodLoop();
      wss.clients.forEach((ws) => ws.close());
      wss.close();
      connRateLimiter.stopCleanup();
      sessionStore.close();
      closeChurchAgent();
      if (parentPort) parentPort.postMessage({ type: 'status', status: 'stopped' });
      const finish = () => process.exit(0);
      if (plugins) {
        plugins
          .shutdown()
          .catch(() => {})
          .finally(finish);
        setTimeout(finish, 2000).unref?.();
      } else {
        finish();
      }
      return;
    }

    if (msg.type === 'theme-changed') {
      broadcast({ action: 'applyTheme', ...msg.css });
      return;
    }

    if (msg.type === 'obs-gate-changed') {
      sessionState.setObsGate(msg.open, msg.reason || '');
      log(`OBS gate: ${msg.open ? 'OPEN' : 'CLOSED'} (${sessionState.getObsGate().reason})`);
      return;
    }

    // AJOUT (Partie 3.1 — reconnexion automatique) : une coupure OBS en
    // plein culte ne doit jamais être silencieuse — diffusée telle quelle
    // au dashboard (voir action-registry.js, dashboard/ws-dispatch.js).
    if (msg.type === 'obs-connection-status') {
      log(`OBS connexion : ${msg.status} (${msg.reason || ''})`);
      broadcast({ action: 'obsConnectionStatus', status: msg.status, reason: msg.reason || '' });
      return;
    }

    if (msg.type === 'audio-pcm-chunk') {
      audioCapture.feedPcmChunk(Buffer.from(msg.buffer));
      return;
    }

    if (msg.type === 'hotkey-action') {
      handleHotkeyAction(msg.action);
      return;
    }
  });

  parentPort.postMessage({ type: 'status', status: 'running' });

  // AJOUT (mémoire — polish) : perf-monitor.js (main.js) n'échantillonnait
  // que le process principal Electron — le pipeline audio/ASR/Bible réel
  // tourne ici, dans ce worker, resté invisible côté dashboard sur un
  // culte de plusieurs heures. Même cadence que main.js (PERF_PUSH_MS =
  // 2000ms) pour rester cohérent avec l'échantillon déjà affiché.
  const workerMemTimer = setInterval(() => {
    const mem = process.memoryUsage();
    parentPort.postMessage({
      type: 'worker-mem',
      rssMB: Math.round((mem.rss / 1024 / 1024) * 10) / 10,
      heapUsedMB: Math.round((mem.heapUsed / 1024 / 1024) * 10) / 10,
      externalMB: Math.round((mem.external / 1024 / 1024) * 10) / 10,
    });
  }, 2000);
  workerMemTimer.unref();
}

module.exports = { wireWorkerIpc };
