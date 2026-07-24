/**
 * ============================================================================
 *  server.js — Serveur pont WebSocket pour Overlay Versets (Église Mesev)
 * ----------------------------------------------------------------------------
 *  RÔLE ACTUEL (étape 4) :
 *    Relaie tout message JSON reçu d'un client (ex: test-envoi.js, ou plus
 *    tard le pupitre opérateur / pipeline micro) vers tous les autres clients
 *    connectés — en particulier overlay.html ouvert dans OBS Browser Source.
 *
 *  ÉVOLUTION PRÉVUE (étape 5) :
 *    Ce même fichier accueillera la capture micro en continu, la connexion
 *    au service Speech-to-Text, puis le branchement de detector.js +
 *    context-tracker.js + bible-lookup.js. Au lieu d'un simple relais, il
 *    construira lui-même les messages { action: "showVerse", ... } et les
 *    enverra directement aux clients connectés (overlay.html), sans passer
 *    par un envoi externe.
 *
 *  TRANSCRIPTION (étape 5, mise à jour) :
 *    Chaque segment audio est envoyé en parallèle à Groq (Whisper large-v3,
 *    cloud, précision prioritaire) et à Whisper local (whisper-wrapper.js).
 *    Le serveur attend Groq jusqu'à 5 secondes ; en cas de timeout ou
 *    d'échec, il bascule automatiquement sur le résultat local déjà en
 *    cours — l'overlay n'est jamais vide. Voir groq-wrapper.js.
 *
 *  BUFFER DE TRANSCRIPTION (correctif) :
 *    Les segments audio font ~6.1s chacun. Une référence biblique prononcée
 *    à cheval sur deux segments (ex: "Jean 3" en fin de segment N, "17" en
 *    début de segment N+1) n'était auparavant JAMAIS détectée, car
 *    detector.detect() ne recevait que le texte d'un seul segment à la fois.
 *    On maintient donc une fenêtre glissante (les ~200 derniers caractères
 *    transcrits, tous segments confondus) et on lance la détection sur cette
 *    fenêtre plutôt que sur le texte du segment isolé. context-tracker.js
 *    continue de filtrer les doublons, donc repasser plusieurs fois sur un
 *    texte qui se chevauche ne réaffiche pas le même verset en boucle.
 *
 *  BIBLE LOOKUP (mise à jour) :
 *    Utilise bible-lookup-with-api.js, qui récupère le texte français
 *    (Louis Segond 1910) via bible.helloao.org — API JSON gratuite, sans
 *    clé requise. Un chapitre entier est mis en cache pour éviter de le
 *    re-télécharger à chaque verset demandé dedans.
 *
 *  DÉMARRAGE :
 *    npm install ws        (une seule fois)
 *    cp .env.example .env  (configurer une fois)
 *    node server.js
 *
 *  Le serveur écoute par défaut sur ws://localhost:8765 — doit correspondre
 *  à WS_URL dans overlay.html.
 * ============================================================================
 */

const WebSocket = require('ws');
const fs = require('fs');
const whisper = require('./whisper-wrapper');
const groq = require('./groq-wrapper');
const audioCapture = require('./audio-capture');
const detector = require('./detector');
const bibleLookup = require('./bible-lookup-with-api'); // ✅ Updated to use free API
const { createContextTracker } = require('./context-tracker');
const { validateAndSanitize } = require('./validation');
const { createRateLimiter } = require('./rate-limiter');
const { validateSystemConfig, displayValidationResults } = require('./config-validator');

const verseTracker = createContextTracker();
const rateLimiter = createRateLimiter({
  maxConnections: process.env.MAX_CONNECTIONS || 10,
  maxMessagesPerMinute: process.env.MAX_MESSAGES_PER_MINUTE || 60
});

let wss = null; // Sera initialisé après la validation

// --- Buffer de transcription glissant ---------------------------------
// Concatène le texte des derniers segments pour ne pas perdre une
// référence biblique coupée entre deux segments audio consécutifs.
let transcriptBuffer = '';
const TRANSCRIPT_BUFFER_MAX_CHARS = 200; // ~2 segments de contexte

function pushToBuffer(text) {
  if (!text) return transcriptBuffer;
  
  // If the buffer ends mid-word, the new text is likely a continuation
  const isContinuation = transcriptBuffer.length > 0 && 
                         !transcriptBuffer.endsWith(' ') && 
                         !transcriptBuffer.endsWith('.') && 
                         !transcriptBuffer.endsWith(',');
  
  if (isContinuation) {
    transcriptBuffer += ' ' + text;
  } else {
    // Start fresh if it's a new sentence
    if (text.startsWith('.') || text.startsWith('!') || text.startsWith('?')) {
      transcriptBuffer = text;
    } else {
      transcriptBuffer = (transcriptBuffer + ' ' + text).trim();
    }
  }
  
  // Trim from the beginning if too long
  if (transcriptBuffer.length > TRANSCRIPT_BUFFER_MAX_CHARS) {
    transcriptBuffer = transcriptBuffer.slice(-TRANSCRIPT_BUFFER_MAX_CHARS);
    // Try to start at a word boundary
    const firstSpace = transcriptBuffer.indexOf(' ');
    if (firstSpace > 0 && firstSpace < 50) {
      transcriptBuffer = transcriptBuffer.slice(firstSpace + 1);
    }
  }
  
  return transcriptBuffer.trim();
}

// Reset buffer when Groq provides a clean transcription
function resetBuffer() {
  transcriptBuffer = '';
}
// ------------------------------------------------------------------------

// --- Duplicate segment prevention --------------------------------------
const processedSegments = new Set();
const MAX_PROCESSED_SEGMENTS = 50;

function isDuplicateSegment(segmentFile) {
  const segmentId = segmentFile.split('/').pop().replace('.wav', '');
  if (processedSegments.has(segmentId)) {
    return true;
  }
  processedSegments.add(segmentId);
  if (processedSegments.size > MAX_PROCESSED_SEGMENTS) {
    const firstKey = processedSegments.values().next().value;
    processedSegments.delete(firstKey);
  }
  return false;
}
// ------------------------------------------------------------------------

function broadcast(payload, except) {
  if (!wss) return;
  const message = JSON.stringify(payload);
  wss.clients.forEach((client) => {
    if (client !== except && client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}

// Validation de la configuration au démarrage
console.log('[server] Validation de la configuration...');
validateSystemConfig()
  .then(configValidation => {
    displayValidationResults(configValidation);
    
    if (!configValidation.valid) {
      console.error('[server] Erreur de configuration critique. Arrêt du serveur.');
      process.exit(1);
    }
    
    // Utiliser la configuration validée
    const PORT = configValidation.config.PORT;
    console.log(`[server] Configuration validée, démarrage sur le port ${PORT}`);
    return PORT;
  })
  .catch(error => {
    console.error('[server] Erreur lors de la validation de la configuration:', error.message);
    process.exit(1);
  })
  .then(PORT => {
    // Continuer avec le démarrage normal
    startServer(PORT);
  })
  .catch(error => {
    console.error('[server] Erreur au démarrage:', error.message);
    process.exit(1);
  });

async function processTranscript(text) {
  console.log('[server] Processing transcript:', text.substring(0, 100));
  
  const reference = detector.detect(text);
  if (!reference) {
    console.log('[server] No reference detected in segment');
    return;
  }
  
  console.log('[server] Reference detected:', JSON.stringify(reference));
  
  broadcast({ 
    action: 'candidateVerse', 
    reference, 
    transcript: text, 
    timestamp: Date.now() 
  });
  
  if (!verseTracker.shouldProcess(reference)) {
    console.log('[server] Reference already processed recently, skipping');
    return;
  }
  
  console.log('[server] Looking up:', bibleLookup.buildReferenceLabel(reference));
  
  try {
    const verse = await bibleLookup.getVerse(reference);
    broadcast({ 
      action: 'showVerse', 
      ...verse, 
      durationMs: 300000, 
      autoDetected: true 
    });
    console.log('[server] Verse sent to overlay:', verse.reference);
    
    // Reset failed providers on success
    bibleLookup.resetFailedProviders();
    
  } catch (error) {
    console.warn('[server] Bible lookup unavailable:', error.message);
    
    // Still show the reference even if lookup failed
    broadcast({ 
      action: 'showVerse', 
      reference: bibleLookup.buildReferenceLabel(reference),
      text: '(Texte non disponible - vérifiez la connexion internet)',
      provider: 'error',
      durationMs: 300000,
      autoDetected: true 
    });
    
    broadcast({ 
      action: 'lookupError', 
      reference, 
      error: error.message, 
      timestamp: Date.now() 
    });
    
    // DO NOT reset failed providers on error - they need to cool down
  }
}

// Démarrage du serveur Whisper au démarrage de server.js
console.log('[server] Démarrage du serveur Whisper Speech-to-Text...');

function startPipeline() {
  console.log('[server] Starting Whisper Speech-to-Text...');
  whisper.startServer()
  .then(() => {
    console.log('[server] Whisper Speech-to-Text prêt et opérationnel');
    
    // Démarrer la capture audio après que Whisper soit prêt
    console.log('[server] Démarrage de la capture audio...');
    return audioCapture.startRecording();
  })
  .then(() => {
    console.log('[server] Capture audio démarrée - Pipeline complet opérationnel');
  })
  .catch((err) => {
    console.error('[server] Erreur lors du démarrage:', err.message);
    if (err.message.includes('FFmpeg')) {
      console.error('[server] FFmpeg n\'est pas installé - Pipeline audio désactivé');
      console.error('[server] Installez FFmpeg et ajoutez-le au PATH pour activer la capture audio');
    } else if (err.message.includes('whisper-server.exe')) {
      console.error('[server] Whisper server non trouvé - Pipeline audio désactivé');
      console.error('[server] Vérifiez que whisper-server.exe est dans le dossier whisper/');
    } else {
      console.error('[server] Le serveur continuera sans Speech-to-Text');
    }
    // Notifier les clients connectés que le pipeline audio est indisponible
    broadcast({ action: 'pipelineError', error: err.message, timestamp: Date.now() });
  });
}

// Configuration des callbacks Whisper
// NOTE : ce bloc reste en place comme filet de sécurité / log si
// whisper.transcribeFile est appelé ailleurs (ex. tests). Le flux
// principal de transcription passe désormais par onAudioSegment
// ci-dessous, via groq.transcribeWithFallback.
whisper.on({
  onTranscript: (result) => {
    // LOG UNIQUEMENT — ne rien broadcaster ni traiter ici.
    // whisper.transcribeFile() déclenche ce callback à CHAQUE appel, y
    // compris ceux faits en interne par groq.transcribeWithFallback()
    // (via onAudioSegment ci-dessous). Si ce callback traitait aussi le
    // texte (buffer, detection, bible lookup), chaque segment audio était
    // traité deux fois : une fois ici, une fois dans onAudioSegment.
    // Le traitement réel du texte transcrit vit exclusivement dans
    // audioCapture.on({ onAudioSegment }) plus bas.
    console.log('[server] (log) Transcription whisper reçue en interne:', result.text || '(sans texte)');
  },
  onError: (error) => {
    console.error('[server] Erreur Whisper:', error);
  },
});

// Configuration des callbacks audio-capture
audioCapture.on({
  onAudioSegment: async (segmentFile) => {
    console.log('[server] Segment audio reçu, envoi vers Groq + Whisper local...');
    
    // Prevent duplicate processing
    if (isDuplicateSegment(segmentFile)) {
      console.log('[server] Segment déjà traité, ignoré:', segmentFile);
      try { fs.unlinkSync(segmentFile); } catch {}
      return;
    }

    try {
      // Attend Groq (précision), avec fallback automatique sur le
      // whisper local si Groq ne répond pas en 5s ou échoue.
      const result = await groq.transcribeWithFallback(
        segmentFile,
        (path) => whisper.transcribeFile(path),
      );

      console.log(
        '[server] Transcription (%s):',
        result.source,
        result.text || '(sans texte)'
      );

      // If Groq provided the result, it's more accurate - reset buffer
      if (result.source === 'groq') {
        console.log('[server] Groq result - resetting transcript buffer');
        resetBuffer();
      }

      // Relayer vers les clients connectés (overlay.html), en gardant
      // la même forme de message qu'avant (+ la source utilisée).
      broadcast({
        action: 'transcript',
        text: result.text || '',
        source: result.source,
        timestamp: Date.now(),
      });

      // Fenêtre glissante : on détecte sur le texte accumulé des derniers
      // segments, pas seulement sur ce segment isolé, pour ne pas perdre
      // une référence coupée entre deux segments (ex: "Jean 3" / "17").
      const windowed = pushToBuffer(result.text || '');
      await processTranscript(windowed);

      // Nettoyer le fichier temporaire après transcription
      try {
        fs.unlinkSync(segmentFile);
      } catch (e) {
        console.warn('[server] Impossible de supprimer le fichier temporaire:', segmentFile);
      }
    } catch (error) {
      console.error('[server] Erreur lors de la transcription:', error.message);
      // Notifier les clients de l'erreur de transcription
      broadcast({ 
        action: 'transcriptionError', 
        error: error.message, 
        timestamp: Date.now() 
      });

      // Nettoyer quand même le fichier temporaire
      try {
        fs.unlinkSync(segmentFile);
      } catch (e) {
        console.warn('[server] Impossible de supprimer le fichier temporaire après erreur:', segmentFile);
      }
    }
  },
  onError: (error) => {
    console.error('[server] Erreur capture audio:', error.message);
    broadcast({ 
      action: 'audioCaptureError', 
      error: error.message, 
      timestamp: Date.now() 
    });
  },
});

let compteurClients = 0;

/**
 * Démarre le serveur WebSocket avec le port spécifié
 * @param {number} PORT - Port d'écoute
 */
function startServer(PORT) {
  // Toujours lié à la machine locale : aucun message showVerse/lookupReference
  // ne doit pouvoir venir d'un autre poste sur le réseau pendant un culte.
  const HOST = process.env.WS_HOST || '127.0.0.1';
  wss = new WebSocket.Server({ host: HOST, port: PORT }, () => {
    startPipeline();
    console.log('[server] Serveur WebSocket démarré sur ws://' + HOST + ':' + PORT);
    console.log('[server] En attente de connexions (overlay.html dans OBS, test-envoi.js, ...).');
  });

  // Heartbeat pour détecter les connexions mortes
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

  wss.on('close', () => {
    clearInterval(heartbeat);
  });

  wss.on('connection', (ws) => {
    // Vérifier le rate limiting pour les connexions
    const connectionCheck = rateLimiter.checkConnection(ws);
    if (!connectionCheck.allowed) {
      console.warn('[server] Connexion rejetée:', connectionCheck.reason);
      ws.send(JSON.stringify({ action: 'error', error: connectionCheck.reason }));
      ws.close();
      return;
    }

    ws.isAlive = true;
    ws.on('pong', () => {
      ws.isAlive = true;
    });

    compteurClients++;
    const idClient = compteurClients;
    console.log('[server] Client #' + idClient + ' connecté. (' + wss.clients.size + ' client(s) au total)');

    ws.on('message', async (data) => {
      // Vérifier le rate limiting pour les messages
      const messageCheck = rateLimiter.checkMessage(ws);
      if (!messageCheck.allowed) {
        console.warn('[server] Message rejeté pour client #' + idClient + ':', messageCheck.reason);
        ws.send(JSON.stringify({ action: 'error', error: messageCheck.reason }));
        return;
      }

      const message = data.toString();

      // Validation et nettoyage du message
      let parsed;
      try {
        parsed = JSON.parse(message);
      } catch (e) {
        console.warn('[server] Message ignoré du client #' + idClient + ' (JSON invalide) :', message);
        ws.send(JSON.stringify({ action: 'error', error: 'Format JSON invalide' }));
        return;
      }

      // Validation approfondie avec le module de validation
      const validation = validateAndSanitize(parsed);
      if (!validation.valid) {
        console.warn('[server] Message rejeté du client #' + idClient + ' :', validation.error);
        ws.send(JSON.stringify({ action: 'error', error: validation.error }));
        return;
      }

      const sanitized = validation.sanitized;
      console.log('[server] Message validé depuis client #' + idClient + ' :', sanitized.action);

      // Diagnostic endpoint
      if (sanitized.action === 'diagnostic') {
        const diagnostics = {
          action: 'diagnosticResult',
          timestamp: Date.now(),
          modules: {
            detector: !!detector,
            bibleLookup: !!bibleLookup,
            groq: !!groq,
            whisper: !!whisper,
            audioCapture: !!audioCapture,
          },
          providers: bibleLookup.getProviders(),
          cacheSize: bibleLookup.getCacheSize ? bibleLookup.getCacheSize() : 'unknown',
          connections: wss.clients.size,
          transcriptBuffer: transcriptBuffer.length
        };
        
        // Test a known verse
        try {
          const testResult = await bibleLookup.getVerse({ book: 'jean', chapter: 3, verseStart: 16 });
          diagnostics.bibleApiTest = { 
            success: true, 
            text: testResult.text.substring(0, 100) + '...',
            provider: testResult.provider
          };
        } catch (error) {
          diagnostics.bibleApiTest = { 
            success: false, 
            error: error.message 
          };
        }
        
        ws.send(JSON.stringify(diagnostics));
        return;
      }

      // Usage depuis un pupitre opérateur : { action: 'lookupReference', reference: 'Jean 3:16' }.
      if (sanitized.action === 'lookupReference') {
        const reference = detector.detect(sanitized.reference || '');
        if (!reference) {
          ws.send(JSON.stringify({ action: 'lookupError', error: 'Référence biblique non reconnue.' }));
          return;
        }
        try {
          const verse = await bibleLookup.getVerse(reference);
          broadcast({ 
            action: 'showVerse', 
            ...verse, 
            durationMs: Number(sanitized.durationMs) || 300000 
          }, ws);
        } catch (error) {
          ws.send(JSON.stringify({ 
            action: 'lookupError', 
            reference, 
            error: error.message 
          }));
        }
        return;
      }

      // Relaie à tous les autres clients connectés (typiquement : overlay.html).
      const sanitizedMessage = JSON.stringify(sanitized);
      wss.clients.forEach((client) => {
        if (client !== ws && client.readyState === WebSocket.OPEN) {
          client.send(sanitizedMessage);
        }
      });
    });

    ws.on('close', () => {
      rateLimiter.removeConnection(ws);
      console.log('[server] Client #' + idClient + ' déconnecté. (' + wss.clients.size + ' client(s) restant(s))');
    });

    ws.on('error', (err) => {
      console.error('[server] Erreur sur le client #' + idClient + ' :', err.message);
    });
  });

  wss.on('error', (err) => {
    console.error('[server] Erreur serveur :', err.message);
    if (err.code === 'EADDRINUSE') {
      console.error('[server] Le port est déjà utilisé — un autre server.js tourne-t-il déjà ?');
    }
  });
  
  // Arrêt propre du serveur Whisper et de la capture audio lors de la fermeture du serveur
  process.on('SIGINT', () => {
    console.log('\n[server] Arrêt du serveur...');
    
    // Clear heartbeat
    clearInterval(heartbeat);
    
    // Arrêter le rate limiter
    if (rateLimiter && rateLimiter.stopCleanup) {
      rateLimiter.stopCleanup();
    }
    
    // Fermer toutes les connexions WebSocket
    wss.clients.forEach((client) => {
      client.close(1000, 'Server shutting down');
    });
    
    // Arrêter la capture audio d'abord
    audioCapture.stopRecording()
      .then(() => {
        console.log('[server] Capture audio arrêtée');
        // Puis arrêter Whisper
        return whisper.stopServer();
      })
      .then(() => {
        console.log('[server] Whisper arrêté');
        // Nettoyer les fichiers temporaires
        audioCapture.cleanupTempFiles({ force: true });
        console.log('[server] Nettoyage terminé');
        process.exit(0);
      })
      .catch((err) => {
        console.error('[server] Erreur lors de l\'arrêt:', err.message);
        process.exit(1);
      });
  });
  
  // Handle other termination signals
  process.on('SIGTERM', () => {
    console.log('\n[server] SIGTERM reçu, arrêt...');
    process.emit('SIGINT');
  });
}
