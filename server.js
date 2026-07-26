/**
 * ============================================================================
 *  server.js — Serveur pont WebSocket pour Overlay Versets (Église Mesev)
 * ----------------------------------------------------------------------------
 *  CHANGELOG v0.3.0 — Suppression complète de Whisper local
 *    1. whisper-wrapper.js n'est plus chargé du tout : plus aucun code ne
 *       peut démarrer whisper-server.exe (c'était le plus gros
 *       consommateur CPU de l'app, ~40-70% d'un cœur en continu quand il
 *       tournait). Transcription = Groq (cloud) → Deepgram (cloud, si
 *       clé) uniquement, voir groq-wrapper.js.
 *    2. console.log / console.error ne sont plus interceptés dans le
 *       worker : ils partaient déjà en double vers le tableau de bord
 *       (une fois via stdout/stderr piping du Worker, une fois via un
 *       postMessage explicite). Un seul chemin reste : stdout/stderr.
 *
 *  CHANGELOG v0.2.1 — Optimisations de Réactivité (Option A + Bonus)
 *    1. TRANSCRIPT_BUFFER_MAX_CHARS: 200 → 500 (meilleure détection)
 *    2. Audio segments réduits à 5s (via audio-capture.js)
 *
 *  CHANGELOG v0.2.0 — Performance & Stability Repair Plan
 *    1. Runs inside a Worker Thread when spawned by main.js
 *       (worker_threads.isMainThread === false, parentPort available).
 *       Backwards-compatible : still runnable as a stand-alone Node process
 *       via `npm run server-only` — the worker-only wiring is gated on
 *       parentPort.
 *    2. Robust temp-file cleanup on SIGINT / SIGTERM / uncaughtException
 *       / parentPort shutdown.
 *
 *  RÔLE ACTUEL :
 *    Relaie tout message JSON reçu d'un client (ex: test-envoi.js, ou plus
 *    tard le pupitre opérateur / pipeline micro) vers tous les autres clients
 *    connectés — en particulier overlay.html ouvert dans OBS Browser Source.
 *
 *  TRANSCRIPTION (course à 2 niveaux, 100% cloud) :
 *    Groq (Whisper large-v3, cloud) → Deepgram (Nova-2, cloud, si clé
 *    configurée). Sans internet, la transcription s'arrête et
 *    transcriptionError est diffusé — il n'y a plus de filet de secours
 *    local.
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
  // CORRECTIF v0.3.0 — logs dupliqués dans le tableau de bord :
  // main.js crée ce Worker avec { stdout: true, stderr: true }, ce qui
  // capture déjà TOUT ce que console.log/warn/error écrit (via
  // worker.stdout / worker.stderr). Un ancien correctif ajoutait EN PLUS
  // un postMessage({ type: 'log', ... }) explicite pour chaque appel —
  // main.js traitait donc les deux, affichant chaque ligne deux fois.
  // On ne garde ici que ce qui n'est pas déjà couvert par stdout/stderr :
  // le canal de statut (status: running/stopped/error) et l'arrêt propre.
  // console.log/warn/error ne sont plus interceptés du tout : le
  // comportement par défaut du Worker (piping vers stdout/stderr) suffit.

  // Graceful shutdown from main.js — triggers the same cleanup path as SIGINT.
  parentPort.on('message', (msg) => {
    if (msg && msg.type === 'shutdown') {
      console.log('\n[server] Message d\'arrêt reçu du thread principal (IPC).');
      process.emit('SIGINT');
    }
    // Ajouté à l'audit : theme-loader.js était déjà branché au dashboard
    // (choix du thème), mais rien ne relayait le changement jusqu'à
    // overlay.html en direct. main.js envoie ce message dès que
    // themeLoader.setActiveTheme() réussit ; on le rediffuse tel quel à
    // tous les overlays connectés (aucun redémarrage du pipeline requis).
    if (msg && msg.type === 'theme-changed' && msg.css) {
      broadcast({ action: 'applyTheme', ...msg.css });
    }

    // CORRECTIF v0.5.0 — main.js relaie chaque bloc PCM16 reçu de
    // capture.html (getUserMedia/AudioWorklet, fenêtre Electron cachée) via
    // worker.postMessage({type:'audio-chunk', buffer}). Ce message n'était
    // jusqu'ici traité nulle part ici : audio-capture.js ne recevait donc
    // jamais aucun échantillon audio malgré tout le reste du branchement
    // déjà en place côté Electron. On le relaie à pushAudioChunk(), qui
    // reprend la même logique de segmentation/chevauchement qu'avant.
    if (msg && msg.type === 'audio-chunk' && msg.buffer) {
      try {
        audioCapture.pushAudioChunk(msg.buffer);
      } catch (e) {
        console.error('[server] Erreur traitement chunk audio:', e.message);
      }
    }
  });
}

const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const groq = require('./groq-wrapper');
const deepgram = require('./deepgram-wrapper');
const audioCapture = require('./audio-capture');
const detector = require('./detector');
const detectorEn = require('./detector-en');

// Détection bilingue : on essaie d'abord le FR (détecteur historique le plus
// éprouvé), puis EN en fallback. Renvoie la première référence trouvée avec
// la langue qui l'a captée (utile pour les logs et l'analytics).
function detectBilingual(text) {
  const fr = detector.detect(text);
  if (fr) return { ...fr, detectedLang: 'fr' };
  const en = detectorEn.detect(text);
  if (en) return { ...en, detectedLang: 'en' };
  return null;
}
const bibleLookup = require('./bible-lookup-with-api');
const { createContextTracker } = require('./context-tracker');
const { validateAndSanitize } = require('./validation');
const { createRateLimiter } = require('./rate-limiter');
const { validateSystemConfig, displayValidationResults } = require('./config-validator');
const themeLoader = require('./theme-loader');

const verseTracker = createContextTracker();
const rateLimiter = createRateLimiter({
  maxConnections: process.env.MAX_CONNECTIONS || 10,
  maxMessagesPerMinute: process.env.MAX_MESSAGES_PER_MINUTE || 60
});

let wss = null;

// --- Buffer de transcription glissant ---------------------------------
// OPTIMISÉ v0.2.1 : 200 → 500 caractères pour meilleure détection
let transcriptBuffer = '';
const TRANSCRIPT_BUFFER_MAX_CHARS = 500;

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

// CORRECTIF (audit) — Les erreurs (transcriptionError, pipelineError,
// audioCaptureError, lookupError) n'étaient diffusées QUE vers les clients
// WebSocket (overlay.html, test-envoi.js). Le tableau de bord (dashboard.html)
// ne les recevait jamais autrement que noyées dans le flux de logs bruts —
// invisibles en pratique pour l'équipe régie (non-technique). On notifie
// maintenant explicitement main.js via l'IPC du Worker, qui pousse une
// alerte visible (bannière) au tableau de bord. Sans effet si lancé en
// standalone (`node server.js`), RUNNING_AS_WORKER étant alors false.
function notifyAlert(code, severity, message) {
  if (!RUNNING_AS_WORKER) return;
  try {
    parentPort.postMessage({ type: 'alert', code, severity, message, timestamp: Date.now() });
  } catch (_) {}
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
  deepgram.isConfigured()
    ? '[server] Deepgram configuré — course Groq → Deepgram.'
    : '[server] Deepgram non configuré — Groq uniquement.'
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

// Langue d'affichage : 'fr', 'en', ou 'both' (FR + EN empilés dans l'overlay).
// Piloté par le dashboard (message setLanguage) ; défaut = 'fr' pour rester
// compatible avec l'existant. Peut aussi être forcé via variable d'env.
let displayLanguage = (process.env.DISPLAY_LANGUAGE || 'fr').toLowerCase();
if (!['fr', 'en', 'both'].includes(displayLanguage)) displayLanguage = 'fr';
console.log(`[server] Langue d'affichage initiale : ${displayLanguage}`);

// Historique en mémoire des N derniers versets diffusés (auto + manuel).
// Utilisé par le dashboard pour la re-diffusion rapide ("rejouer un verset").
// Non persisté sur disque : c'est un buffer volatil, cleared au restart, ce
// qui évite de conserver du contenu bibliophonique après plusieurs services.
const HISTORY_MAX = 30;
const verseHistory = [];
function pushHistory(entry) {
  // Dédoublonnage : si la même référence est ajoutée coup sur coup on remonte
  // simplement l'entrée existante en tête au lieu d'entasser des doublons.
  const key = `${entry.reference}|${entry.langMode || 'fr'}`;
  const idx = verseHistory.findIndex((e) => `${e.reference}|${e.langMode || 'fr'}` === key);
  if (idx !== -1) verseHistory.splice(idx, 1);
  verseHistory.unshift({ ...entry, id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}` });
  if (verseHistory.length > HISTORY_MAX) verseHistory.length = HISTORY_MAX;
}

async function processTranscript(text) {
  console.log('[server] Processing transcript:', text.substring(0, 100));
  const reference = detectBilingual(text);
  if (!reference) { console.log('[server] No reference detected in segment'); return; }
  console.log('[server] Reference detected:', JSON.stringify(reference));

  broadcast({ action: 'candidateVerse', reference, transcript: text, timestamp: Date.now() });

  if (!verseTracker.shouldProcess(reference)) {
    console.log('[server] Reference already processed recently, skipping'); return;
  }
  console.log('[server] Looking up:', bibleLookup.buildReferenceLabel(reference), 'lang:', displayLanguage);

  try {
    const verse = await bibleLookup.getVerseMultilang(reference, displayLanguage);
    const payload = { action: 'showVerse', ...verse, durationMs: 300000, autoDetected: true };
    broadcast(payload);
    pushHistory({
      reference: verse.reference, text: verse.text,
      text_fr: verse.text_fr, text_en: verse.text_en, langMode: verse.langMode,
      provider: verse.provider, autoDetected: true, timestamp: Date.now(),
    });
    broadcast({ action: 'historyUpdated', history: verseHistory });
    console.log('[server] Verse sent to overlay:', verse.reference, `(${displayLanguage})`);
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
    notifyAlert('lookupError', 'warning', `Verset introuvable (${bibleLookup.buildReferenceLabel(reference)}) : ${error.message}`);
  }
}

function startPipeline() {
  console.log('[server] Démarrage de la capture audio…');
  audioCapture.startRecording()
    .then(() => console.log('[server] Capture audio démarrée - Pipeline opérationnel (Groq/Deepgram cloud)'))
    .catch(pipelineStartFailed);
}

function pipelineStartFailed(err) {
  console.error('[server] Erreur lors du démarrage:', err.message);
  console.error('[server] Le serveur continuera sans Speech-to-Text');
  broadcast({ action: 'pipelineError', error: err.message, timestamp: Date.now() });
  notifyAlert('pipelineError', 'error', `Le pipeline n'a pas démarré : ${err.message}`);
}

audioCapture.on({
  onAudioSegment: async (segmentFile) => {
    console.log('[server] Segment audio reçu — traitement…');

    if (isDuplicateSegment(segmentFile)) {
      console.log('[server] Segment déjà traité, ignoré:', segmentFile);
      safeUnlink(segmentFile);
      return;
    }

    try {
      const result = await groq.transcribeWithFallback(segmentFile);
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
      notifyAlert('transcriptionError', 'warning',
        `Transcription indisponible (Groq + Deepgram) : ${error.message}. La détection automatique de versets est interrompue jusqu'au retour du réseau.`);
      safeUnlink(segmentFile);
    }
  },
  onError: (error) => {
    console.error('[server] Erreur capture audio:', error.message);
    broadcast({ action: 'audioCaptureError', error: error.message, timestamp: Date.now() });
    notifyAlert('audioCaptureError', 'error', `Problème micro : ${error.message}`);
  },
});

/** Safe temp file cleanup (never throws — every exit path calls this). */
function safeUnlink(file) {
  try { fs.unlinkSync(file); } catch (_) { /* already gone or locked */ }
}

let compteurClients = 0;

function verifyOrigin(info) {
  const origin = info.origin;
  // Une page HTML chargée en local (overlay.html ouvert directement, sans
  // serveur web devant) n'a pas d'origine web classique. Selon le moteur du
  // navigateur, cette absence d'origine est signalée différemment :
  //   - Chrome/Edge/Firefox classiques -> origin === undefined
  //   - La plupart des Chromium         -> origin === 'null' (chaîne littérale)
  //   - CEF (moteur d'OBS Studio "Source Navigateur")
  //                                     -> origin === 'file://' (littéral)
  // Les trois cas correspondent au même scénario légitime (fichier local,
  // pas un site web tiers) : on les accepte tous les trois. C'est ce
  // dernier cas (CEF/OBS) qui manquait, causant un rejet en boucle de la
  // connexion WebSocket dès qu'overlay.html est ajouté comme Source
  // Navigateur "Fichier local" dans OBS.
  return origin === undefined || origin === 'null' || origin === 'file://';
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

    // Ajouté à l'audit : sans ça, un overlay qui se (re)connecte (ex: OBS
    // relance la Source Navigateur) repartait toujours sur le thème CSS en
    // dur d'overlay.html, pas sur le thème actif choisi dans le dashboard.
    try {
      const activeTheme = themeLoader.getActiveTheme();
      ws.send(JSON.stringify({ action: 'applyTheme', ...themeLoader.themeToCss(activeTheme) }));
    } catch (e) {
      console.warn('[server] Impossible d\'envoyer le thème initial au client #' + idClient + ':', e.message);
    }

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
            groq: !!groq, audioCapture: !!audioCapture,
          },
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

      if (sanitized.action === 'setLanguage') {
        const requested = String(sanitized.language || '').toLowerCase();
        if (!['fr', 'en', 'both'].includes(requested)) {
          ws.send(JSON.stringify({ action: 'error', error: 'Langue invalide (fr | en | both).' }));
          return;
        }
        displayLanguage = requested;
        console.log(`[server] Langue d'affichage changée : ${displayLanguage}`);
        broadcast({ action: 'languageChanged', language: displayLanguage, timestamp: Date.now() });
        return;
      }

      if (sanitized.action === 'setTranslation') {
        try {
          const lang = String(sanitized.language).toLowerCase();
          const code = String(sanitized.code);
          const newId = bibleLookup.setTranslation(lang, code);
          console.log(`[server] Traduction ${lang} changée : ${newId}`);
          broadcast({
            action: 'translationChanged', language: lang, code,
            translationId: newId, translations: bibleLookup.listTranslations(),
            timestamp: Date.now(),
          });
        } catch (e) {
          ws.send(JSON.stringify({ action: 'error', error: e.message }));
        }
        return;
      }

      if (sanitized.action === 'getState') {
        ws.send(JSON.stringify({
          action: 'state',
          language: displayLanguage,
          translations: bibleLookup.listTranslations(),
          history: verseHistory,
        }));
        return;
      }

      if (sanitized.action === 'getHistory') {
        ws.send(JSON.stringify({ action: 'history', history: verseHistory }));
        return;
      }

      if (sanitized.action === 'replayVerse') {
        const entry = verseHistory.find((e) => e.id === sanitized.id);
        if (!entry) {
          ws.send(JSON.stringify({ action: 'error', error: 'Verset introuvable dans l\'historique.' }));
          return;
        }
        // Rediffusion à l'identique — pas de nouvelle requête réseau (déjà en cache),
        // et on ne re-pousse pas dans l'historique (ce serait un doublon).
        broadcast({
          action: 'showVerse',
          reference: entry.reference, text: entry.text,
          text_fr: entry.text_fr, text_en: entry.text_en, langMode: entry.langMode,
          provider: entry.provider, durationMs: Number(sanitized.durationMs) || 300000,
          replayed: true,
        });
        console.log('[server] Verset rejoué :', entry.reference);
        return;
      }

      if (sanitized.action === 'lookupReference') {
        const reference = detectBilingual(sanitized.reference || '');
        if (!reference) {
          ws.send(JSON.stringify({ action: 'lookupError', error: 'Référence biblique non reconnue.' }));
          return;
        }
        try {
          const lang = ['fr', 'en', 'both'].includes(String(sanitized.language || '').toLowerCase())
            ? String(sanitized.language).toLowerCase()
            : displayLanguage;
          const verse = await bibleLookup.getVerseMultilang(reference, lang);
          broadcast({ action: 'showVerse', ...verse, durationMs: Number(sanitized.durationMs) || 300000 }, ws);
          pushHistory({
            reference: verse.reference, text: verse.text,
            text_fr: verse.text_fr, text_en: verse.text_en, langMode: verse.langMode,
            provider: verse.provider, autoDetected: false, timestamp: Date.now(),
          });
          broadcast({ action: 'historyUpdated', history: verseHistory });
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
      console.error('[server] Le port est déjà utilisé — une autre instance de l\'app tourne-t-elle déjà ?');
    }
    // CORRECTIF : avant, une erreur de bind (ex: EADDRINUSE) restait un
    // simple log — le worker ne passait jamais à 'running' ET ne notifiait
    // jamais 'error' non plus, donc main.js/le dashboard restaient bloqués
    // indéfiniment sur "connexion...". On force maintenant un arrêt propre
    // + notification 'error' pour que le dashboard sorte de cet état figé.
    shutdownOnce();
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
