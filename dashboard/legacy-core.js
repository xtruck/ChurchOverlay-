/**
 * dashboard/legacy-core.js — Interface opérateur (tableau de bord)
 *
 * ÉTAT DE TRANSITION (chantier de modularisation "dashboard/", front end
 * plus léger/mieux construit) : ce fichier est l'ancien dashboard.js déplacé
 * tel quel, chargé maintenant via dashboard/main.js (import './legacy-core.js')
 * en <script type="module">, plutôt que l'ancien <script src="dashboard.js">
 * classique. Comportement identique pour l'instant — voir le bloc
 * `window.x = x` en fin de fichier pour pourquoi (exposition explicite
 * requise, un module ne rend rien global par défaut contrairement à un
 * script classique). Les lots suivants démantèlent ce fichier en modules
 * dédiés sous dashboard/features/* ; il rétrécit à chaque lot.
 *
 * NOTE ESLint : de nombreuses fonctions ci-dessous (setLanguage,
 * clearTranscript, etc.) sont appelées par dashboard.html via des attributs
 * onclick="..." inline (certains statiques dans le HTML, d'autres générés
 * dynamiquement dans ce fichier même via des template strings, ex.
 * moveQueueItem/setMoodTheme dans le rendu de liste), invisibles à l'analyse
 * statique d'un fichier isolé. Contrairement à l'ancien dashboard.js (un
 * <script> classique, où ces fonctions étaient globales par défaut), le
 * bloc `window.x = x` en fin de fichier les rend explicitement globales ET
 * donne à ESLint une vraie référence de lecture pour chacune — plus besoin
 * du désactivateur `no-unused-vars` que ce fichier portait auparavant.
 */

// AJOUT (modularisation, lot 4) : showToast/addActivity/escapeHtmlDashboard/
// requireWsOrWarn ont déménagé dans dashboard/utils.js — importés ici car
// le reste de ce fichier les appelle encore par leur nom nu (même portée
// partagée qu'avant l'extraction).
import { showToast, addActivity } from './utils.js';
// AJOUT (modularisation, lot 5) : import CIRCULAIRE assumé et sûr —
// verse-session-display.js importe state/ws depuis CE fichier (voir plus
// bas), et ce fichier importe ses fonctions ici. Sûr uniquement parce que
// tous les usages de state/ws dans verse-session-display.js sont à
// l'intérieur de corps de fonction (jamais évalués immédiatement à
// l'import) — au moment où l'une de ces fonctions s'exécute réellement
// (WS reçu, clic opérateur...), tout le graphe de modules a fini de se
// charger et state/ws sont déjà initialisés.
import {
  displayVerse,
  hideVerseDisplay,
  addTranscript,
  showCandidateVerse,
  updateDashboard,
  updateStatus,
} from './features/verse-session-display.js';
import { renderMoodPicker, setActiveMoodButton } from './features/mood-theme.js';
import { renderSongLibrary } from './features/song-library.js';
import { renderOfflineBibleStatus } from './features/offline-bible.js';
import {
  renderAiEnricherOutput,
  renderSessionStats,
  renderHighlightsExport,
  updateSermonModeBadge,
  renderSermonQaResult,
  requestAutoTranslation,
  renderPreServiceCheckResult,
} from './features/preservice-ai.js';
import { renderMediaLibrary } from './features/media-library.js';
import { renderNetworkStatus } from './features/network-settings.js';
import { renderIpCameras, showCameraPairingQr } from './features/ip-cameras.js';
import { renderBranding } from './features/branding.js';
import { setTranscriptionHealth } from './features/pipeline-health.js';

// State Management
// AJOUT (modularisation, lot 5) : exporté pour verse-session-display.js —
// un seul objet partagé, muter une propriété depuis l'import reste visible
// partout (aucun wrapper nécessaire, contrairement à ws qui est réassigné).
export const state = {
  totalVerses: 0,
  detectionRate: 100,
  activeLanguage: 'FR',
  sessionStartTime: Date.now(),
  transcripts: [],
  currentVerse: null,
  // AJOUT (mode culte + traduction live + export récap)
  autoTranslateEnabled: false,
  autoTranslateLang: 'en',
  lastPostServiceRecap: null,
  // AJOUT (audit — lien OBS manquant) : URL file:// avec jeton
  // WS_VIEWER_TOKEN, poussée par main.js (voir applyOverlayUrl).
  overlayUrl: null,
  // AJOUT (habillage caméra) : même mécanisme, pour branding-overlay.html.
  brandingOverlayUrl: null,
};

// AJOUT : intervalle d'auto-détection du mode de culte (louange, prédication,
// prière, annonces...). Tourne toutes les 2 minutes en tâche de fond une fois
// le WebSocket connecté ; volontairement peu fréquent pour ne pas multiplier
// les appels IA inutilement. unref() n'existe pas côté navigateur (pas besoin :
// la page se ferme avec l'onglet, pas de process Node à libérer ici).
const SERMON_MODE_INTERVAL_MS = 120000;
let sermonModeTimer = null;

function startSermonModeAutoDetect() {
  if (sermonModeTimer) return;
  sermonModeTimer = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ action: 'getSermonTheme', silent: true }));
    }
  }, SERMON_MODE_INTERVAL_MS);
}

function stopSermonModeAutoDetect() {
  if (sermonModeTimer) {
    clearInterval(sermonModeTimer);
    sermonModeTimer = null;
  }
}

// Navigation tab switching
//
// CORRECTIF (audit — tableau de bord "trop rempli") : 6 onglets séparés
// regroupés en 2 vues ("En Direct" / "Réglages"), chacune affichant
// PLUSIEURS <section> existantes ensemble plutôt qu'une seule — aucune
// section n'a été déplacée ni son id changé, donc tout le reste du
// câblage (getElementById, WS handlers...) continue de fonctionner sans
// modification. item.dataset.sections (pluriel, liste séparée par des
// virgules) remplace l'ancien item.dataset.section (singulier, une seule
// section à la fois).
function showSectionsFor(item) {
  document.querySelectorAll('.section').forEach((s) => (s.style.display = 'none'));
  const targetIds = (item.dataset.sections || '').split(',').filter(Boolean);
  targetIds.forEach((id) => {
    const targetSec = document.getElementById(id);
    if (targetSec) targetSec.style.display = 'block';
  });
}

document.querySelectorAll('.nav-item').forEach((item) => {
  item.addEventListener('click', () => {
    document.querySelectorAll('.nav-item').forEach((i) => i.classList.remove('active'));
    item.classList.add('active');
    showSectionsFor(item);
  });
});

// Applique l'état initial (l'onglet marqué "active" dans le HTML, "En
// Direct" par défaut) dès le chargement — sans ça, seule la section
// "overview" (sans display:none en dur) serait visible au démarrage,
// alors que "transcript" (micro/transcription) fait aussi partie du
// groupe "En Direct" mais reste display:none tant qu'aucun clic n'a eu
// lieu.
const initialNavItem = document.querySelector('.nav-item.active');
if (initialNavItem) showSectionsFor(initialNavItem);

// Dynamic WebSocket connection URL
// CORRECTIF (bug "app tout le temps déconnectée") : le token n'était
// jamais transmis à la connexion WebSocket. En Electron, main.js
// injecte ?token=... via l'option `query` de loadFile() ; on le
// relit ici depuis l'URL de la PAGE (pas celle du WebSocket).
//
// SECURITY (backend audit) : le token n'est plus ajouté en ?token=
// sur l'URL WebSocket elle-même — un reverse proxy / CDN placé
// devant un serveur exposé au réseau journalise typiquement l'URI
// de requête, ce qui aurait exposé le jeton en clair dans ces logs.
// Il voyage maintenant via l'en-tête de handshake
// Sec-WebSocket-Protocol (2e argument du constructeur WebSocket),
// que les proxys ne journalisent pas par défaut.
export const getWsToken = () => new URLSearchParams(window.location.search).get('token');
// CORRECTIF (bug "overlay hors ligne par défaut" — même famille pour le
// dashboard) : ce port était codé en dur (8765) et ignorait le paramètre
// ?port=... que main.js transmet pourtant via l'option `query` de
// loadFile() (voir main.js > mainWindow.loadFile). Ça fonctionnait par
// coïncidence tant que PORT restait à sa valeur par défaut (8765,
// justement), mais silencieusement plus dès que PORT était personnalisé
// dans .env — le dashboard tentait alors de se connecter au mauvais port
// sans qu'aucune erreur explicite n'indique pourquoi. Aligné sur le même
// pattern que overlay.html (getWsPort()), qui lisait déjà correctement ce
// paramètre.
export const getWsPort = () => new URLSearchParams(window.location.search).get('port') || '8765';
const getWsUrl = () => {
  if (window.location.protocol === 'http:' || window.location.protocol === 'https:') {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${window.location.host}`;
  }
  return `ws://localhost:${getWsPort()}`;
};

// CORRECTIF (bug production — logo d'habillage caméra invisible dans le
// tableau de bord, "Failed to load resource: /C:/branding/..."). Ce
// tableau de bord est chargé en file:// dans Electron (pas via le
// serveur Express), donc un chemin racine-relatif comme "/branding/xxx"
// (renvoyé tel quel par le serveur, voir server.js > logoUrl) se
// résolvait contre la racine du disque au lieu du serveur HTTP local —
// même famille de bug que getWsUrl() ci-dessus pour le WebSocket.
export const getHttpOrigin = () => {
  if (window.location.protocol === 'http:' || window.location.protocol === 'https:') {
    return window.location.origin;
  }
  return `http://localhost:${getWsPort()}`;
};

// AJOUT (modularisation, lot 4) : exporté pour que dashboard/utils.js
// (requireWsOrWarn) y accède en lecture seule — liaison "live" ES module,
// voir son commentaire d'en-tête. Seul CE fichier réassigne ws.
export let ws = null;
let reconnectAttempts = 0;
// CORRECTIF (bug de production signalé — "l'application reste
// déconnectée et je ne peux rien faire") : `maxReconnectAttempts`
// faisait ABANDONNER toute tentative de reconnexion après 10 essais
// (~90s de backoff cumulé), contrairement à overlay.html qui retente
// indéfiniment toutes les 3s. Si le serveur redémarrait ou avait un
// simple hoquet de plus de 90s (mise à jour, redémarrage Electron,
// pic de charge), le dashboard restait bloqué déconnecté pour de bon
// — seul un rechargement manuel de la page pouvait le réparer.
// On retente maintenant indéfiniment, avec le même backoff plafonné
// à 10s qu'avant, sans jamais s'arrêter.
let reconnectTimer = null;

function initWebSocket() {
  if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) {
    return;
  }

  try {
    const token = getWsToken();
    ws = token ? new WebSocket(getWsUrl(), [token]) : new WebSocket(getWsUrl());
  } catch (e) {
    console.error('Erreur création WebSocket :', e);
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    console.log('Connecté au serveur ChurchOverlay');
    updateStatus(true);
    reconnectAttempts = 0;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    // AJOUT : (re)démarre l'auto-détection du mode de culte à chaque
    // connexion/reconnexion — pas d'effet si déjà démarré (voir
    // startSermonModeAutoDetect, protégé contre le double-démarrage).
    startSermonModeAutoDetect();
    // AJOUT (innovation frontend — sélecteur d'ambiances) : le serveur
    // sait déjà répondre à 'getMoods' (ai-theme-generator.js) mais rien
    // côté dashboard ne le demandait jusqu'ici. On récupère la liste à
    // chaque connexion pour peupler les boutons dynamiquement plutôt
    // que de coder les moods en dur (ils pourraient changer côté serveur).
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ action: 'getMoods' }));
      // AJOUT (médiathèque) : la liste vit côté serveur (le déclenchement
      // vocal doit y accéder même sans tableau de bord ouvert) — récupérée
      // à chaque connexion/reconnexion pour rester synchronisée.
      ws.send(JSON.stringify({ action: 'getMediaLibrary' }));
      // AJOUT (bibliothèque de chants) : même raisonnement que getMediaLibrary.
      ws.send(JSON.stringify({ action: 'getSongLibrary' }));
      // AJOUT (caméras de téléphone) : même raisonnement que getMediaLibrary.
      ws.send(JSON.stringify({ action: 'getIpCameras' }));
      // AJOUT (habillage caméra) : même raisonnement que getMediaLibrary.
      ws.send(JSON.stringify({ action: 'getBranding' }));
      // AJOUT (base biblique hors-ligne) : un seul statut suffit à la
      // connexion ; pollOfflineBibleStatusUntilDone() prend le relais si un
      // téléchargement est en cours (voir plus bas).
      ws.send(JSON.stringify({ action: 'getOfflineBibleStatus' }));
      // AJOUT (carte réseau) : même raisonnement que getMediaLibrary.
      ws.send(JSON.stringify({ action: 'getNetworkStatus' }));
    }
  };

  ws.onmessage = (event) => {
    try {
      const message = JSON.parse(event.data);
      handleMessage(message);
    } catch (e) {
      console.error("Échec de l'analyse du message WebSocket :", e);
    }
  };

  ws.onerror = (err) => {
    console.error('Erreur WebSocket :', err);
    updateStatus(false);
  };

  ws.onclose = () => {
    console.log('Déconnecté du serveur ChurchOverlay');
    updateStatus(false);
    stopSermonModeAutoDetect();
    scheduleReconnect();
  };
}

function scheduleReconnect() {
  if (reconnectTimer) return;

  reconnectAttempts++;
  const delay = Math.min(2000 * reconnectAttempts, 10000);
  updateStatus(false, reconnectAttempts);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    initWebSocket();
  }, delay);
}

initWebSocket();

function handleMessage(message) {
  switch (message.action) {
    case 'showVerse':
      displayVerse(message);
      state.totalVerses++;
      updateDashboard();
      addActivity(`Verset affiché : ${message.reference}`, 'success');
      showToast(`Verset : ${message.reference}`, 'success');
      // AJOUT : traduction live automatique si le toggle est activé —
      // chaque nouveau verset déclenche translateText sans action manuelle.
      if (state.autoTranslateEnabled && message.text) {
        requestAutoTranslation(message);
      }
      break;
    case 'hideVerse':
      hideVerseDisplay();
      addActivity('Verset masqué', 'info');
      break;
    case 'transcript':
      addTranscript(message);
      break;
    case 'candidateVerse':
      showCandidateVerse(message);
      addActivity(`Verset candidat : ${message.reference}`, 'warning');
      break;
    case 'error':
      addActivity(`Erreur : ${message.error}`, 'error');
      showToast(`Erreur : ${message.error}`, 'error');
      break;
    case 'transcriptionError':
      addActivity(`Transcription indisponible : ${message.error}`, 'error');
      // CORRECTIF (audit — message d'erreur générique inutile) : ce toast
      // affichait toujours "vérifier la connexion internet" quelle que soit
      // la vraie cause (clé API invalide, quota dépassé, clé absente...),
      // alors que le message réel (message.error) était déjà disponible —
      // juste jamais montré ailleurs que dans le flux d'activité, moins
      // visible. Affiche désormais la vraie raison.
      showToast(`Transcription en échec : ${message.error || 'raison inconnue'}`, 'error');
      break;
    case 'audioError':
      addActivity(`Capture audio interrompue : ${message.error}`, 'error');
      showToast(`Micro/audio en échec — vérifier la capture`, 'error');
      break;
    case 'audioSilenceWarning':
      addActivity(message.message, 'warning');
      showToast(`⚠️ ${message.message}`, 'error');
      break;
    case 'preServiceCheckResult':
      renderPreServiceCheckResult(message);
      break;
    case 'networkStatus':
      renderNetworkStatus(message);
      break;
    // CORRECTIF (audit round 6) : réponses des modules ai-enricher.js,
    // jusqu'ici sans destination côté dashboard (les WS envoyaient bien
    // ces actions, mais rien n'écoutait la réponse).
    case 'sermonTheme':
      // AJOUT : les requêtes auto (silent:true, voir startSermonModeAutoDetect)
      // mettent seulement à jour le badge, sans polluer le panneau de sortie
      // manuel avec un texte qui change toutes les 2 minutes.
      updateSermonModeBadge(message);
      if (!message.silent) {
        renderAiEnricherOutput(
          message.theme
            ? `Thème détecté : ${message.theme}${message.keywords ? ' — mots-clés : ' + message.keywords.join(', ') : ''}`
            : 'Aucun thème identifiable pour le moment (transcription encore trop courte).'
        );
      }
      break;
    case 'liveSummary':
      renderAiEnricherOutput(
        message.summary ? `Résumé : ${message.summary}` : 'Résumé indisponible pour le moment.'
      );
      break;
    case 'crossReferences':
      renderAiEnricherOutput(
        message.results && message.results.length
          ? `Références croisées pour ${message.reference} : ` +
              message.results
                .map((r) => `${r.ref}${r.reason ? ' (' + r.reason + ')' : ''}`)
                .join(' · ')
          : `Aucune référence croisée trouvée pour ${message.reference || 'ce verset'}.`
      );
      break;
    case 'textTranslated':
      // Le broadcast vers l'overlay (action showTranslation) est fait
      // directement par le serveur quand autoBroadcast est vrai (voir
      // requestAutoTranslation) — ici on ne fait qu'afficher côté dashboard.
      if (!message.autoBroadcast) {
        renderAiEnricherOutput(`Traduction (${message.targetLang}) : ${message.translation}`);
      }
      break;
    case 'sessionStats':
      renderSessionStats(message);
      break;
    case 'highlightsExported':
      renderHighlightsExport(message);
      break;
    case 'postServiceRecap':
      // AJOUT : on garde le dernier récap en mémoire pour permettre
      // l'export en .txt sans le régénérer si l'opérateur clique export
      // juste après avoir cliqué "Récap fin de culte".
      state.lastPostServiceRecap = message.recap || null;
      renderAiEnricherOutput(
        message.recap
          ? `${message.recap.title || 'Récap du culte'} — Points clés : ${(message.recap.keyPoints || []).join(', ')}. ` +
              `Application : ${message.recap.application || '—'}. Verset à retenir : ${message.recap.memoryVerse || '—'}.`
          : 'Récap indisponible.'
      );
      break;
    // AJOUT (innovation frontend — sélecteur d'ambiances) : le serveur
    // envoyait déjà ces deux réponses (server.js: 'moodsList' sur
    // getMoods, 'themeApplied' sur setMoodTheme) mais aucun cas ne les
    // traitait ici — le générateur de thèmes IA restait invisible et
    // inutilisable depuis le tableau de bord.
    case 'moodsList':
      renderMoodPicker(message.moods || []);
      break;
    case 'themeApplied':
      setActiveMoodButton(message.mood);
      addActivity(`Ambiance changée : ${message.themeName || message.mood}`, 'info');
      showToast(`Ambiance : ${message.themeName || message.mood}`, 'success');
      break;
    // AJOUT (audit — état de repli visible, session parallèle) : émises par
    // transcribeWithRetry() côté serveur (server.js) — un échec de
    // transcription tente désormais un nouvel essai automatique avant
    // d'abandonner. Distinct du case 'transcriptionError' déjà présent
    // ci-dessus (qui gère l'échec final) : ceci couvre les tentatives
    // intermédiaires et l'état "dégradé" persistant.
    case 'transcriptionRetrying':
      setTranscriptionHealth({
        status: 'retrying',
        attempt: message.attempt,
        maxAttempts: message.maxAttempts,
      });
      break;
    case 'pipelineHealth':
      setTranscriptionHealth(message);
      if (message.status === 'ok') {
        addActivity('Transcription rétablie', 'success');
      }
      break;
    // AJOUT (audit — mémoire des cultes, session parallèle) : réponse à
    // getArchiveMatches (voir sermon-archive.js — recherche locale par
    // mots-clés, pas d'IA impliquée ici).
    case 'archiveMatches':
      renderAiEnricherOutput(
        message.results && message.results.length
          ? `Cultes correspondants pour "${message.query}" : ` +
              message.results
                .map((r) => {
                  const date = new Date(r.date).toLocaleDateString('fr-FR', {
                    day: 'numeric',
                    month: 'long',
                    year: 'numeric',
                  });
                  return `${r.theme || 'Sans titre'} (${date})`;
                })
                .join(' · ')
          : `Aucun culte archivé ne correspond à "${message.query}".`
      );
      break;
    // AJOUT (médiathèque — déclenchement vocal de photos/vidéos) : la liste
    // vit côté serveur, diffusée à tous les tableaux de bord ouverts après
    // chaque ajout/suppression pour rester synchronisée entre eux.
    case 'mediaLibraryUpdated':
      renderMediaLibrary(message.items);
      break;
    // AJOUT (caméras de téléphone) : même raisonnement que mediaLibraryUpdated
    // ci-dessus — la liste vit côté serveur, diffusée à tous les tableaux de
    // bord ouverts après chaque ajout/suppression.
    case 'ipCamerasUpdated':
      renderIpCameras(message.items);
      break;
    // AJOUT (caméra téléphone par QR code) : réponse ponctuelle à
    // generateCameraPairing() — affiche le QR généré, voir showCameraPairingQr().
    case 'cameraPairingGenerated':
      showCameraPairingQr(message);
      break;
    // AJOUT (habillage caméra) : même raisonnement — diffusé à chaque
    // changement pour rester synchronisé entre plusieurs tableaux de bord.
    case 'brandingUpdate':
      renderBranding(message.branding);
      break;
    case 'showMedia':
      addActivity(
        `Média affiché : ${message.label}` +
          (message.detectedBy === 'voice-cue' ? ' (déclenché à la voix)' : ''),
        'info'
      );
      break;
    case 'hideMedia':
      break;
    // AJOUT (bibliothèque de chants) : même raisonnement que mediaLibraryUpdated.
    case 'songLibraryUpdated':
      renderSongLibrary(message.songs);
      break;
    // AJOUT (stage display) : messages opérateur -> écran scène uniquement,
    // rien à faire côté tableau de bord au-delà d'un accusé dans le journal
    // d'activité (le contenu réel s'affiche sur stage-display.html).
    case 'stageMessage':
      addActivity(`Message envoyé à l'écran scène : ${message.text}`, 'info');
      break;
    case 'stageMessageClear':
      break;
    // AJOUT (base biblique hors-ligne) : voir renderOfflineBibleStatus() plus bas.
    case 'offlineBibleStatus':
      renderOfflineBibleStatus(message);
      break;
    // AJOUT (cahier des charges — assistant sermons) : voir renderSermonQaResult().
    case 'sermonQuestionAnswered':
      renderSermonQaResult(message);
      break;
    // AJOUT : le serveur diffusait déjà languageChanged (déclenché par
    // une commande vocale "passe en bilingue", ou par un autre tableau
    // de bord connecté) mais rien n'écoutait ici — les boutons de langue
    // restaient figés sur FR même après un changement effectif.
    case 'languageChanged':
      state.activeLanguage = (message.language || 'fr').toUpperCase();
      document.querySelectorAll('.lang-btn').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.lang === message.language);
      });
      updateDashboard();
      if (message.triggeredByVoice) {
        addActivity(`Langue changée par commande vocale : ${state.activeLanguage}`, 'info');
      }
      break;
  }
}

/* ============================================================================
   AJOUT (modularisation — chantier "dashboard/", front end plus léger, mieux
   construit) : dashboard.html charge désormais ce fichier via
   <script type="module">, dans lequel les déclarations top-level ne sont PAS
   globales par défaut (contrairement à un <script> classique). Les 70+
   attributs onclick="..." de dashboard.html référencent ces fonctions par
   leur nom global — exposition explicite ci-dessous pour que rien ne casse.

   Ce fichier est un ÉTAT DE TRANSITION : le contenu ci-dessus est encore
   dashboard.js tel quel, déplacé sans découpage. Les prochains lots le
   démantèlent progressivement en modules par fonctionnalité (voir
   dashboard/features/*.js) ; ce bloc d'exposition rétrécit au fur et à
   mesure — sans usage restant une fois le démantèlement terminé.
   ============================================================================ */
window.getWsPort = getWsPort;
window.getWsToken = getWsToken;
window.getWsUrl = getWsUrl;
window.handleMessage = handleMessage;
window.initWebSocket = initWebSocket;
window.scheduleReconnect = scheduleReconnect;
window.showSectionsFor = showSectionsFor;
window.startSermonModeAutoDetect = startSermonModeAutoDetect;
window.stopSermonModeAutoDetect = stopSermonModeAutoDetect;
