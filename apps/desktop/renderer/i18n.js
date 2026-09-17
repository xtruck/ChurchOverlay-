// Plain browser JS, no build step, no dependency — matches dashboard.js's
// own convention. ARCHITECTURE.md section 63.5: a small, dependency-free
// key-based lookup, not a new i18n library, for the dashboard/setup
// screen's own interface text (never the verse content itself, which
// comes pre-resolved from the server — see LocalizedVerseSource).
;(function () {
  const DICTIONARIES = {
    en: {
      "app.title": "ChurchOverlay — Operator",
      "header.subtitle": "Verse Ops Console",
      "setup.title": "Set up ChurchOverlay",
      "setup.description":
        "Enter your Groq API key to start transcribing. It's encrypted and stored locally — this only needs to be done once.",
      "setup.groqKeyLabel": "Groq API key",
      "setup.saveButton": "Save and continue",
      "setup.saving": "Saving…",
      "setup.enterKeyError": "Enter a Groq API key to continue.",
      "setup.displayModeLabel": "Verse display language",
      "setup.displayMode.english": "English only",
      "setup.displayMode.french": "French only",
      "setup.displayMode.bilingual": "Bilingual (French + English)",
      "setup.uiLanguageLabel": "Interface language",
      "setup.uiLanguage.en": "English",
      "setup.uiLanguage.fr": "French",
      "mic.title": "Microphone",
      "mic.start": "Start listening",
      "mic.stop": "Stop",
      "mic.lastTranscriptLabel": "Last transcript",
      "mic.waitingForSpeech": "Waiting for speech…",
      "override.title": "Manual Override",
      "override.referenceLabel": "Verse reference",
      "override.showButton": "Show on overlay",
      "override.clearButton": "Clear",
      "media.title": "Media Library",
      "media.importButton": "+ Import",
      "media.empty": "No media imported yet.",
      "media.play": "Play",
      "media.pause": "Pause",
      "media.stop": "Stop",
      "livePreview.label": "LIVE PREVIEW",
      "livePreview.empty": "Nothing is live right now.",
      "activity.title": "Activity",
      "status.connecting": "connecting…",
      "status.connectedOperator": "connected · operator",
      "status.disconnectedRetrying": "disconnected — retrying in {seconds}s…",
      "log.connected": "connected",
      "log.disconnectedRetrying": "disconnected, retrying in {seconds}s",
      "log.connectionError": "connection error",
      "log.received": "received {type}",
      "log.notConnected": "not connected — can't send",
      "log.sentVerseOverride": "sent verse:override {reference}",
      "log.sentVerseClear": "sent verse:clear",
      "log.micPermissionDenied": "microphone permission denied or unavailable: {error}",
      "log.micStarted": "microphone started",
      "log.micStopped": "microphone stopped",
      "log.parseError": 'could not parse "{text}" as "Book Chapter:Verse"',
      "log.sentMediaSelect": "sent media:select {title}",
      "log.sentMediaPlay": "sent media:play",
      "log.sentMediaPause": "sent media:pause",
      "log.sentMediaClear": "sent media:clear",
      "log.mediaLoadFailed": "failed to load media library: {error}",
      "log.importFailed": "import failed: {error}",
      "log.imported": "imported {title}",
    },
    fr: {
      "app.title": "ChurchOverlay — Opérateur",
      "header.subtitle": "Console de Verset",
      "setup.title": "Configurer ChurchOverlay",
      "setup.description":
        "Entrez votre clé API Groq pour démarrer la transcription. Elle est chiffrée et stockée localement — cela ne doit être fait qu'une seule fois.",
      "setup.groqKeyLabel": "Clé API Groq",
      "setup.saveButton": "Enregistrer et continuer",
      "setup.saving": "Enregistrement…",
      "setup.enterKeyError": "Entrez une clé API Groq pour continuer.",
      "setup.displayModeLabel": "Langue d'affichage des versets",
      "setup.displayMode.english": "Anglais uniquement",
      "setup.displayMode.french": "Français uniquement",
      "setup.displayMode.bilingual": "Bilingue (Français + Anglais)",
      "setup.uiLanguageLabel": "Langue de l'interface",
      "setup.uiLanguage.en": "Anglais",
      "setup.uiLanguage.fr": "Français",
      "mic.title": "Microphone",
      "mic.start": "Démarrer l'écoute",
      "mic.stop": "Arrêter",
      "mic.lastTranscriptLabel": "Dernière transcription",
      "mic.waitingForSpeech": "En attente de parole…",
      "override.title": "Contrôle manuel",
      "override.referenceLabel": "Référence du verset",
      "override.showButton": "Afficher sur l'incrustation",
      "override.clearButton": "Effacer",
      "media.title": "Bibliothèque multimédia",
      "media.importButton": "+ Importer",
      "media.empty": "Aucun média importé pour l'instant.",
      "media.play": "Lire",
      "media.pause": "Pause",
      "media.stop": "Arrêter",
      "livePreview.label": "APERÇU EN DIRECT",
      "livePreview.empty": "Rien n'est en direct actuellement.",
      "activity.title": "Activité",
      "status.connecting": "connexion…",
      "status.connectedOperator": "connecté · opérateur",
      "status.disconnectedRetrying": "déconnecté — nouvelle tentative dans {seconds}s…",
      "log.connected": "connecté",
      "log.disconnectedRetrying": "déconnecté, nouvelle tentative dans {seconds}s",
      "log.connectionError": "erreur de connexion",
      "log.received": "reçu {type}",
      "log.notConnected": "non connecté — envoi impossible",
      "log.sentVerseOverride": "envoi de verse:override {reference}",
      "log.sentVerseClear": "envoi de verse:clear",
      "log.micPermissionDenied": "permission du microphone refusée ou indisponible : {error}",
      "log.micStarted": "microphone démarré",
      "log.micStopped": "microphone arrêté",
      "log.parseError": 'impossible d’interpréter « {text} » comme « Livre Chapitre:Verset »',
      "log.sentMediaSelect": "envoi de media:select {title}",
      "log.sentMediaPlay": "envoi de media:play",
      "log.sentMediaPause": "envoi de media:pause",
      "log.sentMediaClear": "envoi de media:clear",
      "log.mediaLoadFailed": "échec du chargement de la bibliothèque multimédia : {error}",
      "log.importFailed": "échec de l'importation : {error}",
      "log.imported": "{title} importé",
    },
  }

  let currentLanguage = "en"

  function t(key, params) {
    const dict = DICTIONARIES[currentLanguage] || DICTIONARIES.en
    let value = dict[key] ?? DICTIONARIES.en[key] ?? key
    if (params) {
      for (const paramKey of Object.keys(params)) {
        value = value.split("{" + paramKey + "}").join(String(params[paramKey]))
      }
    }
    return value
  }

  function applyTranslations() {
    document.title = t("app.title")
    document.querySelectorAll("[data-i18n]").forEach((el) => {
      el.textContent = t(el.getAttribute("data-i18n"))
    })
    document.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
      el.setAttribute("placeholder", t(el.getAttribute("data-i18n-placeholder")))
    })
  }

  function setLanguage(lang) {
    currentLanguage = DICTIONARIES[lang] ? lang : "en"
    applyTranslations()
  }

  function getLanguage() {
    return currentLanguage
  }

  window.i18n = { t, applyTranslations, setLanguage, getLanguage }
})()
