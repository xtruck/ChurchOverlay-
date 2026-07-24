/**
 * ============================================================================
 *  server.js — Serveur pont WebSocket pour Overlay Versets (Église Mesev)
 * ----------------------------------------------------------------------------
 *  CHANGELOG v0.2.0 — Performance & Stability Repair Plan
 *    1. Runs inside a Worker Thread when spawned by main.js
 *       (worker_threads.isMainThread === false, parentPort available).
 *       Backwards-compatible : still runnable as a stand-alone Node process
 *       via `npm run server-only` — the worker-only wiring is gated on
 *       parentPort.
 *    2. CLOUD_ONLY_MODE=1 → whisper-server.exe is NEVER launched. The local
 *       fallback stub just throws so that groq.transcribeWithFallback falls
 *       back to Deepgram (if configured) or reports transcriptionError.
 *       Biggest CPU win : whisper-server.exe was the single biggest CPU
 *       consumer (~40-70% of one core, permanently).
 *    3. Robust temp-file cleanup on SIGINT / SIGTERM / uncaughtException
 *       / parentPort shutdown.
 *    4. Under a worker : console.log / console.error / process.exit are
 *       intercepted so main.js gets everything on the message channel.
 *       process.exit() becomes parentPort.postMessage({type:'exit'}) so the
 *       main thread can observe status transitions cleanly.
 *
 *  RÔLE ACTUEL :
 *    Relaie tout message JSON reçu d'un client (ex: test-envoi.js, ou plus
 *    tard le pupitre opérateur / pipeline micro) vers tous les autres clients
 *    connectés — en particulier overlay.html ouvert dans OBS Browser Source.
 *
 *  TRANSCRIPTION (course à 3 niveaux) :
 *    Groq (Whisper large-v3, cloud) → Deepgram (Nova-2, cloud, si clé) →
 *    Whisper local (whisper-wrapper.js, hors ligne). En CLOUD_ONLY_MODE=1
 *    la 3e étape est court-circuitée (voir localTranscribeFn ci-dessous).
 * ============================================================================
 */

'use strict';

const { isMainThread, parentPort, workerData } = require('worker_threads');
const RUNNING_AS_WORKER = !isMainThread && !!parentPort;

// -----------------------------------------------------------------------
// Worker plumbing : forward console output + graceful shutdown via IPC.
// Gated on RUNNING_AS_WORKER so `node server.js` behaviour is unchanged.
// -----------------------------------------------------------------------
if (RUNNING_AS_WORKER) {
  const origLog = console.log.bind(console);
  const origErr = console.error.bind(console);
  const origWarn = console.warn.bind(console);

  const format = (args) => args.map((a) => {
    if (typeof a === 'string') return a;
    try { return JSON.stringify(a); } catch (_) { return String(a); }
  }).join(' ');

  console.log = (...args) => {
    const text = format(args);
    try { parentPort.postMessage({ type: 'log', text, isError: false }); } catch (_) {}
    origLog(...args);
  };
  console.warn = (...args) => {
    const text = format(args);
    try { parentPort.postMessage({ type: 'log', text, isError: false }); } catch (_) {}
    origWarn(...args);
  };
  console.error = (...args) => {
    const text = format(args);
    try { parentPort.postMessage({ type: 'log', text, isError: true }); } catch (_) {}
    origErr(...args);
  };

  // Graceful shutdown from main.js — triggers the same cleanup path as SIGINT.
  parentPort.on('message', (msg) => {
    if (msg && msg.type === 'shutdown') {
      console.log('\n[server] Message d\'arrêt reçu du thread principal (IPC).');
      process.emit('SIGINT');
    }
  });
}

const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const whisper = require('./whisper-wrapper');
const groq = require('./groq-wrapper');
const deepgram = require('./deepgram-wrapper');
const audioCapture = require('./audio-capture');
const detector = require('./detector');
const bibleLookup = require('./bible-lookup-with-api');
const { createContextTracker } = require('./context-tracker');
const { validateAndSanitize } = require('./validation');
const { createRateLimiter } = require('./rate-limiter');
const { validateSystemConfig, displayValidationResults } = require('./config-validator');

const CLOUD_ONLY_MODE = process.env.CLOUD_ONLY_MODE === '1' ||
                       String(process.env.CLOUD_ONLY_MODE || '').toLowerCase() === 'true';

const verseTracker = createContextTracker();
const rateLimiter = createRateLimiter({
  maxConnections: process.env.MAX_CONNECTIONS || 10,
  maxMessagesPerMinute: process.env.MAX_MESSAGES_PER_MINUTE || 60
});

let wss = null;

// --- Buffer de transcription glissant ---------------------------------
let transcriptBuffer = '';
const TRANSCRIPT_BUFFER_MAX_CHARS = 200;

function pushToBuffer(text) {
  if (!text) return transcriptBuffer;
  const isContinuation = transcriptBuffer.length > 0 &&
                         !transcriptBuffer.endsWith(' ') &&
                         !transcriptBuffer.endsWith('.') &&
                         !transcriptBuffer.endsWith(',');
  if (isContinuation) {
    transcriptBuffer += ' ' + text;
  } else {
    if (text.startsWith('.') || text.startsWith('!') || text.startsWith('?')) {
      transcriptBuffer = text;
    } else {
      transcriptBuffer = (transcriptBuffer + ' ' + text).trim();
    }
  }
  if (transcriptBuffer.length > TRANSCRIPT_BUFFER_MAX_CHARS) {
    transcriptBuffer = transcriptBuffer.slice(-TRANSCRIPT_BUFFER_MAX_CHARS);
    const firstSpace = transcriptBuffer.indexOf(' ');
    if (firstSpace > 0 && firstSpace < 50) {
      transcriptBuffer = transcriptBuffer.slice(firstSpace + 1);
    }
  }
  return transcriptBuffer.trim();
}

function resetBuffer() { transcriptBuffer = ''; }

// --- Duplicate segment prevention --------------------------------------
const processedSegments = new Set();
const MAX_PROCESSED_SEGMENTS = 50;
function isDuplicateSegment(segmentFile) {
  const segmentId = segmentFile.split(/[\\/]/).pop().replace('.wav', '');
  if (processedSegments.has(segmentId)) return true;
  processedSegments.add(segmentId);
  if (processedSegments.size > MAX_PROCESSED_SEGMENTS) {
    const firstKey = processedSegments.values().next().value;
    processedSegments.delete(firstKey);
  }
  return false;
}

function broadcast(payload, except) {
  if (!wss) return;
  const message = JSON.stringify(payload);
  wss.clients.forEach((client) => {
    if (client !== except && client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}

console.log(
  CLOUD_ONLY_MODE
    ? '[server] CLOUD_ONLY_MODE=1 — Whisper local désactivé, transcription 100% cloud.'
    : (deepgram.isConfigured()
        ? '[server] Deepgram configuré — course Groq → Deepgram → local.'
        : '[server] Deepgram non configuré — course Groq → local.')
);

// Config validation puis démarrage
console.log('[server] Validation de la configuration...');
validateSystemConfig()
  .then(configValidation => {
    displayValidationResults(configValidation);
    if (!configValidation.valid) {
      console.error('[server] Erreur de configuration critique. Arrêt du serveur.');
      workerSafeExit(1);
      return;
    }
    const PORT = configValidation.config.PORT;
    console.log(`[server] Configuration validée, démarrage sur le port ${PORT}`);
    startServer(PORT);
  })
  .catch(error => {
    console.error('[server] Erreur lors de la validation de la configuration:', error.message);
    workerSafeExit(1);
  });

async function processTranscript(text) {
  console.log('[server] Processing transcript:', text.substring(0, 100));
  const reference = detector.detect(text);
  if (!reference) { console.log('[server] No reference detected in segment'); return; }
  console.log('[server] Reference detected:', JSON.stringify(reference));

  broadcast({ action: 'candidateVerse', reference, transcript: text, timestamp: Date.now() });

  if (!verseTracker.shouldProcess(reference)) {
    console.log('[server] Reference already processed recently, skipping'); return;
  }
  console.log('[server] Looking up:', bibleLookup.buildReferenceLabel(reference));

  try {
    const verse = await bibleLookup.getVerse(reference);
    broadcast({ action: 'showVerse', ...verse, durationMs: 300000, autoDetected: true });
    console.log('[server] Verse sent to overlay:', verse.reference);
    bibleLookup.resetFailedProviders();
  } catch (error) {
    console.warn('[server] Bible lookup unavailable:', error.message);
    broadcast({
      action: 'showVerse',
      reference: bibleLookup.buildReferenceLabel(reference),
      text: '(Texte non disponible - vérifiez la connexion internet)',
      provider: 'error', durationMs: 300000, autoDetected: true,
    });
    broadcast({ action: 'lookupError', reference, error: error.message, timestamp: Date.now() });
  }
}

// -----------------------------------------------------------------------
// Local transcription function passed to groq.transcribeWithFallback.
// In CLOUD_ONLY_MODE we deliberately reject so the fallback chain stops
// at the cloud tier — never launches whisper-server.exe, never touches
// CPU for local decoding.
// -----------------------------------------------------------------------
const localTranscribeFn = CLOUD_ONLY_MODE
  ? () => Promise.reject(new Error('CLOUD_ONLY_MODE : Whisper local désactivé'))
  : (p) => whisper.transcribeFile(p);

function startPipeline() {
  if (CLOUD_ONLY_MODE) {
    console.log('[server] CLOUD_ONLY_MODE : whisper-server.exe NON démarré. Démarrage de la capture audio…');
    audioCapture.startRecording()
      .then(() => console.log('[server] Capture audio démarrée - Pipeline cloud-only opérationnel'))
      .catch(pipelineStartFailed);
    return;
  }

  console.log('[server] Starting Whisper Speech-to-Text...');
  whisper.startServer()
    .then(() => {
      console.log('[server] Whisper Speech-to-Text prêt et opérationnel');
      console.log('[server] Démarrage de la capture audio...');
      return audioCapture.startRecording();
    })
    .then(() => console.log('[server] Capture audio démarrée - Pipeline complet opérationnel'))
    .catch(pipelineStartFailed);
}

function pipelineStartFailed(err) {
  console.error('[server] Erreur lors du démarrage:', err.message);
  if (err.message.includes('FFmpeg')) {
    console.error('[server] FFmpeg n\'est pas installé - Pipeline audio désactivé');
  } else if (err.message.includes('whisper-server.exe')) {
    console.error('[server] Whisper server non trouvé - Pipeline audio désactivé');
  } else {
    console.error('[server] Le serveur continuera sans Speech-to-Text');
  }
  broadcast({ action: 'pipelineError', error: err.message, timestamp: Date.now() });
}

// Whisper callbacks (log-only path, see comment in original file)
whisper.on({
  onTranscript: (result) => {
    console.log('[server] (log) Transcription whisper reçue en interne:', result.text || '(sans texte)');
  },
  onError: (error) => {
    console.error('[server] Erreur Whisper:', error.message || error);
    broadcast({
      action: 'pipelineError',
      error: 'Whisper local : ' + (error.message || String(error)),
      timestamp: Date.now(),
    });
  },
});

audioCapture.on({
  onAudioSegment: async (segmentFile) => {
    console.log('[server] Segment audio reçu — traitement…');

    if (isDuplicateSegment(segmentFile)) {
      console.log('[server] Segment déjà traité, ignoré:', segmentFile);
      safeUnlink(segmentFile);
      return;
    }

    try {
      const result = await groq.transcribeWithFallback(segmentFile, localTranscribeFn);
      console.log('[server] Transcription (%s):', result.source, result.text || '(sans texte)');

      if (result.source === 'groq' || result.source === 'deepgram') {
        console.log('[server] Résultat cloud (%s) - reset du buffer de transcription', result.source);
        resetBuffer();
      }

      broadcast({ action: 'transcript', text: result.text || '', source: result.source, timestamp: Date.now() });

      const windowed = pushToBuffer(result.text || '');
      await processTranscript(windowed);

      safeUnlink(segmentFile);
    } catch (error) {
      console.error('[server] Erreur lors de la transcription:', error.message);
      broadcast({ action: 'transcriptionError', error: error.message, timestamp: Date.now() });
      safeUnlink(segmentFile);
    }
  },
  onError: (error) => {
    console.error('[server] Erreur capture audio:', error.message);
    broadcast({ action: 'audioCaptureError', error: error.message, timestamp: Date.now() });
  },
});

/** Safe temp file cleanup (never throws — every exit path calls this). */
function safeUnlink(file) {
  try { fs.unlinkSync(file); } catch (_) { /* already gone or locked */ }
}

let compteurClients = 0;

function verifyOrigin(info) {
  const origin = info.origin;
  return origin === undefined || origin === 'null';
}

function startServer(PORT) {
  const HOST = process.env.WS_HOST || '127.0.0.1';
  wss = new WebSocket.Server({
    host: HOST,
    port: PORT,
    verifyClient: (info) => {
      const allowed = verifyOrigin(info);
      if (!allowed) console.warn(`[server] Connexion refusée : origine non autorisée ("${info.origin}")`);
      return allowed;
    },
  }, () => {
    startPipeline();
    console.log('[server] Serveur WebSocket démarré sur ws://' + HOST + ':' + PORT);
    console.log('[server] En attente de connexions (overlay.html dans OBS, test-envoi.js, ...).');
    if (RUNNING_AS_WORKER) {
      try { parentPort.postMessage({ type: 'status', status: 'running' }); } catch (_) {}
    }
  });

  const heartbeat = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (ws.isAlive === false) {
        console.log('[server] Client stale détecté, déconnexion forcée');
        return ws.terminate();
      }
      ws.isAlive = false;
      ws.ping();
    });
  }, 30000);

  wss.on('close', () => clearInterval(heartbeat));

  wss.on('connection', (ws) => {
    const connectionCheck = rateLimiter.checkConnection(ws);
    if (!connectionCheck.allowed) {
      console.warn('[server] Connexion rejetée:', connectionCheck.reason);
      ws.send(JSON.stringify({ action: 'error', error: connectionCheck.reason }));
      ws.close();
      return;
    }

    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    compteurClients++;
    const idClient = compteurClients;
    console.log('[server] Client #' + idClient + ' connecté. (' + wss.clients.size + ' client(s) au total)');

    ws.on('message', async (data) => {
      const messageCheck = rateLimiter.checkMessage(ws);
      if (!messageCheck.allowed) {
        console.warn('[server] Message rejeté pour client #' + idClient + ':', messageCheck.reason);
        ws.send(JSON.stringify({ action: 'error', error: messageCheck.reason }));
        return;
      }

      const message = data.toString();
      let parsed;
      try { parsed = JSON.parse(message); }
      catch (e) {
        console.warn('[server] Message ignoré du client #' + idClient + ' (JSON invalide) :', message);
        ws.send(JSON.stringify({ action: 'error', error: 'Format JSON invalide' }));
        return;
      }

      const validation = validateAndSanitize(parsed);
      if (!validation.valid) {
        console.warn('[server] Message rejeté du client #' + idClient + ' :', validation.error);
        ws.send(JSON.stringify({ action: 'error', error: validation.error }));
        return;
      }

      const sanitized = validation.sanitized;
      console.log('[server] Message validé depuis client #' + idClient + ' :', sanitized.action);

      if (sanitized.action === 'diagnostic') {
        const diagnostics = {
          action: 'diagnosticResult',
          timestamp: Date.now(),
          modules: {
            detector: !!detector, bibleLookup: !!bibleLookup,
            groq: !!groq, whisper: !!whisper, audioCapture: !!audioCapture,
          },
          cloudOnlyMode: CLOUD_ONLY_MODE,
          providers: bibleLookup.getProviders(),
          cacheSize: bibleLookup.getCacheSize ? bibleLookup.getCacheSize() : 'unknown',
          connections: wss.clients.size,
          transcriptBuffer: transcriptBuffer.length,
        };
        try {
          const testResult = await bibleLookup.getVerse({ book: 'jean', chapter: 3, verseStart: 16 });
          diagnostics.bibleApiTest = {
            success: true,
            text: testResult.text.substring(0, 100) + '...',
            provider: testResult.provider,
          };
        } catch (error) {
          diagnostics.bibleApiTest = { success: false, error: error.message };
        }
        ws.send(JSON.stringify(diagnostics));
        return;
      }

      if (sanitized.action === 'lookupReference') {
        const reference = detector.detect(sanitized.reference || '');
        if (!reference) {
          ws.send(JSON.stringify({ action: 'lookupError', error: 'Référence biblique non reconnue.' }));
          return;
        }
        try {
          const verse = await bibleLookup.getVerse(reference);
          broadcast({ action: 'showVerse', ...verse, durationMs: Number(sanitized.durationMs) || 300000 }, ws);
        } catch (error) {
          ws.send(JSON.stringify({ action: 'lookupError', reference, error: error.message }));
        }
        return;
      }

      const sanitizedMessage = JSON.stringify(sanitized);
      wss.clients.forEach((client) => {
        if (client !== ws && client.readyState === WebSocket.OPEN) client.send(sanitizedMessage);
      });
    });

    ws.on('close', () => {
      rateLimiter.removeConnection(ws);
      console.log('[server] Client #' + idClient + ' déconnecté. (' + wss.clients.size + ' client(s) restant(s))');
    });
    ws.on('error', (err) => console.error('[server] Erreur sur le client #' + idClient + ' :', err.message));
  });

  wss.on('error', (err) => {
    console.error('[server] Erreur serveur :', err.message);
    if (err.code === 'EADDRINUSE') {
      console.error('[server] Le port est déjà utilisé — un autre server.js tourne-t-il déjà ?');
    }
  });

  // --- Cleanup on EVERY exit path ----------------------------------------
  const shutdownOnce = createOnce(() => shutdown(heartbeat));
  process.on('SIGINT', shutdownOnce);
  process.on('SIGTERM', shutdownOnce);
  process.on('uncaughtException', (err) => {
    console.error('[server] uncaughtException:', err && err.stack || err);
    shutdownOnce();
  });
  process.on('unhandledRejection', (reason) => {
    console.error('[server] unhandledRejection:', reason && (reason.stack || reason));
  });
}

function createOnce(fn) {
  let called = false;
  return (...args) => { if (called) return; called = true; try { fn(...args); } catch (_) {} };
}

function shutdown(heartbeat) {
  console.log('\n[server] Arrêt du serveur...');
  if (heartbeat) clearInterval(heartbeat);
  if (rateLimiter && rateLimiter.stopCleanup) rateLimiter.stopCleanup();
  if (wss) {
    try {
      wss.clients.forEach((client) => { try { client.close(1000, 'Server shutting down'); } catch (_) {} });
    } catch (_) {}
  }

  const cleanup = () => {
    try { audioCapture.cleanupTempFiles({ force: true }); } catch (_) {}
    console.log('[server] Nettoyage terminé');
    workerSafeExit(0);
  };

  audioCapture.stopRecording()
    .then(() => {
      console.log('[server] Capture audio arrêtée');
      if (CLOUD_ONLY_MODE) return Promise.resolve();
      return whisper.stopServer();
    })
    .then(() => {
      if (!CLOUD_ONLY_MODE) console.log('[server] Whisper arrêté');
      cleanup();
    })
    .catch((err) => {
      console.error('[server] Erreur lors de l\'arrêt:', err.message);
      cleanup();
    });

  // Absolute deadline — no matter what, we don't hang the worker exit.
  setTimeout(() => {
    console.warn('[server] Deadline d\'arrêt (7s) — sortie forcée après cleanup.');
    try { audioCapture.cleanupTempFiles({ force: true }); } catch (_) {}
    workerSafeExit(0);
  }, 7000).unref?.();
}

/**
 * Under a worker, process.exit() kills only the worker (which is what we
 * want), but we also notify the parent so it can distinguish "stopped
 * cleanly" from "crashed". Under stand-alone Node, this is just process.exit.
 */
function workerSafeExit(code) {
  if (RUNNING_AS_WORKER) {
    try { parentPort.postMessage({ type: 'status', status: code === 0 ? 'stopped' : 'error' }); } catch (_) {}
  }
  process.exit(code);
}
