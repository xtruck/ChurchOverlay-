/**
 * dashboard/state.js — état partagé du tableau de bord (objet `state`,
 * connexion WebSocket, reconnexion, auto-détection du mode de culte,
 * navigation par onglets).
 *
 * Extrait de dashboard/legacy-core.js (chantier de modularisation, dernier
 * lot). `state` et `ws` restent le point de partage central de tout le
 * tableau de bord — chaque module feature les importe en lecture seule
 * (liaison "live" ES module pour `ws`, référence d'objet partagée pour
 * `state`). IMPORT CIRCULAIRE assumé et sûr avec ws-dispatch.js : ce
 * fichier importe handleMessage() (appelé uniquement depuis ws.onmessage,
 * jamais évalué au chargement du module) et ws-dispatch.js importe `state`
 * d'ici (utilisé uniquement à l'intérieur des branches du switch) — au
 * moment où l'un ou l'autre s'exécute réellement, tout le graphe de
 * modules a fini de se charger.
 */
import { updateStatus } from './features/verse-session-display.js';
import { handleMessage } from './ws-dispatch.js';

// State Management
// Un seul objet partagé, muter une propriété depuis l'import reste visible
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
  // AJOUT (transparence détection IA) : posé par ws-dispatch.js sur
  // 'semanticDetected', consommé par displayVerse() dans
  // verse-session-display.js — voir les commentaires de ces deux fichiers.
  pendingSemanticDetection: null,
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
    // CORRECTIF (redesign visuel, lot 5) : la barre d'onglets fixée en bas
    // d'écran (<1024px, voir .bottom-tab-bar) duplique ces mêmes
    // .nav-item pour rester utilisable en largeur tablette — un clic doit
    // donc activer TOUTES les copies partageant le même data-sections
    // (barre latérale + barre du bas), pas seulement l'élément
    // physiquement cliqué, sinon les deux indicateurs actifs se
    // désynchronisent dès le premier redimensionnement de fenêtre.
    document
      .querySelectorAll(`.nav-item[data-sections="${item.dataset.sections}"]`)
      .forEach((i) => i.classList.add('active'));
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

// Exporté pour que dashboard/utils.js (requireWsOrWarn) et tous les
// modules feature y accèdent en lecture seule — liaison "live" ES module,
// voir le commentaire d'en-tête. Seul CE fichier réassigne ws.
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
      // AJOUT (recherche de versets par thème) : même raisonnement que
      // getMoods — la liste de thèmes vit côté serveur (TOPIC_INDEX dans
      // bible-semantic-search.js), récupérée à chaque connexion plutôt
      // que codée en dur ici.
      ws.send(JSON.stringify({ action: 'getTopics' }));
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

/* ============================================================================
   Exposition globale explicite (module ES, pas de globals implicites) — voir
   dashboard/legacy-core.js (historique) pour le contexte complet de ce
   chantier de modularisation.
   ============================================================================ */
window.getWsPort = getWsPort;
window.getWsToken = getWsToken;
window.getWsUrl = getWsUrl;
window.initWebSocket = initWebSocket;
window.scheduleReconnect = scheduleReconnect;
window.showSectionsFor = showSectionsFor;
window.startSermonModeAutoDetect = startSermonModeAutoDetect;
window.stopSermonModeAutoDetect = stopSermonModeAutoDetect;
