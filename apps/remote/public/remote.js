// Plain browser JS, no build step — Pro Studio Remote 2.0
;(function () {
  const params = new URLSearchParams(window.location.search)
  // The token is in the URL fragment (#token=..., never sent to a server); ?token= is the older form.
  const token = new URLSearchParams(window.location.hash.slice(1)).get("token") || params.get("token")
  const wsPort = params.get("wsPort")

  const STRINGS = {
    en: {
      title: "Remote",
      noToken: "No operator token in the link. Copy the remote link from the desktop console's Settings again.",
      offAir: "Nothing on screen",
      onAir: "On screen",
      clearScreen: "Clear the screen",
      rundown: "Rundown Stepper",
      noRundown: "No rundown loaded.",
      previous: "Previous",
      next: "Next",
      media: "Media",
      clearMedia: "Stop media",
      layoutMedia: "Layout & Media",
      layoutFullscreen: "Fullscreen View",
      layoutLowerThird: "Lower-Third",
      connecting: "Connecting…",
      connected: "Connected",
      retrying: "Reconnecting in {s} s",
      error: "Connection error",
      mediaScene: "Media",
      blankScene: "Blank screen",
      scene: "Scene",
      tabLive: "On-Air",
      tabStage: "Stage",
      tabPad: "Scripture",
      tabSummary: "Pack",
      quickVerse: "Quick Verse Fire",
      quickVerseProject: "Project",
      outlineTitle: "Spoken Outline Point Triggers",
      outlineClear: "Clear Outline Banner",
      "prepared.title": "My Prepared Verses",
      "prepared.add": "Add",
      "prepared.empty": "No verses prepared yet. Add one above.",
      "prepared.invalid": "Could not recognize that reference (e.g. \"John 3:16\").",
      "prepared.remove": "Remove",
      onAirTag: "On air",
      tabsLabel: "Sections",
      timerTitle: "Sermon timer",
      timerLabel: "Sermon countdown",
      timerStop: "Pause / Stop",
      timerReset: "Reset",
      alertTitle: "Message to the stage",
      alert2min: "2 minutes",
      alertWrap: "Wrap up",
      alertNursery: "Nursery",
      alertMic: "Mic check",
      alertPlaceholder: "Custom stage message…",
      send: "Send",
      quickVersePlaceholder: "e.g. John 3:16 or Rom 8:28",
      preparedPlaceholder: "e.g. John 3:16",
      packTitle: "Post-service pack",
      packBody: "Generate timestamped YouTube chapters, bulletin summaries, and social media quotes from this service.",
      packGenerate: "Generate service summary pack",
      packGenerating: "Generating…",
      packFailed: "Failed to load service pack.",
    },
    fr: {
      title: "Télécommande",
      noToken: "Aucun jeton opérateur dans le lien. Copiez à nouveau le lien depuis les Paramètres.",
      offAir: "Rien à l'écran",
      onAir: "À l'écran",
      clearScreen: "Effacer l'écran",
      rundown: "Déroulé",
      noRundown: "Aucun déroulé chargé.",
      previous: "Précédent",
      next: "Suivant",
      media: "Médias",
      clearMedia: "Arrêter le média",
      layoutMedia: "Mise en page & médias",
      layoutFullscreen: "Plein écran",
      layoutLowerThird: "Bandeau bas",
      connecting: "Connexion…",
      connected: "Connecté",
      retrying: "Reconnexion dans {s} s",
      error: "Erreur de connexion",
      mediaScene: "Média",
      blankScene: "Écran vide",
      scene: "Scène",
      tabLive: "Direct",
      tabStage: "Scène",
      tabPad: "Écritures",
      tabSummary: "Pack",
      quickVerse: "Verset express",
      quickVerseProject: "Projeter",
      outlineTitle: "Déclencheurs des points du plan",
      outlineClear: "Effacer le bandeau du plan",
      "prepared.title": "Mes versets préparés",
      "prepared.add": "Ajouter",
      "prepared.empty": "Aucun verset préparé pour l'instant. Ajoutez-en un ci-dessus.",
      "prepared.invalid": "Référence non reconnue (ex. « Jean 3:16 »).",
      "prepared.remove": "Retirer",
      onAirTag: "À l'antenne",
      tabsLabel: "Sections",
      timerTitle: "Minuteur de prédication",
      timerLabel: "Compte à rebours",
      timerStop: "Pause / Arrêt",
      timerReset: "Réinitialiser",
      alertTitle: "Message à la scène",
      alert2min: "2 minutes",
      alertWrap: "Conclure",
      alertNursery: "Garderie",
      alertMic: "Vérifier le micro",
      alertPlaceholder: "Message personnalisé…",
      send: "Envoyer",
      quickVersePlaceholder: "ex. Jean 3:16 ou Rom 8:28",
      preparedPlaceholder: "ex. Jean 3:16",
      packTitle: "Pack après le culte",
      packBody: "Générez des chapitres YouTube horodatés, des résumés pour le bulletin et des citations pour les réseaux sociaux à partir de ce culte.",
      packGenerate: "Générer le pack de résumé",
      packGenerating: "Génération…",
      packFailed: "Impossible de charger le pack.",
    },
  }
  const lang = (navigator.language || "en").toLowerCase().startsWith("fr") ? "fr" : "en"
  const t = (key, vars) => {
    let value = STRINGS[lang]?.[key] ?? STRINGS.en[key] ?? key
    for (const [name, v] of Object.entries(vars || {})) value = value.split("{" + name + "}").join(String(v))
    return value
  }
  document.documentElement.lang = lang
  document.querySelectorAll("[data-t]").forEach((el) => {
    el.textContent = t(el.getAttribute("data-t"))
  })
  document.querySelectorAll("[data-t-placeholder]").forEach((el) => {
    el.setAttribute("placeholder", t(el.getAttribute("data-t-placeholder")))
  })
  document.querySelectorAll("[data-t-label]").forEach((el) => {
    el.setAttribute("aria-label", t(el.getAttribute("data-t-label")))
  })
  document.title = "ChurchOverlay — " + t("title")

  const FRENCH_BOOK_NAMES = {
    genesis: "Genèse", exodus: "Exode", leviticus: "Lévitique", numbers: "Nombres",
    deuteronomy: "Deutéronome", joshua: "Josué", judges: "Juges", ruth: "Ruth",
    "1 samuel": "1 Samuel", "2 samuel": "2 Samuel", "1 kings": "1 Rois", "2 kings": "2 Rois",
    "1 chronicles": "1 Chroniques", "2 chronicles": "2 Chroniques", ezra: "Esdras",
    nehemiah: "Néhémie", esther: "Esther", job: "Job", psalm: "Psaumes",
    proverbs: "Proverbes", ecclesiastes: "Ecclésiaste", "song of solomon": "Cantique des Cantiques",
    isaiah: "Ésaïe", jeremiah: "Jérémie", lamentations: "Lamentations", ezekiel: "Ézéchiel",
    daniel: "Daniel", hosea: "Osée", joel: "Joël", amos: "Amos", obadiah: "Abdias",
    jonah: "Jonas", micah: "Michée", nahum: "Nahum", habakkuk: "Habacuc",
    zephaniah: "Sophonie", haggai: "Aggée", zechariah: "Zacharie", malachi: "Malachie",
    matthew: "Matthieu", mark: "Marc", luke: "Luc", john: "Jean", acts: "Actes",
    romans: "Romains", "1 corinthians": "1 Corinthiens", "2 corinthians": "2 Corinthiens",
    galatians: "Galates", ephesians: "Éphésiens", philippians: "Philippiens",
    colossians: "Colossiens", "1 thessalonians": "1 Thessaloniciens",
    "2 thessalonians": "2 Thessaloniciens", "1 timothy": "1 Timothée", "2 timothy": "2 Timothée",
    titus: "Tite", philemon: "Philémon", hebrews: "Hébreux", james: "Jacques",
    "1 peter": "1 Pierre", "2 peter": "2 Pierre", "1 john": "1 Jean", "2 john": "2 Jean",
    "3 john": "3 Jean", jude: "Jude", revelation: "Apocalypse",
  }
  // ARCHITECTURE.md section 107: "darby" (J.N. Darby, French, public
  // domain) added alongside the existing Louis Segond aliases — both name
  // a French-language translation, so both should render French book names.
  const FRENCH_TRANSLATIONS = new Set(["ls1910", "lsg", "segond", "darby"])
  const capitalize = (book) => book.replace(/\b\w/g, (c) => c.toUpperCase())
  function referenceText(reference, translation) {
    const french = FRENCH_TRANSLATIONS.has(String(translation || "").toLowerCase())
    const name = french ? FRENCH_BOOK_NAMES[reference.book] || capitalize(reference.book) : capitalize(reference.book)
    return name + " " + reference.chapter + ":" + reference.verse
  }

  function parseVerseString(str) {
    const match = str.trim().match(/^([\d\s\w]+?)\s+(\d+)[:\s]+(\d+)$/i)
    if (!match) return null
    return {
      book: match[1].trim().toLowerCase(),
      chapter: parseInt(match[2], 10),
      verse: parseInt(match[3], 10),
    }
  }

  function triggerHaptic() {
    try {
      if (typeof navigator !== "undefined" && navigator.vibrate) {
        navigator.vibrate(12)
      }
    } catch {
      // Ignored if restricted
    }
  }

  const noTokenEl = document.getElementById("no-token")
  const appEl = document.getElementById("app")
  const statusPillEl = document.getElementById("status-pill")
  const statusTextEl = document.getElementById("status-text")
  const onScreenEl = document.getElementById("on-screen")
  const onScreenStateEl = document.getElementById("on-screen-state")
  const onScreenRefEl = document.getElementById("on-screen-ref")
  const onScreenAnnounceEl = document.getElementById("on-screen-announce")
  const clearVerseBtn = document.getElementById("clear-verse-btn")
  const sceneListEl = document.getElementById("scene-list")
  const prevBtn = document.getElementById("prev-btn")
  const nextBtn = document.getElementById("next-btn")
  const clearMediaBtn = document.getElementById("clear-media-btn")
  const layoutFullscreenBtn = document.getElementById("layout-fullscreen-btn")
  const layoutLowerThirdBtn = document.getElementById("layout-lowerthird-btn")
  const remoteTimerClockEl = document.getElementById("remote-timer-clock")
  const timerStopBtn = document.getElementById("timer-stop-btn")
  const timerResetBtn = document.getElementById("timer-reset-btn")
  const stageAlertInput = document.getElementById("stage-alert-input")
  const sendAlertBtn = document.getElementById("send-alert-btn")
  const quickVerseInput = document.getElementById("quick-verse-input")
  const quickVerseBtn = document.getElementById("quick-verse-btn")
  const preparedVerseInput = document.getElementById("prepared-verse-input")
  const preparedVerseAddBtn = document.getElementById("prepared-verse-add-btn")
  const preparedVerseListEl = document.getElementById("prepared-verse-list")
  const downloadServicePackBtn = document.getElementById("download-service-pack-btn")
  const servicePackResult = document.getElementById("service-pack-result")
  const servicePackText = document.getElementById("service-pack-text")

  // Small inline SVG icon (same 24-unit grid / currentColor stroke as the
  // page's sprite), built with DOM APIs — never innerHTML.
  const SVG_NS = "http://www.w3.org/2000/svg"
  function iconEl(symbolId) {
    const svg = document.createElementNS(SVG_NS, "svg")
    svg.setAttribute("class", "icon")
    svg.setAttribute("aria-hidden", "true")
    const use = document.createElementNS(SVG_NS, "use")
    use.setAttribute("href", "#" + symbolId)
    svg.appendChild(use)
    return svg
  }

  // Tab switching (WAI-ARIA tabs: roving tabindex, arrow keys move between tabs)
  const tabButtons = Array.from(document.querySelectorAll(".tab-btn"))
  function selectTab(btn) {
    tabButtons.forEach((b) => {
      const selected = b === btn
      b.classList.toggle("active", selected)
      b.setAttribute("aria-selected", String(selected))
      b.tabIndex = selected ? 0 : -1
    })
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"))
    const targetId = "panel-" + btn.getAttribute("data-tab")
    const panel = document.getElementById(targetId)
    if (panel) panel.classList.add("active")
  }
  tabButtons.forEach((btn, index) => {
    btn.addEventListener("click", () => {
      triggerHaptic()
      selectTab(btn)
    })
    btn.addEventListener("keydown", (event) => {
      let next = null
      if (event.key === "ArrowRight") next = tabButtons[(index + 1) % tabButtons.length]
      else if (event.key === "ArrowLeft") next = tabButtons[(index - 1 + tabButtons.length) % tabButtons.length]
      else if (event.key === "Home") next = tabButtons[0]
      else if (event.key === "End") next = tabButtons[tabButtons.length - 1]
      if (!next) return
      event.preventDefault()
      selectTab(next)
      next.focus()
    })
  })

  if (!token || !wsPort) {
    noTokenEl.style.display = "block"
    appEl.style.display = "none"
    return
  }

  let currentRundownState = null
  let activeWs = null

  function setStatus(text, state) {
    statusTextEl.textContent = text
    statusPillEl.className = state
  }

  function renderOnScreen(label) {
    onScreenEl.classList.toggle("live", Boolean(label))
    document.body.classList.toggle("is-live", Boolean(label))
    onScreenStateEl.textContent = label ? t("onAir") : t("offAir")
    onScreenRefEl.textContent = label || ""
    onScreenAnnounceEl.textContent = label ? t("onAir") + ": " + label : t("offAir")
  }

  function sceneSummary(scene) {
    switch (scene.kind) {
      case "verse":
        return referenceText(scene.reference)
      case "media":
        return t("mediaScene")
      case "announcement":
        return scene.title
      case "blank":
        return t("blankScene")
      default:
        return t("scene")
    }
  }

  function renderSceneList() {
    sceneListEl.innerHTML = ""
    if (!currentRundownState) {
      const empty = document.createElement("div")
      empty.className = "scene-empty"
      empty.textContent = t("noRundown")
      sceneListEl.appendChild(empty)
      prevBtn.disabled = true
      nextBtn.disabled = true
      return
    }
    prevBtn.disabled = false
    nextBtn.disabled = false

    const chip = document.createElement("div")
    chip.className = "scene-chip active" + (currentRundownState.interrupted ? " interrupted" : "")
    chip.textContent = sceneSummary(currentRundownState.scene)
    sceneListEl.appendChild(chip)
  }

  function sendJson(ws, message) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    triggerHaptic()
    ws.send(JSON.stringify(message))
  }

  // Sends a spoken-style reference string ("Jean 3:16") the exact same way
  // a quick-fire or preset button already does: through verse:override,
  // which the server validates against KnownValidVerseIndex identically to
  // any other reference (ARCHITECTURE.md section 50, AGENTS.md section 12
  // "Manual override is still subject to validation" — no admin bypass).
  // Uses `activeWs` (kept current by connect()/reconnect below) rather than
  // a closed-over socket, so this one function works for quick-fire,
  // presets, and the prepared list alike.
  function fireVerse(refStr) {
    const ref = parseVerseString(refStr)
    if (!ref) return false
    sendJson(activeWs, { id: crypto.randomUUID(), type: "verse:override", timestamp: Date.now(), payload: ref })
    return true
  }

  // A pastor's own prepared verse list ("prepare these ahead of time, tap
  // to show whenever ready during the service") — deliberately just a
  // client-side convenience on top of the existing, fully-validated
  // verse:override path above: no new WS command, no server-side storage,
  // no new hallucination-guard surface. Persisted in this phone's own
  // localStorage (survives closing the page; never synced anywhere, never
  // read by the server or by Claude — see the module's own storage
  // guidance) so a pastor's prepared list is still there next Sunday.
  // Bounded (AGENTS.md section 36: no unbounded queue/cache), same
  // reasoning as the server's own bounded near-miss/cache limits.
  const PREPARED_VERSES_STORAGE_KEY = "churchoverlay.remote.preparedVerses"
  const PREPARED_VERSES_LIMIT = 30

  function loadPreparedVerses() {
    try {
      const raw = window.localStorage.getItem(PREPARED_VERSES_STORAGE_KEY)
      const parsed = raw ? JSON.parse(raw) : []
      return Array.isArray(parsed) ? parsed.filter((v) => typeof v === "string") : []
    } catch {
      return []
    }
  }

  function savePreparedVerses(list) {
    try {
      window.localStorage.setItem(PREPARED_VERSES_STORAGE_KEY, JSON.stringify(list))
    } catch {
      // Private-browsing/quota failure: the list simply won't survive a
      // reload this time. Not worth surfacing as an error for a
      // convenience feature with no server-side counterpart.
    }
  }

  let preparedVerses = loadPreparedVerses()

  function renderPreparedVerses() {
    preparedVerseListEl.innerHTML = ""
    if (preparedVerses.length === 0) {
      const empty = document.createElement("div")
      empty.className = "prepared-verse-empty"
      empty.textContent = t("prepared.empty")
      preparedVerseListEl.appendChild(empty)
      return
    }
    preparedVerses.forEach((refStr, index) => {
      const row = document.createElement("div")
      row.className = "prepared-verse-row"

      const fireBtn = document.createElement("button")
      fireBtn.type = "button"
      fireBtn.className = "preset-btn"
      const strong = document.createElement("strong")
      strong.textContent = refStr
      fireBtn.appendChild(strong)
      fireBtn.addEventListener("click", () => fireVerse(refStr))
      row.appendChild(fireBtn)

      const removeBtn = document.createElement("button")
      removeBtn.type = "button"
      removeBtn.className = "prepared-remove-btn"
      removeBtn.appendChild(iconEl("i-x"))
      removeBtn.setAttribute("aria-label", t("prepared.remove") + " " + refStr)
      removeBtn.addEventListener("click", (event) => {
        event.stopPropagation()
        preparedVerses.splice(index, 1)
        savePreparedVerses(preparedVerses)
        renderPreparedVerses()
      })
      row.appendChild(removeBtn)

      preparedVerseListEl.appendChild(row)
    })
  }

  function addPreparedVerse(refStr) {
    const trimmed = refStr.trim()
    if (!trimmed) return
    if (!parseVerseString(trimmed)) {
      preparedVerseInput.setCustomValidity(t("prepared.invalid"))
      preparedVerseInput.reportValidity()
      return
    }
    preparedVerseInput.setCustomValidity("")
    if (preparedVerses.length >= PREPARED_VERSES_LIMIT) preparedVerses.shift()
    preparedVerses.push(trimmed)
    savePreparedVerses(preparedVerses)
    renderPreparedVerses()
    preparedVerseInput.value = ""
  }

  preparedVerseAddBtn.addEventListener("click", () => addPreparedVerse(preparedVerseInput.value))
  preparedVerseInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") addPreparedVerse(preparedVerseInput.value)
  })
  preparedVerseInput.addEventListener("input", () => preparedVerseInput.setCustomValidity(""))
  // Enter / the keyboard's Go/Send key does what the button next to the field does.
  quickVerseInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") quickVerseBtn.click()
  })
  stageAlertInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") sendAlertBtn.click()
  })
  renderPreparedVerses()

  const BASE_RECONNECT_DELAY_MS = 1000
  const MAX_RECONNECT_DELAY_MS = 30000
  let reconnectAttempts = 0

  function nextReconnectDelay() {
    const delay = Math.min(BASE_RECONNECT_DELAY_MS * 2 ** reconnectAttempts, MAX_RECONNECT_DELAY_MS)
    reconnectAttempts += 1
    return delay
  }

  function formatTime(seconds) {
    const m = Math.floor(Math.abs(seconds) / 60)
    const s = Math.abs(seconds) % 60
    return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`
  }

  function connect() {
    setStatus(t("connecting"), "disconnected")
    const ws = new WebSocket("ws://" + window.location.hostname + ":" + wsPort, [token])
    activeWs = ws

    ws.addEventListener("open", () => {
      reconnectAttempts = 0
      setStatus(t("connected"), "connected")
    })
    ws.addEventListener("close", () => {
      const delay = nextReconnectDelay()
      setStatus(t("retrying", { s: Math.round(delay / 1000) }), "disconnected")
      setTimeout(connect, delay)
    })
    ws.addEventListener("error", () => setStatus(t("error"), "disconnected"))
    ws.addEventListener("message", (event) => {
      let message
      try {
        message = JSON.parse(event.data)
      } catch {
        return
      }
      if (message.type === "rundown:state") {
        currentRundownState = message.payload
        renderSceneList()
      } else if (message.type === "verse:show" && message.payload?.reference) {
        renderOnScreen(referenceText(message.payload.reference, message.payload.translation))
      } else if (message.type === "verse:clear") {
        renderOnScreen(null)
      } else if (message.type === "timer:state" && message.payload) {
        if (remoteTimerClockEl) {
          remoteTimerClockEl.textContent = (message.payload.isOvertime ? "+ " : "") + formatTime(message.payload.remainingSeconds)
          remoteTimerClockEl.classList.toggle("overtime", Boolean(message.payload.isOvertime))
        }
      }
    })

    const sendCmd = (type, payload = null) => () => {
      sendJson(ws, { id: crypto.randomUUID(), type, timestamp: Date.now(), payload })
    }

    clearVerseBtn.onclick = sendCmd("verse:clear")
    prevBtn.onclick = sendCmd("scene:previous")
    nextBtn.onclick = sendCmd("scene:next")
    clearMediaBtn.onclick = sendCmd("media:clear")

    layoutFullscreenBtn.onclick = () => sendJson(ws, { id: crypto.randomUUID(), type: "layout:set", timestamp: Date.now(), payload: { layout: "fullscreen" } })
    layoutLowerThirdBtn.onclick = () => sendJson(ws, { id: crypto.randomUUID(), type: "layout:set", timestamp: Date.now(), payload: { layout: "lower-third" } })

    timerStopBtn.onclick = sendCmd("timer:stop")
    timerResetBtn.onclick = sendCmd("timer:reset")

    document.querySelectorAll(".timer-preset-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const min = parseInt(btn.getAttribute("data-min"), 10) || 30
        sendJson(ws, { id: crypto.randomUUID(), type: "timer:start", timestamp: Date.now(), payload: { durationMinutes: min, title: "Sermon" } })
      })
    })

    document.querySelectorAll(".alert-quick-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const msg = btn.getAttribute("data-msg")
        sendJson(ws, { id: crypto.randomUUID(), type: "stage:alert", timestamp: Date.now(), payload: { message: msg } })
      })
    })

    sendAlertBtn.onclick = () => {
      const msg = stageAlertInput.value.trim()
      if (!msg) return
      sendJson(ws, { id: crypto.randomUUID(), type: "stage:alert", timestamp: Date.now(), payload: { message: msg } })
      stageAlertInput.value = ""
    }

    const fireVerse = (refStr) => {
      const ref = parseVerseString(refStr)
      if (ref) {
        sendJson(ws, { id: crypto.randomUUID(), type: "verse:override", timestamp: Date.now(), payload: ref })
      }
    }

    quickVerseBtn.onclick = () => {
      const val = quickVerseInput.value.trim()
      if (val) fireVerse(val)
    }

    document.querySelectorAll(".verse-preset-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const refStr = btn.getAttribute("data-ref")
        if (refStr) fireVerse(refStr)
      })
    })

    document.querySelectorAll(".outline-preset-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const pointNumber = parseInt(btn.getAttribute("data-num"), 10) || 1
        const title = btn.getAttribute("data-title") || ""
        const text = btn.getAttribute("data-text") || undefined
        sendJson(ws, { id: crypto.randomUUID(), type: "outline:show", timestamp: Date.now(), payload: { pointNumber, title, text } })
      })
    })

    const clearOutlineBtn = document.getElementById("clear-outline-btn")
    if (clearOutlineBtn) {
      clearOutlineBtn.onclick = () => {
        sendJson(ws, { id: crypto.randomUUID(), type: "outline:clear", timestamp: Date.now(), payload: null })
      }
    }

    const servicePackLabel = downloadServicePackBtn.querySelector(".btn-label") || downloadServicePackBtn
    downloadServicePackBtn.onclick = async () => {
      try {
        servicePackLabel.textContent = t("packGenerating")
        downloadServicePackBtn.disabled = true
        const res = await fetch("/api/service-pack", { headers: { Authorization: "Bearer " + token } })
        if (res.ok) {
          const data = await res.json()
          servicePackResult.style.display = "block"
          servicePackText.value = `# YouTube Description:\n${data.youtubeDescription}\n\n# Service Analytics:\nDuration: ${data.analytics?.serviceDurationMinutes}m | WPM: ${data.analytics?.speechRateWpm}\nVerses Quoted: ${data.analytics?.uniqueVersesCount}`
        }
      } catch (err) {
        servicePackResult.style.display = "block"
        servicePackText.value = t("packFailed")
      } finally {
        servicePackLabel.textContent = t("packGenerate")
        downloadServicePackBtn.disabled = false
      }
    }
  }

  renderOnScreen(null)
  connect()
})()
