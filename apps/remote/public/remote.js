// Plain browser JS, no build step — matches dashboard.js/overlay.js's own
// convention. ARCHITECTURE.md section 65.6: reuses the existing operator
// token/role (no new WsRole) — this page authenticates exactly like the
// desktop dashboard does, just scoped by its OWN UI to a narrower set of
// actions (rundown navigation, media clear) than the dashboard exposes.
;(function () {
  const params = new URLSearchParams(window.location.search)
  const token = params.get("token")
  const wsPort = params.get("wsPort")

  const noTokenEl = document.getElementById("no-token")
  const appEl = document.getElementById("app")
  const statusPillEl = document.getElementById("status-pill")
  const statusTextEl = document.getElementById("status-text")
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

  function sceneSummary(scene) {
    switch (scene.kind) {
      case "verse":
        return scene.reference.book.replace(/\b\w/g, (c) => c.toUpperCase()) + " " + scene.reference.chapter + ":" + scene.reference.verse
      case "media":
        return "Media cue"
      case "announcement":
        return scene.title
      case "blank":
        return "(blank)"
      default:
        return "Scene"
    }
  }

  function renderSceneList() {
    sceneListEl.innerHTML = ""
    if (!currentRundownState) {
      const empty = document.createElement("div")
      empty.className = "scene-empty"
      empty.textContent = "No rundown loaded."
      sceneListEl.appendChild(empty)
      prevBtn.disabled = true
      nextBtn.disabled = true
      return
    }
    prevBtn.disabled = false
    nextBtn.disabled = false

    // rundown:state only ever carries the CURRENT scene (ARCHITECTURE.md
    // section 64.4), not the whole list — this remote page has no reason
    // to author/preview the full rundown (that stays the desktop
    // dashboard's job), so it only ever shows "what's active right now."
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
    setStatus("connecting…", "disconnected")
    // The phone reached this page via the machine's LAN address already
    // (window.location.hostname) — the WS server runs on the same
    // machine, a different port, so no separate host param is needed.
    const ws = new WebSocket("ws://" + window.location.hostname + ":" + wsPort, [token])

    ws.addEventListener("open", () => {
      reconnectAttempts = 0
      setStatus("connected", "connected")
    })
    ws.addEventListener("close", () => {
      const delay = nextReconnectDelay()
      setStatus("disconnected — retrying in " + Math.round(delay / 1000) + "s…", "disconnected")
      setTimeout(connect, delay)
    })
    ws.addEventListener("error", () => setStatus("connection error", "disconnected"))
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
      }
    })

    prevBtn.onclick = () => sendJson(ws, { id: crypto.randomUUID(), type: "scene:previous", timestamp: Date.now(), payload: null })
    nextBtn.onclick = () => sendJson(ws, { id: crypto.randomUUID(), type: "scene:next", timestamp: Date.now(), payload: null })
    clearMediaBtn.onclick = () => sendJson(ws, { id: crypto.randomUUID(), type: "media:clear", timestamp: Date.now(), payload: null })
  }

  connect()
})()
