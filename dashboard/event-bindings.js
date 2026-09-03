/**
 * dashboard/event-bindings.js — câblage central des écouteurs de clic du
 * tableau de bord (phase 3, point 2 : suppression des attributs onclick
 * inline).
 *
 * POURQUOI CE MODULE EXISTE :
 * dashboard.html portait 153 attributs `onclick="..."` en clair. Deux
 * problèmes : (1) une CSP stricte ne peut pas interdire les gestionnaires
 * d'événements inline tant qu'ils existent (même raison qui a fait bannir
 * les blocs <script> inline de ce fichier), et (2) la logique appelée
 * n'était ni relisible ni testable depuis le HTML. Les fonctions
 * elles-mêmes n'ont pas bougé : elles vivaient déjà toutes dans
 * dashboard/features/*.js et étaient déjà republiées sur `window` en bas
 * de leur fichier — ce module ne fait que changer la FAÇON dont elles sont
 * reliées à un clic, jamais ce qu'elles font.
 *
 * POURQUOI `window.x()` PLUTÔT QU'UN import DIRECT :
 * choix délibéré, pour deux raisons de sûreté :
 *   - La résolution reste TARDIVE (au clic), exactement comme le faisait
 *     un attribut onclick, qui cherchait le nom dans la portée globale au
 *     moment du clic et non au chargement. Un module encore non évalué ne
 *     change donc rien au résultat.
 *   - Aucune nouvelle arête d'import n'est ajoutée au graphe de modules.
 *     Plusieurs features/*.js ne sont chargées qu'INDIRECTEMENT (voir les
 *     commentaires de main.js) et exécutent des effets de bord à
 *     l'évaluation ; les importer ici aurait pu déplacer leur ordre
 *     d'évaluation, donc changer le démarrage. Le câblage doit être
 *     strictement inerte de ce point de vue.
 * Seule exception : showToast, qui n'est PAS republiée sur `window` (voir
 * plus bas).
 *
 * POURQUOI PAS DE DOMContentLoaded :
 * main.js est chargé via <script type="module">, qui est TOUJOURS différé —
 * le document est donc entièrement analysé quand ce fichier s'évalue. C'est
 * l'hypothèse que font déjà toutes les features/*.js (elles interrogent le
 * DOM à l'évaluation). Ajouter un écouteur DOMContentLoaded ici serait au
 * mieux inutile, au pire une source de décalage avec le reste.
 */
import { showToast } from './utils.js';

/**
 * Table déclarative id d'élément -> écouteur de clic, dans l'ordre du
 * document pour rester relisible en regard de dashboard.html.
 */
const CLICK_BINDINGS = {
  // --- Mode focus ---
  focusModeToggleBtn: () => window.toggleFocusMode(),

  // --- Barre d'état / pipeline ---
  speechBtn: () => window.toggleRealMicCapture(),
  restartPipelineBtn: () => window.restartPipeline(),
  aiDegradedDismissBtn: () => window.dismissAiDegradedBanner(),
  // AJOUT (audit — bannière "hors ligne / mode manuel") : setTrustMode()
  // vit dans trust-mode.js, acknowledgeOfflineManualBanner() dans
  // pipeline-health.js — deux modules qui ne s'importent pas l'un l'autre
  // (voir pipeline-health.js), câblés ici plutôt que d'ajouter une arête
  // d'import croisée entre eux pour un seul clic.
  offlineManualModeSwitchBtn: () => {
    window.setTrustMode('manual');
    window.acknowledgeOfflineManualBanner();
    showToast('Mode manuel activé — continuez le service sans attendre le rétablissement.', 'info');
  },

  // --- Studio ProPresenter : effacement d'urgence (F1-F4) ---
  ppClearAllBtn: () => window.ppClearAll(),
  ppClearSlideBtn: () => window.ppClearSlide(),
  ppClearMediaBtn: () => window.ppClearMedia(),
  ppClearPropsBtn: () => window.ppClearProps(),
  ppMicBtn: () => window.toggleRealMicCapture(),

  // --- Studio : feuille de culte ---
  // Gardes `if (window.x)` conservées telles quelles : elles font partie du
  // comportement d'origine, pas un ajout défensif de ce chantier.
  ppRundownNextCueBtn: () => {
    if (window.nextRundownCue) window.nextRundownCue();
  },
  ppRundownAddBtn: () => window.addVerseToRundownFromStudio(),

  // --- Studio : écriture rapide / recherche sémantique ---
  fireQuickScriptureBtn: () => window.fireQuickScripture(),
  executeAiSemanticSearchBtn: () => window.executeAiSemanticSearch(),
  // Apostrophes DROITES (U+0027) volontairement : c'est le texte exact que
  // portaient les attributs onclick (`l\'épreuve`), et il part tel quel
  // dans la requête sémantique — une apostrophe typographique donnerait
  // une chaîne différente.
  ppQuickQueryPaixBtn: () => window.quickSemanticQuery("paix et réconfort dans l'épreuve"),
  ppQuickQueryAmourBtn: () => window.quickSemanticQuery("l'amour inconditionnel de Dieu"),
  ppQuickQueryFoiBtn: () => window.quickSemanticQuery('la foi et la persévérance'),
  ppQuickQueryEsperanceBtn: () => window.quickSemanticQuery('toutes choses concourent au bien'),
  generateKeyPointFromSpeechBtn: () => window.generateKeyPointFromSpeech(),
  ppAiAutoThemeBtn: () => window.toggleAiAutoTheme(),

  // --- Studio : médiathèque (pseudo-boutons, voir CUE_BINDINGS) ---
  // CORRECTIF (audit fonctionnel) : appelaient window.triggerMediaById(),
  // qui n'a jamais existé — la vraie fonction est triggerMediaLibraryItem(id)
  // dans dashboard/features/media-library.js (déjà republiée sur window).
  // Les quatre ids bg-gold/bg-blue/bg-purple/bg-green doivent exister dans
  // la médiathèque pour que ces boutons déclenchent réellement quelque
  // chose — voir le média par défaut correspondant, séparément.
  ppMediaCueBgGold: () => {
    if (window.triggerMediaLibraryItem) window.triggerMediaLibraryItem('bg-gold');
  },
  ppMediaCueBgBlue: () => {
    if (window.triggerMediaLibraryItem) window.triggerMediaLibraryItem('bg-blue');
  },
  ppMediaCueBgPurple: () => {
    if (window.triggerMediaLibraryItem) window.triggerMediaLibraryItem('bg-purple');
  },
  ppMediaCueBgGreen: () => {
    if (window.triggerMediaLibraryItem) window.triggerMediaLibraryItem('bg-green');
  },

  // CORRECTIF (relevé pendant ce chantier) : ces deux repères appelaient
  // `showToast(...)` en inline alors que showToast est un export ES de
  // utils.js JAMAIS republié sur `window` — le clic levait donc une
  // ReferenceError et n'affichait aucun toast. L'import en tête de fichier
  // rend enfin le geste conforme à ce que le balisage annonçait.
  ppSongCue1: () => showToast('Chant sélectionné', 'info'),
  ppSongCue2: () => showToast('Chant sélectionné', 'info'),

  // --- Studio : navigation lecture ---
  ppPrevChapterBtn: () => {
    if (window.prevChapter) window.prevChapter();
  },
  ppPrevReadingVerseBtn: () => {
    if (window.prevReadingVerse) window.prevReadingVerse();
  },
  ppNextReadingVerseBtn: () => {
    if (window.nextReadingVerse) window.nextReadingVerse();
  },
  ppNextChapterBtn: () => {
    if (window.nextChapter) window.nextChapter();
  },

  // --- Studio : ambiances ---
  setStudioMoodDarkBtn: () => window.setStudioMood('dark'),
  setStudioMoodWarmBtn: () => window.setStudioMood('warm'),
  setStudioMoodCoolBtn: () => window.setStudioMood('cool'),
  setStudioMoodCelebrationBtn: () => window.setStudioMood('celebration'),
  setStudioMoodPurpleBtn: () => window.setStudioMood('purple'),
  setStudioMoodRegalBtn: () => window.setStudioMood('regal'),

  // --- Mode confiance ---
  setTrustModeAutoBtn: () => window.setTrustMode('auto'),
  setTrustModeSemiAutoBtn: () => window.setTrustMode('semi-auto'),
  setTrustModeManualBtn: () => window.setTrustMode('manual'),

  // --- Simulation de parole (test opérateur) ---
  sendCustomSpeechTextBtn: () => window.sendCustomSpeechText(),
  speechChipJean316Btn: () => window.sendCustomSpeechText('Lisons dans Jean chapitre 3 verset 16'),
  speechChipPsaume231Btn: () => window.sendCustomSpeechText('Psaume 23 verset 1'),
  speechChip1Cor134Btn: () => window.sendCustomSpeechText('1 Corinthiens chapitre 13 verset 4'),
  speechChipRomains828Btn: () => window.sendCustomSpeechText('Romains chapitre 8 verset 28'),
  speechChipEsaie4031Btn: () => window.sendCustomSpeechText('Esaie 40 verset 31'),

  // --- Aperçu direct / motifs de fond ---
  livePreviewToggleBtn: () => window.toggleLivePreview(),
  'pattern-btn-none': () => window.setBackgroundPattern('none'),
  'pattern-btn-dots': () => window.setBackgroundPattern('dots'),
  'pattern-btn-grid': () => window.setBackgroundPattern('grid'),
  'pattern-btn-diagonal': () => window.setBackgroundPattern('diagonal'),

  // --- File d'attente de versets / feuille de route ---
  sendNextInQueueBtn: () => window.sendNextInQueue(),
  addToQueueBtn: () => window.addToQueue(),
  clearRundownBtn: () => window.clearRundown(),
  nextRundownCueBtn: () => window.nextRundownCue(),
  addVerseToRundownBtn: () => window.addVerseToRundown(),

  // --- Sas de diffusion (Airlock Preview) ---
  airlockDisarmBtn: () => window.disarmAirlock(),
  airlockGoLiveBtn: () => window.goLiveFromAirlock(),

  // --- Médiathèque / chants ---
  clearDefaultPosterFromCardBtn: () => window.clearDefaultPosterFromCard(),
  hideMediaNowBtn: () => window.hideMediaNow(),
  addMediaLibraryItemBtn: () => window.addMediaLibraryItem(),
  addMediaGroupBtn: () => window.addMediaGroup(),
  addSongToLibraryBtn: () => window.addSongToLibrary(),

  // --- Verset en attente (mode confiance) ---
  confirmPendingVerseBtn: () => window.confirmPendingVerse(),
  dismissPendingVerseBtn: () => window.dismissPendingVerse(),

  // --- Carte "verset en direct" (héros) ---
  heroShowManualVerseBtn: () => window.showManualVerse(),
  heroShareImageBtn: () => window.exportVerseAsImage(),
  heroHideVerseBtn: () => window.hideVerse(),
  heroEmergencyStopBtn: () => window.emergencyStop(),

  // --- Actions rapides ---
  showManualVerseBtn: () => window.showManualVerse(),
  hideVerseBtn: () => window.hideVerse(),
  pauseTimerBtn: () => window.pauseTimer(),
  resumeTimerBtn: () => window.resumeTimer(),
  emergencyStopBtn: () => window.emergencyStop(),
  toggleBlackScreenBtn: () => window.toggleBlackScreen(),
  toggleTrainingModeBtn: () => window.toggleTrainingMode(),

  // --- Compte à rebours de culte ---
  startServiceCountdownBtn: () => window.startServiceCountdown(),
  stopServiceCountdownBtn: () => window.stopServiceCountdown(),

  // --- Mode lecture ---
  readingModeStartBtn: () => window.startReadingMode(),
  readingModeStopBtn: () => window.stopReadingMode(),
  previousReadingVerseBtn: () => window.previousReadingVerse(),
  nextReadingVerseBtn: () => window.nextReadingVerse(),

  // --- Langue d'affichage ---
  setLanguageFrBtn: () => window.setLanguage('fr'),
  setLanguageEnBtn: () => window.setLanguage('en'),
  setLanguageBothBtn: () => window.setLanguage('both'),

  // --- Transcription ---
  clearTranscriptBtn: () => window.clearTranscript(),

  // --- Fonctions IA ---
  liveSummaryRefreshBtn: () => window.requestLiveSummary(),
  requestSermonThemeBtn: () => window.requestSermonTheme(),
  requestLiveSummaryBtn: () => window.requestLiveSummary(),
  requestCrossReferencesBtn: () => window.requestCrossReferences(),
  requestLiveTranslationBtn: () => window.requestLiveTranslation(),
  requestPostServiceRecapBtn: () => window.requestPostServiceRecap(),
  exportPostServiceRecapBtn: () => window.exportPostServiceRecap(),
  requestAiStatsBtn: () => window.requestAiStats(),

  // --- Archives de prédication ---
  requestArchiveSearchBtn: () => window.requestArchiveSearch(),
  exportPostServiceRecapArchiveBtn: () => window.exportPostServiceRecap(),
  exportHighlightsArchiveBtn: () => window.exportHighlights(),

  // --- Agent IA ---
  runAgentBtn: () => window.runAgent(),
  agentApproveBtn: () => window.approveAgentTool(),
  askSermonQuestionBtn: () => window.askSermonQuestion(),

  // --- Recherche biblique par sujet / statistiques ---
  searchBibleByTopicBtn: () => window.searchBibleByTopic(),
  requestSessionStats1Btn: () => window.requestSessionStats(1),
  requestSessionStats7Btn: () => window.requestSessionStats(7),
  exportHighlightsBtn: () => window.exportHighlights(),

  // --- Export de clips vidéo ---
  pickClipSourceVideoBtn: () => window.pickClipSourceVideo(),
  pickClipOutputFolderBtn: () => window.pickClipOutputFolder(),
  clipExportBtn: () => window.startClipExport(),

  // --- Vérification d'avant-culte ---
  preServiceCheckBtn: () => window.runPreServiceCheck(),

  // --- Identité du tableau de bord ---
  saveDashboardOrgNameBtn: () => window.saveDashboardOrgName(),
  pickDashboardLogoBtn: () => window.pickDashboardLogo(),
  clearDashboardLogoBtn: () => window.clearDashboardLogo(),

  // --- Écrans / affichage scène ---
  refreshDisplaysBtn: () => window.refreshDisplays(),
  outputOpenOverlayBtn: () => window.openOutputWindow('overlay'),
  outputCloseOverlayBtn: () => window.closeOutputWindow('overlay'),
  outputOpenStageBtn: () => window.openOutputWindow('stage'),
  outputCloseStageBtn: () => window.closeOutputWindow('stage'),
  outputOpenAnnouncementsBtn: () => window.openOutputWindow('announcements'),
  outputCloseAnnouncementsBtn: () => window.closeOutputWindow('announcements'),
  sendStageMessageBtn: () => window.sendStageMessage(),
  clearStageMessageBtn: () => window.clearStageMessage(),

  // --- Caméras ---
  refreshCameraListBtn: () => window.refreshCameraList(),
  cameraToggleBtn: () => window.toggleCameraCapture(),
  generateCameraPairingBtn: () => window.generateCameraPairing(),
  addIpCameraBtn: () => window.addIpCamera(),

  // --- Réseau ---
  networkSuggestBtn: () => window.useSuggestedLanIp(),
  saveNetworkSettingsBtn: () => window.saveNetworkSettings(),

  // --- Habillage / marque ---
  copyBrandingOverlayUrlBtn: () => window.copyBrandingOverlayUrl(),
  pickBrandingLogoBtn: () => window.pickBrandingLogo(),
  clearBrandingLogoBtn: () => window.clearBrandingLogo(),
  saveBrandingTextBtn: () => window.saveBrandingText(),
  brandingVisibleToggleBtn: () => window.toggleBrandingVisible(),

  // --- Page compagnon ---
  copyCompanionLinkBtn: () => window.copyCompanionLink(),
  copyMcpTokenBtn: () => window.copyMcpToken(),

  // --- Export / import de culte ---
  exportServicePortableBtn: () => window.exportServicePortable(),
  importServicePortableBtn: () => window.importServicePortable(),

  // --- OBS ---
  saveObsConfigBtn: () => window.saveObsConfig(),
  connectObsBtn: () => window.connectObs(),
  refreshObsScenesBtn: () => window.refreshObsScenes(),
  toggleObsRecordingBtn: () => window.toggleObsRecording(),
  toggleObsStreamingBtn: () => window.toggleObsStreaming(),

  // --- ProPresenter / Planning Center ---
  saveProPresenterConfigBtn: () => window.saveProPresenterConfig(),
  connectProPresenterBtn: () => window.connectProPresenter(),
  sendProPresenterTestMessageBtn: () => window.sendProPresenterTestMessage(),
  savePlanningCenterConfigBtn: () => window.savePlanningCenterConfig(),
  fetchPlanningCenterPlanBtn: () => window.fetchPlanningCenterPlan(),

  // --- Overlay & liens à partager ---
  togglePreviewProgramModeBtn: () => window.togglePreviewProgramMode(),
  refreshOverlayBtn: () => window.refreshOverlay(),
  copyOverlayUrlBtn: () => window.copyOverlayUrl(),
  copyCompanionUrlBtn: () => window.copyCompanionUrl(),
  copyStageDisplayUrlBtn: () => window.copyStageDisplayUrl(),
  copyAnnouncementLoopUrlBtn: () => window.copyAnnouncementLoopUrl(),

  // --- Phrase de déclenchement ---
  testTriggerPhraseBtn: () => window.testTriggerPhrase(),

  // --- Studio de scènes ---
  openSceneComposerBtn: () => window.openSceneComposer(null),
  importPptxSlidesBtn: () => window.importPptxSlides(),
  hideSceneNowBtn: () => window.hideSceneNow(),
  closeSceneComposerBtn: () => window.closeSceneComposer(),
  addComposerElementTextBtn: () => window.addComposerElement('text'),
  addComposerElementImageBtn: () => window.addComposerElement('image'),
  saveComposerSceneBtn: () => window.saveComposerScene(),
};

/**
 * Champs en lecture seule affichant une URL à partager : un clic
 * sélectionne tout le contenu pour un copier-coller immédiat (ancien
 * idiome `onclick="this.select()"`). La référence capturée à la liaison
 * EST l'élément, donc la sémantique de `this` est préservée à l'identique.
 */
const SELECT_ALL_ON_CLICK = [
  'brandingOverlayUrlInput',
  'overlayUrlInput',
  'companionUrlInput',
  'stageDisplayUrlInput',
  'announcementLoopUrlInput',
];

/**
 * Pseudo-boutons du studio : des <div class="pp-cue-item"> qui agissaient
 * comme des boutons sans en avoir aucune sémantique — non focusables, donc
 * strictement inatteignables au clavier. `role="button"`/`tabindex="0"`
 * sont posés dans le balisage ; ici on complète avec l'activation clavier
 * qu'un vrai <button> aurait fournie gratuitement (Entrée et Espace).
 */
const CUE_BUTTON_IDS = [
  'ppMediaCueBgGold',
  'ppMediaCueBgBlue',
  'ppMediaCueBgPurple',
  'ppMediaCueBgGreen',
  'ppSongCue1',
  'ppSongCue2',
];

const missing = [];

for (const [id, handler] of Object.entries(CLICK_BINDINGS)) {
  const el = document.getElementById(id);
  if (!el) {
    missing.push(id);
    continue;
  }
  el.addEventListener('click', handler);
}

for (const id of SELECT_ALL_ON_CLICK) {
  const el = document.getElementById(id);
  if (!el) {
    missing.push(id);
    continue;
  }
  el.addEventListener('click', () => el.select());
}

for (const id of CUE_BUTTON_IDS) {
  const el = document.getElementById(id);
  if (!el) continue; // déjà signalé par la boucle CLICK_BINDINGS
  el.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
    // Espace ferait défiler la page, Entrée peut soumettre un formulaire
    // englobant : un <button> natif neutralise les deux, on fait pareil.
    e.preventDefault();
    el.click();
  });
}

// Lien compagnon : href="#" purement décoratif (le texte est injecté par
// companion-link.js), le clic ne doit jamais naviguer. Équivalent exact de
// l'ancien `onclick="return false;"` — un `return false` d'attribut inline
// n'appelle que preventDefault, il n'arrête pas la propagation.
const companionLink = document.getElementById('companionLink');
if (companionLink) companionLink.addEventListener('click', (e) => e.preventDefault());
else missing.push('companionLink');

// Un id absent signifie qu'un élément a été renommé/supprimé dans
// dashboard.html sans mettre à jour ce fichier : le bouton correspondant
// serait alors muet en plein culte. On le signale bruyamment plutôt que de
// laisser la panne silencieuse (les tests d'intégration Playwright
// échouent sur toute erreur console, ce qui l'attrape avant la production).
if (missing.length > 0) {
  console.error(
    `[event-bindings] ${missing.length} élément(s) introuvable(s), boutons non câblés : ${missing.join(', ')}`
  );
}
