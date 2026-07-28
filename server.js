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
 *  DÉMARRAGE :
 *    npm install ws        (une seule fois)
 *    node server.js
 *
 *  Le serveur écoute par défaut sur ws://localhost:8765 — doit correspondre
 *  à WS_URL dans overlay.html.
 * ============================================================================
 */

const WebSocket = require('ws');
const fs = require('fs');
const whisper = require('./whisper-wrapper');
const audioCapture = require('./audio-capture');
const { detect: mlDetect, getStatistics: getMLStats } = require('./ml-detector');
const { addTranscript, startSession, getAnalysis, getDetailedSummary, endSession } = require('./sermon-analyzer');
const { detectLanguage, setLanguage, getLanguage, getSupportedLanguages, detectReference: mlDetectReference } = require('./multi-language');
const { processCommand: processVoiceCommand, getHistory: getCommandHistory, getAvailableCommands, getStatistics: getVoiceStats } = require('./voice-commands');
const { startSession: startAnalyticsSession, endSession: endAnalyticsSession, trackVerseDisplay, trackTranscription, trackVoiceCommand, trackLanguageUsage, trackDetectionConfidence, trackError, updatePeakUsers, getAnalyticsReport, getInsights, exportAnalytics } = require('./analytics');
const { startAutoSync, stopAutoSync, backupSermon, backupVerse, backupAnalytics, getSyncStatus, getBackups, restoreFromBackup, cleanupOldBackups, exportAllData, importData } = require('./cloud-sync');
const bibleLookup = require('./bible-lookup');
const { createContextTracker } = require('./context-tracker');
const { validateAndSanitize } = require('./validation');
const { createRateLimiter } = require('./rate-limiter');
const { validateSystemConfig, displayValidationResults } = require('./config-validator');

const verseTracker = createContextTracker();
const rateLimiter = createRateLimiter({
  maxConnections: 10,
  maxMessagesPerMinute: 60
});

let wss = null; // Sera initialisé après la validation

function broadcast(payload, except) {
  if (!wss) return;
  const message = JSON.stringify(payload);
  wss.clients.forEach((client) => {
    if (client !== except && client.readyState === WebSocket.OPEN) client.send(message);
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
    // En cas d'erreur de validation, continuer avec les valeurs par défaut
    console.log('[server] Utilisation des valeurs par défaut');
    return 8765;
  })
  .then(PORT => {
    // Continuer avec le démarrage normal
    startServer(PORT);
  })
  .catch(error => {
    console.error('[server] Erreur au démarrage:', error.message);
    process.exit(1);
  });

async function processTranscript(text, language = null) {
  // Use multi-language detection if language is specified
  const reference = language ? mlDetectReference(text, language) : mlDetect(text);
  if (!reference) return;
  
  // Log confidence score
  console.log(`[server] Reference detected with confidence: ${reference.confidence || 'N/A'}`);
  
  // Track detection confidence for analytics
  if (reference.confidence) {
    trackDetectionConfidence(reference.confidence);
  }
  
  // Only process high-confidence detections automatically
  if (reference.confidence && reference.confidence < 0.6) {
    console.log('[server] Low confidence detection, requiring manual confirmation');
    broadcast({ action: 'candidateVerse', reference, transcript: text, timestamp: Date.now(), requiresConfirmation: true });
    return;
  }
  
  broadcast({ action: 'candidateVerse', reference, transcript: text, timestamp: Date.now() });
  if (!verseTracker.shouldProcess(reference)) return;
  console.log('[server] Reference detected:', bibleLookup.buildReferenceLabel(reference));
  try {
    const verse = await bibleLookup.getVerse(reference);
    broadcast({ action: 'showVerse', ...verse, durationMs: 300000, autoDetected: true, confidence: reference.confidence, language: reference.language || language });
    
    // Track verse display for analytics
    trackVerseDisplay(verse.reference, reference.book);
    if (language) trackLanguageUsage(language);
    
    // Backup verse to cloud (async, don't wait)
    backupVerse({ reference: verse.reference, text: verse.text, timestamp: Date.now() }).catch(err => {
      console.warn('[server] Cloud backup failed:', err.message);
    });
  } catch (error) {
    console.warn('[server] Bible lookup unavailable:', error.message);
    broadcast({ action: 'lookupError', reference, error: error.message, timestamp: Date.now() });
    trackError('detection');
    // Réinitialiser les providers échoués pour permettre de nouvelles tentatives
    bibleLookup.resetFailedProviders();
  }
}

// Démarrage du serveur Whisper au démarrage de server.js
console.log('[server] Démarrage du serveur Whisper Speech-to-Text...');
function startPipeline() {
  console.log('[server] Starting Whisper Speech-to-Text...');
  
  // Start sermon analysis session
  startSession();
  console.log('[server] Session d\'analyse de sermon démarrée');
  
  // Start analytics session
  startAnalyticsSession();
  console.log('[server] Session d\'analytics démarrée');
  
  // Start cloud sync
  startAutoSync();
  console.log('[server] Cloud sync démarré');
  
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
    } else if (err.message.includes('micro')) {
      console.error('[server] Aucun micro configuré - Pipeline audio désactivé');
      console.error('[server] Lancez "node list-audio-devices.js" pour lister les micros disponibles');
      console.error('[server] Configurez AUDIO_DEVICE avec le nom exact du micro');
    } else {
      console.error('[server] Le serveur continuera sans Speech-to-Text');
    }
    // Notifier les clients connectés que le pipeline audio est indisponible
    broadcast({ action: 'pipelineError', error: err.message, timestamp: Date.now() });
  });

}

// Configuration des callbacks Whisper
whisper.on({
  onTranscript: (result) => {
    console.log('[server] Transcription reçue:', result.text || '(sans texte)');
    
    // Track transcription for analytics
    trackTranscription(result.timestamp || Date.now());
    
    // Detect language
    const detectedLang = detectLanguage(result.text || '');
    console.log('[server] Langue détectée:', detectedLang);
    
    // Add transcript to sermon analyzer
    addTranscript(result.text || '');
    
    // Process voice commands
    const voiceCommand = processVoiceCommand(result.text || '');
    if (voiceCommand) {
      console.log('[server] Commande vocale détectée:', voiceCommand.action);
      trackVoiceCommand(voiceCommand.action);
      broadcast({ action: 'voiceCommand', ...voiceCommand });
      
      // Execute certain commands automatically
      if (voiceCommand.action === 'hideVerse') {
        broadcast({ action: 'hideVerse' });
      } else if (voiceCommand.action === 'pauseTimer') {
        broadcast({ action: 'pauseTimer' });
      } else if (voiceCommand.action === 'resumeTimer') {
        broadcast({ action: 'resumeTimer' });
      } else if (voiceCommand.action === 'startSermonAnalysis') {
        startSession();
        broadcast({ action: 'sermonAnalysisStarted', timestamp: Date.now() });
      } else if (voiceCommand.action === 'endSermonAnalysis') {
        const summary = endSession();
        broadcast({ action: 'sermonAnalysisEnded', summary, timestamp: Date.now() });
        
        // Backup sermon to cloud
        backupSermon({ summary, timestamp: Date.now() }).catch(err => {
          console.warn('[server] Cloud backup failed:', err.message);
        });
      } else if (voiceCommand.action === 'getSermonSummary') {
        const summary = getDetailedSummary();
        broadcast({ action: 'sermonSummary', summary });
      } else if (voiceCommand.action === 'setLanguage' && voiceCommand.language) {
        setLanguage(voiceCommand.language);
        broadcast({ action: 'languageSet', language: voiceCommand.language, timestamp: Date.now() });
      } else if (voiceCommand.action === 'help') {
        const commands = getAvailableCommands();
        broadcast({ action: 'availableCommands', commands });
      }
    }
    
    // Relayer la transcription vers tous les clients connectés (overlay.html)
    broadcast({
      action: 'transcript',
      text: result.text || '',
      timestamp: Date.now(),
      language: detectedLang
    });
    
    processTranscript(result.text || '', detectedLang).catch((error) => {
      console.error('[server] Detection error:', error.message);
    });
  },
  onError: (error) => {
    console.error('[server] Erreur Whisper:', error);
    trackError('transcription');
  },
});

// Configuration des callbacks audio-capture
audioCapture.on({
  onAudioSegment: async (segmentFile) => {
    console.log('[server] Segment audio reçu, envoi vers Whisper...');
    
    try {
      // Envoyer le segment audio à Whisper pour transcription
      const result = await whisper.transcribeFile(segmentFile);
      console.log('[server] Transcription Whisper:', result.text || '(sans texte)');
      
      // Nettoyer le fichier temporaire après transcription
      try {
        fs.unlinkSync(segmentFile);
      } catch (e) {
        console.warn('[server] Impossible de supprimer le fichier temporaire:', segmentFile);
      }
    } catch (error) {
      console.error('[server] Erreur lors de la transcription:', error.message);
      // Notifier les clients de l'erreur de transcription
      broadcast({ action: 'transcriptionError', error: error.message, timestamp: Date.now() });
      
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
    broadcast({ action: 'audioCaptureError', error: error.message, timestamp: Date.now() });
  },
});

let compteurClients = 0;

// Save analytics data on process exit
process.on('SIGINT', () => {
  console.log('[server] Sauvegarde des analytics avant arrêt...');
  endAnalyticsSession();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('[server] Sauvegarde des analytics avant arrêt...');
  endAnalyticsSession();
  process.exit(0);
});

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

  wss.on('connection', (ws) => {
    // Vérifier le rate limiting pour les connexions
    const connectionCheck = rateLimiter.checkConnection(ws);
    if (!connectionCheck.allowed) {
      console.warn('[server] Connexion rejetée:', connectionCheck.reason);
      ws.send(JSON.stringify({ action: 'error', error: connectionCheck.reason }));
      ws.close();
      return;
    }

    compteurClients++;
    const idClient = compteurClients;
    console.log('[server] Client #' + idClient + ' connecté. (' + wss.clients.size + ' client(s) au total)');
    
    // Update peak users for analytics
    updatePeakUsers(wss.clients.size);

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

      // Usage depuis un pupitre opérateur : { action: 'lookupReference', reference: 'Jean 3:16' }.
      if (sanitized.action === 'lookupReference') {
        const reference = mlDetect(sanitized.reference || '');
        if (!reference) {
          ws.send(JSON.stringify({ action: 'lookupError', error: 'Référence biblique non reconnue.' }));
          return;
        }
        try {
          const verse = await bibleLookup.getVerse(reference);
          broadcast({ action: 'showVerse', ...verse, durationMs: Number(sanitized.durationMs) || 300000, confidence: reference.confidence }, ws);
        } catch (error) {
          ws.send(JSON.stringify({ action: 'lookupError', reference, error: error.message }));
        }
        return;
      }

      // Get ML detection statistics
      if (sanitized.action === 'getStatistics') {
        const stats = getMLStats();
        ws.send(JSON.stringify({ action: 'statistics', ...stats }));
        return;
      }

      // Sermon analysis endpoints
      if (sanitized.action === 'startSermonAnalysis') {
        startSession();
        ws.send(JSON.stringify({ action: 'sermonAnalysisStarted', timestamp: Date.now() }));
        return;
      }

      if (sanitized.action === 'getSermonAnalysis') {
        const analysis = getAnalysis();
        ws.send(JSON.stringify({ action: 'sermonAnalysis', ...analysis }));
        return;
      }

      if (sanitized.action === 'getSermonSummary') {
        const summary = getDetailedSummary();
        ws.send(JSON.stringify({ action: 'sermonSummary', summary }));
        return;
      }

      if (sanitized.action === 'endSermonAnalysis') {
        const summary = endSession();
        ws.send(JSON.stringify({ action: 'sermonAnalysisEnded', summary, timestamp: Date.now() }));
        return;
      }

      // Language support endpoints
      if (sanitized.action === 'setLanguage') {
        setLanguage(sanitized.language);
        ws.send(JSON.stringify({ action: 'languageSet', language: sanitized.language, timestamp: Date.now() }));
        return;
      }

      if (sanitized.action === 'getLanguage') {
        ws.send(JSON.stringify({ action: 'currentLanguage', language: getLanguage() }));
        return;
      }

      if (sanitized.action === 'getSupportedLanguages') {
        const languages = getSupportedLanguages();
        ws.send(JSON.stringify({ action: 'supportedLanguages', languages }));
        return;
      }

      // Voice command endpoints
      if (sanitized.action === 'getVoiceCommands') {
        const commands = getAvailableCommands();
        ws.send(JSON.stringify({ action: 'availableCommands', commands }));
        return;
      }

      if (sanitized.action === 'getVoiceCommandHistory') {
        const limit = sanitized.limit || 10;
        const history = getCommandHistory(limit);
        ws.send(JSON.stringify({ action: 'voiceCommandHistory', history }));
        return;
      }

      if (sanitized.action === 'getVoiceStatistics') {
        const stats = getVoiceStats();
        ws.send(JSON.stringify({ action: 'voiceStatistics', ...stats }));
        return;
      }

      // Analytics endpoints
      if (sanitized.action === 'getAnalyticsReport') {
        const report = getAnalyticsReport();
        ws.send(JSON.stringify({ action: 'analyticsReport', ...report }));
        return;
      }

      if (sanitized.action === 'getAnalyticsInsights') {
        const insights = getInsights();
        ws.send(JSON.stringify({ action: 'analyticsInsights', insights }));
        return;
      }

      if (sanitized.action === 'exportAnalytics') {
        const format = sanitized.format || 'json';
        const data = require('./analytics').exportAnalytics(format);
        ws.send(JSON.stringify({ action: 'analyticsExport', format, data }));
        return;
      }

      // Cloud sync endpoints
      if (sanitized.action === 'getCloudSyncStatus') {
        const status = getSyncStatus();
        ws.send(JSON.stringify({ action: 'cloudSyncStatus', ...status }));
        return;
      }

      if (sanitized.action === 'getCloudBackups') {
        const type = sanitized.type || null;
        try {
          const backups = await getBackups(type);
          ws.send(JSON.stringify({ action: 'cloudBackups', backups }));
        } catch (error) {
          ws.send(JSON.stringify({ action: 'error', error: error.message }));
        }
        return;
      }

      if (sanitized.action === 'restoreFromBackup') {
        try {
          const data = await restoreFromBackup(sanitized.backupId);
          ws.send(JSON.stringify({ action: 'backupRestored', data }));
        } catch (error) {
          ws.send(JSON.stringify({ action: 'error', error: error.message }));
        }
        return;
      }

      if (sanitized.action === 'cleanupCloudBackups') {
        const days = sanitized.days || 30;
        try {
          const deletedCount = await cleanupOldBackups(days);
          ws.send(JSON.stringify({ action: 'cloudBackupsCleaned', deletedCount }));
        } catch (error) {
          ws.send(JSON.stringify({ action: 'error', error: error.message }));
        }
        return;
      }

      if (sanitized.action === 'exportCloudData') {
        try {
          const data = await exportAllData();
          ws.send(JSON.stringify({ action: 'cloudDataExport', data }));
        } catch (error) {
          ws.send(JSON.stringify({ action: 'error', error: error.message }));
        }
        return;
      }

      if (sanitized.action === 'importCloudData') {
        try {
          const importedCount = await importData(sanitized.data);
          ws.send(JSON.stringify({ action: 'cloudDataImported', importedCount }));
        } catch (error) {
          ws.send(JSON.stringify({ action: 'error', error: error.message }));
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
    console.log('[server] Arrêt du serveur...');
    
    // Arrêter le rate limiter
    if (rateLimiter && rateLimiter.stopCleanup) {
      rateLimiter.stopCleanup();
    }
    
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
}