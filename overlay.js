/**
 * overlay.js — logique de la page overlay.html (affichage projeté/OBS).
 * ----------------------------------------------------------------------------
 * EXTRAIT de overlay.html (Chantier D, mission autonome — dernier monolithe
 * du type déjà corrigé sur dashboard.html) : contenu déplacé tel quel d'un
 * <script> inline vers ce fichier externe, chargé via
 * <script src="overlay.js"></script> à l'identique de sa position
 * précédente (juste après scene-render.js, juste avant </body>) — ordre
 * d'exécution et portée des `const`/`let` de plus haut niveau inchangés
 * (script classique, pas un module ; scene-render.js expose déjà
 * SCENE_POSITION_PCT/renderSceneDom comme variables globales consommées
 * directement ici, voir son commentaire d'en-tête dans overlay.html).
 * PAS de 'use strict' délibérément absent : le <script> inline d'origine
 * n'était pas en mode strict — en ajouter un ici changerait la sémantique
 * (ex. assignation à une variable non déclarée) pour un chantier qui ne
 * doit AUCUN changement de comportement, seul l'emplacement du code change.
 * Non-régression : test/integration-scene-overlay-lifecycle.js (Playwright,
 * charge le vrai overlay.html dans un vrai navigateur).
 */

/* ==========================================================================
   WebSocket connection
   ========================================================================== */
// CORRECTIF (bug "serveur tout le temps hors ligne") : server.js rejette
// (code 1008) toute connexion sans jeton dès que l'authentification est
// activée côté serveur. Le token voyage dans la query string de la page
// overlay elle-même (celle collée dans OBS, ex.
// http://127.0.0.1:8765/overlay?token=...) — main.js y place désormais
// WS_VIEWER_TOKEN (accès lecture seule), pas le jeton opérateur.
//
// SECURITY (backend audit) : le token n'est plus rajouté en ?token= sur
// l'URL WebSocket elle-même (un reverse proxy exposant le serveur au LAN
// journalise typiquement l'URI de requête, exposant le jeton en clair).
// Il voyage maintenant via l'en-tête de handshake Sec-WebSocket-Protocol
// (2e argument du constructeur WebSocket).
const getWsToken = () => new URLSearchParams(window.location.search).get('token');
// CORRECTIF (bug "overlay hors ligne par défaut") : en file:// (cas réel,
// cette page est chargée depuis disque et collée dans OBS), il n'y a pas
// de window.location.host à réutiliser. main.js transmet le port réel via
// ?port=... (voir getOverlayUrl()) ; 8765 est le vrai défaut de server.js
// (voir config-validator.js > ENV_SCHEMA.PORT) — un correctif précédent
// utilisait 3000 par erreur ici, qui ne correspondait au port réel de
// server.js que si PORT était explicitement défini à cette valeur.
const getWsPort = () => new URLSearchParams(window.location.search).get('port') || '8765';
const getWsUrl = () => {
  if (window.location.protocol === 'http:' || window.location.protocol === 'https:') {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${window.location.host}`;
  }
  return `ws://localhost:${getWsPort()}`;
};

// CORRECTIF (trouvé en marge de l'innovation frontend) : escapeHtml était
// appelé dans showVerse() pour le texte bilingue (EN) mais n'était défini
// nulle part dans ce fichier -> ReferenceError silencieuse dès qu'un verset
// avec langMode 'both' s'affichait (le crash arrêtait tout le script, donc
// aussi le WebSocket et les timers).
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str == null ? '' : String(str);
  return div.innerHTML;
}

let ws = null;
let hideTimeout = null;
// CORRECTIF (Chantier D, mission autonome — extraction overlay.html ->
// overlay.js) : `currentTheme` était déclaré ici, jamais lu ni réassigné
// ailleurs dans ce fichier (code mort depuis toujours — invisible tant
// que ce script vivait inline dans overlay.html, jamais linté). Retiré ;
// aucun autre repère n'utilise cette variable.
let currentAnimation = 'fadeInUp';
// AJOUT (Ken Burns) : backgroundImage du thème actif (voir applyTheme()
// et showMediaItem()) — { type, source, kenBurns, opacity }.
let currentThemeBackground = {};
let reconnectTimer = null;

function connectWs() {
  if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) return;

  try {
    const token = getWsToken();
    ws = token ? new WebSocket(getWsUrl(), [token]) : new WebSocket(getWsUrl());
  } catch (e) {
    console.error('[overlay] Error creating WS:', e);
    scheduleOverlayReconnect();
    return;
  }

  ws.onopen = () => {
    console.log('[overlay] WebSocket connecté');
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  };

  ws.onmessage = (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    if (!msg || !msg.action) return;

    switch (msg.action) {
      case 'init':
        if (msg.theme) applyTheme(msg.theme);
        setHighContrast(!!msg.highContrast);
        setCaptionsEnabled(!!msg.captions);
        setTranslatedCaptionsEnabled(!!msg.translatedCaptions);
        setTestPattern(!!msg.testPattern);
        setBackgroundPattern(msg.backgroundPattern || 'none');
        // AJOUT (poster principal) : à l'ouverture/rechargement de l'overlay,
        // affiche immédiatement le poster principal s'il y en a un et que
        // rien d'autre n'est encore à l'écran (setCurrentDefaultMedia()
        // appelle déjà maybeShowDefaultContent() en interne).
        setCurrentDefaultMedia(msg.defaultMedia || null);
        // AJOUT (studio de scènes, lot 4/6) : même raisonnement — voir
        // setCurrentDefaultScene() plus bas. Une scène par défaut est
        // prioritaire sur un média par défaut (les deux ne peuvent de
        // toute façon jamais coexister, voir maybeShowDefaultContent()).
        setCurrentDefaultScene(msg.defaultScene || null);
        break;
      case 'defaultMediaChanged':
        setCurrentDefaultMedia(msg.item || null);
        break;
      case 'defaultSceneChanged':
        setCurrentDefaultScene(msg.item || null);
        break;
      case 'showScene':
        showScene(msg);
        break;
      case 'hideScene':
        hideScene();
        break;
      case 'showVerse':
        showVerse(msg);
        break;
      case 'hideVerse':
        hideVerse(msg.emergency);
        break;
      case 'applyTheme':
        applyTheme(msg);
        break;
      case 'languageChanged':
        break;
      case 'translationChanged':
        break;
      case 'readingStarted':
        showReadingIndicator(true);
        break;
      case 'readingStopped':
        showReadingIndicator(false);
        break;
      case 'nextVerse':
      case 'previousVerse':
      case 'nextChapter':
        break;
      case 'extendTime':
        extendDisplayTime(msg.extraMs);
        break;
      case 'pauseTimer':
        pauseTimer();
        break;
      case 'resumeTimer':
        resumeTimer();
        break;
      case 'emergencyClear':
        emergencyClear();
        break;
      case 'semanticDetected':
        showSemanticIndicator(msg.reference, msg.confidence);
        break;
      case 'transcriptCorrected':
        console.log('[overlay] Transcript corrected:', msg.corrected);
        break;
      case 'transcript':
        updateCaptionText(msg.text);
        break;
      case 'accessibilityMode':
        setHighContrast(!!msg.highContrast);
        break;
      case 'captionsMode':
        setCaptionsEnabled(!!msg.captions);
        break;
      case 'translatedCaptionsMode':
        setTranslatedCaptionsEnabled(!!msg.enabled);
        break;
      case 'transcriptTranslation':
        updateTranslatedCaptionText(msg.text);
        break;
      case 'testPatternMode':
        setTestPattern(!!msg.enabled);
        break;
      case 'backgroundPatternMode':
        setBackgroundPattern(msg.pattern || 'none');
        break;
      case 'blackScreenMode':
        document.getElementById('black-screen').style.display = msg.enabled ? 'block' : 'none';
        break;
      case 'countdownMode':
        startCountdown(msg.endTimeMs, msg.label);
        break;
      case 'countdownStop':
        stopCountdown();
        break;
      case 'showMedia':
        showMediaItem(msg);
        break;
      case 'hideMedia':
        hideMediaItem();
        break;
      case 'error':
        console.error('[overlay] Server error:', msg.error);
        break;
      case 'transcriptionError':
        console.error('[overlay] Transcription error:', msg.error);
        showPipelineAlert('Transcription indisponible — vérifier la connexion internet');
        break;
      case 'audioError':
        console.error('[overlay] Audio capture error:', msg.error);
        showPipelineAlert('Capture audio interrompue — vérifier le micro');
        break;
      case 'audioSilenceWarning':
        console.warn('[overlay] Silence prolongé:', msg.message);
        showPipelineAlert('Aucune voix détectée — vérifiez le micro');
        break;
    }
  };

  ws.onclose = () => {
    console.log('[overlay] WebSocket déconnecté');
    scheduleOverlayReconnect();
  };

  ws.onerror = (err) => {
    console.error('[overlay] WebSocket error:', err);
  };
}

function scheduleOverlayReconnect() {
  if (!reconnectTimer) {
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connectWs();
    }, 3000);
  }
}

connectWs();

/* ==========================================================================
   Typographie cinétique
   ========================================================================== */
// Active la config config/features.json -> design.kineticTypography (elle
// existait déjà côté config mais n'avait aucun effet visuel réel jusqu'ici :
// applyAnimation('wordByWord') n'animait que la carte entière, pas les mots).
// Passages trop longs (> 55 mots) : la cascade deviendrait plus distrayante
// que lisible sur un plan large, donc on retombe sur un affichage direct.
const KINETIC_MAX_WORDS = 55;
const KINETIC_WORD_STEP_MS = 55;

function renderVerseTextContent(el, text) {
  el.classList.remove('kinetic-mode');
  const words = (text || '').split(/(\s+)/).filter(Boolean);
  const wordCount = words.filter((w) => !/^\s+$/.test(w)).length;

  if (wordCount === 0 || wordCount > KINETIC_MAX_WORDS) {
    el.textContent = text || '';
    return;
  }

  el.innerHTML = '';
  el.classList.add('kinetic-mode');
  let wordIndex = 0;
  words.forEach((token) => {
    if (/^\s+$/.test(token)) {
      el.appendChild(document.createTextNode(token));
      return;
    }
    const span = document.createElement('span');
    span.className = 'kinetic-word';
    span.textContent = token;
    span.style.setProperty('--word-delay', `${wordIndex * KINETIC_WORD_STEP_MS}ms`);
    el.appendChild(span);
    wordIndex++;
  });
}

/* ==========================================================================
   Display functions
   ========================================================================== */
// CORRECTIF (audit — plusieurs versets à la fois pouvaient déborder de
// l'écran) : réduit progressivement la taille du texte du verset jusqu'à
// ce que la carte tienne dans la hauteur de fenêtre disponible, avec un
// plancher lisible (jamais en dessous de MIN_VERSE_FONT_PX). Remise à la
// taille par défaut (CSS clamp()) avant chaque mesure, pour repartir de
// zéro à chaque nouveau verset plutôt que de cumuler les réductions
// précédentes.
const MIN_VERSE_FONT_PX = 18;
const VIEWPORT_MARGIN_PX = 120; // marge haut+bas pour rester lisible, pas collé aux bords
function fitVerseCardToViewport() {
  const card = document.getElementById('verse-card');
  const verseTextEl = document.getElementById('verse-text');
  if (!card || !verseTextEl) return;

  verseTextEl.style.fontSize = '';
  const maxCardHeight = window.innerHeight - VIEWPORT_MARGIN_PX;
  if (maxCardHeight <= 0) return;

  let currentSize = parseFloat(getComputedStyle(verseTextEl).fontSize);
  let guard = 0;
  while (card.scrollHeight > maxCardHeight && currentSize > MIN_VERSE_FONT_PX && guard < 30) {
    currentSize -= 2;
    verseTextEl.style.fontSize = `${currentSize}px`;
    guard++;
  }
}

function showVerse(data) {
  const container = document.getElementById('overlay-container');
  const card = document.getElementById('verse-card');
  const refText = document.getElementById('ref-text');
  const verseText = document.getElementById('verse-text');
  const verseBilingual = document.getElementById('verse-text-bilingual');
  const sourceBadge = document.getElementById('source-badge');

  // Update content
  refText.textContent = data.reference || 'Référence inconnue';

  // Bilingual display — on détermine d'abord le texte principal réel
  // (le français prend le pas sur le texte brut si bilingue), puis on
  // ne fait le rendu (cinétique ou direct) qu'une seule fois dessus.
  let mainText = data.text || '';
  if (data.langMode === 'both' && data.text_fr && data.text_en) {
    verseBilingual.style.display = 'block';
    verseBilingual.innerHTML = `<em>EN:</em> ${escapeHtml(data.text_en)}`;
    mainText = data.text_fr;
  } else {
    verseBilingual.style.display = 'none';
  }
  renderVerseTextContent(verseText, mainText);

  // Source badge
  if (data.detectedBy || data.triggeredByVoice || data.triggeredManually) {
    sourceBadge.style.display = 'inline-flex';
    if (data.triggeredByVoice) {
      sourceBadge.className = 'source-badge voice';
      sourceBadge.textContent = '🎤 Voix';
      showVoiceIndicator();
    } else if (data.triggeredManually) {
      sourceBadge.className = 'source-badge manual';
      sourceBadge.textContent = '👤 Manuel';
    } else if (data.detectedBy === 'semantic' || data.detectedBy === 'quote') {
      sourceBadge.className = 'source-badge ai';
      sourceBadge.textContent = '🤖 IA';
    } else {
      sourceBadge.style.display = 'none';
    }
  } else {
    sourceBadge.style.display = 'none';
  }

  card.className = 'verse-card animate-verse';
  card.style.animationName = currentAnimation;

  // CORRECTIF (poster principal — demande explicite) : un média (poster/
  // vidéo) a un z-index plus élevé que #overlay-container (150 vs 10) —
  // sans ce masquage, un verset détecté PENDANT qu'un média est affiché
  // restait invisible, caché derrière le calque média, jusqu'à ce que ce
  // dernier se masque de lui-même. Version "silencieuse" (hideMediaLayer,
  // pas hideMediaItem) : pas de vérification "poster principal" ici, un
  // verset est sur le point de prendre l'écran de toute façon.
  hideMediaLayer();
  // AJOUT (studio de scènes, lot 4/6) : même raisonnement — une scène
  // partage le même tier de z-index que le média (150), un verset
  // détecté pendant qu'une scène est affichée doit aussi la masquer.
  hideSceneLayer();
  // CORRECTIF (voir maybeShowDefaultContent() plus haut) : un verset
  // est TOUJOURS un contenu explicite, jamais un poster principal.
  screenOccupiedByExplicitContent = true;

  // Show
  container.className = 'visible';

  // CORRECTIF (audit — plages de plusieurs versets pouvaient déborder de
  // l'écran) : #overlay-container n'a aucune limite de hauteur ni
  // .verse-card ; pour une plage demandée à voix haute ("versets 2 à 8"),
  // le texte concaténé de plusieurs versets peut largement dépasser
  // l'espace disponible — la carte, ancrée en bas de l'écran, pousserait
  // alors son sommet hors du cadre visible, sans qu'aucun mécanisme
  // n'ajuste quoi que ce soit. On réduit la taille du texte du verset
  // (jamais en dessous d'un plancher lisible) jusqu'à ce que la carte
  // tienne dans la hauteur de la fenêtre. Après le rendu (requestAnimationFrame)
  // pour mesurer la vraie hauteur une fois le texte injecté dans le DOM.
  requestAnimationFrame(fitVerseCardToViewport);

  // Auto-hide timer
  clearTimeout(hideTimeout);
  const duration = sanitizeDurationMs(data.durationMs);
  hideTimeout = setTimeout(() => hideVerse(false), duration);
}

// AJOUT (poster principal) : version "silencieuse", sans vérification du
// poster principal — utilisée en interne (showMediaItem()) quand un média
// est sur le point de prendre l'écran, pour éviter un flash du poster
// principal entre les deux. hideVerse() (public, plus bas) reste la
// fonction à appeler depuis un minuteur/action WS/urgence.
function hideVerseQuiet(emergency) {
  const container = document.getElementById('overlay-container');
  if (emergency) {
    container.className = 'hidden emergency-flash';
  } else {
    container.className = 'hidden';
  }
  clearTimeout(hideTimeout);
  hideTimeout = null;
  // CORRECTIF (voir maybeShowDefaultContent() plus bas) : ce verset ne
  // "tient" plus l'écran — si un show*() suit dans la même chaîne
  // d'appels (mutuelle exclusion), il réaffirmera ce drapeau à `true`
  // lui-même ; sinon, un poster principal doit pouvoir reprendre sa place.
  screenOccupiedByExplicitContent = false;
}

function hideVerse(emergency = false) {
  hideVerseQuiet(emergency);
  maybeShowDefaultContent();
}

function extendDisplayTime(extraMs) {
  if (hideTimeout) {
    clearTimeout(hideTimeout);
    hideTimeout = setTimeout(() => hideVerse(false), sanitizeDurationMs(extraMs));
  }
}

// Borne strictement toute durée de timer venant du réseau (WebSocket) avant
// de la passer à setTimeout : évite qu'une valeur non finie, négative ou
// démesurée (accidentelle ou malveillante) ne cause un épuisement de
// ressources côté overlay. Alignée avec le plafond serveur (1h = 3600000 ms).
const MAX_DISPLAY_DURATION_MS = 3600000;
// Filet de sécurité uniquement (si le serveur envoie une valeur invalide/
// absente) : aligné sur le défaut serveur de 120s (config/features.json
// display.verseDurationMs). Le serveur envoie normalement toujours une
// durée valide via getVerseDurationMs().
const DEFAULT_DISPLAY_DURATION_MS = 120000;
function sanitizeDurationMs(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_DISPLAY_DURATION_MS;
  return Math.min(n, MAX_DISPLAY_DURATION_MS);
}

let timerPaused = false;

function pauseTimer() {
  if (hideTimeout && !timerPaused) {
    timerPaused = true;
    clearTimeout(hideTimeout);
    console.log('[overlay] Timer paused');
  }
}

function resumeTimer() {
  if (timerPaused) {
    timerPaused = false;
    console.log('[overlay] Timer resumed');
    // We don't know original remaining, so just extend by elapsed pause time
    // In practice, the server handles the real timing
  }
}

function emergencyClear() {
  // CORRECTIF (poster principal) : hideVerse(true) seul ne masquait pas un
  // média activement affiché (couche séparée, voir #media-layer) — un
  // "effacement d'urgence" laissait le poster/vidéo en place. hideMediaItem()
  // est appelée en second : si aucun poster principal n'est configuré,
  // l'écran reste bien vide comme avant ; sinon le poster principal
  // réapparaît (préférable à un écran noir).
  hideVerseQuiet(true);
  // AJOUT (studio de scènes, lot 4/6) : même raisonnement pour une
  // scène activement affichée — silencieuse (pas de double appel à
  // maybeShowDefaultContent, hideMediaItem() ci-dessous s'en charge
  // une fois les deux couches masquées).
  hideSceneLayer();
  hideMediaItem();
  showVoiceIndicator('🚨 Urgence');
  setTimeout(() => hideVoiceIndicator(), 2000);
}

/* ==========================================================================
   Theme system
   ========================================================================== */
function applyTheme(theme) {
  if (!theme) return;
  const root = document.documentElement;

  // CORRECTIF (deux bugs distincts, trouvés indépendamment dans le même
  // repli silencieux — deux sessions parallèles, aucun conflit réel) :
  // applyTheme() n'attendait qu'une forme plate (theme.background,
  // theme.color...), mais deux sources totalement différentes envoient
  // deux AUTRES formes :
  //  1. ai-theme-generator.js (verset détecté, commande vocale, mode
  //     ambiant automatique) envoie backgroundGradient/textColor/
  //     animationStyle — voir bloc ci-dessous.
  //  2. theme-loader.js (thèmes "nuit"/"claire" et thèmes personnalisés
  //     choisis depuis le tableau de bord) envoie une forme imbriquée
  //     { variables: {'--bg':..., '--verse-font':...}, effects,
  //     animations, background } — voir bloc `theme.variables` plus bas.
  // Sans ces deux ponts, --overlay-bg/--overlay-text (qui pilotent le
  // fond et la couleur du texte RÉELLEMENT visibles, voir background:
  // var(--overlay-bg) / color: var(--overlay-text) plus haut) n'étaient
  // jamais mis à jour pour l'une ou l'autre source : changer de thème
  // depuis le tableau de bord, ou laisser le mode ambiant réagir au ton
  // du sermon, ne changeait silencieusement rien sur l'overlay projeté.
  if (theme.variables) {
    const v = theme.variables;
    if (v['--bg']) root.style.setProperty('--overlay-bg', v['--bg']);
    if (v['--text']) root.style.setProperty('--overlay-text', v['--text']);
    if (v['--accent']) root.style.setProperty('--overlay-accent', v['--accent']);
    if (v['--verse-font']) root.style.setProperty('--overlay-font', v['--verse-font']);
    if (v['--ref-font']) root.style.setProperty('--overlay-font-ui', v['--ref-font']);
    // CORRECTIF (thèmes à moitié appliqués) : theme-loader.js calcule
    // déjà ces 5 variables depuis config/themes/*.json (typography.verseFontSize/
    // Weight, effects.borderRadius/blurBackdrop, colors.reference), mais
    // applyTheme() les ignorait silencieusement — changer de thème ne
    // modifiait donc jamais les coins arrondis/le flou/la taille et le
    // poids du verset/la couleur de la référence, malgré leur présence
    // dans les deux thèmes livrés (nuit.json/claire.json).
    if (v['--verse-size']) root.style.setProperty('--overlay-verse-size', v['--verse-size']);
    if (v['--verse-weight']) root.style.setProperty('--overlay-verse-weight', v['--verse-weight']);
    if (v['--border-radius']) root.style.setProperty('--overlay-radius', v['--border-radius']);
    if (v['--blur']) root.style.setProperty('--overlay-blur', v['--blur']);
    if (v['--reference-color'])
      root.style.setProperty('--overlay-reference-color', v['--reference-color']);
    if (theme.animations && theme.animations.default) currentAnimation = theme.animations.default;
    currentThemeBackground = theme.background || {};
    return;
  }

  const background = theme.backgroundGradient || theme.background;
  const color = theme.textColor || theme.color;
  const animation = theme.animationStyle || theme.animation;

  if (background) root.style.setProperty('--overlay-bg', background);
  if (color) root.style.setProperty('--overlay-text', color);
  if (theme.accentColor) root.style.setProperty('--overlay-accent', theme.accentColor);
  if (theme.fontFamily) root.style.setProperty('--overlay-font', theme.fontFamily);
  if (theme.borderColor) root.style.setProperty('--overlay-border', theme.borderColor);
  if (theme.glowColor) root.style.setProperty('--overlay-glow', theme.glowColor);
  if (theme.shadowColor) root.style.setProperty('--overlay-shadow', theme.shadowColor);
  if (theme.particleColor) root.style.setProperty('--overlay-particle', theme.particleColor);
  // CORRECTIF (bug de nommage — les animations de mood IA ne jouaient
  // jamais) : ai-theme-generator.js envoie animationStyle en kebab-case
  // ("fade-in-up"), mais les @keyframes CSS de ce fichier sont en
  // camelCase ("fadeInUp") — animation-name ne matchait donc jamais
  // aucune règle et le navigateur n'animait rien, silencieusement.
  if (animation) currentAnimation = animation.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

  // CORRECTIF PERF (audit CPU) : updateParticles() était appelée mais
  // jamais définie nulle part dans ce fichier -> ReferenceError silencieuse
  // à chaque changement de thème, qui interrompait applyTheme() en plein
  // milieu. La couleur des particules est une variable CSS (--overlay-particle,
  // déjà positionnée ci-dessus) : le navigateur la propage tout seul à tous
  // les éléments .particle/.advanced-particle existants, aucune fonction
  // JS n'est nécessaire ici.
}

/* ==========================================================================
   Accessibilité (audit — gratuit/léger) : bascule explicite opérateur,
   aucune détection automatique, aucun appel réseau au-delà du message WS
   déjà en place pour tout le reste de l'overlay.
   ========================================================================== */
function setHighContrast(enabled) {
  document.body.classList.toggle('high-contrast', !!enabled);
}

let captionsEnabled = false;
function setCaptionsEnabled(enabled) {
  captionsEnabled = !!enabled;
  document.body.classList.toggle('captions-active', captionsEnabled);
  const strip = document.getElementById('caption-strip');
  const text = document.getElementById('caption-strip-text');
  const translation = document.getElementById('caption-strip-translation');
  if (!strip) return;
  strip.classList.toggle('visible', captionsEnabled);
  if (!captionsEnabled) {
    if (text) text.textContent = '';
    if (translation) translation.textContent = '';
  }
}

function updateCaptionText(text) {
  if (!captionsEnabled) return;
  const el = document.getElementById('caption-strip-text');
  if (el) el.textContent = text || '';
}

// AJOUT (sous-titres traduits en direct, opt-in — voir caption-translator.js
// et l'action 'setTranslatedCaptions' dans server.js).
let translatedCaptionsEnabled = false;
function setTranslatedCaptionsEnabled(enabled) {
  translatedCaptionsEnabled = !!enabled;
  const translation = document.getElementById('caption-strip-translation');
  if (translation && !translatedCaptionsEnabled) translation.textContent = '';
}

function updateTranslatedCaptionText(text) {
  if (!captionsEnabled || !translatedCaptionsEnabled) return;
  const el = document.getElementById('caption-strip-translation');
  if (el) el.textContent = text || '';
}

/* ==========================================================================
   Affichage & sortie (audit — gratuit/léger) : motif de test (barres de
   couleur, vérification OBS/NDI/projecteur) et motif de fond optionnel.
   CSS pur dans les deux cas, aucun calcul par frame.
   ========================================================================== */
function setTestPattern(enabled) {
  const el = document.getElementById('test-pattern');
  if (el) el.classList.toggle('visible', !!enabled);
}

const BACKGROUND_PATTERNS = ['dots', 'grid', 'diagonal'];
function setBackgroundPattern(pattern) {
  const el = document.getElementById('pattern-layer');
  if (!el) return;
  BACKGROUND_PATTERNS.forEach((p) => el.classList.remove('pattern-' + p));
  if (BACKGROUND_PATTERNS.includes(pattern)) {
    el.classList.add('pattern-' + pattern);
  }
}

/* ==========================================================================
   Médiathèque (audit — déclenchement vocal ou manuel de photos/vidéos).
   Prise de contrôle plein écran comme #test-pattern : masque la carte de
   verset pendant l'affichage (hideVerse(), aucune tentative de "restaurer"
   le dernier verset ensuite — même simplicité que le motif de test, qui ne
   restaure rien non plus ; le prochain verset détecté réaffichera
   naturellement la carte).
   ========================================================================== */
let mediaHideTimeout = null;
function showMediaItem(msg) {
  const layer = document.getElementById('media-layer');
  const img = document.getElementById('media-layer-img');
  const video = document.getElementById('media-layer-video');
  if (!layer || !img || !video) return;

  // Version "silencieuse" (voir hideVerseQuiet ci-dessus) : ce média est sur
  // le point de prendre l'écran, pas besoin/pas souhaitable de vérifier le
  // poster principal entre les deux (éviterait un flash inutile).
  hideVerseQuiet(false);
  // AJOUT (studio de scènes, lot 4/6) : même raisonnement — un média et
  // une scène partagent le même tier de z-index (150), mutuellement
  // exclusifs comme verset/média l'étaient déjà.
  hideSceneLayer();
  // CORRECTIF (voir maybeShowDefaultContent() plus haut) : ce média
  // n'est "le poster principal" que si c'est bien maybeShowDefaultContent()
  // elle-même qui a déclenché cet appel (detectedBy: 'default') —
  // sinon (déclenchement vocal/manuel), c'est un contenu explicite.
  screenOccupiedByExplicitContent = msg.detectedBy !== 'default';
  clearTimeout(mediaHideTimeout);
  mediaHideTimeout = null;

  if (msg.mediaType === 'video') {
    img.hidden = true;
    img.removeAttribute('src');
    img.classList.remove('ken-burns');
    video.hidden = false;
    video.src = msg.mediaUrl;
    video.currentTime = 0;
    video.play().catch(() => {
      /* lecture auto refusée (rare, sans interaction utilisateur) : la vidéo reste affichée, silencieuse */
    });
  } else {
    video.hidden = true;
    video.pause();
    video.removeAttribute('src');
    img.hidden = false;
    img.src = msg.mediaUrl;
    // AJOUT (Ken Burns — images fixes uniquement, une vidéo bouge déjà) :
    // classe retirée puis reposée pour relancer l'animation à chaque
    // nouvelle image (une classe déjà présente ne redémarre pas seule).
    img.classList.remove('ken-burns');
    if (currentThemeBackground.kenBurns) {
      void img.offsetWidth;
      img.classList.add('ken-burns');
    }
  }

  // AJOUT (détails d'affichage média — style d'apparition) : classe posée
  // AVANT '.visible' pour que le navigateur ait bien calculé l'état "avant"
  // (voir règles #media-layer.transition-*:not(.visible) plus haut) — sans
  // ça, la transition ne s'anime pas, elle saute directement à l'état final.
  layer.classList.remove(
    'transition-fade',
    'transition-slide',
    'transition-zoom',
    'transition-cut'
  );
  const style = ['slide', 'zoom', 'cut'].includes(msg.transitionStyle)
    ? msg.transitionStyle
    : 'fade';
  layer.classList.add(`transition-${style}`);

  layer.classList.add('visible');
  layer.setAttribute('aria-hidden', 'false');

  // displayDurationMs absent/null = vidéo qui joue jusqu'à sa fin naturelle,
  // ou image affichée jusqu'à hideMedia() manuel. sanitizeDurationMs() est
  // réutilisée telle quelle (même borne réseau que pour les versets).
  if (typeof msg.displayDurationMs === 'number' && msg.displayDurationMs > 0) {
    mediaHideTimeout = setTimeout(() => hideMediaItem(), sanitizeDurationMs(msg.displayDurationMs));
  }
}

// AJOUT (poster principal) : version "silencieuse", sans vérification du
// poster principal — utilisée en interne (showVerse()) quand un verset est
// sur le point de prendre l'écran. hideMediaItem() (public, plus bas) reste
// la fonction à appeler depuis un minuteur/action WS/urgence.
function hideMediaLayer() {
  const layer = document.getElementById('media-layer');
  const img = document.getElementById('media-layer-img');
  const video = document.getElementById('media-layer-video');
  if (!layer) return;

  clearTimeout(mediaHideTimeout);
  mediaHideTimeout = null;
  layer.classList.remove('visible');
  layer.setAttribute('aria-hidden', 'true');

  if (video) {
    video.pause();
    video.removeAttribute('src');
    video.hidden = true;
  }
  if (img) {
    img.removeAttribute('src');
    img.hidden = true;
  }
  // CORRECTIF (voir maybeShowDefaultContent() plus bas) : même
  // raisonnement que hideVerseQuiet() ci-dessus.
  screenOccupiedByExplicitContent = false;
}

function hideMediaItem() {
  hideMediaLayer();
  maybeShowDefaultContent();
}

/* ==========================================================================
   Studio de scènes (texte + logo/image composés, voir action 'showScene') —
   lot 4/6. Même principe que la médiathèque ci-dessus : hideSceneLayer()
   (silencieuse) pour un contenu qui prend l'écran, hideScene() (publique)
   pour un masquage explicite qui doit laisser la place au poster principal.
   SCENE_POSITION_PCT et renderSceneDom() sont désormais partagés avec
   l'aperçu du tableau de bord — voir scene-render.js (lot 5), chargé en
   script classique juste avant celui-ci (voir <head>/<body> plus haut).
   ========================================================================== */
function showScene(msg) {
  // Même discipline que showVerse()/showMediaItem() : masque les deux
  // autres couches AVANT de prendre l'écran (mutuelle exclusion à
  // trois, voir showVerse()/showMediaItem() plus haut pour le miroir).
  hideVerseQuiet(false);
  hideMediaLayer();
  // CORRECTIF (voir maybeShowDefaultContent() plus haut) : cette scène
  // n'est "le poster principal" que si c'est bien maybeShowDefaultContent()
  // elle-même qui a déclenché cet appel (detectedBy: 'default') —
  // sinon (déclenchement vocal/manuel), c'est un contenu explicite.
  screenOccupiedByExplicitContent = msg.detectedBy !== 'default';
  const layer = document.getElementById('scene-layer');
  if (!layer) return;
  renderSceneDom(msg, layer);
  layer.classList.add('visible');
  layer.setAttribute('aria-hidden', 'false');
}

// Silencieuse (pas de vérification poster principal) — même rôle que
// hideMediaLayer() ci-dessus, utilisée en interne par showVerse()/
// showMediaItem()/emergencyClear() quand un autre contenu prend l'écran.
function hideSceneLayer() {
  const layer = document.getElementById('scene-layer');
  if (!layer) return;
  layer.classList.remove('visible');
  layer.setAttribute('aria-hidden', 'true');
  layer.innerHTML = '';
  layer.style.background = '';
  // CORRECTIF (voir maybeShowDefaultContent() plus bas) : même
  // raisonnement que hideVerseQuiet()/hideMediaLayer() ci-dessus.
  screenOccupiedByExplicitContent = false;
}

function hideScene() {
  hideSceneLayer();
  maybeShowDefaultContent();
}

/* ==========================================================================
   Poster principal — demande explicite : "quand il n'y a rien à afficher,
   ce poster doit toujours être là". Réutilise entièrement showMediaItem()/
   showScene() (mêmes styles d'apparition, même z-index) plutôt que de
   dupliquer la logique d'affichage — le poster principal EST un média ou
   une scène comme un autre, juste réaffiché automatiquement quand l'écran
   serait sinon vide. Une SCÈNE par défaut est prioritaire sur un MÉDIA par
   défaut (voir maybeShowDefaultContent() ci-dessous) — de toute façon les
   deux ne peuvent jamais coexister (arbitrage croisé côté serveur, voir
   scene-store.js#setDefaultScene/media-library.js#setDefaultItem).
   ========================================================================== */
let currentDefaultMedia = null; // { id, mediaType, filename, label, transitionStyle } ou null
let currentDefaultScene = null; // scène résolue (mediaUrl, pas mediaId) ou null
// CORRECTIF (studio de scènes, lot 4/6 — arbitrage croisé scène/média
// trouvé en testant CE lot avec un vrai navigateur, voir
// integration-scene-overlay-lifecycle.js) : distingue "un verset, un
// média ou une scène EXPLICITEMENT déclenchés occupent l'écran" (ne
// jamais interrompre) de "ce qui est visible n'est que le poster
// principal (ou son reliquat)" (toujours remplaçable). Sans cette
// distinction, une garde naïve "rien d'autre à l'écran" bloquait
// indéfiniment un NOUVEAU poster désigné pendant que l'ANCIEN poster
// (scène ou média) était encore affiché — y compris juste après avoir
// RETIRÉ ce dernier (setDefaultMediaItem sans id, par ex.), puisque
// rien ne masque jamais automatiquement un poster qu'on vient de
// démarquer, seul un nouveau poster/verset/déclenchement le fait. Ce
// cas n'existait pas avant le studio de scènes (un seul magasin de
// poster possible) — l'ancien maybeShowDefaultMedia() n'avait jamais
// eu à s'en soucier. Mis à jour par showVerse()/showMediaItem()/
// showScene() elles-mêmes (voir leur paramètre `detectedBy`), jamais
// ici directement.
let screenOccupiedByExplicitContent = false;

function setCurrentDefaultMedia(item) {
  currentDefaultMedia = item || null;
  maybeShowDefaultContent();
}

function setCurrentDefaultScene(scene) {
  currentDefaultScene = scene || null;
  maybeShowDefaultContent();
}

function maybeShowDefaultContent() {
  // Un verset/média/scène EXPLICITEMENT déclenché est toujours
  // prioritaire — jamais interrompu par un poster, nouveau ou ancien.
  if (screenOccupiedByExplicitContent) return;

  if (currentDefaultScene) {
    showScene({ ...currentDefaultScene, detectedBy: 'default' });
    return;
  }
  if (currentDefaultMedia) {
    showMediaItem({
      mediaType: currentDefaultMedia.mediaType,
      mediaUrl: `/media/${currentDefaultMedia.filename}`,
      label: currentDefaultMedia.label,
      displayDurationMs: null,
      transitionStyle: currentDefaultMedia.transitionStyle,
      detectedBy: 'default',
    });
    return;
  }
  // Aucun poster candidat : rien à afficher, mais on ne masque pas non
  // plus ce qui traînerait encore à l'écran (même comportement
  // historique que l'ancien maybeShowDefaultMedia() — un poster
  // retiré ne se masque pas tout seul, voir le commentaire ci-dessus).
}

/* ==========================================================================
   Indicators
   ========================================================================== */
let voiceIndicatorTimeout = null;
let semanticIndicatorTimeout = null;

function showVoiceIndicator(text = 'Commande vocale') {
  const el = document.getElementById('voice-indicator');
  el.querySelector('span').textContent = text;
  el.classList.add('visible');
  clearTimeout(voiceIndicatorTimeout);
  voiceIndicatorTimeout = setTimeout(() => hideVoiceIndicator(), 2500);
}

function hideVoiceIndicator() {
  document.getElementById('voice-indicator').classList.remove('visible');
}

function showSemanticIndicator(reference, confidence) {
  const el = document.getElementById('semantic-indicator');
  const textEl = document.getElementById('semantic-text');
  textEl.textContent = `IA: ${reference} (${Math.round((confidence || 0) * 100)}%)`;
  el.classList.add('visible');
  clearTimeout(semanticIndicatorTimeout);
  semanticIndicatorTimeout = setTimeout(() => {
    el.classList.remove('visible');
  }, 4000);
}

let pipelineAlertTimeout;
function showPipelineAlert(text) {
  const el = document.getElementById('pipeline-alert');
  const textEl = document.getElementById('pipeline-alert-text');
  textEl.textContent = text;
  el.classList.add('visible');
  clearTimeout(pipelineAlertTimeout);
  pipelineAlertTimeout = setTimeout(() => {
    el.classList.remove('visible');
  }, 6000);
}

function showReadingIndicator(show) {
  const el = document.getElementById('reading-indicator');
  el.classList.toggle('visible', show);
}

/* ============================================================================
 * Particules d'ambiance — #ambientCanvas (audit perf)
 * ----------------------------------------------------------------------------
 * REMPLACE l'ancien conteneur .particles/.particle : ce dernier n'était plus
 * jamais peuplé depuis le retrait d'animation-library.js (voir commentaire
 * près de <head>) — coût nul, mais ~20 lignes de CSS mortes. Rendu ici sur
 * un unique <canvas> (au lieu de N nœuds DOM individuels), avec la même
 * intention visuelle (points lumineux qui montent lentement) pour un coût
 * de composition GPU nettement plus faible que N box-shadow animées.
 * Respecte prefers-reduced-motion (aucune particule créée) et se met en
 * pause quand la page n'est pas visible.
 * ============================================================================ */
(function initAmbientParticles() {
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const canvas = document.getElementById('ambientCanvas');
  if (!canvas || !canvas.getContext) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const PARTICLE_COUNT = 18;
  let particles = [];
  let width = 0;
  let height = 0;
  const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
  let particleColor = '#dcb46a';
  let glowColor = 'rgba(220, 180, 106, 0.32)';
  let colorRefreshCounter = 0;
  let rafId = null;
  let running = false;

  function readThemeColors() {
    // getComputedStyle() a un coût réel : on ne le fait qu'une fois toutes
    // les ~90 frames (autour d'1x/seconde à 90fps, moins souvent en dessous)
    // plutôt qu'à chaque frame, pour suivre les changements de mood/thème
    // (applyTheme) sans payer ce coût en continu.
    const styles = getComputedStyle(document.body);
    particleColor = styles.getPropertyValue('--overlay-particle').trim() || particleColor;
    glowColor = styles.getPropertyValue('--overlay-glow').trim() || glowColor;
  }

  function makeParticle(randomizeY) {
    return {
      x: Math.random() * width,
      y: randomizeY ? Math.random() * height : height + 20,
      speed: 6 + Math.random() * 10, // px/s, monte lentement
      size: 1.5 + Math.random() * 2,
      phase: Math.random() * Math.PI * 2,
    };
  }

  function resize() {
    width = window.innerWidth;
    height = window.innerHeight;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = width + 'px';
    canvas.style.height = height + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  let lastTs = 0;
  function tick(ts) {
    if (!running) return;
    const dt = lastTs ? Math.min(0.05, (ts - lastTs) / 1000) : 0;
    lastTs = ts;

    colorRefreshCounter++;
    if (colorRefreshCounter % 90 === 0) readThemeColors();

    ctx.clearRect(0, 0, width, height);
    for (const p of particles) {
      p.y -= p.speed * dt;
      const lifeRatio = 1 - p.y / height; // 0 en bas, ~1 en haut
      const fadeIn = Math.min(1, (height - p.y) / (height * 0.15));
      const fadeOut = Math.min(1, p.y / (height * 0.15));
      const opacity =
        Math.max(0, Math.min(0.6, fadeIn, fadeOut)) * (0.7 + 0.3 * Math.sin(p.phase + ts / 900));

      if (opacity > 0.01) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fillStyle = particleColor;
        ctx.globalAlpha = opacity;
        ctx.shadowColor = glowColor;
        ctx.shadowBlur = 8;
        ctx.fill();
        ctx.shadowBlur = 0;
        ctx.globalAlpha = 1;
      }

      if (p.y < -20 || lifeRatio > 1.05) {
        Object.assign(p, makeParticle(false));
      }
    }
    rafId = requestAnimationFrame(tick);
  }

  function start() {
    if (running) return;
    running = true;
    lastTs = 0;
    rafId = requestAnimationFrame(tick);
  }

  function stop() {
    running = false;
    if (rafId) cancelAnimationFrame(rafId);
    rafId = null;
  }

  window.addEventListener('resize', resize);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stop();
    else start();
  });

  resize();
  readThemeColors();
  particles = Array.from({ length: PARTICLE_COUNT }, () => makeParticle(true));
  if (!document.hidden) start();
})();

/* === Compteur avant culte === */
let countdownInterval = null;
function startCountdown(endTimeMs, label) {
  stopCountdown();
  const el = document.getElementById('service-countdown');
  const timeEl = document.getElementById('countdown-time');
  const labelEl = document.getElementById('countdown-label');
  const subEl = document.getElementById('countdown-sub');
  if (!el || !timeEl) return;
  if (labelEl && label) labelEl.textContent = label;
  el.style.display = 'flex';
  function tick() {
    const remaining = Math.max(0, endTimeMs - Date.now());
    const totalSec = Math.ceil(remaining / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    timeEl.textContent =
      h > 0
        ? String(h).padStart(2, '0') +
          ':' +
          String(m).padStart(2, '0') +
          ':' +
          String(s).padStart(2, '0')
        : String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
    if (subEl) subEl.textContent = totalSec <= 0 ? 'Le culte commence !' : '';
    if (totalSec <= 0) {
      clearInterval(countdownInterval);
      countdownInterval = null;
    }
  }
  tick();
  countdownInterval = setInterval(tick, 1000);
}
function stopCountdown() {
  if (countdownInterval) {
    clearInterval(countdownInterval);
    countdownInterval = null;
  }
  const el = document.getElementById('service-countdown');
  if (el) el.style.display = 'none';
}
