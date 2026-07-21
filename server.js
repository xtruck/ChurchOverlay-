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
const whisper = require('./whisper-wrapper');
const audioCapture = require('./audio-capture');
const detector = require('./detector');
const bibleLookup = require('./bible-lookup');
const { createContextTracker } = require('./context-tracker');

const verseTracker = createContextTracker();

const PORT = Number(process.env.PORT || 8765);

function broadcast(payload, except) {
  const message = JSON.stringify(payload);
  wss.clients.forEach((client) => {
    if (client !== except && client.readyState === WebSocket.OPEN) client.send(message);
  });
}

async function processTranscript(text) {
  const reference = detector.detect(text);
  if (!reference) return;
  broadcast({ action: 'candidateVerse', reference, transcript: text, timestamp: Date.now() });
  if (!verseTracker.shouldProcess(reference)) return;
  console.log('[server] Reference detected:', bibleLookup.buildReferenceLabel(reference));
  try {
    const verse = await bibleLookup.getVerse(reference);
    broadcast({ action: 'showVerse', ...verse, durationMs: 300000, autoDetected: true });
  } catch (error) {
    console.warn('[server] Bible lookup unavailable:', error.message);
    broadcast({ action: 'lookupError', reference, error: error.message, timestamp: Date.now() });
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
    } else {
      console.error('[server] Le serveur continuera sans Speech-to-Text');
    }
  });

}

// Configuration des callbacks Whisper
whisper.on({
  onTranscript: (result) => {
    console.log('[server] Transcription reçue:', result.text || '(sans texte)');
    
    // Relayer la transcription vers tous les clients connectés (overlay.html)
    const message = JSON.stringify({
      action: 'transcript',
      text: result.text || '',
      timestamp: Date.now(),
    });
    
    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    });
    processTranscript(result.text || '').catch((error) => {
      console.error('[server] Detection error:', error.message);
    });
  },
  onError: (error) => {
    console.error('[server] Erreur Whisper:', error);
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
      const fs = require('fs');
      try {
        fs.unlinkSync(segmentFile);
      } catch (e) {
        console.warn('[server] Impossible de supprimer le fichier temporaire:', segmentFile);
      }
    } catch (error) {
      console.error('[server] Erreur lors de la transcription:', error.message);
    }
  },
  onError: (error) => {
    console.error('[server] Erreur capture audio:', error.message);
  },
});

const wss = new WebSocket.Server({ port: PORT }, () => {
  startPipeline();
  console.log('[server] Serveur WebSocket démarré sur ws://localhost:' + PORT);
  console.log('[server] En attente de connexions (overlay.html dans OBS, test-envoi.js, ...).');
});

let compteurClients = 0;

wss.on('connection', (ws) => {
  compteurClients++;
  const idClient = compteurClients;
  console.log('[server] Client #' + idClient + ' connecté. (' + wss.clients.size + ' client(s) au total)');

  ws.on('message', async (data) => {
    const message = data.toString();

    // Validation minimale : on vérifie que c'est du JSON avant de relayer,
    // pour éviter de propager n'importe quoi à l'overlay pendant un culte.
    let parsed;
    try {
      parsed = JSON.parse(message);
    } catch (e) {
      console.warn('[server] Message ignoré du client #' + idClient + ' (JSON invalide) :', message);
      return;
    }

    console.log('[server] Relais depuis client #' + idClient + ' :', parsed.action || '(action manquante)');

    // Usage depuis un pupitre opérateur : { action: 'lookupReference', reference: 'Jean 3:16' }.
    if (parsed.action === 'lookupReference') {
      const reference = detector.detect(parsed.reference || '');
      if (!reference) {
        ws.send(JSON.stringify({ action: 'lookupError', error: 'Référence biblique non reconnue.' }));
        return;
      }
      try {
        const verse = await bibleLookup.getVerse(reference);
        broadcast({ action: 'showVerse', ...verse, durationMs: Number(parsed.durationMs) || 300000 }, ws);
      } catch (error) {
        ws.send(JSON.stringify({ action: 'lookupError', reference, error: error.message }));
      }
      return;
    }

    // Relaie à tous les autres clients connectés (typiquement : overlay.html).
    wss.clients.forEach((client) => {
      if (client !== ws && client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    });
  });

  ws.on('close', () => {
    console.log('[server] Client #' + idClient + ' déconnecté. (' + wss.clients.size + ' client(s) restant(s))');
  });

  ws.on('error', (err) => {
    console.error('[server] Erreur sur le client #' + idClient + ' :', err.message);
  });
});

wss.on('error', (err) => {
  console.error('[server] Erreur serveur :', err.message);
  if (err.code === 'EADDRINUSE') {
    console.error('[server] Le port ' + PORT + ' est déjà utilisé — un autre server.js tourne-t-il déjà ?');
  }
});

// Arrêt propre du serveur Whisper et de la capture audio lors de la fermeture du serveur
process.on('SIGINT', () => {
  console.log('[server] Arrêt du serveur...');
  
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
      audioCapture.cleanupTempFiles();
      console.log('[server] Nettoyage terminé');
      process.exit(0);
    })
    .catch((err) => {
      console.error('[server] Erreur lors de l\'arrêt:', err.message);
      process.exit(1);
    });
});