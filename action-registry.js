'use strict';

/**
 * action-registry.js — Registre centralisé de toutes les actions du système.
 *
 * Source de vérité unique : chaque action (WS, voix, raccourci clavier) est
 * listée ici avec ses métadonnées. Le test CI (test/test-action-registry.js)
 * vérifie la parité entre ce registre et le code d'exécution réel.
 *
 * Convention : un "action" est un identifiant string unique, pas un objet.
 * Les actions serveur→client et client→serveur sont séparées car elles
 * vivent dans des canaux différents.
 */

// ---------------------------------------------------------------------------
// Actions CLIENT → SERVEUR (WS message action field)
// ---------------------------------------------------------------------------

const CLIENT_ACTIONS = {
  // Affichage core
  transcript: {
    operatorOnly: true,
    category: 'display',
    description: 'Texte transcrit pour détection de verset',
  },
  showVerse: {
    operatorOnly: true,
    category: 'display',
    description: 'Afficher un verset par référence',
  },
  hideVerse: { operatorOnly: true, category: 'display', description: 'Masquer le verset affiché' },

  // Mode lecture
  startReading: {
    operatorOnly: true,
    category: 'reading',
    description: 'Démarrer le mode lecture',
  },
  stopReading: { operatorOnly: true, category: 'reading', description: 'Arrêter le mode lecture' },
  nextReadingVerse: {
    operatorOnly: true,
    category: 'reading',
    description: 'Verset suivant en mode lecture',
  },
  previousReadingVerse: {
    operatorOnly: true,
    category: 'reading',
    description: 'Verset précédent en mode lecture',
  },

  // Langue & traduction
  setLanguage: {
    operatorOnly: true,
    category: 'language',
    description: "Langue d'affichage (fr/en/both)",
  },
  setTranslation: { operatorOnly: true, category: 'language', description: 'Traduction biblique' },
  setSecondaryTranslation: {
    operatorOnly: true,
    category: 'language',
    description: 'Traduction secondaire (affichage côte à côte, verset manuel)',
  },
  translateText: {
    operatorOnly: true,
    category: 'language',
    description: 'Traduction IA en direct',
  },
  hideTranslation: {
    operatorOnly: true,
    category: 'language',
    description: 'Masquer la traduction',
  },
  setConfidenceThreshold: {
    operatorOnly: true,
    category: 'transcription',
    description: 'Seuil de confiance ASR',
  },

  // Mode confiance (Partie 2 — auto/semi-auto/manuel)
  setTrustMode: {
    operatorOnly: true,
    category: 'trust',
    description: 'Changer le mode confiance (auto/semi-auto/manuel)',
  },
  confirmPendingVerse: {
    operatorOnly: true,
    category: 'trust',
    description: 'Confirmer le verset en attente (mode semi-auto/manuel)',
  },
  dismissPendingVerse: {
    operatorOnly: true,
    category: 'trust',
    description: 'Ignorer le verset en attente (mode semi-auto/manuel)',
  },

  // Thème & affichage
  applyTheme: { operatorOnly: true, category: 'theme', description: 'Appliquer un thème CSS' },
  setMoodTheme: { operatorOnly: true, category: 'theme', description: "Thème d'ambiance IA" },
  setHighContrast: {
    operatorOnly: true,
    category: 'accessibility',
    description: 'Contraste élevé',
  },
  setCaptions: {
    operatorOnly: true,
    category: 'accessibility',
    description: 'Sous-titres en direct',
  },
  setTranslatedCaptions: {
    operatorOnly: true,
    category: 'accessibility',
    description: 'Sous-titres traduits',
  },
  setTestPattern: { operatorOnly: true, category: 'display', description: 'Motif de test couleur' },
  setBackgroundPattern: { operatorOnly: true, category: 'theme', description: 'Motif de fond' },
  setBlackScreen: {
    operatorOnly: true,
    category: 'emergency',
    description: "Écran noir d'urgence",
  },
  startCountdown: {
    operatorOnly: true,
    category: 'timer',
    description: 'Lancer le compteur avant culte',
  },
  stopCountdown: {
    operatorOnly: true,
    category: 'timer',
    description: 'Arrêter le compteur avant culte',
  },
  setAmbientMode: {
    operatorOnly: true,
    category: 'theme',
    description: "Activer/désactiver le cycle auto d'ambiances",
  },
  extendTime: {
    operatorOnly: true,
    category: 'timer',
    description: "Prolonger la durée d'affichage",
  },
  pauseTimer: { operatorOnly: true, category: 'timer', description: 'Mettre en pause le timer' },
  resumeTimer: { operatorOnly: true, category: 'timer', description: 'Reprendre le timer' },
  emergencyClear: {
    operatorOnly: true,
    category: 'emergency',
    description: 'Effacer tout immédiatement',
  },

  // Recherche biblique
  searchBible: {
    operatorOnly: true,
    category: 'bible',
    description: 'Recherche biblique par mot-clé',
  },
  getTopics: { category: 'bible', description: 'Liste des sujets bibliques' },

  // IA
  agentRun: {
    operatorOnly: true,
    category: 'ai',
    description: 'Exécuter une demande avec l’agent opérateur',
  },
  agentResume: {
    operatorOnly: true,
    category: 'ai',
    description: 'Reprendre une exécution agent confirmée',
  },
  getMoods: { category: 'ai', description: "Thèmes d'ambiance disponibles" },
  getLiveSummary: {
    operatorOnly: true,
    category: 'ai',
    description: 'Résumé IA du culte en direct',
  },
  getSermonTheme: {
    operatorOnly: true,
    category: 'ai',
    description: 'Détection du thème du sermon',
  },
  getPostServiceRecap: {
    operatorOnly: true,
    category: 'ai',
    description: 'Récapitulatif post-culte IA',
  },
  getCrossReferences: { operatorOnly: true, category: 'ai', description: 'Références croisées' },
  getAiStats: { category: 'ai', description: 'Statistiques des modules IA' },
  getArchiveMatches: {
    operatorOnly: true,
    category: 'ai',
    description: 'Recherche dans les archives',
  },
  askSermonQuestion: {
    operatorOnly: true,
    category: 'ai',
    description: 'Question Q&A sur les sermons',
  },
  preServiceCheck: { operatorOnly: true, category: 'ai', description: 'Vérification pré-culte' },

  // Médiathèque
  getMediaLibrary: { operatorOnly: true, category: 'media', description: 'Liste des médias' },
  addMediaItem: { operatorOnly: true, category: 'media', description: 'Ajouter un média' },
  updateMediaItem: { operatorOnly: true, category: 'media', description: 'Modifier un média' },
  deleteMediaItem: { operatorOnly: true, category: 'media', description: 'Supprimer un média' },
  triggerMediaItem: {
    operatorOnly: true,
    category: 'media',
    description: "Déclencher l'affichage d'un média",
  },
  hideMedia: { operatorOnly: true, category: 'media', description: 'Masquer le média affiché' },
  setDefaultMediaItem: {
    operatorOnly: true,
    category: 'media',
    description: 'Définir le poster principal',
  },
  testTriggerPhrase: {
    operatorOnly: true,
    category: 'media',
    description: 'Tester une phrase déclencheuse avant le culte (bouton "essayer")',
  },
  getMediaGroups: {
    operatorOnly: true,
    category: 'media',
    description: 'Liste des groupes de médias',
  },
  addMediaGroup: {
    operatorOnly: true,
    category: 'media',
    description: 'Créer un groupe de médias déclenchable à la voix',
  },
  deleteMediaGroup: {
    operatorOnly: true,
    category: 'media',
    description: 'Supprimer un groupe de médias',
  },
  setMediaItemGroup: {
    operatorOnly: true,
    category: 'media',
    description: "Rattacher/détacher un média d'un groupe",
  },

  // Studio de scènes
  getSceneLibrary: { operatorOnly: true, category: 'scenes', description: 'Liste des scènes' },
  addScene: { operatorOnly: true, category: 'scenes', description: 'Ajouter une scène' },
  importPptxSlides: {
    operatorOnly: true,
    category: 'scenes',
    description: "Importer le texte des diapositives d'un .pptx en scènes",
  },
  exportService: {
    operatorOnly: true,
    category: 'infra',
    description: 'Exporter le service courant (feuille de route + scènes + médias) en .zip',
  },
  updateScene: { operatorOnly: true, category: 'scenes', description: 'Modifier une scène' },
  deleteScene: { operatorOnly: true, category: 'scenes', description: 'Supprimer une scène' },
  triggerScene: { operatorOnly: true, category: 'scenes', description: 'Déclencher une scène' },
  hideScene: { operatorOnly: true, category: 'scenes', description: 'Masquer la scène affichée' },
  setDefaultScene: { operatorOnly: true, category: 'scenes', description: 'Scène par défaut' },

  // Bibliothèque de chants
  getSongLibrary: { operatorOnly: true, category: 'songs', description: 'Liste des chants' },
  addSong: { operatorOnly: true, category: 'songs', description: 'Ajouter un chant' },
  deleteSong: { operatorOnly: true, category: 'songs', description: 'Supprimer un chant' },
  showSongSection: {
    operatorOnly: true,
    category: 'songs',
    description: 'Afficher une section de chant',
  },

  // Caméras IP
  getIpCameras: { operatorOnly: true, category: 'cameras', description: 'Liste des caméras IP' },
  addIpCamera: { operatorOnly: true, category: 'cameras', description: 'Ajouter une caméra IP' },
  deleteIpCamera: {
    operatorOnly: true,
    category: 'cameras',
    description: 'Supprimer une caméra IP',
  },
  generateCameraPairing: {
    operatorOnly: true,
    category: 'cameras',
    description: 'Générer un code QR de jumelage',
  },

  // Habillage caméra
  getBranding: {
    operatorOnly: true,
    category: 'branding',
    description: "État de l'habillage caméra",
  },
  setBrandingLogo: { operatorOnly: true, category: 'branding', description: "Logo d'habillage" },
  clearBrandingLogo: { operatorOnly: true, category: 'branding', description: 'Effacer le logo' },
  setBrandingPosition: {
    operatorOnly: true,
    category: 'branding',
    description: "Position de l'habillage",
  },
  setBrandingSize: {
    operatorOnly: true,
    category: 'branding',
    description: "Taille de l'habillage",
  },
  setBrandingText: {
    operatorOnly: true,
    category: 'branding',
    description: "Titre/sous-titre d'habillage",
  },
  setBrandingVisible: {
    operatorOnly: true,
    category: 'branding',
    description: "Visibilité de l'habillage",
  },

  // Branding tableau de bord
  getDashboardBranding: {
    operatorOnly: true,
    category: 'dashboard-branding',
    description: 'Identité du dashboard',
  },
  setDashboardOrgName: {
    operatorOnly: true,
    category: 'dashboard-branding',
    description: "Nom de l'organisation",
  },
  setDashboardAccentColor: {
    operatorOnly: true,
    category: 'dashboard-branding',
    description: "Couleur d'accent",
  },
  setDashboardLogo: {
    operatorOnly: true,
    category: 'dashboard-branding',
    description: 'Logo du dashboard',
  },
  clearDashboardLogo: {
    operatorOnly: true,
    category: 'dashboard-branding',
    description: 'Effacer le logo dashboard',
  },

  // Infrastructure
  getNetworkStatus: { operatorOnly: true, category: 'infra', description: 'État du réseau' },
  getSessionStats: {
    operatorOnly: true,
    category: 'infra',
    description: 'Statistiques de session',
  },
  exportHighlights: {
    operatorOnly: true,
    category: 'infra',
    description: 'Exporter les temps forts',
  },
  exportClips: {
    operatorOnly: true,
    category: 'infra',
    description: 'Générer des extraits vidéo des temps forts',
  },
  getRundown: {
    operatorOnly: true,
    category: 'infra',
    description: 'Lire la feuille de route (rundown/cue-list)',
  },
  addRundownCue: {
    operatorOnly: true,
    category: 'infra',
    description: 'Ajouter un repère à la feuille de route',
  },
  removeRundownCue: {
    operatorOnly: true,
    category: 'infra',
    description: 'Retirer un repère de la feuille de route',
  },
  reorderRundownCues: {
    operatorOnly: true,
    category: 'infra',
    description: 'Réordonner la feuille de route',
  },
  triggerRundownCue: {
    operatorOnly: true,
    category: 'infra',
    description: 'Déclencher un repère précis de la feuille de route',
  },
  nextRundownCue: {
    operatorOnly: true,
    category: 'infra',
    description: 'Déclencher le repère suivant de la feuille de route',
  },
  clearRundown: { operatorOnly: true, category: 'infra', description: 'Vider la feuille de route' },
  sendStageMessage: {
    operatorOnly: true,
    category: 'infra',
    description: "Message sur l'écran de piste",
  },
  clearStageMessage: {
    operatorOnly: true,
    category: 'infra',
    description: 'Effacer le message de piste',
  },
  getOfflineBibleStatus: {
    operatorOnly: true,
    category: 'infra',
    description: 'État de la Bible hors-ligne',
  },
  listPlugins: { category: 'infra', description: 'Liste des plugins' },
  togglePlugin: {
    operatorOnly: true,
    category: 'infra',
    description: 'Activer/désactiver un plugin',
  },
  ping: { category: 'infra', description: 'Heartbeat' },
};

// ---------------------------------------------------------------------------
// Actions SERVEUR → CLIENT (broadcast / ws.send)
// ---------------------------------------------------------------------------

const SERVER_ACTIONS = {
  init: { description: 'État initial à la connexion WS' },
  agentEvent: { description: 'Événement de progression de l’agent opérateur' },
  showVerse: { description: 'Afficher un verset' },
  hideVerse: { description: 'Masquer le verset' },
  transcript: { description: 'Texte transcrit final' },
  transcriptCorrected: { description: 'Transcription corrigée par IA' },
  semanticDetected: { description: 'Référence détectée par sémantique IA' },
  candidateVerse: { description: 'Candidat de verset spéculatif' },
  verseBuffered: { description: 'Verset en attente de confirmation' },
  trustModeChanged: { description: 'Mode confiance changé (auto/semi-auto/manuel)' },
  pendingVerseConfirmation: {
    description: 'Verset détecté en attente de confirmation opérateur (mode semi-auto/manuel)',
  },
  pendingVerseDismissed: { description: 'Verset en attente ignoré ou remplacé' },
  readingStarted: { description: 'Mode lecture activé' },
  readingStopped: { description: 'Mode lecture désactivé' },
  nextVerse: { description: 'Verset suivant' },
  previousVerse: { description: 'Verset précédent' },
  nextChapter: { description: 'Chapitre suivant' },
  previousChapter: { description: 'Chapitre précédent' },
  languageChanged: { description: "Langue d'affichage changée" },
  transcriptionLanguageChanged: { description: 'Langue de transcription changée' },
  translationChanged: { description: 'Traduction biblique changée' },
  secondaryTranslationChanged: { description: 'Traduction secondaire (côte à côte) changée' },
  showTranslation: { description: 'Traduction affichée' },
  hideTranslation: { description: 'Traduction masquée' },
  textTranslated: { description: 'Texte traduit' },
  applyTheme: { description: 'Thème appliqué' },
  accessibilityMode: { description: 'Mode contraste élevé' },
  captionsMode: { description: 'Mode sous-titres' },
  translatedCaptionsMode: { description: 'Mode sous-titres traduits' },
  testPatternMode: { description: 'Mode motif de test' },
  backgroundPatternMode: { description: 'Mode motif de fond' },
  blackScreenMode: { description: 'Mode écran noir' },
  countdownMode: { description: 'Compteur avant culte actif' },
  countdownStop: { description: 'Compteur avant culte arrêté' },
  ambientModeChanged: { description: 'Mode ambiances changé' },
  extendTime: { description: 'Durée étendue' },
  pauseTimer: { description: 'Timer en pause' },
  resumeTimer: { description: 'Timer repris' },
  emergencyClear: { description: "Effacement d'urgence" },
  historyUpdated: { description: 'Historique des versets mis à jour' },
  showMedia: { description: 'Média affiché' },
  hideMedia: { description: 'Média masqué' },
  showScene: { description: 'Scène affichée' },
  hideScene: { description: 'Scène masquée' },
  defaultMediaChanged: { description: 'Poster principal changé' },
  defaultSceneChanged: { description: 'Scène par défaut changée' },
  mediaLibraryUpdated: { description: 'Médiathèque mise à jour' },
  mediaGroupsUpdated: { description: 'Groupes de médias mis à jour' },
  triggerPhraseTestResult: {
    description: 'Résultat du test "essayer" une phrase déclencheuse',
  },
  mediaTriggerCollisions: {
    description: "Collision(s) phonétique(s) détectée(s) entre phrases déclencheuses à l'import",
  },
  sceneLibraryUpdated: { description: 'Scènes mises à jour' },
  pptxImportResult: { description: "Résultat de l'import PowerPoint" },
  serviceExportResult: { description: "Résultat de l'export du service" },
  rundownUpdated: { description: 'Feuille de route mise à jour' },
  rundownActiveCue: { description: 'Repère actif de la feuille de route changé' },
  songLibraryUpdated: { description: 'Bibliothèque chants mise à jour' },
  ipCamerasUpdated: { description: 'Liste caméras IP mise à jour' },
  brandingUpdate: { description: 'Habillage caméra mis à jour' },
  dashboardBrandingUpdate: { description: 'Branding dashboard mis à jour' },
  networkStatus: { description: 'État réseau' },
  sessionStats: { description: 'Statistiques de session' },
  highlightsExported: { description: 'Temps forts exportés' },
  preServiceCheckResult: { description: 'Résultat vérification pré-culte' },
  searchResults: { description: 'Résultats recherche biblique' },
  searchError: { description: 'Erreur recherche biblique' },
  topicsList: { description: 'Liste des sujets' },
  moodsList: { description: 'Liste des ambiances' },
  themeApplied: { description: 'Thème appliqué (confirmation)' },
  pluginsList: { description: 'Liste des plugins' },
  pluginToggled: { description: 'Plugin activé/désactivé' },
  aiStats: { description: 'Statistiques IA' },
  liveSummary: { description: 'Résumé IA en direct' },
  sermonTheme: { description: 'Thème du sermon' },
  postServiceRecap: { description: 'Récapitulatif post-culte' },
  archiveMatches: { description: 'Résultats recherche archive' },
  crossReferences: { description: 'Références croisées' },
  stageMessage: { description: 'Message de piste' },
  offlineBibleStatus: { description: 'État Bible hors-ligne' },
  audioDiagnostics: { description: 'Diagnostics audio' },
  dedupSuppressed: { description: 'Verset supprimé par dédoublonnage' },
  aiModuleError: {
    description: "Échec d'appel d'un module IA (corrector/semanticDetector/themeGenerator)",
  },
  obsConnectionStatus: {
    description: 'État de connexion OBS (connected/disconnected/reconnecting/error)',
  },
  confidenceThresholdChanged: { description: 'Seuil de confiance mis à jour' },
  error: { description: "Message d'erreur" },
};

// ---------------------------------------------------------------------------
// Commandes vocales (détection → exécution)
// ---------------------------------------------------------------------------

const VOICE_COMMANDS = {
  hideVerse: { description: 'Masquer le verset' },
  emergencyClear: { description: "Effacement d'urgence" },
  nextVerse: { description: 'Verset suivant' },
  previousVerse: { description: 'Verset précédent' },
  nextChapter: { description: 'Chapitre suivant' },
  previousChapter: { description: 'Chapitre précédent' },
  setTheme: { description: 'Changer le thème' },
  setLanguage: { description: "Changer la langue d'affichage" },
  setTranscriptionLanguage: { description: 'Changer la langue de transcription' },
  setTranslation: { description: 'Changer la traduction biblique' },
  extendTime: { description: 'Prolonger la durée' },
  pauseTimer: { description: 'Pause le timer' },
  resumeTimer: { description: 'Reprend le timer' },
};

// ---------------------------------------------------------------------------
// Raccourcis clavier (hotkeys, main.js → worker)
// ---------------------------------------------------------------------------

const KEYBOARD_SHORTCUTS = {
  emergencyClear: { description: "Effacement d'urgence" },
  hideVerse: { description: 'Masquer le verset' },
  hideMedia: { description: 'Masquer le média' },
  hideScene: { description: 'Masquer la scène' },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function listClientActions() {
  return Object.keys(CLIENT_ACTIONS).sort();
}

function listServerActions() {
  return Object.keys(SERVER_ACTIONS).sort();
}

function listVoiceCommands() {
  return Object.keys(VOICE_COMMANDS).sort();
}

function listKeyboardShortcuts() {
  return Object.keys(KEYBOARD_SHORTCUTS).sort();
}

// Source unique de vérité pour le contrôle d'accès WS (rôle 'operator' vs
// 'viewer', voir server.js). Une action CLIENT_ACTIONS sans `operatorOnly`
// est accessible aux deux rôles (ex. ping, les listes en lecture seule).
function listOperatorOnlyActions() {
  return Object.keys(CLIENT_ACTIONS)
    .filter((action) => CLIENT_ACTIONS[action].operatorOnly)
    .sort();
}

const ACTION_REGISTRY_EXPORTS = {
  CLIENT_ACTIONS,
  SERVER_ACTIONS,
  VOICE_COMMANDS,
  KEYBOARD_SHORTCUTS,
  listClientActions,
  listServerActions,
  listVoiceCommands,
  listOperatorOnlyActions,
  listKeyboardShortcuts,
};

// AJOUT (Partie 2.4 — palette Ctrl+K, un seul vocabulaire pour la voix et le
// manuel) : ce fichier tournait jusqu'ici uniquement côté Node (server.js,
// tests) via module.exports. Chargé aussi en <script> classique par
// dashboard.html (avant dashboard/main.js, même raisonnement que
// scene-render.js ci-dessus) pour que command-palette.js lise CLIENT_ACTIONS
// au lieu d'une liste dupliquée à la main. `module` n'existe pas dans un
// navigateur : le garde ci-dessous évite un crash au chargement dans ce
// contexte, sans rien changer côté Node.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = ACTION_REGISTRY_EXPORTS;
}
if (typeof window !== 'undefined') {
  window.ACTION_REGISTRY = ACTION_REGISTRY_EXPORTS;
}
