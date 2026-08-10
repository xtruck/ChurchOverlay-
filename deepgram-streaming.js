'use strict';
/**
 * ============================================================================
 *  deepgram-streaming.js — Client WebSocket streaming Deepgram (temps réel)
 * ----------------------------------------------------------------------------
 *  Remplace le modèle "enregistrer un WAV complet puis l'envoyer" par un
 *  flux continu : chaque chunk PCM arrivant du micro est poussé sur la
 *  connexion WebSocket au fil de l'eau, Deepgram répond par des évènements
 *  'Results' (is_final=false pendant que la phrase se construit, true une
 *  fois la phrase considérée terminée côté serveur — endpointing).
 *
 *  IMPORTANT — NON VÉRIFIÉ EN CONDITIONS RÉELLES : aucune clé DEEPGRAM_API_KEY
 *  n'était disponible dans cet environnement de développement pour ouvrir une
 *  vraie connexion vers l'API Deepgram. Le contrat ci-dessous (endpoint,
 *  paramètres de requête, en-tête d'authentification, forme des messages
 *  'Results') suit la documentation publique de l'API streaming Deepgram —
 *  cohérent avec deepgram-wrapper.js (même schéma d'authentification
 *  `Authorization: Token <clé>`, même modèle nova-2/langue fr) — mais SEULE
 *  la logique de ce fichier (parsing des messages, routage partial/final,
 *  reconnexion, mesure de latence) a été testée ici, via une WebSocket
 *  simulée (voir test/test-deepgram-streaming.js). Un test réel avec une
 *  vraie clé est nécessaire avant mise en production de ce chemin.
 *
 *  USAGE :
 *    const session = createSession({
 *      onPartial: (text, meta) => ...,   // meta: { confidence, timestamp }
 *      onFinal: (text, meta) => ...,
 *      onError: (err) => ...,             // connexion perdue/erreur -> l'appelant décide du repli
 *      onOpen: () => ...,
 *    });
 *    session.sendAudio(pcmChunkBuffer);   // PCM16LE mono 16kHz, appelé en continu
 *    session.finish();                    // fin de capture normale
 * ============================================================================
 */

const { buildDeepgramKeywords } = require('./bible-keyterms');

const DEEPGRAM_STREAMING_ENDPOINT = 'wss://api.deepgram.com/v1/listen';
const DEEPGRAM_MODEL = 'nova-2';
const DEEPGRAM_LANGUAGE = 'fr';
// Silence côté serveur Deepgram avant de considérer une phrase terminée
// (is_final=true) — voir endpointing dans la doc Deepgram. Volontairement
// proche de trailingSilenceMs (audio-capture.js) pour un ressenti cohérent
// entre les deux chemins (streaming vs repli segment).
const DEFAULT_ENDPOINTING_MS = 500;
// Délai maximum d'attente, après CloseStream, avant de forcer la fermeture
// locale si Deepgram ne ferme jamais lui-même la connexion — voir finish()
// plus bas. Assez long pour laisser passer un dernier 'final', assez court
// pour ne jamais bloquer un arrêt de capture perçu par l'opérateur.
const FINISH_TIMEOUT_MS = 2000;

function isConfigured() {
  return !!process.env.DEEPGRAM_API_KEY;
}

// AJOUT (tests d'intégration — audio-capture.js appelle createSession() sans
// jamais passer de wsFactory explicite en usage réel) : point d'injection
// EXPLICITE pour les tests uniquement, jamais utilisé par le code de
// production. Voir test/test-audio-capture-deepgram-streaming.js.
let testWsFactory = null;
/** @param {Function|null} factory */
function setWsFactoryForTesting(factory) {
  testWsFactory = factory;
}

function buildStreamingUrl() {
  const keywordsQuery = buildDeepgramKeywords()
    .map((kw) => `keywords=${encodeURIComponent(kw)}`)
    .join('&');
  const params = [
    `model=${DEEPGRAM_MODEL}`,
    `language=${DEEPGRAM_LANGUAGE}`,
    'punctuate=true',
    'smart_format=true',
    'interim_results=true',
    `endpointing=${DEFAULT_ENDPOINTING_MS}`,
    'encoding=linear16',
    'sample_rate=16000',
    'channels=1',
    keywordsQuery,
  ]
    .filter(Boolean)
    .join('&');
  return `${DEEPGRAM_STREAMING_ENDPOINT}?${params}`;
}

/**
 * @param {Object} handlers
 * @param {(text: string, meta: {confidence: number|undefined, timestamp: number}) => void} handlers.onPartial
 * @param {(text: string, meta: {confidence: number|undefined, timestamp: number}) => void} handlers.onFinal
 * @param {(err: Error) => void} handlers.onError - connexion perdue/erreur — jamais relancée automatiquement ici, voir audio-capture.js pour la politique de repli.
 * @param {() => void} [handlers.onOpen]
 * @param {() => void} [handlers.onClose]
 * @param {(url: string, options: Object) => Object} [wsFactory] - injectable pour les tests
 *   (défaut : `(url, options) => new (require('ws'))(url, options)`). Une FONCTION qui
 *   RETOURNE une instance compatible avec l'API `ws` (.on/.send/.close), pas une classe
 *   à instancier avec `new` — voir test/test-deepgram-streaming.js pour un exemple.
 * @returns {{ sendAudio: (buf: Buffer) => void, finish: () => void, abort: () => void, isOpen: () => boolean }}
 */
function createSession(handlers, wsFactory) {
  if (!isConfigured()) {
    throw new Error('DEEPGRAM_API_KEY non défini — impossible de démarrer une session streaming.');
  }
  const factory =
    wsFactory || testWsFactory || ((url, options) => new (require('ws'))(url, options));
  const apiKey = process.env.DEEPGRAM_API_KEY;
  const url = buildStreamingUrl();

  let open = false;
  let closed = false;
  // File d'attente des chunks arrivés AVANT l'ouverture effective de la
  // connexion (la négociation WebSocket prend quelques dizaines de ms) —
  // aucun audio n'est perdu pendant ce court intervalle.
  const pendingChunks = [];

  const ws = factory(url, {
    headers: { Authorization: `Token ${apiKey}` },
  });

  ws.on('open', () => {
    open = true;
    while (pendingChunks.length > 0) {
      ws.send(pendingChunks.shift());
    }
    if (handlers.onOpen) handlers.onOpen();
  });

  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch (_err) {
      // Message non-JSON (ne devrait pas arriver côté Deepgram) — ignoré,
      // jamais bloquant pour le flux.
      return;
    }
    if (msg.type !== 'Results') return; // Metadata/SpeechStarted/etc. ignorés — hors périmètre de ce module
    const alternative =
      msg.channel && Array.isArray(msg.channel.alternatives) ? msg.channel.alternatives[0] : null;
    const text = alternative && alternative.transcript ? alternative.transcript : '';
    if (!text) return; // Deepgram envoie aussi des Results vides (silence) — rien à faire remonter
    const meta = {
      confidence:
        alternative && typeof alternative.confidence === 'number'
          ? alternative.confidence
          : undefined,
      timestamp: Date.now(),
    };
    if (msg.is_final || msg.speech_final) {
      if (handlers.onFinal) handlers.onFinal(text, meta);
    } else if (handlers.onPartial) {
      handlers.onPartial(text, meta);
    }
  });

  ws.on('error', (err) => {
    if (handlers.onError) handlers.onError(err instanceof Error ? err : new Error(String(err)));
  });

  ws.on('close', () => {
    closed = true;
    open = false;
    if (handlers.onClose) handlers.onClose();
  });

  return {
    /** @param {Buffer} buf - PCM16LE mono 16kHz */
    sendAudio(buf) {
      if (closed) return;
      if (open) {
        ws.send(buf);
      } else {
        pendingChunks.push(buf);
      }
    },
    /**
     * Fin normale — signale à Deepgram que le flux est terminé, laisse le
     * dernier 'final' arriver.
     *
     * CORRECTIF (live test réel, DEEPGRAM_API_KEY vraie — le dernier 'final'
     * n'arrivait JAMAIS) : ce code fermait auparavant le socket local
     * (ws.close()) IMMÉDIATEMENT après avoir envoyé CloseStream, sans
     * laisser à Deepgram la moindre chance de vider son buffer et renvoyer
     * son dernier résultat avant que la connexion ne soit coupée depuis
     * notre côté. Confirmé par une connexion réelle (voir
     * live-tests/diagnose-raw-messages.js) : après CloseStream, fermer tout
     * de suite empêchait tout 'Results' final de jamais arriver. On attend
     * maintenant que Deepgram ferme lui-même la connexion (l'événement
     * 'close' existant déclenche déjà handlers.onClose ci-dessus, sans
     * changement) — avec un filet de sécurité (FINISH_TIMEOUT_MS) pour ne
     * jamais rester bloqué si Deepgram ne répond pas.
     */
    finish() {
      if (closed) return;
      if (!open) {
        ws.close();
        return;
      }
      try {
        ws.send(JSON.stringify({ type: 'CloseStream' }));
      } catch (_err) {
        // Envoi impossible (connexion déjà en mauvais état) : rien à attendre, ferme tout de suite.
        ws.close();
        return;
      }
      const timer = setTimeout(() => {
        if (!closed) ws.close();
      }, FINISH_TIMEOUT_MS);
      if (typeof ws.once === 'function') {
        ws.once('close', () => clearTimeout(timer));
      }
    },
    /** Coupure immédiate (erreur/repli) — pas de message de fin propre. */
    abort() {
      if (closed) return;
      ws.terminate ? ws.terminate() : ws.close();
    },
    isOpen: () => open && !closed,
  };
}

module.exports = {
  createSession,
  isConfigured,
  buildStreamingUrl,
  DEFAULT_ENDPOINTING_MS,
  FINISH_TIMEOUT_MS,
  setWsFactoryForTesting,
};
