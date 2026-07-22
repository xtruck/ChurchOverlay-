// ============================================================================
// Modification à apporter dans server.js
// ============================================================================

// 1. Ajouter en haut du fichier, avec les autres require() :
const groq = require('./groq-wrapper');

// 2. Remplacer le contenu du callback audioCapture.on({ onAudioSegment... })
//    par ceci (le reste du fichier ne change pas) :

audioCapture.on({
  onAudioSegment: async (segmentFile) => {
    console.log('[server] Segment audio reçu, envoi vers Groq + Whisper local...');

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

      // Relayer vers les clients connectés (overlay.html), en gardant
      // la même forme de message qu'avant.
      broadcast({
        action: 'transcript',
        text: result.text || '',
        source: result.source,
        timestamp: Date.now(),
      });

      processTranscript(result.text || '').catch((error) => {
        console.error('[server] Detection error:', error.message);
      });

      // Nettoyer le fichier temporaire après transcription
      try {
        fs.unlinkSync(segmentFile);
      } catch (e) {
        console.warn('[server] Impossible de supprimer le fichier temporaire:', segmentFile);
      }
    } catch (error) {
      console.error('[server] Erreur lors de la transcription:', error.message);
      broadcast({ action: 'transcriptionError', error: error.message, timestamp: Date.now() });

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

// 3. Le bloc whisper.on({ onTranscript: ... }) existant peut rester tel quel :
//    il servira uniquement de log de secours si transcribeFile est appelé
//    ailleurs (ex. tests). Le flux principal passe maintenant par
//    onAudioSegment ci-dessus.
