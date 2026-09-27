// Plain browser JS, no build step — matches dashboard.js/overlay.js's own
// convention. ARCHITECTURE.md section 65.6: reuses the existing operator
// token/role (no new WsRole) — this page authenticates exactly like the
// desktop dashboard does, just scoped by its OWN UI to a narrower set of
// actions (what is on screen and clearing it, rundown navigation, media
// clear) than the dashboard exposes.
;(function () {
  const params = new URLSearchParams(window.location.search)
  const token = params.get("token")
  const wsPort = params.get("wsPort")

  // The phone's own language, French or English — no settings screen on a
  // phone remote, so it simply follows the device.
  const STRINGS = {
    en: {
      title: "Remote",
      noToken: "No operator token in the link. Copy the remote link from the desktop console's Settings again.",
      offAir: "Nothing on screen",
      onAir: "On screen",
      clearScreen: "Clear the screen",
      rundown: "Rundown",
      noRundown: "No rundown loaded.",
      previous: "Previous",
      next: "Next",
      media: "Media",
      clearMedia: "Stop media",
      connecting: "Connecting…",
      connected: "Connected",
      retrying: "Reconnecting in {s} s",
      error: "Connection error",
      mediaScene: "Media",
      blankScene: "Blank screen",
      scene: "Scene",
    },
    fr: {
      title: "Télécommande",
      noToken: "Aucun jeton opérateur dans le lien. Copiez à nouveau le lien depuis les Paramètres de la console.",
      offAir: "Rien à l'écran",
      onAir: "À l'écran",
      clearScreen: "Effacer l'écran",
      rundown: "Déroulé",
      noRundown: "Aucun déroulé chargé.",
      previous: "Précédent",
      next: "Suivant",
      media: "Médias",
      clearMedia: "Arrêter le média",
      connecting: "Connexion…",
      connected: "Connecté",
      retrying: "Reconnexion dans {s} s",
      error: "Erreur de connexion",
      mediaScene: "Média",
      blankScene: "Écran vide",
      scene: "Scène",
    },
  }
  const lang = (navigator.language || "en").toLowerCase().startsWith("fr") ? "fr" : "en"
  const t = (key, vars) => {
    let value = STRINGS[lang][key] ?? STRINGS.en[key] ?? key
    for (const [name, v] of Object.entries(vars || {})) value = value.split("{" + name + "}").join(String(v))
    return value
  }
  document.documentElement.lang = lang
  document.querySelectorAll("[data-t]").forEach((el) => {
    el.textContent = t(el.getAttribute("data-t"))
  })
  document.title = t("title")

  // Same table as overlay.js / dashboard.js (duplicated, no build step).
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
  const FRENCH_TRANSLATIONS = new Set(["ls1910", "lsg", "segond"])
  const capitalize = (book) => book.replace(/\b\w/g, (c) => c.toUpperCase())
  function referenceText(reference, translation) {
    const french = FRENCH_TRANSLATIONS.has(String(translation || "").toLowerCase())
    const name = french ? FRENCH_BOOK_NAMES[reference.book] || capitalize(reference.book) : capitalize(reference.book)
    return name + " " + reference.chapter + ":" + reference.verse
  }

  const noTokenEl = document.getElementById("no-token")
  const appEl = document.getElementById("app")
  const statusPillEl = document.getElementById("status-pill")
  const statusTextEl = document.getElementById("status-text")
  const onScreenEl = document.getElementById("on-screen")
  const onScreenStateEl = document.getElementById("on-screen-state")
  const onScreenRefEl = document.getElementById("on-screen-ref")
  const clearVerseBtn = document.getElementById("clear-verse-btn")
  const sceneListEl = document.getElementById("scene-list")
  const prevBtn = document.getElementById("prev-btn")
  const nextBtn = document.getElementById("next-btn")
  const clearMediaBtn = document.getElementById("clear-media-btn")

  if (!token || !wsPort) {
    noTokenEl.style.display = "block"
    appEl.style.display = "none"
    return
  }

  let currentRundownState = null // last rundown:state payload, or null

  function setStatus(text, state) {
    statusTextEl.textContent = text
    statusPillEl.className = state
  }

  function renderOnScreen(label) {
    onScreenEl.classList.toggle("live", Boolean(label))
    onScreenStateEl.textContent = label ? t("onAir") : t("offAir")
    onScreenRefEl.textContent = label || ""
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

    // rundown:state only ever carries the CURRENT scene (ARCHITECTURE.md
    // section 64.4), not the whole list — this page only shows what is
    // active right now; authoring stays the desktop dashboard's job.
    const chip = document.createElement("div")
    chip.className = "scene-chip active" + (currentRundownState.interrupted ? " interrupted" : "")
    chip.textContent = sceneSummary(currentRundownState.scene)
    sceneListEl.appendChild(chip)
  }

  function sendJson(ws, message) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify(message))
  }

  const BASE_RECONNECT_DELAY_MS = 1000
  const MAX_RECONNECT_DELAY_MS = 30000
  let reconnectAttempts = 0

  function nextReconnectDelay() {
    const delay = Math.min(BASE_RECONNECT_DELAY_MS * 2 ** reconnectAttempts, MAX_RECONNECT_DELAY_MS)
    reconnectAttempts += 1
    return delay
  }

  function connect() {
    setStatus(t("connecting"), "disconnected")
    // The phone reached this page via the machine's LAN address already
    // (window.location.hostname) — the WS server runs on the same
    // machine, a different port, so no separate host param is needed.
    const ws = new WebSocket("ws://" + window.location.hostname + ":" + wsPort, [token])

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
      } else if (message.type === "verse:show" && message.payload && message.payload.reference) {
        renderOnScreen(referenceText(message.payload.reference, message.payload.translation))
      } else if (message.type === "verse:clear") {
        renderOnScreen(null)
      }
    })

    const command = (type) => () => sendJson(ws, { id: crypto.randomUUID(), type, timestamp: Date.now(), payload: null })
    clearVerseBtn.onclick = command("verse:clear")
    prevBtn.onclick = command("scene:previous")
    nextBtn.onclick = command("scene:next")
    clearMediaBtn.onclick = command("media:clear")
  }

  renderOnScreen(null)
  connect()
})()
