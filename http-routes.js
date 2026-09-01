'use strict';

/**
 * http-routes.js — Routes HTTP "cœur" de l'application (pages statiques,
 * health/status, données publiques en lecture seule pour companion.html).
 *
 * Extrait de server.js (Phase 2 — modularisation, même chantier que
 * session-state.js/ai-modules-loader.js/sentence-buffer.js/
 * phone-camera-routes.js, mêmes conventions : comportement identique à
 * l'original, seulement un déplacement de code, dépendances injectées via
 * un objet de contexte plutôt que des closures implicites sur tout
 * server.js).
 *
 * NE couvre PAS : le middleware express.static/compression (reste dans
 * server.js — configuration globale de l'app, pas une "route" au sens où
 * l'entend ce fichier), les routes caméra téléphone (déjà extraites dans
 * phone-camera-routes.js), ni le dispatch WebSocket (bien plus gros
 * chantier, à part).
 *
 * getConsecutiveTranscriptionFailures/getLastLiveCaption sont des GETTERS
 * (pas les valeurs elles-mêmes) : ce sont des `let` de server.js réassignés
 * en continu pendant que le pipeline tourne — leur passer la valeur au
 * moment de l'enregistrement des routes figerait /api/health et
 * /api/captions sur un instantané de démarrage, jamais mis à jour.
 */

const path = require('path');

/**
 * @param {object} ctx
 * @param {import('express').Express} ctx.app
 * @param {string} ctx.appRoot - APP_ROOT
 * @param {string} ctx.appVersion - APP_VERSION
 * @param {number} ctx.serverPort - SERVER_PORT
 * @param {string|null} ctx.wsAuthToken - WS_AUTH_TOKEN
 * @param {import('ws').Server} ctx.wss
 * @param {object} ctx.asrEngine
 * @param {object} ctx.audioCapture
 * @param {object} ctx.groq
 * @param {object} ctx.bibleLookup
 * @param {object} ctx.sessionState
 * @param {object} ctx.sessionStore
 * @param {() => number} ctx.getConsecutiveTranscriptionFailures
 * @param {() => {text: string|null, translation: string|null, timestamp: number|null}} ctx.getLastLiveCaption
 */
function registerRoutes(ctx) {
  const {
    app,
    appRoot,
    appVersion,
    serverPort,
    wsAuthToken,
    wss,
    asrEngine,
    audioCapture,
    groq,
    bibleLookup,
    sessionState,
    sessionStore,
    getConsecutiveTranscriptionFailures,
    getLastLiveCaption,
  } = ctx;

  app.get('/', (req, res) => res.sendFile(path.join(appRoot, 'dashboard.html')));
  app.get('/dashboard', (req, res) => res.sendFile(path.join(appRoot, 'dashboard.html')));
  app.get('/overlay', (req, res) => res.sendFile(path.join(appRoot, 'overlay.html')));
  app.get('/setup', (req, res) => res.sendFile(path.join(appRoot, 'setup.html')));

  // AJOUT (Chantier 2 — health system) : le endpoint historique ne renvoyait
  // que status/port/authEnabled — statique, jamais le moindre état opérationnel
  // réel. Enrichi pour servir de watchdog côté production : à chaque requête il
  // reflète l'état VIVANT du pipeline (ASR actif et en quel mode, VAD, capture,
  // échecs de transcription consécutifs, cache Bible, clients WebSocket) et
  // bascule `status` sur 'degraded' dès qu'un composant est dégradé — sans
  // jamais avoir besoin d'instancier l'Electron shell (le worker HTTP est
  // indépendant, voir main.js/startServerWorker).
  function buildHealthReport() {
    const asrResolved = asrEngine.resolveProvider();
    const streamingActive = audioCapture.isDeepgramStreamingActive();
    const asrActive = audioCapture.getAsrProvider();
    const recording = audioCapture.isRecording();
    const consecutiveTranscriptionFailures = getConsecutiveTranscriptionFailures();
    const degradedReasons = [];
    // NOTE : les getters audio-capture renvoient l'état RÉEL de la capture en
    // cours (safe à appeler même hors capture : valeurs d'init).
    if (recording && asrResolved === 'deepgram' && !streamingActive) {
      degradedReasons.push('deepgram-streaming-down');
    }
    if (consecutiveTranscriptionFailures > 0) {
      degradedReasons.push(`transcription-failures-${consecutiveTranscriptionFailures}`);
    }
    // AJOUT (Chantier 2 — panne silencieuse trouvée en conditions réelles) :
    // la course Groq/Deepgram (transcribeWithFallback) masque un Groq cassé
    // tant que Deepgram répond — consecutiveTranscriptionFailures ci-dessus
    // ne bouge donc jamais dans ce cas précis. groq.getGroqHealthState() est
    // un compteur SÉPARÉ, purement passif (voir groq-wrapper.js), qui rend
    // ce cas visible. Seuil à 3 (pas 1) pour ignorer un aléa réseau isolé —
    // 3 échecs Groq CONSÉCUTIFS sur le vrai trafic du culte est un signal
    // fiable, pas un faux positif sur un segment ou deux.
    const groqHealth = groq.getGroqHealthState();
    if (groqHealth.consecutiveFailures >= 3) {
      degradedReasons.push(`groq-failing-${groqHealth.consecutiveFailures}`);
    }
    return {
      status: degradedReasons.length === 0 ? 'ok' : 'degraded',
      service: 'ChurchOverlay',
      version: appVersion,
      port: serverPort,
      authEnabled: !!wsAuthToken,
      uptimeSeconds: Math.round(process.uptime()),
      degradedReasons,
      recording,
      asr: {
        resolved: asrResolved,
        active: asrActive,
        mode: streamingActive ? 'streaming' : 'batch',
        groq: groqHealth,
      },
      vad: audioCapture.getVadProvider(),
      transcription: {
        consecutiveFailures: consecutiveTranscriptionFailures,
      },
      bible: {
        cacheEntries: bibleLookup.getCacheSize(),
      },
      wsClients: wss.clients ? wss.clients.size : 0,
      memory: {
        rss: process.memoryUsage().rss,
        heapUsed: process.memoryUsage().heapUsed,
        heapTotal: process.memoryUsage().heapTotal,
      },
    };
  }

  app.get('/api/health', (req, res) => {
    res.json(buildHealthReport());
  });
  app.get('/api/status', (req, res) => {
    res.json(buildHealthReport());
  });

  // AJOUT (audit — second écran pour l'assemblée, gratuit/léger) : page de
  // lecture seule, pensée pour un QR code scanné pendant le culte. Pas de
  // jeton WS_AUTH_TOKEN requis ici — contrairement au canal WebSocket, qui
  // peut déclencher des actions, cette route ne fait que RELIRE des versets
  // déjà projetés publiquement sur l'écran de la salle (même donnée, même
  // sensibilité que /api/health, déjà sans authentification).
  app.get('/companion', (req, res) => res.sendFile(path.join(appRoot, 'companion.html')));
  app.get('/api/verses', (req, res) => {
    res.json({ verses: sessionState.getVerseHistory() });
  });
  // AJOUT (chantier 4.4 — sous-titres en direct, sur companion.html) : même
  // discipline que /api/verses juste au-dessus (lecture seule, pas de jeton —
  // un sous-titre déjà diffusé en direct sur l'overlay/la salle n'est pas
  // plus sensible qu'un verset déjà projeté). `text`/`translation` restent
  // `null` tant que rien n'a encore été transcrit, ou si les sous-titres
  // (respectivement leur traduction) sont désactivés côté opérateur —
  // jamais de fuite de transcript quand l'opérateur a explicitement choisi
  // de ne pas l'exposer (voir sessionState.getCaptionsEnabled()).
  // AJOUT (chantier 4.6 — présence anonyme, companion.html) : POST plutôt que
  // GET (déclenche une écriture, pas une simple lecture comme /api/verses et
  // /api/captions ci-dessus). Aucun jeton non plus — même sensibilité que les
  // deux autres routes /api/* de cette page publique, et voir l'en-tête de
  // session-store.js#recordCheckin() pour la portée volontairement limitée à
  // un horodatage anonyme (pas de nom, pas d'identité).
  app.post('/api/checkin', (req, res) => {
    sessionStore.recordCheckin();
    res.json({ ok: true });
  });
  app.get('/api/captions', (req, res) => {
    const captionsEnabled = sessionState.getCaptionsEnabled();
    const translationEnabled = sessionState.getTranslatedCaptionsEnabled();
    const lastLiveCaption = getLastLiveCaption();
    res.json({
      enabled: captionsEnabled,
      translationEnabled,
      targetLang: translationEnabled ? sessionState.getCaptionTargetLang() : null,
      text: captionsEnabled ? lastLiveCaption.text : null,
      translation: captionsEnabled && translationEnabled ? lastLiveCaption.translation : null,
      timestamp: captionsEnabled ? lastLiveCaption.timestamp : null,
    });
  });
}

module.exports = { registerRoutes };
