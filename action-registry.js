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
  transcript: { category: 'display', description: 'Texte transcrit pour détection de verset' },
  showVerse: { category: 'display', description: 'Afficher un verset par référence' },
  hideVerse: { category: 'display', description: 'Masquer le verset affiché' },

  // Mode lecture
  startReading: { category: 'reading', description: 'Démarrer le mode lecture' },
  stopReading: { category: 'reading', description: 'Arrêter le mode lecture' },
  nextReadingVerse: { category: 'reading', description: 'Verset suivant en mode lecture' },
  previousReadingVerse: { category: 'reading', description: 'Verset précédent en mode lecture' },

  // Langue & traduction
  setLanguage: { category: 'language', description: "Langue d'affichage (fr/en/both)" },
  setTranslation: { category: 'language', description: 'Traduction biblique' },
  setSecondaryTranslation: {
    category: 'language',
    description: 'Traduction secondaire (affichage côte à côte, verset manuel)',
  },
  translateText: { category: 'language', description: 'Traduction IA en direct' },
  hideTranslation: { category: 'language', description: 'Masquer la traduction' },
  setConfidenceThreshold: { category: 'transcription', description: 'Seuil de confiance ASR' },

  // Thème & affichage
  applyTheme: { category: 'theme', description: 'Appliquer un thème CSS' },
  setMoodTheme: { category: 'theme', description: "Thème d'ambiance IA" },
  setHighContrast: { category: 'accessibility', description: 'Contraste élevé' },
  setCaptions: { category: 'accessibility', description: 'Sous-titres en direct' },
  setTranslatedCaptions: { category: 'accessibility', description: 'Sous-titres traduits' },
  setTestPattern: { category: 'display', description: 'Motif de test couleur' },
  setBackgroundPattern: { category: 'theme', description: 'Motif de fond' },
  setBlackScreen: { category: 'emergency', description: "Écran noir d'urgence" },
  startCountdown: { category: 'timer', description: 'Lancer le compteur avant culte' },
  stopCountdown: { category: 'timer', description: 'Arrêter le compteur avant culte' },
  setAmbientMode: {
    category: 'theme',
    description: "Activer/désactiver le cycle auto d'ambiances",
  },
  extendTime: { category: 'timer', description: "延长 durée d'affichage" },
  pauseTimer: { category: 'timer', description: 'Mettre en pause le timer' },
  resumeTimer: { category: 'timer', description: 'Reprendre le timer' },
  emergencyClear: { category: 'emergency', description: 'Effacer tout immédiatement' },

  // Recherche biblique
  searchBible: { category: 'bible', description: 'Recherche biblique par mot-clé' },
  getTopics: { category: 'bible', description: 'Liste des sujets bibliques' },

  // IA
  agentRun: { category: 'ai', description: 'Exécuter une demande avec l’agent opérateur' },
  agentResume: { category: 'ai', description: 'Reprendre une exécution agent confirmée' },
  getMoods: { category: 'ai', description: "Thèmes d'ambiance disponibles" },
  getLiveSummary: { category: 'ai', description: 'Résumé IA du culte en direct' },
  getSermonTheme: { category: 'ai', description: 'Détection du thème du sermon' },
  getPostServiceRecap: { category: 'ai', description: 'Récapitulatif post-culte IA' },
  getCrossReferences: { category: 'ai', description: 'Références croisées' },
  getAiStats: { category: 'ai', description: 'Statistiques des modules IA' },
  getArchiveMatches: { category: 'ai', description: 'Recherche dans les archives' },
  askSermonQuestion: { category: 'ai', description: 'Question Q&A sur les sermons' },
  preServiceCheck: { category: 'ai', description: 'Vérification pré-culte' },

  // Médiathèque
  getMediaLibrary: { category: 'media', description: 'Liste des médias' },
  addMediaItem: { category: 'media', description: 'Ajouter un média' },
  updateMediaItem: { category: 'media', description: 'Modifier un média' },
  deleteMediaItem: { category: 'media', description: 'Supprimer un média' },
  triggerMediaItem: { category: 'media', description: "Déclencher l'affichage d'un média" },
  hideMedia: { category: 'media', description: 'Masquer le média affiché' },
  setDefaultMediaItem: { category: 'media', description: 'Définir le poster principal' },

  // Studio de scènes
  getSceneLibrary: { category: 'scenes', description: 'Liste des scènes' },
  addScene: { category: 'scenes', description: 'Ajouter une scène' },
  updateScene: { category: 'scenes', description: 'Modifier une scène' },
  deleteScene: { category: 'scenes', description: 'Supprimer une scène' },
  triggerScene: { category: 'scenes', description: 'Déclencher une scène' },
  hideScene: { category: 'scenes', description: 'Masquer la scène affichée' },
  setDefaultScene: { category: 'scenes', description: 'Scène par défaut' },

  // Bibliothèque de chants
  getSongLibrary: { category: 'songs', description: 'Liste des chants' },
  addSong: { category: 'songs', description: 'Ajouter un chant' },
  deleteSong: { category: 'songs', description: 'Supprimer un chant' },
  showSongSection: { category: 'songs', description: 'Afficher une section de chant' },

  // Caméras IP
  getIpCameras: { category: 'cameras', description: 'Liste des caméras IP' },
  addIpCamera: { category: 'cameras', description: 'Ajouter une caméra IP' },
  deleteIpCamera: { category: 'cameras', description: 'Supprimer une caméra IP' },
  generateCameraPairing: { category: 'cameras', description: 'Générer un code QR de jumelage' },

  // Habillage caméra
  getBranding: { category: 'branding', description: "État de l'habillage caméra" },
  setBrandingLogo: { category: 'branding', description: "Logo d'habillage" },
  clearBrandingLogo: { category: 'branding', description: 'Effacer le logo' },
  setBrandingPosition: { category: 'branding', description: "Position de l'habillage" },
  setBrandingSize: { category: 'branding', description: "Taille de l'habillage" },
  setBrandingText: { category: 'branding', description: "Titre/sous-titre d'habillage" },
  setBrandingVisible: { category: 'branding', description: "Visibilité de l'habillage" },

  // Branding tableau de bord
  getDashboardBranding: { category: 'dashboard-branding', description: 'Identité du dashboard' },
  setDashboardOrgName: { category: 'dashboard-branding', description: "Nom de l'organisation" },
  setDashboardAccentColor: { category: 'dashboard-branding', description: "Couleur d'accent" },
  setDashboardLogo: { category: 'dashboard-branding', description: 'Logo du dashboard' },
  clearDashboardLogo: { category: 'dashboard-branding', description: 'Effacer le logo dashboard' },

  // Infrastructure
  getNetworkStatus: { category: 'infra', description: 'État du réseau' },
  getSessionStats: { category: 'infra', description: 'Statistiques de session' },
  exportHighlights: { category: 'infra', description: 'Exporter les temps forts' },
  exportClips: { category: 'infra', description: 'Générer des extraits vidéo des temps forts' },
  getRundown: { category: 'infra', description: 'Lire la feuille de route (rundown/cue-list)' },
  addRundownCue: { category: 'infra', description: 'Ajouter un repère à la feuille de route' },
  removeRundownCue: { category: 'infra', description: 'Retirer un repère de la feuille de route' },
  reorderRundownCues: { category: 'infra', description: 'Réordonner la feuille de route' },
  triggerRundownCue: {
    category: 'infra',
    description: 'Déclencher un repère précis de la feuille de route',
  },
  nextRundownCue: {
    category: 'infra',
    description: 'Déclencher le repère suivant de la feuille de route',
  },
  clearRundown: { category: 'infra', description: 'Vider la feuille de route' },
  sendStageMessage: { category: 'infra', description: "Message sur l'écran de piste" },
  clearStageMessage: { category: 'infra', description: 'Effacer le message de piste' },
  getOfflineBibleStatus: { category: 'infra', description: 'État de la Bible hors-ligne' },
  listPlugins: { category: 'infra', description: 'Liste des plugins' },
  togglePlugin: { category: 'infra', description: 'Activer/désactiver un plugin' },
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
  sceneLibraryUpdated: { description: 'Scènes mises à jour' },
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
  extendTime: { description: '延长 durée' },
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

module.exports = {
  CLIENT_ACTIONS,
  SERVER_ACTIONS,
  VOICE_COMMANDS,
  KEYBOARD_SHORTCUTS,
  listClientActions,
  listServerActions,
  listVoiceCommands,
  listKeyboardShortcuts,
};
